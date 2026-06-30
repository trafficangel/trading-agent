/**
 * DEEP-WICK ANOMALY-FADE RUNNER — the SECOND validated edge ([[hl-micro-layer]]), launched in HL
 * TESTNET. Rest a post-only (maker, no speed needed) deep limit X% from the mid on each coin; a flash /
 * over-extension fills it; fade back to the pre-wick mid. Validated broad on retail alts (cross-window
 * + direction-null + controls-fail). The edge lives on retail-driven alts, dies on efficient majors.
 *
 * MECHANICS (matches the backtest): bid at mid·(1−X), ask at mid·(1+X). On fill the exit target is the
 * pre-wick mid, DERIVED from the fill price: target = entry/(1−X) (long) / entry/(1+X) (short). Exit on
 * target-revert OR holdMins time-stop OR stopPct catastrophe (a real move, not a wick). EXCHANGE is the
 * source of truth for BOTH positions and resting orders (no DB order-state to desync).
 *
 * SAFE (funding-flip lessons): reconcile the exchange every tick (orphan fill → adopt; DB-open but
 * exchange-flat → reconciled, no fabricated PnL); confirm-flat before booking; immutable entry `reason`;
 * endpoint guard (mode=testnet refuses to run if HL_USE_TESTNET=false → idle, not crash). Post-only Alo
 * limits can never accidentally take (HL rejects a crossing Alo), so a deep quote only ever rests.
 */
import cron from 'node-cron';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { hlConfigured, hlSetLeverage, hlLimitOrder, hlCancelOrder, hlOpenOrders, hlFetchPosition, hlClosePosition, hlMid, type HlOpenOrder } from '../exchange/hyperliquid-private.js';

type WfMode = 'off' | 'testnet' | 'live';
// per-coin depth X (validated sweet spot): 2% for TON, 3% for the rest. ALL HL-listed.
// NB: coins MUST be DISJOINT from funding-flip's {ETH,ADA,XRP,AVAX} — one strategy per symbol on a shared
// account, else each runner adopts/closes the other's position (CLAUDE.md One-Way rule). XRP dropped for this.
const COIN_X: Record<string, number> = { TON: 0.02, DOGE: 0.03, ICP: 0.03, NEAR: 0.03, ATOM: 0.03, CRV: 0.03, ENA: 0.03, TIA: 0.03, kPEPE: 0.03 };
export const WF_CONFIG: { mode: WfMode; coins: string[]; capitalUsd: number; leverage: number; holdMins: number; stopPct: number; requoteDrift: number } = {
  mode: 'testnet',        // operator chose HL testnet
  coins: Object.keys(COIN_X),
  capitalUsd: 150,        // testnet; per-coin margin = capitalUsd/coins.length (small — resting orders reserve margin, account is shared with funding-flip)
  leverage: 2,
  holdMins: 60,           // time-stop (backtest exitH=12×5m bars)
  stopPct: 0.03,          // catastrophe stop beyond entry (backtest STOP=3%)
  requoteDrift: 0.01,     // re-quote a resting level only when it drifts >1% off the desired (anti-churn; deep limits don't need tight tracking)
};
const COST_RT = 0.10;     // CONSERVATIVE round-trip booking: maker entry (Alo) + taker exit IOC crosses thin alt books worse than mid (the strong coins survived 0.15% in backtest; book pessimistically so the promotion gate isn't optimistically biased)
const MIN_NOTIONAL = 11;  // HL min order ≈ $10
const HR = 3_600_000;

type PosRow = { coin: string; side: 'long' | 'short'; entry_px: number; qty: number; x: number; opened_at: number; reason: string };
const getPos = db.prepare<[string], PosRow>(`SELECT * FROM wick_fade_pos WHERE coin = ?`);
const insPos = db.prepare(`INSERT OR REPLACE INTO wick_fade_pos (coin,side,entry_px,qty,x,opened_at,reason) VALUES (?,?,?,?,?,?,?)`);
const delPos = db.prepare(`DELETE FROM wick_fade_pos WHERE coin = ?`);
const insLog = db.prepare(`INSERT INTO wick_fade_log (coin,side,entry_px,qty,x,opened_at,reason,mode) VALUES (?,?,?,?,?,?,?,?)`);
// close the ACTIVE log row (closed_at IS NULL) — sets close fields, NEVER touches the immutable entry `reason`.
const updLog = db.prepare(`UPDATE wick_fade_log SET exit_px=?,closed_at=?,pnl_pct=?,close_reason=? WHERE id=(SELECT id FROM wick_fade_log WHERE coin=? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1)`);
const closeTxn = db.transaction((exitPx: number, closedAt: number, pnl: number, reason: string, coin: string) => { updLog.run(exitPx, closedAt, pnl, reason, coin); delPos.run(coin); });

