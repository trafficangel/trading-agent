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
import { hlConfigured, hlSetLeverage, hlLimitOrder, hlCancelOrder, hlOpenOrders, hlFetchPosition, hlClosePosition, hlMid, hlAccountValue, hlPlaceStop, hlCancelTriggers, hlExitAvgSince, hlPositionStartTime, hlBatchPlace, hlBatchCancel, hlNetTransfersSince, type HlOpenOrder, type BatchPlaceSpec } from '../exchange/hyperliquid-private.js';
import { l2Book } from '../exchange/hyperliquid.js';
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
export const COIN_X: Record<string, number> = {
  // Depth per coin = the TIGHTEST level that still passed the full battery (K100 null + net>0 at a
  // CONSERVATIVE 0.15% cost + persist≥2). Tighter = ~1.5-2× more fills (operator wants frequency);
  // 2.5% validated Jul 2 for 8 coins (POPCAT/DOGE/NEAR/TIA/ENA Kelly 1.7-4 + ICP/BLUR/JUP); the rest
  // FAILED 2.5% (kPEPE/ATOM/LTC/EIGEN/MANTA/CRV/AR/GOAT/RENDER) and stay at 3%. TON grandfathered 2%.
  // BATTERY-AUDIT Jul 2 (scripts/battery-honest.ts — corrected null + one-position lock + same-bar stop-through
  // + stop slippage): CUT the coins robustly NEGATIVE at real cost in BOTH slippage scenarios — GOAT, SNX, APE,
  // ZRO, W (the tier-B margin-of-safety concern materialized). ICP: 2.5% was a mis-tighten (honest-negative);
  // its DEEP levels are strong (@3.5 honest +49.5, Kelly 1.08) → base depth moved to 3.5%. Weak-but-positive
  // stay (JTO/ALT/PNUT/kPEPE/EIGEN/AR/XRP — tiny sizes; the live run measures the real slippage that decides them).
  DOGE: 0.025, ICP: 0.035, NEAR: 0.025, ATOM: 0.03, TON: 0.02, CRV: 0.03, ENA: 0.025, TIA: 0.025, kPEPE: 0.03,
  RENDER: 0.03, POPCAT: 0.025, JUP: 0.025, AR: 0.03, LTC: 0.03, EIGEN: 0.03, MANTA: 0.03, // BLUR CUT Jul 6:
  // real stop slippage ~2% (8× the 0.25% model) on its low liquidity — a genuine drain the backtest understates.

  // JTO CUT Jul 8 live audit: both sides went negative on real fills (long -3.14%, short -2.40%)
  // and the large loss was not an isolated wick but a continuation through the trap.
  XRP: 0.02, ALT: 0.03, PNUT: 0.03,
};
const RETIRED_COINS = ['BLUR', 'JTO'];
// Side-split (Jul 2, scripts/wick-fade-sides.ts, K100): these sides are consistently NEGATIVE at BOTH real
// costs (0.05/0.10) with n≥100 and worse-than-random nullP → don't quote them (ballast: pays costs on noise).
// Weak-but-POSITIVE sides stay (pre-registered bar — dropping a weak positive side loses money). The quoting
// loop also CANCELS any resting order on a disabled side, so this self-heals on deploy.
export const DISABLED_SIDE: Record<string, 'long' | 'short'> = { ATOM: 'short', LTC: 'short', ALT: 'long', EIGEN: 'short', MANTA: 'long' };
// LADDER — a second, DEEPER rung where the rung passed the HONEST battery (battery-honest.ts): ATOM@3.5
// (strict pass both slippage scenarios, Kelly 6.3-7.5) + DOGE@3.5 (net-positive both scenarios, p marginal).
// ICP@3.5 became the BASE depth instead (its 2.5 was honest-negative). Both rungs rest while flat; a deep
// flush can fill both within a tick (adopt reads the merged avg entry). Applies to ENABLED sides only. Each
// rung reserves its own ~$6.65 margin. On adopt the FILLED rung's depth is inferred so the stored x — and
// thus target = the rung's own anchor mid — stays faithful to what was validated (see inferFilledX).
export const LADDER: Record<string, number> = { DOGE: 0.035, ATOM: 0.035 };

/** Which rung filled? Same-side rungs share the quote anchor, so entry÷survivor-price classifies the fill:
 *  for a long, ratio<1 = the fill sat DEEPER than the surviving rung. Partial fills leave the filled order
 *  resting (matched by px). Fallbacks (both rungs filled → no survivor; ambiguous ratio): the rungs' average
 *  depth — a merged avg entry sits between the rungs, so the middle is the honest estimate. */
