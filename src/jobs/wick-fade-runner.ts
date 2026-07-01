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
import { hlConfigured, hlSetLeverage, hlLimitOrder, hlCancelOrder, hlOpenOrders, hlFetchPosition, hlClosePosition, hlMid, hlAccountValue, hlPlaceStop, hlCancelTriggers, hlExitAvgSince, type HlOpenOrder } from '../exchange/hyperliquid-private.js';

type WfMode = 'off' | 'testnet' | 'live';
// per-coin depth X (validated sweet spot): 2% for TON, 3% for the rest — MAX coverage of the full validated
// set. NB: coins MUST be DISJOINT from funding-flip's {ETH,ADA,XRP,AVAX} — one strategy per symbol on a
// shared account (CLAUDE.md One-Way rule). All on HL mainnet; on testnet TON is halted + CRV/ENA absent → no-op.
const COIN_X: Record<string, number> = {
  // batch-1 (live since Jul 1): X=0.03 except TON (grandfathered 0.02)
  DOGE: 0.03, ICP: 0.03, NEAR: 0.03, ATOM: 0.03, TON: 0.02, CRV: 0.03, ENA: 0.03, TIA: 0.03, kPEPE: 0.03,
  // batch-2 (added Jul 1): survived K100 null + net>0 at conservative 0.15%, on HL, disjoint. All X=0.03 (2% died at 0.15%).
  RENDER: 0.03, POPCAT: 0.03, JUP: 0.03, AR: 0.03, BLUR: 0.03, LTC: 0.03, GOAT: 0.03, EIGEN: 0.03, MANTA: 0.03,
};
export const WF_CONFIG: { mode: WfMode; coins: string[]; capitalUsd: number; leverage: number; holdMins: number; stopPct: number; requoteDrift: number; dailyLossPct: number } = {
  mode: 'live',           // LIVE on mainnet — the guard IDLES this runner until .env HL_USE_TESTNET=false
  coins: Object.keys(COIN_X),
  capitalUsd: 120,        // SIZING basis: per-quote notional = capitalUsd/coins × lev ≈ $13 (18 coins → 120/18×2 = $13.3, clears HL $10 min). Total reserved ≈ capitalUsd (HL nets opposing same-coin orders) → ~$120 of $159.60, ~$40 buffer (operator chose max coverage over buffer; downside bounded: worst all-fill-all-stop ≈ −$8 = daily-kill, far from liquidation)
  leverage: 2,            // fractional-Kelly (backtest Kelly 2-5 ⇒ full = 2-5×; 2× is the conservative smoothness choice)
  holdMins: 60,           // time-stop (backtest exitH=12×5m bars)
  stopPct: 0.03,          // catastrophe stop beyond entry (backtest STOP=3%)
  requoteDrift: 0.01,     // re-quote a resting level only when it drifts >1% off the desired (anti-churn)
  dailyLossPct: 0.05,     // DAILY-LOSS KILL: if account EQUITY drops >5% below start-of-day (incl. UNREALIZED open drawdown) → pull all quotes + no new entries until the day rolls (open positions still exit). The correlated-tail circuit-breaker.
};
const COST_RT = 0.05;     // RT FEES only (maker entry ~0.01% + taker exit ~0.035%): real exit slippage is now captured by booking at the actual close avgPx, and the maker entry fills AT the limit price (no entry slippage)
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
// reconcile-flat: close the log row + drop the pos row ATOMICALLY (a restart between the two would otherwise
// re-run reconcile and close the WRONG active row). exitPx/pnl may be NULL if unrecoverable from userFills.
const reconcileFlatTxn = db.transaction((exitPx: number | null, closedAt: number, pnl: number | null, coin: string) => { updLog.run(exitPx, closedAt, pnl, 'reconciled-flat', coin); delPos.run(coin); });