const targetPx = (side: 'long' | 'short', entry: number, x: number) => (side === 'long' ? entry / (1 - x) : entry / (1 + x));
const stopAbs = (side: 'long' | 'short', entry: number) => (side === 'long' ? entry * (1 - WF_CONFIG.stopPct) : entry * (1 + WF_CONFIG.stopPct));

const levSet = new Set<string>();
/** cancel every given order; returns true only if ALL succeeded (a transient failure leaves an order
 *  resting, so callers must NOT place a fresh same-side quote on false → would duplicate). */
async function cancelAll(coin: string, orders: HlOpenOrder[]): Promise<boolean> {
  let allOk = true;
  for (const o of orders) { const c = await hlCancelOrder(coin, o.oid); if (!c.ok) { allOk = false; logger.warn({ coin, oid: o.oid, msg: c.msg }, 'wick-fade: cancel failed'); } }
  return allOk;
}

async function stepCoin(coin: string): Promise<void> {
  const x = COIN_X[coin]; if (x == null) return;
  const nowMs = Date.now();
  const dbPos = getPos.get(coin);
  const exRes = await hlFetchPosition(coin);
  if (!exRes.ok) { logger.warn({ coin, msg: exRes.msg }, 'wick-fade: position fetch failed — skip tick'); return; }
  const exPos = exRes.data;
  const ooRes = await hlOpenOrders(coin);
  const exOrders = ooRes.ok ? ooRes.data : [];

  // ── RECONCILE: a deep quote FILLED (exchange position, no DB row) → adopt + clear the other side ──
  if (exPos && !dbPos) {
    if (!ooRes.ok) { logger.warn({ coin }, 'wick-fade: fill detected but openOrders read failed — defer adopt (must clear the other side first)'); return; }
    await cancelAll(coin, exOrders);
    insPos.run(coin, exPos.side, exPos.entryPx, exPos.size, x, nowMs, 'fill');
    insLog.run(coin, exPos.side, exPos.entryPx, exPos.size, x, nowMs, 'fill', WF_CONFIG.mode);
    logger.warn({ coin, side: exPos.side, entry: exPos.entryPx, target: +targetPx(exPos.side, exPos.entryPx, x).toFixed(6) }, '✅ wick-fade: FILLED (deep wick) — managing exit');
    return;
  }
  // ── DB-open but exchange-flat (closed out-of-band) → reconcile, do NOT fabricate PnL ──
  if (!exPos && dbPos) {
    updLog.run(null, nowMs, null, 'reconciled-flat', coin); delPos.run(coin);
    logger.warn({ coin }, 'wick-fade: DB-open but exchange-flat → reconciled + cleared (PnL unknown)');
    return;
  }
  // ── IN POSITION → manage exit (target revert / time-stop / catastrophe) ──
  if (exPos && dbPos) {
    if (!ooRes.ok) { logger.warn({ coin }, 'wick-fade: in-position but openOrders read failed — defer (a surviving opposite order could fill)'); return; }
    if (exOrders.length) await cancelAll(coin, exOrders); // defensive: no resting orders while holding
    const mid = await hlMid(coin); if (mid == null || !(mid > 0)) { logger.warn({ coin }, 'wick-fade: no mid — retry'); return; }
    const tgt = targetPx(dbPos.side, dbPos.entry_px, dbPos.x), stp = stopAbs(dbPos.side, dbPos.entry_px);
    const hitTarget = dbPos.side === 'long' ? mid >= tgt : mid <= tgt;
    const timeStop = nowMs - dbPos.opened_at >= WF_CONFIG.holdMins * 60_000;
    const catastrophe = dbPos.side === 'long' ? mid <= stp : mid >= stp;
    if (!hitTarget && !timeStop && !catastrophe) return;
    const reason = hitTarget ? 'target' : timeStop ? 'time-stop' : 'catastrophe';
    const close = await hlClosePosition(coin);
    if (!close.ok) { logger.error({ coin, msg: close.msg }, '🛑 wick-fade: close FAILED — retry next tick'); return; }
    const recheck = await hlFetchPosition(coin);
    if (!recheck.ok) { logger.warn({ coin }, 'wick-fade: post-close fetch failed — defer to reconcile'); return; }
    if (recheck.data) { logger.warn({ coin, remaining: recheck.data.size }, 'wick-fade: close did not fully fill — retry'); return; }
    const gross = dbPos.side === 'long' ? (mid - dbPos.entry_px) / dbPos.entry_px * 100 : (dbPos.entry_px - mid) / dbPos.entry_px * 100;
    const pnl = +(gross - COST_RT).toFixed(3);
    closeTxn(mid, nowMs, pnl, reason, coin);
    logger.warn({ coin, side: dbPos.side, entry: dbPos.entry_px, exit: mid, pnlPct: pnl, reason }, '✅ wick-fade: CLOSED');
    return;
  }

  // ── FLAT → maintain deep post-only quotes on both sides ──
  // Guard: if we could NOT read open orders, do NOT place quotes — we'd risk duplicating an unseen
  // resting order. (Position reconcile/exit above don't need exOrders, so they already ran safely.)
  if (!ooRes.ok) { logger.warn({ coin, msg: ooRes.msg }, 'wick-fade: openOrders read failed — skip quoting this tick'); return; }
  const mid = await hlMid(coin); if (mid == null || !(mid > 0)) return;
  const margin = WF_CONFIG.capitalUsd / WF_CONFIG.coins.length;
  for (const side of ['long', 'short'] as const) {
    const desired = side === 'long' ? mid * (1 - x) : mid * (1 + x);
    const existing = exOrders.filter((o) => o.side === side);
    const good = existing.length === 1 && Math.abs(existing[0]!.px - desired) / desired < WF_CONFIG.requoteDrift;
    if (good) continue;
    // clear stale/duplicate first; if a cancel FAILED, do NOT place a fresh quote (would duplicate) — defer
    if (existing.length) { const cleared = await cancelAll(coin, existing); if (!cleared) { logger.warn({ coin, side }, 'wick-fade: stale cancel failed — defer re-quote (avoid duplicate)'); continue; } }
    const qty = (margin * WF_CONFIG.leverage) / desired;
    if (qty * desired < MIN_NOTIONAL) { logger.warn({ coin, side, notional: +(qty * desired).toFixed(1) }, 'wick-fade: notional below min — skip side'); continue; }
    // set leverage BEFORE placing; if it fails, skip the quote (never rest at unknown/default leverage)
    if (!levSet.has(coin)) { const lev = await hlSetLeverage(coin, WF_CONFIG.leverage); if (!lev.ok) { logger.warn({ coin, msg: lev.msg }, 'wick-fade: setLeverage failed — skip quote'); continue; } levSet.add(coin); }
    const r = await hlLimitOrder({ coin, side, qty, price: desired });
    if (!r.ok) { logger.warn({ coin, side, price: +desired.toFixed(6), msg: r.msg }, 'wick-fade: quote place failed'); continue; }
    if (r.data.filled) logger.warn({ coin, side }, 'wick-fade: deep quote filled IMMEDIATELY (unexpected) — reconcile will adopt');
  }
}