function inferFilledX(coin: string, side: 'long' | 'short', entryPx: number, preCancelOrders: HlOpenOrder[]): number {
  // Scale both rungs by the SAME live vol factor as placement — so the stored x matches the depth we actually
  // quoted at, and target = entry/(1∓x) lands on the true pre-wick mid. The ratio logic below is unaffected
  // (both rungs scale together). Factor ≈ placement's (vol drifts slowly over the ≤30m to fill); residual tiny.
  const f = depthFactor(coin);
  const base = clampDepth(COIN_X[coin]! * f);
  const deep = LADDER[coin] != null ? clampDepth(LADDER[coin]! * f) : null;
  if (deep == null) return base;
  const surv = preCancelOrders.filter((o) => o.side === side);
  const partial = surv.find((o) => Math.abs(o.px - entryPx) / entryPx < 0.001); // partially-filled rung still rests at the fill px
  if (partial && surv.length === 2) {
    const pxs = surv.map((o) => o.px).sort((a, b) => a - b);
    return (side === 'long' ? partial.px === pxs[0] : partial.px === pxs[1]) ? deep : base;
  }
  if (surv.length === 1) {
    const r = entryPx / surv[0]!.px;
    if (Math.abs(r - 1) < 0.003) return (base + deep) / 2; // too close to classify (mixed partials) → middle
    return (side === 'long' ? r < 1 : r > 1) ? deep : base;
  }
  return (base + deep) / 2; // no same-side survivor: both rungs filled → merged entry between the rungs
}
export const WF_CONFIG: { mode: WfMode; coins: string[]; capitalUsd: number; leverage: number; holdMins: number; stopPct: number; postStopCooldownMins: number; requoteDrift: number; dailyLossPct: number; dynamicDepth: boolean; volWindow: number } = {
  mode: 'live',           // RESUMED Jul 5 (operator: 'перезапускай все'). Account is UNIFIED (spot USDC is
                          // tradeable collateral — no spot→perp transfer needed; hlAccountValue sums perp+spot).
                          // Runs on 2% requoteDrift + 30-min cadence (budget-sustainable). If the ~14k action
                          // deficit is still open, the breaker idles quoting until volume clears it.
  coins: Object.keys(COIN_X),
  capitalUsd: 120,        // SIZING: per-RUNG margin = capitalUsd/coins = 120/20 = $6 -> notional $12 @2x (clears HL $11 min).
                          // Reserve per rung = capitalUsd/coins regardless of leverage. HL reserves GROSS for every
                          // resting rung (both sides + ladders), not netted by opposite quotes. With 38 active rungs
                          // this targets about $228 reserved on the current ~$284 account, restoring a modest buffer
                          // while keeping every rung above MIN_NOTIONAL. Existing larger quotes are resized by the
                          // size-aware good-check below on the next quote tick.
  leverage: 2,            // fractional-Kelly (backtest Kelly 2-5 ⇒ full = 2-5×; 2× is the conservative smoothness choice)
  holdMins: 30,           // time-stop. Was 60 (fixed by construction, never swept); the Jul 3 hold-sweep on the
                          // honest battery found a 25-40m PLATEAU dominating 60m in ALL 3×180d windows (total net
                          // +1127 vs +931, Kelly 1.83 vs 1.20, catastrophes 12% vs 18%) — reversion happens fast or
                          // not at all; extra hold time mostly lets losers reach the stop and freezes the coin. 30m
                          // = plateau CENTER (not the edge max — anti-overfit). scripts/wick-fade-holdsweep.ts
  stopPct: 0.04,          // catastrophe stop beyond entry. Was 3% (fixed by construction); the Jul 3 param sweep
                          // (honest battery): 4% dominates 3% in ALL 3×180d windows (+1357 vs +1119, cat% 12→7,
                          // Kelly 2.08) — a 3%-deep flush that runs another 3% usually keeps running, but many
                          // 3.0-3.9% excursions still revert; 5% fails one window (grid edge). Combined with the
                          // post-stop cooldown below: +1644 total, Kelly 2.79. scripts/wick-fade-paramsweep.ts
  postStopCooldownMins: 30, // after a CATASTROPHE exit, do NOT re-quote the coin for this long — the flush that
                          // blew through the stop is often still running; re-filling into it was a repeat loser
                          // (the cooldown's edge is concentrated in cascade regimes = cheap insurance; sweep D)
  requoteDrift: 0.02,     // re-quote a resting level only when it drifts >2% off the desired. Was 1% — but
                          // scripts/hl-budget-economics.ts (Jul 5, real 45d data) showed 1% drift re-anchors
                          // ~186 coin-events/day pooled → ~700-1500 HL actions/day, dwarfing the ~75/day the
                          // book EARNS from real fills (~2.8/day × $27 volume). 1% is the setting that drained
                          // the action budget in ~2 weeks. 2% cuts re-anchors ~5× (→ ~37 events/day) — the
                          // biggest free lever. TRADEOFF: a resting rung can now sit up to 2% staler before we
                          // fix it, so on an adverse 2% mid-drift the effective depth erodes (worst case X−2%);
                          // the 30-min re-check bounds how long that lasts. Tighter coins (X=2%: TON/XRP) are
                          // most exposed — refine per-coin if live fills show shallow/noise entries. True fix
                          // for the budget squeeze is capital (~$2k+): earned volume scales, cost stays flat.
  dailyLossPct: 0.05,     // DAILY-LOSS KILL / СТОПКРАН: if account EQUITY drops >5% below start-of-day (incl. UNREALIZED open drawdown) → pull all quotes, FORCE-CLOSE all open positions, no new entries until the day rolls. A HARD −5% daily floor (Jul 6, operator: 'каскадные минусы не нужны') — validated to cap worst day −13%→−5%, maxDD 33%→25% at ~flat NET (scripts/wick-fade-breaker.ts). The correlated-cascade circuit-breaker.
  dynamicDepth: true,     // VOL-SCALED entry depth (Jul 6, operator idea, validated scripts/wick-fade-voldepth.ts):
                          // the entry depth = COIN_X × (currentVol / trailing-EWMA-vol) instead of a fixed %, so we
                          // fade GENUINE over-extensions (N sigmas) not a fixed move (noise in a wild coin, a rare
                          // event in a calm one). CAUSAL A/B on 3×180d flipped the pooled book −341→+414 net at real
                          // cost, all 3 windows positive, perm-null p=0.00, Kelly 2.2 — while the efficient-major
                          // CONTROLS (BTC/ETH/SOL/LINK) stayed dead (p=0.16, not a KEEP) ⇒ real structure, not a
                          // vol-fitting artifact. Live vol from the native HL 5m archive (hl_candles). Set false to revert.
  volWindow: 48,          // rolling-vol window in 5m bars (4h). Depth factor bounded [0.4,2.0], final depth clamped [0.8%,6%].
};
const COST_RT = 0.05;     // RT FEES only (maker entry ~0.01% + taker exit ~0.035%): real exit slippage is now captured by booking at the actual close avgPx, and the maker entry fills AT the limit price (no entry slippage)
const MIN_NOTIONAL = 11;  // HL min order ≈ $10
const SIZE_REQUOTE_DRIFT = 0.05; // replace resting quotes when size drifts >5% (e.g. capitalUsd changes)
const HR = 3_600_000;

// ── VOL-SCALED DEPTH (WF_CONFIG.dynamicDepth): live volatility read from the native HL 5m archive (hl_candles,
//    jobs/hl-candle-collector.ts). Entry depth = COIN_X × depthFactor, where depthFactor = currentVol /
//    trailing-EWMA(vol) — CAUSAL (only past bars), matching scripts/wick-fade-voldepth.ts. ──
const VOL_LOOKBACK = 550;                    // bars pulled to build a stable causal EWMA of the rolling-vol series
const DEPTH_MIN = 0.008, DEPTH_MAX = 0.06;   // hard safety clamp on the final entry depth
const FACTOR_MIN = 0.4, FACTOR_MAX = 2.0;    // bound the vol multiplier (keeps the two ladder rungs proportional)
const recentClosesStmt = db.prepare<[string, number], { c: number }>(`SELECT c FROM hl_candles WHERE coin = ? ORDER BY t DESC LIMIT ?`);
const clampDepth = (d: number): number => Math.min(DEPTH_MAX, Math.max(DEPTH_MIN, d));
/** Depth multiplier = currentVol / trailing-EWMA(vol) from hl_candles (rolling std of log-returns over volWindow,
 *  EWMA α=0.01). Returns 1 (⇒ fixed COIN_X) when dynamicDepth is off or the archive lacks enough history — a safe
 *  fall-back that never throws, so a missing/short archive degrades gracefully to the proven fixed book. */