// PERSISTED start-of-day equity (survives the external restart cadence — an in-memory snapshot re-based to
// post-drawdown equity on every restart, disarming the -5% kill). Stored in the runtime_config kv (no migration).
const SOD_KEY = 'wick_fade_sod';
const getKv = db.prepare<[string], { value: string }>(`SELECT value FROM runtime_config WHERE key = ?`);
const updKv = db.prepare(`UPDATE runtime_config SET value=?, updated_at=?, reason=? WHERE key=?`);
const insKv = db.prepare(`INSERT INTO runtime_config (key,value,updated_at,reason) VALUES (?,?,?,?)`);
function saveSod(day: number, equity: number): void {
  const v = JSON.stringify({ day, equity });
  if (updKv.run(v, Date.now(), 'wick-fade start-of-day equity', SOD_KEY).changes === 0) insKv.run(SOD_KEY, v, Date.now(), 'wick-fade start-of-day equity');
}

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

// DAILY-LOSS KILL via ACCOUNT EQUITY (exact: includes UNREALIZED open-position drawdown AND every exit path).
// Baseline PERSISTS in the DB keyed by UTC day → a restart re-reads the SAME morning snapshot instead of
// re-basing to the (already-drawn-down) current equity, so the -5% kill survives the external restart cadence.
// Fails OPEN (no kill) if equity can't be read, so a transient blip doesn't halt trading.
async function dailyKilled(): Promise<boolean> {
  const av = await hlAccountValue();
  if (!av.ok || !(av.data > 0)) return false;
  const day = Math.floor(Date.now() / 86_400_000);
  let sod: { day: number; equity: number } | null = null;
  const raw = getKv.get(SOD_KEY);
  if (raw) { try { sod = JSON.parse(raw.value) as { day: number; equity: number }; } catch { sod = null; } }
  if (!sod || sod.day !== day) { // new UTC day (or first ever) → snapshot ONCE (first of the day wins, persists across restarts)
    saveSod(day, av.data);
    logger.info({ sodEquity: +av.data.toFixed(2), day }, 'wick-fade: daily-kill equity snapshot (start of day, persisted)');
    return false;
  }
  return (av.data - sod.equity) / sod.equity <= -WF_CONFIG.dailyLossPct;
}

