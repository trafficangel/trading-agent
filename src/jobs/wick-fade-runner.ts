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
import { hlConfigured, hlSetLeverage, hlLimitOrder, hlCancelOrder, hlOpenOrders, hlFetchPosition, hlClosePosition, hlMid, hlAccountValue, hlPlaceStop, hlCancelTriggers, hlExitAvgSince, hlPositionStartTime, type HlOpenOrder } from '../exchange/hyperliquid-private.js';
import { sendMessage } from '../telegram/bot.js';

/** Operator notification (Telegram logs channel) — fire-and-forget: sendMessage never throws, and `void`
 *  keeps the trading path from ever blocking/failing on Telegram. Only live-mode events notify. */
function notify(text: string, silent = false): void {
  if (WF_CONFIG.mode !== 'live') return;
  void sendMessage({ channel: 'logs', text, disable_notification: silent });
}

type WfMode = 'off' | 'testnet' | 'live';
// per-coin depth X (validated sweet spot): 2% for TON, 3% for the rest — MAX coverage of the full validated
// set. NB: coins MUST be DISJOINT from funding-flip's {ETH,ADA,XRP,AVAX} — one strategy per symbol on a
// shared account (CLAUDE.md One-Way rule). All on HL mainnet; on testnet TON is halted + CRV/ENA absent → no-op.
const COIN_X: Record<string, number> = {
  // Depth per coin = the TIGHTEST level that still passed the full battery (K100 null + net>0 at a
  // CONSERVATIVE 0.15% cost + persist≥2). Tighter = ~1.5-2× more fills (operator wants frequency);
  // 2.5% validated Jul 2 for 8 coins (POPCAT/DOGE/NEAR/TIA/ENA Kelly 1.7-4 + ICP/BLUR/JUP); the rest
  // FAILED 2.5% (kPEPE/ATOM/LTC/EIGEN/MANTA/CRV/AR/GOAT/RENDER) and stay at 3%. TON grandfathered 2%.
  DOGE: 0.025, ICP: 0.025, NEAR: 0.025, ATOM: 0.03, TON: 0.02, CRV: 0.03, ENA: 0.025, TIA: 0.025, kPEPE: 0.03,
  RENDER: 0.03, POPCAT: 0.025, JUP: 0.025, AR: 0.03, BLUR: 0.025, LTC: 0.03, GOAT: 0.03, EIGEN: 0.03, MANTA: 0.03,
  // batch-3 (Jul 2, operator topped up → ~$250): XRP-2% = the strongest unadded name (K100 STRONG, Kelly 3.14;
  // free on the LIVE account — funding-flip holds XRP only on testnet and idles on mainnet; re-resolve if it
  // ever goes live here). Tier-B at 3% (pass the kill-lens at REAL cost + K100 null; fail only the extra
  // 0.15%-margin bar): JTO/SNX/APE/ZRO/W Kelly 0.8-1.0, ALT/PNUT 0.4-0.5 (operator's hook-bar: take any
  // genuine positive-expectancy hook at viable sizing).
  XRP: 0.02, JTO: 0.03, SNX: 0.03, APE: 0.03, ZRO: 0.03, W: 0.03, ALT: 0.03, PNUT: 0.03,
};
// Side-split (Jul 2, scripts/wick-fade-sides.ts, K100): these sides are consistently NEGATIVE at BOTH real
// costs (0.05/0.10) with n≥100 and worse-than-random nullP → don't quote them (ballast: pays costs on noise).
// Weak-but-POSITIVE sides stay (pre-registered bar — dropping a weak positive side loses money). The quoting
// loop also CANCELS any resting order on a disabled side, so this self-heals on deploy.
const DISABLED_SIDE: Record<string, 'long' | 'short'> = { ATOM: 'short', LTC: 'short', ALT: 'long' };
export const WF_CONFIG: { mode: WfMode; coins: string[]; capitalUsd: number; leverage: number; holdMins: number; stopPct: number; requoteDrift: number; dailyLossPct: number } = {
  mode: 'live',           // LIVE on mainnet — the guard IDLES this runner until .env HL_USE_TESTNET=false
  coins: Object.keys(COIN_X),
  capitalUsd: 173,        // SIZING basis: per-quote notional = capitalUsd/coins × lev ≈ $13.3 (26 coins → 173/26×2, clears HL $10 min). Total reserved ≈ capitalUsd (HL nets opposing same-coin orders) → ~$173 of ~$250 (operator topped up +$90 for batch-3), buffer ~$77 (~31%). DO NOT deploy this sizing before the top-up lands — reserve would exceed equity
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
function saveSod(state: { day: number; equity: number; killedDay?: number }): void {
  const v = JSON.stringify(state);
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
// The loss-kill is LATCHED for the rest of the UTC day (persisted killedDay): equity bouncing back above −5%
// does NOT re-arm the book mid-day — a flip-flop around the threshold would re-quote 26 coins straight into the
// correlated tail the kill exists to escape. FAIL-CLOSED on sustained blindness measured by WALL-CLOCK (not
// ticks — a hanging API stretches a tick to minutes): unreadable OR degraded (spot leg failed → under-read on a
// unified account) equity for ≥5 min → pull quotes rather than quote blind; outages and flushes correlate. A
// short blip keeps the previous state (no flapping). NB a mid-day DEPOSIT inflates equity vs the baseline and
// can mask a real loss — on any deposit, delete the wick_fade_sod kv row (ops procedure; see memory).
const BLIND_AFTER_MS = 5 * 60_000;
let blindSince: number | null = null;
let killed = false;
let killReason: 'loss' | 'blind' | null = null;
type SodState = { day: number; equity: number; killedDay?: number };
function loadSod(): SodState | null {
  const raw = getKv.get(SOD_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw.value) as SodState; } catch { return null; }
}
async function dailyKilled(): Promise<boolean> {
  const nowMs = Date.now();
  const av = await hlAccountValue();
  // bad read = error, non-positive (hlAccountValue is known to mis-read 0 — treat as blind, NOT as a wipe:
  // a false wipe would latch a day-long kill on a glitch), or degraded (spot leg failed → understated).
  if (!av.ok || !(av.data > 0) || av.degraded) {
    blindSince ??= nowMs;
    const blindMs = nowMs - blindSince;
    if (blindMs >= BLIND_AFTER_MS && killReason == null) {
      logger.error({ blindMins: Math.round(blindMs / 60_000) }, '🛑 wick-fade: equity unreadable/degraded ≥5 min (wall-clock) — FAIL-CLOSED until reads recover');
      notify('⚠️ <b>wick-fade</b>: биржа ≥5 мин не отдаёт эквити — fail-closed: сниму котировки, как только API ответит; новых входов нет. Открытые позиции ведём к выходу как обычно.');
    }
    if (blindMs >= BLIND_AFTER_MS) { killed = true; if (killReason !== 'loss') killReason = 'blind'; }
    return killed; // below the threshold: keep the previous state — a transient blip must not flap the book
  }
  blindSince = null;
  if (killReason === 'blind') { killed = false; killReason = null; notify('▶️ <b>wick-fade</b>: связь с биржей восстановлена — проверяю дневной лимит'); }
  const day = Math.floor(nowMs / 86_400_000);
  let sod = loadSod();
  if (!sod || sod.day !== day) { // new UTC day (or first ever) → snapshot ONCE (first of the day wins, persists across restarts)
    sod = { day, equity: av.data };
    saveSod(sod);
    logger.info({ sodEquity: +av.data.toFixed(2), day }, 'wick-fade: daily-kill equity snapshot (start of day, persisted)');
    if (killReason === 'loss') notify('▶️ <b>wick-fade</b>: новый день — daily-kill снят, котировки возвращаются');
    killed = false; killReason = null;
    return false;
  }
  if (sod.killedDay === day) { killed = true; killReason = 'loss'; return true; } // latched (incl. across restarts — silently, no re-notify)
  if ((av.data - sod.equity) / sod.equity <= -WF_CONFIG.dailyLossPct) {
    saveSod({ ...sod, killedDay: day }); // LATCH for the rest of the UTC day, restart-proof
    notify('⛔ <b>wick-fade DAILY-KILL</b>: эквити −5% за день — котировки сняты, новых входов нет до следующего дня (открытые позиции доведём до выхода)');
    killed = true; killReason = 'loss';
    return true;
  }
  killed = false; killReason = null;
  return false;
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
    // opened_at = the REAL fill time from userFills (not the adopt tick) — otherwise every restart resets the
    // 60-min time-stop clock and a position rides open-ended across a restart-churny day (EOD-audit #3).
    const st = await hlPositionStartTime(coin);
    const openedAt = st.ok && st.data.timeMs != null && st.data.timeMs <= nowMs ? st.data.timeMs : nowMs;
    insPos.run(coin, exPos.side, exPos.entryPx, exPos.size, x, openedAt, 'fill');
    insLog.run(coin, exPos.side, exPos.entryPx, exPos.size, x, openedAt, 'fill', WF_CONFIG.mode);
    // EXCHANGE-RESIDENT catastrophe stop: guards the position through process downtime / restart gaps (the
    // poll is only a backup). reduceOnly stop-market at the 3% level; a trigger, so it won't show in openOrders.
    const stpPx = stopAbs(exPos.side, exPos.entryPx);
    const sres = await hlPlaceStop({ coin, posSide: exPos.side, qty: exPos.size, triggerPx: stpPx });
    if (!sres.ok) logger.error({ coin, msg: sres.msg }, '🛑 wick-fade: EXCHANGE STOP place failed — 1-min poll is the ONLY protection this hold');
    logger.warn({ coin, side: exPos.side, entry: exPos.entryPx, stop: +stpPx.toFixed(6), exStop: sres.ok, openedAt, target: +targetPx(exPos.side, exPos.entryPx, x).toFixed(6) }, '✅ wick-fade: FILLED (deep wick) — managing exit');
    notify(`🪝 <b>wick-fade FILLED</b>: ${coin} ${exPos.side} @${exPos.entryPx}\nцель ${targetPx(exPos.side, exPos.entryPx, x).toFixed(6)} · стоп ${stpPx.toFixed(6)} ${sres.ok ? '(на бирже ✅)' : '(⚠️ только полл!)'} · $${(exPos.size * exPos.entryPx).toFixed(0)}`);
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
    notify(pnl == null
      ? `♻️ <b>wick-fade CLOSED</b> (вне бота): ${coin} ${dbPos.side} — PnL не восстановлен`
      : `${pnl >= 0 ? '🟢' : '🔴'} <b>wick-fade CLOSED</b> (биржевой стоп/вне бота): ${coin} ${dbPos.side} <b>${pnl > 0 ? '+' : ''}${pnl}%</b>\n${dbPos.entry_px} → ${exitPx?.toFixed(6)}`);
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
    const rlabel = reason === 'target' ? 'цель 🎯' : reason === 'time-stop' ? 'тайм-стоп ⏱' : 'катастроф-стоп 🛑';
    notify(`${pnl >= 0 ? '🟢' : '🔴'} <b>wick-fade CLOSED</b>: ${coin} ${dbPos.side} <b>${pnl > 0 ? '+' : ''}${pnl}%</b> (${rlabel})\n${dbPos.entry_px} → ${exitPx.toFixed(6)} · держали ${Math.round((nowMs - dbPos.opened_at) / 60_000)}м`);
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
    const existing = exOrders.filter((o) => o.side === side);
    if (DISABLED_SIDE[coin] === side) { if (existing.length) await cancelAll(coin, existing); continue; }
    const desired = side === 'long' ? mid * (1 - x) : mid * (1 + x);
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
      let isKilled = killed; // on an unexpected throw keep the previous state (same no-flap philosophy)
      try { isKilled = await dailyKilled(); } catch (err) { logger.error({ err }, 'wick-fade: dailyKilled threw — keeping previous kill state'); }
      if (isKilled) logger.warn(`⏸ wick-fade: KILL active (${killReason}) — quotes pulled, no new entries (open positions still exit)`);
      for (const coin of WF_CONFIG.coins) {
        try { await stepCoin(coin, isKilled); } catch (err) { logger.error({ err, coin }, 'wick-fade: step failed'); }
      }
    })().finally(() => { running = false; });
  });
  logger.warn({ mode: WF_CONFIG.mode, endpoint: config.HL_USE_TESTNET ? 'testnet' : 'MAINNET', vault: config.HL_VAULT_ADDRESS ? 'yes' : 'no', coins: WF_CONFIG.coins.length, lev: WF_CONFIG.leverage, capital: WF_CONFIG.capitalUsd, dailyKill: `${WF_CONFIG.dailyLossPct * 100}%` }, '✅ wick-fade runner scheduled (every 1m, post-only deep limits, exchange-reconciled, daily-loss kill)');
  if (!hlConfigured()) logger.error('wick-fade: HL_API_WALLET_KEY missing — runner idles until configured');
}