function depthFactor(coin: string): number {
  if (!WF_CONFIG.dynamicDepth) return 1;
  let closes: number[];
  try { closes = recentClosesStmt.all(coin, VOL_LOOKBACK).map((r) => r.c).reverse(); } catch { return 1; }
  const W = WF_CONFIG.volWindow;
  if (closes.length < W + 80) return 1; // insufficient archive → fixed depth
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i]! > 0 && closes[i - 1]! > 0 ? Math.log(closes[i]! / closes[i - 1]!) : 0);
  const volAt = (end: number): number => { let m = 0; for (let j = end - W; j < end; j++) m += rets[j]!; m /= W; let v = 0; for (let j = end - W; j < end; j++) { const d = rets[j]! - m; v += d * d; } return Math.sqrt(v / (W - 1)); };
  let e = 0, seeded = false;
  for (let end = W; end <= rets.length; end++) { const v = volAt(end); if (!(v > 0)) continue; if (!seeded) { e = v; seeded = true; } else e = e + 0.01 * (v - e); }
  const cur = volAt(rets.length);
  if (!(cur > 0) || !(e > 0)) return 1;
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, cur / e));
}

type PosRow = { coin: string; side: 'long' | 'short'; entry_px: number; qty: number; x: number; opened_at: number; reason: string };
const getPos = db.prepare<[string], PosRow>(`SELECT * FROM wick_fade_pos WHERE coin = ?`);
const allOpenPosCoins = db.prepare<[], { coin: string }>(`SELECT DISTINCT coin FROM wick_fade_pos`); // to wind down positions on CUT coins
const insPos = db.prepare(`INSERT OR REPLACE INTO wick_fade_pos (coin,side,entry_px,qty,x,opened_at,reason) VALUES (?,?,?,?,?,?,?)`);
const delPos = db.prepare(`DELETE FROM wick_fade_pos WHERE coin = ?`);
// last CATASTROPHE-like close per coin — drives the post-stop cooldown. Matches: explicit catastrophe;
// reconciled-flat with deep loss (exchange stop fired between polls, exit recovered); reconciled-flat with
// NULL pnl (exchange stop fired, exit UNrecoverable — SQLite NULL<=-2 is NULL, so it needs its own arm: the
// review caught that the naive predicate silently skipped the cooldown's headline scenario). Ordinary deep
// TIME-STOP losers do NOT cool down — the sweep validated post-catastrophe cooldowns only.
const lastCatStmt = db.prepare<[string, string], { t: number | null }>(`SELECT MAX(closed_at) AS t FROM wick_fade_log WHERE coin = ? AND mode = ? AND (close_reason = 'catastrophe' OR (close_reason = 'reconciled-flat' AND (pnl_pct <= -2 OR pnl_pct IS NULL)))`);