let running = false;
export function startWickFadeRunner(): void {
  if (WF_CONFIG.mode === 'off') { logger.info('wick-fade runner: mode=off (idle)'); return; }
  if (WF_CONFIG.mode === 'live') throw new Error('wick-fade: live mode not enabled — prove out on testnet first');
  // SAFETY: mode=testnet must route to the testnet endpoint (config.HL_USE_TESTNET), else a prod .env flip
  // could send REAL orders. Assert they agree; idle (not throw) if not.
  if (WF_CONFIG.mode === 'testnet' && !config.HL_USE_TESTNET) { logger.error('🛑 wick-fade: mode=testnet but HL_USE_TESTNET=false — REFUSING to route to mainnet; runner idle'); return; }
  void HR;
  cron.schedule('* * * * *', () => { // every 1 min — wicks are fast
    if (running) return;
    running = true;
    void (async () => {
      for (const coin of WF_CONFIG.coins) {
        try { await stepCoin(coin); } catch (err) { logger.error({ err, coin }, 'wick-fade: step failed'); }
      }
    })().finally(() => { running = false; });
  });
  logger.warn({ mode: WF_CONFIG.mode, coins: WF_CONFIG.coins.length, lev: WF_CONFIG.leverage, hold: `${WF_CONFIG.holdMins}m`, stop: `${WF_CONFIG.stopPct * 100}%` }, '✅ wick-fade runner scheduled (every 1m, HL testnet, post-only deep limits, exchange-reconciled)');
  if (!hlConfigured()) logger.error('wick-fade: HL_API_WALLET_KEY missing — runner idles until configured');
}