async function stepCoin(coin: string, killed: boolean): Promise<void> {
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
    // EXCHANGE-RESIDENT catastrophe stop: guards the position through process downtime / restart gaps (the
    // poll is only a backup). reduceOnly stop-market at the 3% level; a trigger, so it won't show in openOrders.
    const stpPx = stopAbs(exPos.side, exPos.entryPx);
    const sres = await hlPlaceStop({ coin, posSide: exPos.side, qty: exPos.size, triggerPx: stpPx });
    if (!sres.ok) logger.error({ coin, msg: sres.msg }, '🛑 wick-fade: EXCHANGE STOP place failed — 1-min poll is the ONLY protection this hold');
    logger.warn({ coin, side: exPos.side, entry: exPos.entryPx, stop: +stpPx.toFixed(6), exStop: sres.ok, target: +targetPx(exPos.side, exPos.entryPx, x).toFixed(6) }, '✅ wick-fade: FILLED (deep wick) — managing exit');
    return;
  }
  // ── DB-open but exchange-flat (closed out-of-band — usually the EXCHANGE STOP fired between polls) →
  //    recover the REAL exit from userFills for honest PnL (not NULL), clear any orphan stop, book ATOMICALLY ──
  if (!exPos && dbPos) {
    await hlCancelTriggers(coin); // remove the now-orphan protective stop
    const ex = await hlExitAvgSince(coin, dbPos.opened_at);
    let exitPx: number | null = null, pnl: number | null = null;
    if (ex.ok && ex.data.avgPx && ex.data.avgPx > 0) {
      exitPx = ex.data.avgPx;
      const gross = dbPos.side === 'long' ? (exitPx - dbPos.entry_px) / dbPos.entry_px * 100 : (dbPos.entry_px - exitPx) / dbPos.entry_px * 100;
      pnl = +(gross - COST_RT).toFixed(3);
    }
    reconcileFlatTxn(exitPx, nowMs, pnl, coin);
    logger.warn({ coin, exit: exitPx, pnlPct: pnl }, pnl == null ? 'wick-fade: exchange-flat → reconciled (exit PnL unrecoverable from fills)' : 'wick-fade: exchange-flat → reconciled with RECOVERED exit PnL (exchange stop / OOB close)');
    return;
  }
  // ── IN POSITION → manage exit (target revert / time-stop / catastrophe) ──
  if (exPos && dbPos) {
    // exchange is truth — if the live side DIVERGED from our DB row (a surviving opposite quote filled during
    // downtime and netted/flipped us), do NOT manage/book off the stale row: flatten, reconcile-flat books it next tick.
    if (exPos.side !== dbPos.side) {
      logger.error({ coin, dbSide: dbPos.side, exSide: exPos.side }, '🛑 wick-fade: live side DIVERGED from DB (netting/flip) — flattening to reconcile');
      await hlCancelTriggers(coin); await hlClosePosition(coin);
      return;
    }
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
    await hlCancelTriggers(coin); // position flat → remove the now-redundant exchange stop before booking
    const exitPx = close.data.avgPx ?? mid; // REAL exit fill (honest live PnL); fall back to mid only if unavailable
    const gross = dbPos.side === 'long' ? (exitPx - dbPos.entry_px) / dbPos.entry_px * 100 : (dbPos.entry_px - exitPx) / dbPos.entry_px * 100;
    const pnl = +(gross - COST_RT).toFixed(3);
    closeTxn(exitPx, nowMs, pnl, reason, coin);
    logger.warn({ coin, side: dbPos.side, entry: dbPos.entry_px, exit: exitPx, pnlPct: pnl, reason }, '✅ wick-fade: CLOSED');
    return;
  }

  // ── FLAT → maintain deep post-only quotes on both sides ──
  // Guard: if we could NOT read open orders, do NOT place quotes — we'd risk duplicating an unseen
  // resting order. (Position reconcile/exit above don't need exOrders, so they already ran safely.)
  if (!ooRes.ok) { logger.warn({ coin, msg: ooRes.msg }, 'wick-fade: openOrders read failed — skip quoting this tick'); return; }
  if (killed) { if (exOrders.length) await cancelAll(coin, exOrders); return; } // DAILY-LOSS KILL: pull quotes, no new entries (open positions still exit via the branches above)
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
  // SAFETY: mode must match the endpoint (config.HL_USE_TESTNET) so a stale .env can't cross-route money.
  // mode='live' is ENABLED but requires HL_USE_TESTNET=false (real account); testnet requires =true.
  if (WF_CONFIG.mode === 'testnet' && !config.HL_USE_TESTNET) { logger.error('🛑 wick-fade: mode=testnet but HL_USE_TESTNET=false — REFUSING to route to mainnet; runner idle'); return; }
  if (WF_CONFIG.mode === 'live' && config.HL_USE_TESTNET) { logger.error('🛑 wick-fade: mode=live but HL_USE_TESTNET=true — REFUSING (would trade testnet as if live); runner idle'); return; }
  void HR;
  cron.schedule('* * * * *', () => { // every 1 min — wicks are fast
    if (running) return;
    running = true;
    void (async () => {
      const killed = await dailyKilled();
      if (killed) logger.warn('⏸ wick-fade: DAILY-LOSS KILL active (equity −5% intraday) — pulling quotes, no new entries until the day rolls');
      for (const coin of WF_CONFIG.coins) {
        try { await stepCoin(coin, killed); } catch (err) { logger.error({ err, coin }, 'wick-fade: step failed'); }
      }
    })().finally(() => { running = false; });
  });
  logger.warn({ mode: WF_CONFIG.mode, endpoint: config.HL_USE_TESTNET ? 'testnet' : 'MAINNET', vault: config.HL_VAULT_ADDRESS ? 'yes' : 'no', coins: WF_CONFIG.coins.length, lev: WF_CONFIG.leverage, capital: WF_CONFIG.capitalUsd, dailyKill: `${WF_CONFIG.dailyLossPct * 100}%` }, '✅ wick-fade runner scheduled (every 1m, post-only deep limits, exchange-reconciled, daily-loss kill)');
  if (!hlConfigured()) logger.error('wick-fade: HL_API_WALLET_KEY missing — runner idles until configured');
}