// LIVE-QUARANTINE: real fills are the final judge. If a coin or side starts losing in live
// execution, stop placing NEW traps. Open positions still wind down through the normal exit path.
const LIVE_QUARANTINE_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const SIDE_QUARANTINE_MIN_TRADES = 3;
const SIDE_QUARANTINE_SUM_PNL_PCT = -2;
const COIN_QUARANTINE_MAX_CATS = 2;
const QUARANTINE_LOG_COOLDOWN_MS = 6 * 60 * 60_000;
const sidePerfStmt = db.prepare<[string, string, string, number], { n: number; sum_pnl: number | null }>(`SELECT COUNT(*) AS n, SUM(pnl_pct) AS sum_pnl FROM wick_fade_log WHERE coin = ? AND side = ? AND mode = ? AND closed_at IS NOT NULL AND closed_at >= ?`);
const coinCatStmt = db.prepare<[string, string, number], { n: number }>(`SELECT COUNT(*) AS n FROM wick_fade_log WHERE coin = ? AND mode = ? AND closed_at IS NOT NULL AND closed_at >= ? AND (close_reason = 'catastrophe' OR (close_reason = 'reconciled-flat' AND (pnl_pct <= -2 OR pnl_pct IS NULL)))`);
const doctorPauseStmt = db.prepare<[string, string, number], { paused_until: number; reason: string }>(`SELECT paused_until, reason FROM wick_fade_doctor_pause WHERE coin = ? AND side = ? AND paused_until > ?`);
const momentumLockStmt = db.prepare<[string, number], { locked_until: number; reason: string }>(`SELECT locked_until, reason FROM hl_momentum_live_lock WHERE coin = ? AND locked_until > ?`);
const quarantineLogAt = new Map<string, number>();
function liveQuarantineReason(coin: string, side: 'long' | 'short', nowMs: number): string | null {
  const doctorPause = doctorPauseStmt.get(coin, side, nowMs);
  if (doctorPause) return `doctor pause until ${new Date(doctorPause.paused_until).toISOString()} — ${doctorPause.reason}`;
  const since = nowMs - LIVE_QUARANTINE_LOOKBACK_MS;
  const cats = coinCatStmt.get(coin, WF_CONFIG.mode, since)?.n ?? 0;
  if (cats >= COIN_QUARANTINE_MAX_CATS) return `coin ${cats} catastrophe-like exits in 7d`;
  const perf = sidePerfStmt.get(coin, side, WF_CONFIG.mode, since);
  const n = perf?.n ?? 0;
  const sum = perf?.sum_pnl ?? 0;
  if (n >= SIDE_QUARANTINE_MIN_TRADES && sum <= SIDE_QUARANTINE_SUM_PNL_PCT) return `${side} ${n} trades / ${sum.toFixed(3)}% in 7d`;
  return null;
}
function logLiveQuarantine(coin: string, side: 'long' | 'short', reason: string, nowMs: number): void {
  const key = `${coin}:${side}:${reason}`;
  const last = quarantineLogAt.get(key) ?? 0;
  if (nowMs - last < QUARANTINE_LOG_COOLDOWN_MS) return;
  quarantineLogAt.set(key, nowMs);
  logger.warn({ coin, side, reason }, 'wick-fade: LIVE-QUARANTINE active - cancel side quotes, no new entries');
  notify(`Wick-fade quarantine: ${coin} ${side} - ${reason}. New traps paused; open positions still exit normally.`, true);
}
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
const closedDayPnlStmt = db.prepare<[string, number], { pnl: number | null }>(`
  SELECT SUM(pnl_pct) AS pnl
    FROM wick_fade_log
   WHERE mode = ?
     AND closed_at IS NOT NULL
     AND pnl_pct IS NOT NULL
     AND closed_at >= ?
`);
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
// does NOT re-arm the book mid-day — a flip-flop around the threshold would re-quote the whole book straight into the
// correlated tail the kill exists to escape. FAIL-CLOSED on sustained blindness measured by WALL-CLOCK (not
// ticks — a hanging API stretches a tick to minutes): unreadable OR degraded (spot leg failed → under-read on a
// unified account) equity for ≥5 min → pull quotes rather than quote blind; outages and flushes correlate. A
// short blip keeps the previous state (no flapping). NB a mid-day DEPOSIT inflates equity vs the baseline and
// can mask a real loss — on any deposit, delete the wick_fade_sod kv row (ops procedure; see memory).
const BLIND_AFTER_MS = 5 * 60_000;
let blindSince: number | null = null;
let killed = false;
let killReason: 'loss' | 'blind' | null = null;
type SodState = { day: number; equity: number; ts?: number; killedDay?: number };
function loadSod(): SodState | null {
  const raw = getKv.get(SOD_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw.value) as SodState; } catch { return null; }
}
function closedDayPnlPct(day: number): number {
  return closedDayPnlStmt.get(WF_CONFIG.mode, day * 86_400_000)?.pnl ?? 0;
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
    sod = { day, equity: av.data, ts: nowMs };
    saveSod(sod);
    logger.info({ sodEquity: +av.data.toFixed(2), day }, 'wick-fade: daily-kill equity snapshot (start of day, persisted)');
    if (killReason === 'loss') notify('▶️ <b>wick-fade</b>: новый день — daily-kill снят, котировки возвращаются');
    killed = false; killReason = null;
    const closedPnl = closedDayPnlPct(day);
    if (closedPnl <= -(WF_CONFIG.dailyLossPct * 100)) {
      saveSod({ ...sod, killedDay: day });
      notify(`⛔ <b>wick-fade DAILY-KILL</b>: закрытый PnL за UTC-день ${closedPnl.toFixed(2)}% — котировки сняты, новых входов нет до следующего дня`);
      killed = true; killReason = 'loss';
      return true;
    }
    return false;
  }
  if (sod.killedDay === day) { killed = true; killReason = 'loss'; return true; } // latched (incl. across restarts — silently, no re-notify)
  const closedPnl = closedDayPnlPct(day);
  if (closedPnl <= -(WF_CONFIG.dailyLossPct * 100)) {
    saveSod({ ...sod, killedDay: day });
    notify(`⛔ <b>wick-fade DAILY-KILL</b>: закрытый PnL за UTC-день ${closedPnl.toFixed(2)}% — котировки сняты, новых входов нет до следующего дня`);
    killed = true; killReason = 'loss';
    return true;
  }
  // TRANSFER-AWARE baseline: deposits/withdrawals since the snapshot shift the reference, so a mid-day
  // withdrawal doesn't read as a crash (false kill) and a deposit doesn't mask a real drawdown. Fail-open
  // to the raw baseline if the ledger read fails (previous behavior; a withdrawal would then false-kill —
  // safe direction — and the manual kv reset still works as the fallback).
  let baseline = sod.equity;
  const flows = await hlNetTransfersSince(sod.ts ?? day * 86_400_000);
  if (flows.ok && flows.data !== 0) baseline = sod.equity + flows.data;
  if (baseline <= 0) return false;
  if ((av.data - baseline) / baseline <= -WF_CONFIG.dailyLossPct) {
    saveSod({ ...sod, killedDay: day }); // LATCH for the rest of the UTC day, restart-proof
    notify('⛔ <b>wick-fade DAILY-KILL</b>: эквити −5% за день — котировки сняты, новых входов нет до следующего дня (открытые позиции доведём до выхода)');
    killed = true; killReason = 'loss';
    return true;
  }
  killed = false; killReason = null;
  return false;
}

// Quote intentions collected per coin and executed as TWO batched actions per quote-tick (cancel-batch +
// place-batch) — the HL action-budget economy (1 action per batch regardless of order count).
type QuoteActions = { cancels: { coin: string; oid: number }[]; places: BatchPlaceSpec[] };
// HL can HALT trading per asset (TON has been halted for days) — a halted order errors and, worse, can fail
// a whole batch. Back off quoting a halted coin for an hour per detection instead of burning an action every
// quote-tick; it self-resumes when HL lifts the halt.
const haltedUntil = new Map<string, number>();

// LIQUIDITY GATE: the edge dies when live execution is thin. If the current book is too wide or shallow,
// pull resting traps for that coin until the next quote tick. This avoids BLUR-style stop slippage regimes.
const MAX_QUOTE_SPREAD_PCT = 0.35;
const MIN_TOP5_NOTIONAL_USD = 150;
const LIQUIDITY_LOG_COOLDOWN_MS = 30 * 60_000;
const liquidityLogAt = new Map<string, number>();
function sumTopNotional(levels: { px: string; sz: string }[], n = 5): number {
  let out = 0;
  for (const l of levels.slice(0, n)) {
    const px = Number(l.px), sz = Number(l.sz);
    if (px > 0 && sz > 0) out += px * sz;
  }
  return out;
}
async function quoteLiquidityBlockReason(coin: string, nowMs: number): Promise<string | null> {
  void nowMs;
  let book;
  try { book = await l2Book(coin); } catch (err) { logger.warn({ coin, msg: (err as Error).message }, 'wick-fade: l2Book read failed - keep current quotes, skip liquidity gate'); return null; }
  const bids = book.levels[0], asks = book.levels[1];
  const bid = Number(bids[0]?.px ?? 0), ask = Number(asks[0]?.px ?? 0);
  if (!(bid > 0) || !(ask > bid)) return 'empty/invalid l2 book';
  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;
  const bidTop5 = sumTopNotional(bids);
  const askTop5 = sumTopNotional(asks);
  if (spreadPct > MAX_QUOTE_SPREAD_PCT) return `spread ${spreadPct.toFixed(3)}% > ${MAX_QUOTE_SPREAD_PCT}%`;
  if (Math.min(bidTop5, askTop5) < MIN_TOP5_NOTIONAL_USD) return `top5 depth $${Math.min(bidTop5, askTop5).toFixed(0)} < $${MIN_TOP5_NOTIONAL_USD}`;
  return null;
}
function logLiquidityBlock(coin: string, reason: string, nowMs: number): void {
  const last = liquidityLogAt.get(coin) ?? 0;
  if (nowMs - last < LIQUIDITY_LOG_COOLDOWN_MS) return;
  liquidityLogAt.set(coin, nowMs);
  logger.warn({ coin, reason }, 'wick-fade: LIQUIDITY-GATE active - cancel coin quotes, no new entries');
}
// MARKET-CASCADE GATE: wick-fade wants isolated over-extensions, not a broad market flush/rip.
// If many traded alts move the same way over the last ~15m, pull flat resting traps within 1 minute.
const CASCADE_LOOKBACK_BARS = 3;
const CASCADE_MOVE_PCT = 1.0;
const CASCADE_MIN_COINS = 10;
const CASCADE_MIN_SAMPLE = 12;
const CASCADE_STALE_MS = 30 * 60_000;
const CASCADE_LOG_COOLDOWN_MS = 10 * 60_000;
let cascadeLogAt = 0;
const cascadeCandlesStmt = db.prepare<[string, number], { t: number; c: number }>(`SELECT t, c FROM hl_candles WHERE coin = ? ORDER BY t DESC LIMIT ?`);
const trendCandlesStmt = db.prepare<[string, number], { t: number; c: number }>(`SELECT t, c FROM hl_candles WHERE coin = ? ORDER BY t DESC LIMIT ?`);
function marketCascadeBlockReason(nowMs: number): string | null {
  let up = 0, down = 0, seen = 0;
  for (const coin of WF_CONFIG.coins) {
    let rows: { t: number; c: number }[];
    try { rows = cascadeCandlesStmt.all(coin, CASCADE_LOOKBACK_BARS + 1); } catch { continue; }
    if (rows.length < CASCADE_LOOKBACK_BARS + 1) continue;
    const latest = rows[0]!, base = rows[CASCADE_LOOKBACK_BARS]!;
    if (nowMs - latest.t > CASCADE_STALE_MS || !(base.c > 0)) continue;
    const ret = ((latest.c - base.c) / base.c) * 100;
    if (ret >= CASCADE_MOVE_PCT) up++;
    else if (ret <= -CASCADE_MOVE_PCT) down++;
    seen++;
  }
  if (seen < CASCADE_MIN_SAMPLE) return null;
  const n = Math.max(up, down);
  if (n < CASCADE_MIN_COINS) return null;
  const dir = up >= down ? 'up' : 'down';
  return `${dir} cascade: ${n}/${seen} coins moved >=${CASCADE_MOVE_PCT}% over ~${CASCADE_LOOKBACK_BARS * 5}m`;
}
function logMarketCascadeBlock(reason: string, nowMs: number): void {
  if (nowMs - cascadeLogAt < CASCADE_LOG_COOLDOWN_MS) return;
  cascadeLogAt = nowMs;
  logger.warn({ reason }, 'wick-fade: MARKET-CASCADE active - cancel all flat quotes, no new entries');
  notify(`⛔ <b>wick-fade market-cascade</b>: ${reason}. Снимаю входные ловушки; открытые позиции выходят штатно.`, true);
}
const TREND_GATE_15M_PCT = 1.0;
const TREND_GATE_1H_PCT = 2.0;
function sideTrendBlockReason(coin: string, side: 'long' | 'short'): string | null {
  let rows: { t: number; c: number }[];
  try { rows = trendCandlesStmt.all(coin, 13); } catch { return null; }
  if (rows.length < 13) return null;
  const latest = rows[0]!, b15 = rows[3]!, b1h = rows[12]!;
  if (!(b15.c > 0) || !(b1h.c > 0)) return null;
  const r15 = ((latest.c - b15.c) / b15.c) * 100;
  const r1h = ((latest.c - b1h.c) / b1h.c) * 100;
  if (side === 'long' && r15 <= -TREND_GATE_15M_PCT && r1h <= -TREND_GATE_1H_PCT) {
    return `falling-knife gate r15=${r15.toFixed(2)}%, r1h=${r1h.toFixed(2)}%`;
  }
  if (side === 'short' && r15 >= TREND_GATE_15M_PCT && r1h >= TREND_GATE_1H_PCT) {
    return `rocket-short gate r15=${r15.toFixed(2)}%, r1h=${r1h.toFixed(2)}%`;
  }
  return null;
}
// ACTION-BUDGET BREAKER: when HL rejects with 'Too many cumulative', STOP quote maintenance for an hour
// instead of retrying every tick — each rejected attempt still increments the counter (the Jul-5 death
// spiral: 12k+ rejects in 6h dug the deficit 1.3k → 14.4k). Exits/stops are unaffected (they ride the
// over-budget trickle of ~1 action/10s). Self-resumes; re-trips if still blocked.
let budgetBlockedUntil = 0;
function tripBudgetBreaker(msg: string): void {
  if (Date.now() < budgetBlockedUntil) return; // already tripped — don't spam
  budgetBlockedUntil = Date.now() + 60 * 60_000;
  logger.error({ msg }, '🛑 wick-fade: HL action budget EXHAUSTED — quote maintenance paused 1h (exits unaffected, trickle serves them)');
  notify('⛔ <b>wick-fade</b>: бюджет действий HL исчерпан — перестановка ловушек на паузе 1ч (выходы/стопы работают через «струйку»). Объём от сделок постепенно погашает дефицит.');
}
const isBudgetErr = (m: string): boolean => /Too many cumulative/i.test(m);
const NO_ACTIONS: QuoteActions = { cancels: [], places: [] };
async function stepCoin(coin: string, killed: boolean, quoteTick: boolean, marketBlockReason: string | null): Promise<QuoteActions> {
  const x = COIN_X[coin]; // undefined = a CUT coin — the exit branches below still WIND DOWN its open position; the quote branch places no new quotes and cancels any resting ones (guard before quoting).
  const nowMs = Date.now();
  const dbPos = getPos.get(coin);
  const exRes = await hlFetchPosition(coin);
  if (!exRes.ok) { logger.warn({ coin, msg: exRes.msg }, 'wick-fade: position fetch failed — skip tick'); return NO_ACTIONS; }
  const exPos = exRes.data;
  const ooRes = await hlOpenOrders(coin);
  const exOrders = ooRes.ok ? ooRes.data : [];
  const momentumLock = momentumLockStmt.get(coin, nowMs);

  // Another HL live strategy owns this coin right now. Pull wick-fade traps and
  // do NOT adopt the exchange position as a wick-fade orphan fill.
  if (momentumLock && !dbPos) {
    if (ooRes.ok && exOrders.length) await cancelAll(coin, exOrders);
    return NO_ACTIONS;
  }

  // ── RECONCILE: a deep quote FILLED (exchange position, no DB row) → adopt + clear the other side ──
  if (exPos && !dbPos && x != null) { // a CUT coin (x==null) never adopts a NEW fill (its quotes are cancelled)
    if (!ooRes.ok) { logger.warn({ coin }, 'wick-fade: fill detected but openOrders read failed — defer adopt (must clear the other side first)'); return NO_ACTIONS; }
    const xf = inferFilledX(coin, exPos.side, exPos.entryPx, exOrders); // BEFORE cancel conceptually — exOrders is the pre-cancel snapshot
    await cancelAll(coin, exOrders);
    // opened_at = the REAL fill time from userFills (not the adopt tick) — otherwise every restart resets the
    // 60-min time-stop clock and a position rides open-ended across a restart-churny day (EOD-audit #3).
    const st = await hlPositionStartTime(coin);
    const openedAt = st.ok && st.data.timeMs != null && st.data.timeMs <= nowMs ? st.data.timeMs : nowMs;
    insPos.run(coin, exPos.side, exPos.entryPx, exPos.size, xf, openedAt, 'fill');
    insLog.run(coin, exPos.side, exPos.entryPx, exPos.size, xf, openedAt, 'fill', WF_CONFIG.mode);
    // EXCHANGE-RESIDENT catastrophe stop: guards the position through process downtime / restart gaps (the
    // poll is only a backup). reduceOnly stop-market at the stopPct level; a trigger, so it won't show in openOrders.
    const stpPx = stopAbs(exPos.side, exPos.entryPx);
    const sres = await hlPlaceStop({ coin, posSide: exPos.side, qty: exPos.size, triggerPx: stpPx });
    if (!sres.ok) logger.error({ coin, msg: sres.msg }, '🛑 wick-fade: EXCHANGE STOP place failed — 1-min poll is the ONLY protection this hold');
    logger.warn({ coin, side: exPos.side, entry: exPos.entryPx, x: xf, stop: +stpPx.toFixed(6), exStop: sres.ok, openedAt, target: +targetPx(exPos.side, exPos.entryPx, xf).toFixed(6) }, '✅ wick-fade: FILLED (deep wick) — managing exit');
    notify(`🪝 <b>wick-fade FILLED</b>: ${coin} ${exPos.side} @${exPos.entryPx}\nцель ${targetPx(exPos.side, exPos.entryPx, xf).toFixed(6)} · стоп ${stpPx.toFixed(6)} ${sres.ok ? '(на бирже ✅)' : '(⚠️ только полл!)'} · $${(exPos.size * exPos.entryPx).toFixed(0)}`);
    return NO_ACTIONS;
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
    return NO_ACTIONS;
  }
  // ── IN POSITION → manage exit (target revert / time-stop / catastrophe) ──
  if (exPos && dbPos) {
    // exchange is truth — if the live side DIVERGED from our DB row (a surviving opposite quote filled during
    // downtime and netted/flipped us), do NOT manage/book off the stale row: flatten, reconcile-flat books it next tick.
    if (exPos.side !== dbPos.side) {
      logger.error({ coin, dbSide: dbPos.side, exSide: exPos.side }, '🛑 wick-fade: live side DIVERGED from DB (netting/flip) — flattening to reconcile');
      await hlCancelTriggers(coin); await hlClosePosition(coin);
      return NO_ACTIONS;
    }
    if (!ooRes.ok) { logger.warn({ coin }, 'wick-fade: in-position but openOrders read failed — defer (a surviving opposite order could fill)'); return NO_ACTIONS; }
    if (exOrders.length) await cancelAll(coin, exOrders); // defensive: no resting orders while holding
    const mid = await hlMid(coin); if (mid == null || !(mid > 0)) { logger.warn({ coin }, 'wick-fade: no mid — retry'); return NO_ACTIONS; }
    const tgt = targetPx(dbPos.side, dbPos.entry_px, dbPos.x), stp = stopAbs(dbPos.side, dbPos.entry_px);
    const hitTarget = dbPos.side === 'long' ? mid >= tgt : mid <= tgt;
    const timeStop = nowMs - dbPos.opened_at >= WF_CONFIG.holdMins * 60_000;
    const catastrophe = dbPos.side === 'long' ? mid <= stp : mid >= stp;
    // DAILY-LOSS FLATTEN (the "стопкран"): on a confirmed −5% daily-equity kill, FORCE-CLOSE the open position
    // too — not just pull quotes — so a continuing cascade cannot drag equity past −5%. The real daily floor
    // (validated scripts/wick-fade-breaker.ts: worst day −13%→−5%, maxDD 33%→25%, NET ~flat). ONLY on
    // killReason='loss' (a real drawdown); NEVER on 'blind' (unreadable equity must not force blind exits).
    // Now that a loss-kill closes positions, the TRANSFER-AWARE daily baseline is what stops a money-move from
    // false-tripping it (a false kill would now realize small losses, not just pause).
    const dailyFlatten = killed && killReason === 'loss';
    if (!hitTarget && !timeStop && !catastrophe && !dailyFlatten) return NO_ACTIONS;
    const reason = dailyFlatten ? 'daily-kill' : hitTarget ? 'target' : timeStop ? 'time-stop' : 'catastrophe';
    const close = await hlClosePosition(coin);
    if (!close.ok) { logger.error({ coin, msg: close.msg }, '🛑 wick-fade: close FAILED — retry next tick'); return NO_ACTIONS; }
    const recheck = await hlFetchPosition(coin);
    if (!recheck.ok) { logger.warn({ coin }, 'wick-fade: post-close fetch failed — defer to reconcile'); return NO_ACTIONS; }
    if (recheck.data) { logger.warn({ coin, remaining: recheck.data.size }, 'wick-fade: close did not fully fill — retry'); return NO_ACTIONS; }
    await hlCancelTriggers(coin); // position flat → remove the now-redundant exchange stop before booking
    const exitPx = close.data.avgPx ?? mid; // REAL exit fill (honest live PnL); fall back to mid only if unavailable
    const gross = dbPos.side === 'long' ? (exitPx - dbPos.entry_px) / dbPos.entry_px * 100 : (dbPos.entry_px - exitPx) / dbPos.entry_px * 100;
    const pnl = +(gross - COST_RT).toFixed(3);
    closeTxn(exitPx, nowMs, pnl, reason, coin);
    logger.warn({ coin, side: dbPos.side, entry: dbPos.entry_px, exit: exitPx, pnlPct: pnl, reason }, '✅ wick-fade: CLOSED');
    const rlabel = reason === 'target' ? 'цель 🎯' : reason === 'time-stop' ? 'тайм-стоп ⏱' : reason === 'daily-kill' ? 'дневной −5% СТОПКРАН 🚨' : 'катастроф-стоп 🛑';
    notify(`${pnl >= 0 ? '🟢' : '🔴'} <b>wick-fade CLOSED</b>: ${coin} ${dbPos.side} <b>${pnl > 0 ? '+' : ''}${pnl}%</b> (${rlabel})\n${dbPos.entry_px} → ${exitPx.toFixed(6)} · держали ${Math.round((nowMs - dbPos.opened_at) / 60_000)}м`);
    return NO_ACTIONS;
  }

  // ── FLAT → maintain deep post-only quotes on both sides ──
  // Guard: if we could NOT read open orders, do NOT place quotes — we'd risk duplicating an unseen
  // resting order. (Position reconcile/exit above don't need exOrders, so they already ran safely.)
  if (!ooRes.ok) { logger.warn({ coin, msg: ooRes.msg }, 'wick-fade: openOrders read failed — skip quoting this tick'); return NO_ACTIONS; }
  if (momentumLock) return { cancels: exOrders.map((o) => ({ coin, oid: o.oid })), places: [] };
  if (marketBlockReason) return { cancels: exOrders.map((o) => ({ coin, oid: o.oid })), places: [] };
  // HL ADDRESS ACTION BUDGET (learned live Jul 4): every order/cancel costs 1 action from a budget of
  // 10k + $1-of-volume-traded each. Per-minute re-quoting across 21+ coins burned ~11.4k actions on $186
  // volume in 3 days → placements started getting REJECTED. Quote maintenance now runs every 5th tick
  // (exits above stay 1-min; adopt-cancels stay immediate). Next: batched placement (all coins = 1 action).
  if (!quoteTick) return NO_ACTIONS;
  if (x == null) return { cancels: exOrders.map((o) => ({ coin, oid: o.oid })), places: [] }; // CUT coin: cancel any resting quotes, never place new (its open position already wound down via the exit branches above)
  if ((haltedUntil.get(coin) ?? 0) > nowMs) return NO_ACTIONS; // per-asset halt backoff
  if (killed) return { cancels: exOrders.map((o) => ({ coin, oid: o.oid })), places: [] }; // DAILY-LOSS KILL: pull quotes, no new entries (open positions are FORCE-FLATTENED on loss-kill in the in-position branch above)
  // POST-STOP COOLDOWN: after a catastrophe the flush is often STILL RUNNING — re-quoting immediately meant
  // re-filling into the same cascade (a repeat loser; validated in the Jul 3 param sweep, section C/D).
  const lastCat = lastCatStmt.get(coin, WF_CONFIG.mode)?.t ?? null;
  if (lastCat != null && nowMs - lastCat < WF_CONFIG.postStopCooldownMins * 60_000) return { cancels: exOrders.map((o) => ({ coin, oid: o.oid })), places: [] };
  const mid = await hlMid(coin); if (mid == null || !(mid > 0)) return NO_ACTIONS;
  const liquidityReason = await quoteLiquidityBlockReason(coin, nowMs);
  if (liquidityReason) { logLiquidityBlock(coin, liquidityReason, nowMs); return { cancels: exOrders.map((o) => ({ coin, oid: o.oid })), places: [] }; }
  const margin = WF_CONFIG.capitalUsd / WF_CONFIG.coins.length;
  const factor = depthFactor(coin); // live vol multiplier (1 = fixed depth); computed once per coin per quote tick
  const acts: QuoteActions = { cancels: [], places: [] };
  for (const side of ['long', 'short'] as const) {
    const existing = exOrders.filter((o) => o.side === side);
    if (DISABLED_SIDE[coin] === side) { for (const o of existing) acts.cancels.push({ coin, oid: o.oid }); continue; }
    const trendReason = sideTrendBlockReason(coin, side);
    if (trendReason) { for (const o of existing) acts.cancels.push({ coin, oid: o.oid }); logLiveQuarantine(coin, side, trendReason, nowMs); continue; }
    const quarantineReason = liveQuarantineReason(coin, side, nowMs);
    if (quarantineReason) { for (const o of existing) acts.cancels.push({ coin, oid: o.oid }); logLiveQuarantine(coin, side, quarantineReason, nowMs); continue; }
    const depths = LADDER[coin] != null ? [clampDepth(x * factor), clampDepth(LADDER[coin]! * factor)] : [clampDepth(x * factor)];
    const desireds = depths.map((d) => {
      const price = side === 'long' ? mid * (1 - d) : mid * (1 + d);
      return { price, qty: (margin * WF_CONFIG.leverage) / price };
    });
    // bijective good-check: right ORDER COUNT and every desired rung has a resting order within price+size drift
    // (and vice versa) — otherwise clear the side and re-place all rungs together (shared anchor keeps inference sane).
    // Size matters because lowering capitalUsd should shrink already-resting quotes, not wait for price drift.
    const matchesDesired = (o: HlOpenOrder, d: { price: number; qty: number }): boolean =>
      Math.abs(o.px - d.price) / d.price < WF_CONFIG.requoteDrift
      && Math.abs(o.sz - d.qty) / d.qty < SIZE_REQUOTE_DRIFT;
    const good = existing.length === desireds.length
      && desireds.every((d) => existing.some((o) => matchesDesired(o, d)))
      && existing.every((o) => desireds.some((d) => matchesDesired(o, d)));
    if (good) continue;
    // set leverage BEFORE enqueueing placement; if it fails, skip the side (never rest at unknown leverage)
    if (!levSet.has(coin)) { const lev = await hlSetLeverage(coin, WF_CONFIG.leverage); if (!lev.ok) { logger.warn({ coin, msg: lev.msg }, 'wick-fade: setLeverage failed — skip quote'); continue; } levSet.add(coin); }
    for (const o of existing) acts.cancels.push({ coin, oid: o.oid });
    for (const desired of desireds) {
      if (desired.qty * desired.price < MIN_NOTIONAL) { logger.warn({ coin, side, notional: +(desired.qty * desired.price).toFixed(1) }, 'wick-fade: notional below min — skip rung'); continue; }
      acts.places.push({ coin, side, qty: desired.qty, price: desired.price });
    }
  }
  return acts;
}

/** Execute the tick's collected quote intentions as (at most) TWO exchange actions: one batched cancel,
 *  one batched place. Preserves the old per-coin all-or-nothing guard: if ANY cancel for a coin failed,
 *  that coin's placements are DROPPED this tick (an order still rests — placing would duplicate). */
async function executeQuoteBatch(cancels: { coin: string; oid: number }[], places: BatchPlaceSpec[]): Promise<void> {
  const failedCoins = new Set<string>();
  if (cancels.length) {
    const cr = await hlBatchCancel(cancels);
    if (!cr.ok) {
      for (const cx of cancels) failedCoins.add(cx.coin);
      if (isBudgetErr(cr.msg)) { tripBudgetBreaker(cr.msg); return; }
      logger.warn({ n: cancels.length, msg: cr.msg }, 'wick-fade: batch cancel FAILED — deferring all affected re-quotes');
    } else {
      cr.data.forEach((okItem, i) => { if (!okItem) { failedCoins.add(cancels[i]!.coin); logger.warn({ coin: cancels[i]!.coin, oid: cancels[i]!.oid }, 'wick-fade: cancel failed — defer re-quote (avoid duplicate)'); } });
    }
  }
  const toPlace = places.filter((pl) => !failedCoins.has(pl.coin));
  if (!toPlace.length) return;
  const markHalt = (coin: string, msg: string): boolean => {
    if (!/halted/i.test(msg)) return false;
    haltedUntil.set(coin, Date.now() + 60 * 60_000);
    logger.warn({ coin }, 'wick-fade: asset HALTED by HL — backing off quoting for 1h (self-resumes)');
    return true;
  };
  const pr = await hlBatchPlace(toPlace);
  if (!pr.ok) {
    // BUDGET rejection → breaker, and NO individual fallback (each rejected retry still burns the counter)
    if (isBudgetErr(pr.msg)) { tripBudgetBreaker(pr.msg); return; }
    // one bad order (e.g. a HALTED asset) can fail the whole multi-coin batch — do NOT let it hold the other
    // coins hostage (their cancels already went through): fall back to INDIVIDUAL placement per order.
    logger.warn({ n: toPlace.length, msg: pr.msg }, 'wick-fade: batch place failed — falling back to individual placement');
    for (const pl of toPlace) {
      if ((haltedUntil.get(pl.coin) ?? 0) > Date.now()) continue;
      const r = await hlLimitOrder({ coin: pl.coin, side: pl.side, qty: pl.qty, price: pl.price });
      if (!r.ok) { if (isBudgetErr(r.msg)) { tripBudgetBreaker(r.msg); return; } if (!markHalt(pl.coin, r.msg)) logger.warn({ coin: pl.coin, side: pl.side, price: +pl.price.toFixed(6), msg: r.msg }, 'wick-fade: quote place failed'); continue; }
      if (r.data.filled) logger.warn({ coin: pl.coin, side: pl.side }, 'wick-fade: deep quote filled IMMEDIATELY (unexpected) — reconcile will adopt');
    }
    return;
  }
  pr.data.forEach((st, i) => {
    const pl = toPlace[i]!;
    if ('error' in st) { if (isBudgetErr(st.error)) tripBudgetBreaker(st.error); else if (!markHalt(pl.coin, st.error)) logger.warn({ coin: pl.coin, side: pl.side, price: +pl.price.toFixed(6), msg: st.error }, 'wick-fade: quote place failed'); }
    else if (st.filled) logger.warn({ coin: pl.coin, side: pl.side }, 'wick-fade: deep quote filled IMMEDIATELY (unexpected) — reconcile will adopt');
  });
}

let running = false;
let tickN = 0;
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
      tickN++;
      // Quote maintenance every 30 MIN — the budget-sustainable cadence at this account size. Hard-learned
      // (Jul 5): earned volume ≈ fills/day × $27 ≈ $100/day = ~100 actions/day allowance; 1-min cadence burned
      // ~2 actions/min (some coin always drifts >1%) → deficit death-spiral (rejects also count). The audit's
      // fill-mix argument for faster requoting stands, but is UNAFFORDABLE until capital (→volume) grows:
      // ~$2k acct sustains 5-min, ~$10k sustains 1-min. Exits stay 1-min (cheap, occasional).
      const nowMs = Date.now();
      const quoteTick = tickN % 30 === 1 && nowMs >= budgetBlockedUntil;
      let marketBlockReason: string | null = null;
      try { marketBlockReason = marketCascadeBlockReason(nowMs); } catch (err) { logger.warn({ err }, 'wick-fade: marketCascadeBlockReason failed - fail open'); }
      if (marketBlockReason) logMarketCascadeBlock(marketBlockReason, nowMs);
      const cancels: { coin: string; oid: number }[] = [];
      const places: BatchPlaceSpec[] = [];
      // book coins ∪ retired coins with stale resting orders ∪ any coin with a still-open position that is
      // NOT in the book (a CUT coin winding down). Retired coins get x=null in stepCoin, so they only cancel.
      let stepCoins = WF_CONFIG.coins;
      try {
        const extra = allOpenPosCoins.all().map((r) => r.coin).filter((c) => COIN_X[c] == null);
        stepCoins = [...new Set([...WF_CONFIG.coins, ...RETIRED_COINS, ...extra])];
      } catch {
        stepCoins = [...new Set([...WF_CONFIG.coins, ...RETIRED_COINS])];
      }
      for (const coin of stepCoins) {
        try { const a = await stepCoin(coin, isKilled, quoteTick, marketBlockReason); cancels.push(...a.cancels); places.push(...a.places); } catch (err) { logger.error({ err, coin }, 'wick-fade: step failed'); }
      }
      if (cancels.length || places.length) {
        try { await executeQuoteBatch(cancels, places); } catch (err) { logger.error({ err }, 'wick-fade: quote batch failed'); }
      }
    })().finally(() => { running = false; });
  });
  logger.warn({ mode: WF_CONFIG.mode, endpoint: config.HL_USE_TESTNET ? 'testnet' : 'MAINNET', vault: config.HL_VAULT_ADDRESS ? 'yes' : 'no', coins: WF_CONFIG.coins.length, lev: WF_CONFIG.leverage, capital: WF_CONFIG.capitalUsd, dailyKill: `${WF_CONFIG.dailyLossPct * 100}%`, dynDepth: WF_CONFIG.dynamicDepth ? `vol×W${WF_CONFIG.volWindow}` : 'fixed' }, '✅ wick-fade runner scheduled (every 1m, post-only deep limits, exchange-reconciled, daily-loss kill)');
  if (!hlConfigured()) logger.error('wick-fade: HL_API_WALLET_KEY missing — runner idles until configured');
}
