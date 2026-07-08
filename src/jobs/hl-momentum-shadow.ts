/**
 * HL Momentum — counterweight to wick-fade.
 *
 * Wick-fade sells panic/greed spikes and needs snap-back. This shadow strategy
 * tests the opposite regime: an impulse that holds and continues. The live mode
 * uses the same signal with tiny real-money size and a per-coin lock so wick-fade
 * cannot fight it on the same account.
 */
import cron from 'node-cron';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { sendMessage } from '../telegram/bot.js';
import { allMids, l2Book } from '../exchange/hyperliquid.js';
import {
  hlCancelOrder,
  hlCancelTriggers,
  hlClosePosition,
  hlFetchPosition,
  hlMarketOrder,
  hlOpenOrders,
  hlPlaceStop,
  hlSetLeverage,
  hlExitAvgSince,
} from '../exchange/hyperliquid-private.js';

type Side = 'long' | 'short';
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type Pos = { coin: string; side: Side; entry_px: number; qty: number; opened_at: number; signal: string };
type LogRow = { id: number; coin: string; side: Side; pnl_pct: number; close_reason: string | null; closed_at: number };
type RiskParams = {
  stopPct: number;
  trailActivatePct: number;
  trailGivebackPct: number;
  trailMinLockPct: number;
  volPct: number;
};

const NOTIONAL_USD = 12;
const LIVE_ENABLED = true;
const LIVE_NOTIONAL_USD = 12;
const LIVE_LEVERAGE = 1;
const LIVE_MAX_OPEN = 4;
const LIVE_DAILY_STOP_PCT = -2.5;
const LIVE_MAX_SPREAD_PCT = 0.35;
const LIVE_MIN_SIDE_DEPTH_USD = 150;
const LIVE_MAX_NOTIONAL_TO_DEPTH = 0.10;
const COST_RT_PCT = 0.07; // shadow assumes taker entry + taker exit, conservative vs maker wick-fade
const HOLD_MS = 30 * 60_000;
const TRAIL_HOLD_MS = 60 * 60_000;
const LEGACY_STOP_PCT = 0.012;
const LEGACY_TRAIL_ACTIVATE_PCT = 0.016;
const LEGACY_TRAIL_GIVEBACK_PCT = 0.0025;
const LEGACY_TRAIL_MIN_LOCK_PCT = 0.004;
const MIN_RISK_REWARD = 2;
const VOL_LOOKBACK_BARS = 24;
const STOP_ATR_MULT = 1.15;
const MIN_STOP_PCT = 0.015;
const MAX_STOP_PCT = 0.018;
const GIVEBACK_ATR_MULT = 0.35;
const MIN_TRAIL_GIVEBACK_PCT = 0.002;
const MAX_TRAIL_GIVEBACK_PCT = 0.0045;
const IMPULSE_3BAR_PCT = 1.2;
const VOL_RATIO_MIN = 1.8;
const TREND_1H_PCT = 0.6;
const LONG_CLOSE_NEAR_HIGH_MIN = 0.75;
const SHORT_CLOSE_NEAR_HIGH_MAX = 0.25;
const REPORT_KEY = 'hl_momentum_shadow_last_report_id';
const LIVE_REPORT_KEY = 'hl_momentum_live_last_report_id';
const FRESH_CANDLE_MAX_AGE_MS = 25 * 60_000;
const FAST_MIDS_POLL_MS = 2_000;
const FAST_MIDS_HISTORY_MS = 5 * 60_000;
const FAST_MOVE_30S_PCT = 0.45;
const FAST_MOVE_90S_PCT = 0.75;
const FAST_FROM_LAST_CLOSE_PCT = 0.60;
const FAST_MAX_AGAINST_1H_PCT = 0.30;
const FAST_MAX_CANDIDATES_PER_TICK = 2;
const FAST_COIN_COOLDOWN_MS = 5 * 60_000;
const FAST_GLOBAL_ATTEMPT_GAP_MS = 6_000;

const candlesStmt = db.prepare<[string, number], Candle>(`
  SELECT t, o, h, l, c, v FROM hl_candles
   WHERE coin = ?
   ORDER BY t DESC
   LIMIT ?
`);
const freshCoinsStmt = db.prepare<[number], { coin: string }>(`
  SELECT coin
    FROM hl_candles
   GROUP BY coin
  HAVING COUNT(*) >= 70 AND MAX(t) >= ?
   ORDER BY coin
`);

const allPosStmt = db.prepare<[], Pos>('SELECT coin, side, entry_px, qty, opened_at, signal FROM hl_momentum_shadow_pos');
const getPosStmt = db.prepare<[string], Pos>('SELECT coin, side, entry_px, qty, opened_at, signal FROM hl_momentum_shadow_pos WHERE coin = ?');
const insPosStmt = db.prepare<[string, Side, number, number, number, string], void>(`
  INSERT OR REPLACE INTO hl_momentum_shadow_pos (coin, side, entry_px, qty, opened_at, signal)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const delPosStmt = db.prepare<[string], void>('DELETE FROM hl_momentum_shadow_pos WHERE coin = ?');
const insLogStmt = db.prepare<[string, Side, number, number, number, string], void>(`
  INSERT INTO hl_momentum_shadow_log (coin, side, entry_px, qty, opened_at, signal)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const closeLogStmt = db.prepare<[number, number, number, string, string], void>(`
  UPDATE hl_momentum_shadow_log
     SET exit_px = ?, closed_at = ?, pnl_pct = ?, close_reason = ?
   WHERE id = (
     SELECT id FROM hl_momentum_shadow_log
      WHERE coin = ? AND closed_at IS NULL
      ORDER BY opened_at DESC
      LIMIT 1
   )
`);
const recentClosedStmt = db.prepare<[number], LogRow>(`
  SELECT id, coin, side, pnl_pct, close_reason, closed_at
    FROM hl_momentum_shadow_log
   WHERE closed_at IS NOT NULL
   ORDER BY closed_at DESC
   LIMIT ?
`);
const maxClosedIdStmt = db.prepare<[], { id: number | null }>('SELECT MAX(id) AS id FROM hl_momentum_shadow_log WHERE closed_at IS NOT NULL');
const getKvStmt = db.prepare<[string], { value: string }>('SELECT value FROM runtime_config WHERE key = ?');
const setKvStmt = db.prepare<[string, string, number, string], void>(`
  INSERT INTO runtime_config (key, value, updated_at, reason)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, reason = excluded.reason
`);

const closeTxn = db.transaction((coin: string, exitPx: number, closedAt: number, pnl: number, reason: string) => {
  closeLogStmt.run(exitPx, closedAt, pnl, reason, coin);
  delPosStmt.run(coin);
});

const openTxn = db.transaction((coin: string, side: Side, entry: number, qty: number, openedAt: number, signal: string) => {
  insPosStmt.run(coin, side, entry, qty, openedAt, signal);
  insLogStmt.run(coin, side, entry, qty, openedAt, signal);
});

const liveAllPosStmt = db.prepare<[], Pos>('SELECT coin, side, entry_px, qty, opened_at, signal FROM hl_momentum_live_pos');
const liveGetPosStmt = db.prepare<[string], Pos>('SELECT coin, side, entry_px, qty, opened_at, signal FROM hl_momentum_live_pos WHERE coin = ?');
const liveInsPosStmt = db.prepare<[string, Side, number, number, number, string], void>(`
  INSERT OR REPLACE INTO hl_momentum_live_pos (coin, side, entry_px, qty, opened_at, signal)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const liveDelPosStmt = db.prepare<[string], void>('DELETE FROM hl_momentum_live_pos WHERE coin = ?');
const liveInsLogStmt = db.prepare<[string, Side, number, number, number, string], void>(`
  INSERT INTO hl_momentum_live_log (coin, side, entry_px, qty, opened_at, signal)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const liveCloseLogStmt = db.prepare<[number | null, number, number | null, string, string], void>(`
  UPDATE hl_momentum_live_log
     SET exit_px = ?, closed_at = ?, pnl_pct = ?, close_reason = ?
   WHERE id = (
     SELECT id FROM hl_momentum_live_log
      WHERE coin = ? AND closed_at IS NULL
      ORDER BY opened_at DESC
      LIMIT 1
   )
`);
const liveRecentClosedStmt = db.prepare<[number], LogRow>(`
  SELECT id, coin, side, pnl_pct, close_reason, closed_at
    FROM hl_momentum_live_log
   WHERE closed_at IS NOT NULL AND pnl_pct IS NOT NULL
   ORDER BY closed_at DESC
   LIMIT ?
`);
const liveMaxClosedIdStmt = db.prepare<[], { id: number | null }>('SELECT MAX(id) AS id FROM hl_momentum_live_log WHERE closed_at IS NOT NULL');
const liveTodayPnlStmt = db.prepare<[number], { pnl: number | null }>(`
  SELECT SUM(pnl_pct) AS pnl FROM hl_momentum_live_log
   WHERE closed_at IS NOT NULL AND pnl_pct IS NOT NULL AND closed_at >= ?
`);
const wickOpenPosStmt = db.prepare<[string], { coin: string }>('SELECT coin FROM wick_fade_pos WHERE coin = ?');
const liveUpsertLockStmt = db.prepare<[string, number, string, number], void>(`
  INSERT INTO hl_momentum_live_lock (coin, locked_until, reason, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(coin) DO UPDATE SET locked_until = excluded.locked_until, reason = excluded.reason, updated_at = excluded.updated_at
`);
const liveDelLockStmt = db.prepare<[string], void>('DELETE FROM hl_momentum_live_lock WHERE coin = ?');

const liveOpenTxn = db.transaction((coin: string, side: Side, entry: number, qty: number, openedAt: number, signal: string) => {
  liveInsPosStmt.run(coin, side, entry, qty, openedAt, signal);
  liveInsLogStmt.run(coin, side, entry, qty, openedAt, signal);
});

const liveCloseTxn = db.transaction((coin: string, exitPx: number | null, closedAt: number, pnl: number | null, reason: string) => {
  liveCloseLogStmt.run(exitPx, closedAt, pnl, reason, coin);
  liveDelPosStmt.run(coin);
  liveDelLockStmt.run(coin);
});

function pct(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

function pnlPct(side: Side, entry: number, exit: number): number {
  return (side === 'long' ? pct(entry, exit) : pct(exit, entry)) - COST_RT_PCT;
}

function fmtPct(n: number, digits = 2): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function runtimePct(key: string, fallback: number, lo: number, hi: number): number {
  const raw = Number(getKvStmt.get(key)?.value ?? fallback);
  return Number.isFinite(raw) ? clamp(raw, lo, hi) : fallback;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getCandles(coin: string, n = 90): Candle[] {
  return candlesStmt.all(coin, n).reverse();
}

function scanCoins(): string[] {
  return freshCoinsStmt.all(Date.now() - FRESH_CANDLE_MAX_AGE_MS).map((r) => r.coin);
}

function tickCoins(): string[] {
  return [...new Set([
    ...scanCoins(),
    ...liveAllPosStmt.all().map((p) => p.coin),
    ...allPosStmt.all().map((p) => p.coin),
  ])];
}

function todayStartUtc(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const xs = [...values].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1]! + xs[mid]!) / 2 : xs[mid]!;
}

function volatilityPctAt(cs: Candle[], atMs: number): number {
  const end = cs.findIndex((c) => c.t > atMs);
  const endExclusive = end === -1 ? cs.length : end;
  const from = Math.max(1, endExclusive - VOL_LOOKBACK_BARS);
  const ranges: number[] = [];
  for (let i = from; i < endExclusive; i += 1) {
    const c = cs[i]!;
    const prev = cs[i - 1]!;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
    if (c.c > 0 && Number.isFinite(tr)) ranges.push(tr / c.c);
  }
  return median(ranges) || LEGACY_STOP_PCT / STOP_ATR_MULT;
}

function riskParams(cs: Candle[], atMs: number): RiskParams {
  const volPct = volatilityPctAt(cs, atMs);
  const minStopPct = runtimePct('hl_momentum_min_stop_pct', MIN_STOP_PCT, 0.012, 0.018);
  const maxStopPct = runtimePct('hl_momentum_max_stop_pct', MAX_STOP_PCT, minStopPct, 0.02);
  const stopPct = clamp(volPct * STOP_ATR_MULT, minStopPct, maxStopPct);
  const trailGivebackPct = clamp(volPct * GIVEBACK_ATR_MULT, MIN_TRAIL_GIVEBACK_PCT, MAX_TRAIL_GIVEBACK_PCT);
  const trailMinLockPct = MIN_RISK_REWARD * stopPct + COST_RT_PCT / 100;
  return {
    stopPct,
    trailGivebackPct,
    trailMinLockPct,
    trailActivatePct: trailMinLockPct + trailGivebackPct,
    volPct,
  };
}

function legacyRiskParams(): RiskParams {
  return {
    stopPct: LEGACY_STOP_PCT,
    trailActivatePct: LEGACY_TRAIL_ACTIVATE_PCT,
    trailGivebackPct: LEGACY_TRAIL_GIVEBACK_PCT,
    trailMinLockPct: LEGACY_TRAIL_MIN_LOCK_PCT,
    volPct: LEGACY_STOP_PCT / STOP_ATR_MULT,
  };
}

function pctNum(n: number): string {
  return (n * 100).toFixed(2);
}

function appendRiskSignal(signal: string, params: RiskParams): string {
  return `${signal} [risk stop=${pctNum(params.stopPct)} act=${pctNum(params.trailActivatePct)} gb=${pctNum(params.trailGivebackPct)} lock=${pctNum(params.trailMinLockPct)} vol=${pctNum(params.volPct)} rr=${MIN_RISK_REWARD.toFixed(1)}]`;
}

function parseRiskSignal(signal: string): RiskParams | null {
  const m = signal.match(/\[risk stop=([\d.]+) act=([\d.]+) gb=([\d.]+) lock=([\d.]+) vol=([\d.]+) rr=([\d.]+)\]/);
  if (!m) return null;
  const nums = m.slice(1, 6).map((v) => Number(v) / 100);
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return {
    stopPct: nums[0]!,
    trailActivatePct: nums[1]!,
    trailGivebackPct: nums[2]!,
    trailMinLockPct: nums[3]!,
    volPct: nums[4]!,
  };
}

function posRiskParams(pos: Pos): RiskParams {
  return parseRiskSignal(pos.signal) ?? legacyRiskParams();
}

function stopPx(side: Side, entry: number, params: RiskParams): number {
  return side === 'long' ? entry * (1 - params.stopPct) : entry * (1 + params.stopPct);
}

function trailingState(pos: Pos, cs: Candle[], params: RiskParams): { active: boolean; bestPx: number; movePct: number; trailPx: number | null; params: RiskParams } | null {
  const bars = cs.filter((c) => c.t > pos.opened_at);
  if (bars.length === 0) return null;
  const bestPx = pos.side === 'long'
    ? Math.max(...bars.map((c) => c.h))
    : Math.min(...bars.map((c) => c.l));
  const move = pos.side === 'long'
    ? (bestPx - pos.entry_px) / pos.entry_px
    : (pos.entry_px - bestPx) / pos.entry_px;
  if (move < params.trailActivatePct) return { active: false, bestPx, movePct: move * 100, trailPx: null, params };
  const trailPx = pos.side === 'long'
    ? Math.max(pos.entry_px * (1 + params.trailMinLockPct), bestPx * (1 - params.trailGivebackPct))
    : Math.min(pos.entry_px * (1 - params.trailMinLockPct), bestPx * (1 + params.trailGivebackPct));
  return { active: true, bestPx, movePct: move * 100, trailPx, params };
}

function liveLock(coin: string, reason: string): void {
  liveUpsertLockStmt.run(coin, Date.now() + HOLD_MS + 20 * 60_000, reason, Date.now());
}

function avgVolume(cs: Candle[], endExclusive: number, n: number): number {
  const from = Math.max(0, endExclusive - n);
  const slice = cs.slice(from, endExclusive);
  if (slice.length === 0) return 0;
  return slice.reduce((s, c) => s + c.v, 0) / slice.length;
}

async function liveLiquidityCheck(coin: string, side: Side): Promise<{ ok: true; spreadPct: number; sideDepthUsd: number } | { ok: false; reason: string }> {
  try {
    const book = await l2Book(coin);
    const bids = book.levels[0].slice(0, 3).map((l) => ({ px: Number(l.px), sz: Number(l.sz) })).filter((l) => l.px > 0 && l.sz > 0);
    const asks = book.levels[1].slice(0, 3).map((l) => ({ px: Number(l.px), sz: Number(l.sz) })).filter((l) => l.px > 0 && l.sz > 0);
    const bestBid = bids[0]?.px ?? 0;
    const bestAsk = asks[0]?.px ?? 0;
    if (!(bestBid > 0) || !(bestAsk > 0) || bestAsk <= bestBid) return { ok: false, reason: 'invalid book' };
    const mid = (bestBid + bestAsk) / 2;
    const spreadPct = ((bestAsk - bestBid) / mid) * 100;
    const sideLevels = side === 'long' ? asks : bids; // long buys asks, short sells bids
    const sideDepthUsd = sideLevels.reduce((s, l) => s + l.px * l.sz, 0);
    if (spreadPct > LIVE_MAX_SPREAD_PCT) return { ok: false, reason: `spread ${spreadPct.toFixed(2)}% > ${LIVE_MAX_SPREAD_PCT}%` };
    if (sideDepthUsd < LIVE_MIN_SIDE_DEPTH_USD) return { ok: false, reason: `top3 depth $${sideDepthUsd.toFixed(0)} < $${LIVE_MIN_SIDE_DEPTH_USD}` };
    if (LIVE_NOTIONAL_USD / sideDepthUsd > LIVE_MAX_NOTIONAL_TO_DEPTH) return { ok: false, reason: `order/depth ${(LIVE_NOTIONAL_USD / sideDepthUsd * 100).toFixed(1)}% > ${(LIVE_MAX_NOTIONAL_TO_DEPTH * 100).toFixed(0)}%` };
    return { ok: true, spreadPct, sideDepthUsd };
  } catch (err) {
    return { ok: false, reason: `book read failed: ${(err as Error).message}` };
  }
}

function decide(coin: string, cs: Candle[]): { side: Side; signal: string } | null {
  if (cs.length < 70) return null;
  const i = cs.length - 1;
  const last = cs[i]!;
  const r3 = pct(cs[i - 3]!.c, last.c);
  const r12 = pct(cs[i - 12]!.c, last.c);
  const volBase = avgVolume(cs, i, 48);
  const volRatio = volBase > 0 ? last.v / volBase : 0;
  const closeNearHigh = (last.c - last.l) / Math.max(1e-12, last.h - last.l);

  const longCloseMin = runtimePct('hl_momentum_long_close_near_high_min', LONG_CLOSE_NEAR_HIGH_MIN, 0.65, 0.9);
  const shortCloseMax = runtimePct('hl_momentum_short_close_near_high_max', SHORT_CLOSE_NEAR_HIGH_MAX, 0.1, 0.35);

  if (r3 >= IMPULSE_3BAR_PCT && r12 >= TREND_1H_PCT && volRatio >= VOL_RATIO_MIN && closeNearHigh >= longCloseMin) {
    return { side: 'long', signal: `${coin} up impulse r3=${r3.toFixed(2)} vol=${volRatio.toFixed(1)}x` };
  }
  if (r3 <= -IMPULSE_3BAR_PCT && r12 <= -TREND_1H_PCT && volRatio >= VOL_RATIO_MIN && closeNearHigh <= shortCloseMax) {
    return { side: 'short', signal: `${coin} down impulse r3=${r3.toFixed(2)} vol=${volRatio.toFixed(1)}x` };
  }
  return null;
}

type MidPoint = { t: number; px: number };
type EarlySignal = { coin: string; side: Side; signal: string; score: number; last: Candle; params: RiskParams };
const midHistory = new Map<string, MidPoint[]>();
const earlyCooldown = new Map<string, number>();
const liveFastBestPx = new Map<string, number>();
const liveFastClosing = new Set<string>();
let fastRadarRunning = false;
let lastFastAttemptAt = 0;

function pushMid(coin: string, px: number, now: number): void {
  let xs = midHistory.get(coin);
  if (!xs) { xs = []; midHistory.set(coin, xs); }
  xs.push({ t: now, px });
  const cutoff = now - FAST_MIDS_HISTORY_MS;
  while (xs.length && xs[0]!.t < cutoff) xs.shift();
}

function midAtOrBefore(coin: string, targetMs: number): number | null {
  const xs = midHistory.get(coin);
  if (!xs?.length) return null;
  for (let i = xs.length - 1; i >= 0; i -= 1) {
    const p = xs[i]!;
    if (p.t <= targetMs) return p.px;
  }
  return null;
}

function pctFromMid(coin: string, mid: number, now: number, ageMs: number): number | null {
  const prev = midAtOrBefore(coin, now - ageMs);
  return prev != null && prev > 0 ? pct(prev, mid) : null;
}

function earlyImpulse(coin: string, mid: number, now: number, cs: Candle[]): EarlySignal | null {
  if (cs.length < 70) return null;
  const last = cs.at(-1)!;
  if (now - last.t > FRESH_CANDLE_MAX_AGE_MS) return null;
  const r30 = pctFromMid(coin, mid, now, 30_000);
  const r90 = pctFromMid(coin, mid, now, 90_000);
  if (r30 == null || r90 == null) return null;
  const r12 = pct(cs[cs.length - 13]!.c, last.c);
  const fromLast = pct(last.c, mid);
  const params = riskParams(cs, now);
  const up = r30 >= FAST_MOVE_30S_PCT
    && r90 >= FAST_MOVE_90S_PCT
    && fromLast >= FAST_FROM_LAST_CLOSE_PCT
    && r12 >= -FAST_MAX_AGAINST_1H_PCT;
  if (up) {
    return {
      coin,
      side: 'long',
      score: r90 + fromLast,
      last: { ...last, t: now, h: Math.max(last.h, mid), l: Math.min(last.l, mid), c: mid },
      params,
      signal: `${coin} fast up radar r30=${r30.toFixed(2)} r90=${r90.toFixed(2)} from5m=${fromLast.toFixed(2)} h1=${r12.toFixed(2)}`,
    };
  }
  const down = r30 <= -FAST_MOVE_30S_PCT
    && r90 <= -FAST_MOVE_90S_PCT
    && fromLast <= -FAST_FROM_LAST_CLOSE_PCT
    && r12 <= FAST_MAX_AGAINST_1H_PCT;
  if (down) {
    return {
      coin,
      side: 'short',
      score: Math.abs(r90) + Math.abs(fromLast),
      last: { ...last, t: now, h: Math.max(last.h, mid), l: Math.min(last.l, mid), c: mid },
      params,
      signal: `${coin} fast down radar r30=${r30.toFixed(2)} r90=${r90.toFixed(2)} from5m=${fromLast.toFixed(2)} h1=${r12.toFixed(2)}`,
    };
  }
  return null;
}

function managePosition(pos: Pos, cs: Candle[]): boolean {
  const last = cs.at(-1);
  if (!last || last.t <= pos.opened_at) return false;

  const params = posRiskParams(pos);
  const stop = stopPx(pos.side, pos.entry_px, params);
  const trail = trailingState(pos, cs, params);
  const stopHit = pos.side === 'long' ? last.l <= stop : last.h >= stop;
  const trailHit = trail?.active && trail.trailPx != null ? (pos.side === 'long' ? last.l <= trail.trailPx : last.h >= trail.trailPx) : false;
  const timed = last.t - pos.opened_at >= (trail?.active ? TRAIL_HOLD_MS : HOLD_MS);

  if (!stopHit && !trailHit && !timed) return false;

  // Conservative same-bar ordering: hard stop before profit trail.
  const reason = stopHit ? 'stop' : trailHit ? 'trailing-stop' : 'time-stop';
  const exit = stopHit ? stop : trailHit && trail?.trailPx != null ? trail.trailPx : last.c;
  const pnl = pnlPct(pos.side, pos.entry_px, exit);
  closeTxn(pos.coin, exit, last.t, Math.round(pnl * 1000) / 1000, reason);
  logger.info({ coin: pos.coin, side: pos.side, pnl: +pnl.toFixed(3), reason, trail }, 'hl-momentum-shadow: closed paper position');
  return true;
}

async function cancelCoinOrders(coin: string): Promise<boolean> {
  const oo = await hlOpenOrders(coin);
  if (!oo.ok) { logger.warn({ coin, msg: oo.msg }, 'hl-momentum-live: openOrders read failed'); return false; }
  let ok = true;
  for (const o of oo.data) {
    const c = await hlCancelOrder(coin, o.oid);
    if (!c.ok) { ok = false; logger.warn({ coin, oid: o.oid, msg: c.msg }, 'hl-momentum-live: cancel resting order failed'); }
  }
  return ok;
}

async function refreshLiveStop(pos: Pos, qty: number, triggerPx: number, label: string): Promise<void> {
  const cancel = await hlCancelTriggers(pos.coin);
  if (!cancel.ok) { logger.warn({ coin: pos.coin, msg: cancel.msg, label }, 'hl-momentum-live: trigger cancel failed before stop refresh'); return; }
  const st = await hlPlaceStop({ coin: pos.coin, posSide: pos.side, qty, triggerPx });
  if (!st.ok) logger.error({ coin: pos.coin, triggerPx, msg: st.msg, label }, 'hl-momentum-live: stop refresh failed - poll is backup');
  else logger.info({ coin: pos.coin, triggerPx, cancelled: cancel.data, label }, 'hl-momentum-live: exchange stop refreshed');
}

async function liveManagePosition(pos: Pos, cs: Candle[]): Promise<void> {
  if (liveFastClosing.has(pos.coin)) return;
  liveLock(pos.coin, `momentum-live ${pos.side}`);
  const ex = await hlFetchPosition(pos.coin);
  if (!ex.ok) { logger.warn({ coin: pos.coin, msg: ex.msg }, 'hl-momentum-live: position read failed'); return; }
  if (!ex.data) {
    await hlCancelTriggers(pos.coin);
    const recovered = await hlExitAvgSince(pos.coin, pos.opened_at);
    const exitPx = recovered.ok ? recovered.data.avgPx : null;
    const pnl = exitPx != null ? Math.round(pnlPct(pos.side, pos.entry_px, exitPx) * 1000) / 1000 : null;
    liveCloseTxn(pos.coin, exitPx, Date.now(), pnl, 'reconciled-flat');
    logger.warn({ coin: pos.coin, exitPx, pnl }, 'hl-momentum-live: exchange flat -> reconciled');
    return;
  }
  if (ex.data.side !== pos.side) {
    logger.error({ coin: pos.coin, dbSide: pos.side, exSide: ex.data.side }, 'hl-momentum-live: side diverged - flatten');
    await hlClosePosition(pos.coin);
    return;
  }

  const last = cs.at(-1);
  if (!last || last.t <= pos.opened_at) return;
  const params = posRiskParams(pos);
  const stop = stopPx(pos.side, pos.entry_px, params);
  const trail = trailingState(pos, cs, params);
  const stopHit = pos.side === 'long' ? last.l <= stop : last.h >= stop;
  const trailHit = trail?.active && trail.trailPx != null ? (pos.side === 'long' ? last.l <= trail.trailPx : last.h >= trail.trailPx) : false;
  const timed = last.t - pos.opened_at >= (trail?.active ? TRAIL_HOLD_MS : HOLD_MS);
  if (!stopHit && !trailHit && !timed) {
    if (trail?.active && trail.trailPx != null) await refreshLiveStop(pos, ex.data.size, trail.trailPx, 'trail');
    return;
  }

  const reason = stopHit ? 'stop' : trailHit ? 'trailing-stop' : 'time-stop';
  const close = await hlClosePosition(pos.coin);
  if (!close.ok) { logger.error({ coin: pos.coin, msg: close.msg }, 'hl-momentum-live: close failed'); return; }
  const check = await hlFetchPosition(pos.coin);
  if (!check.ok || check.data) { logger.warn({ coin: pos.coin }, 'hl-momentum-live: close not confirmed flat'); return; }
  await hlCancelTriggers(pos.coin);
  const exit = close.data.avgPx ?? last.c;
  const pnl = Math.round(pnlPct(pos.side, pos.entry_px, exit) * 1000) / 1000;
  liveCloseTxn(pos.coin, exit, Date.now(), pnl, reason);
  logger.warn({ coin: pos.coin, side: pos.side, exit, pnl, reason, trail }, 'hl-momentum-live: CLOSED');
  void sendMessage({
    channel: 'logs',
    text: `${pnl >= 0 ? '🟢' : '🔴'} <b>momentum-live CLOSED</b>: ${pos.coin} ${pos.side} <b>${pnl > 0 ? '+' : ''}${pnl}%</b> (${reason})\n${pos.entry_px} → ${exit.toFixed(6)}${trail?.active ? `\ntrail best ${trail.bestPx.toFixed(6)} · protected ${trail.trailPx?.toFixed(6)}` : ''}`,
  });
}

function fastTrailingState(pos: Pos, mid: number, params: RiskParams): { active: boolean; bestPx: number; movePct: number; trailPx: number | null; params: RiskParams } {
  const prev = liveFastBestPx.get(pos.coin) ?? pos.entry_px;
  const bestPx = pos.side === 'long' ? Math.max(prev, mid) : Math.min(prev, mid);
  liveFastBestPx.set(pos.coin, bestPx);
  const move = pos.side === 'long'
    ? (bestPx - pos.entry_px) / pos.entry_px
    : (pos.entry_px - bestPx) / pos.entry_px;
  if (move < params.trailActivatePct) return { active: false, bestPx, movePct: move * 100, trailPx: null, params };
  const trailPx = pos.side === 'long'
    ? Math.max(pos.entry_px * (1 + params.trailMinLockPct), bestPx * (1 - params.trailGivebackPct))
    : Math.min(pos.entry_px * (1 - params.trailMinLockPct), bestPx * (1 + params.trailGivebackPct));
  return { active: true, bestPx, movePct: move * 100, trailPx, params };
}

async function fastCloseLivePosition(pos: Pos, reason: string, mid: number, trail: ReturnType<typeof fastTrailingState> | null): Promise<void> {
  if (liveFastClosing.has(pos.coin)) return;
  liveFastClosing.add(pos.coin);
  try {
    const close = await hlClosePosition(pos.coin);
    if (!close.ok) { logger.error({ coin: pos.coin, msg: close.msg, reason }, 'hl-momentum-fast: close failed'); return; }
    const check = await hlFetchPosition(pos.coin);
    if (!check.ok || check.data) { logger.warn({ coin: pos.coin, reason }, 'hl-momentum-fast: close not confirmed flat'); return; }
    await hlCancelTriggers(pos.coin);
    const exit = close.data.avgPx ?? mid;
    const pnl = Math.round(pnlPct(pos.side, pos.entry_px, exit) * 1000) / 1000;
    liveCloseTxn(pos.coin, exit, Date.now(), pnl, reason);
    liveFastBestPx.delete(pos.coin);
    logger.warn({ coin: pos.coin, side: pos.side, exit, pnl, reason, trail }, 'hl-momentum-fast: CLOSED intrabar');
    void sendMessage({
      channel: 'logs',
      text: `${pnl >= 0 ? '🟢' : '🔴'} <b>momentum-fast CLOSED</b>: ${pos.coin} ${pos.side} <b>${pnl > 0 ? '+' : ''}${pnl}%</b> (${reason})\n${pos.entry_px} → ${exit.toFixed(6)}${trail?.active ? `\nfast trail best ${trail.bestPx.toFixed(6)} · protected ${trail.trailPx?.toFixed(6)}` : ''}`,
    });
  } finally {
    liveFastClosing.delete(pos.coin);
  }
}

async function fastManageLivePositions(mids: Map<string, number>): Promise<void> {
  const open = liveAllPosStmt.all();
  const openCoins = new Set(open.map((p) => p.coin));
  for (const coin of [...liveFastBestPx.keys()]) if (!openCoins.has(coin)) liveFastBestPx.delete(coin);
  for (const pos of open) {
    const mid = mids.get(pos.coin);
    if (!(mid != null && mid > 0)) continue;
    liveLock(pos.coin, `momentum-live ${pos.side}`);
    const params = posRiskParams(pos);
    const stop = stopPx(pos.side, pos.entry_px, params);
    const trail = fastTrailingState(pos, mid, params);
    const stopHit = pos.side === 'long' ? mid <= stop : mid >= stop;
    const trailHit = trail.active && trail.trailPx != null ? (pos.side === 'long' ? mid <= trail.trailPx : mid >= trail.trailPx) : false;
    const timed = Date.now() - pos.opened_at >= (trail.active ? TRAIL_HOLD_MS : HOLD_MS);
    if (!stopHit && !trailHit && !timed) continue;
    await fastCloseLivePosition(pos, stopHit ? 'fast-stop' : trailHit ? 'fast-trailing-stop' : 'fast-time-stop', mid, trail);
  }
}

async function liveMaybeOpen(coin: string, sig: { side: Side; signal: string }, last: Candle, params: RiskParams): Promise<void> {
  if (!LIVE_ENABLED) return;
  if (liveFastClosing.has(coin)) return;
  const dayPnl = liveTodayPnlStmt.get(todayStartUtc(Date.now()))?.pnl ?? 0;
  if (dayPnl <= LIVE_DAILY_STOP_PCT) return;
  if (liveGetPosStmt.get(coin)) return;
  if (liveAllPosStmt.all().length >= LIVE_MAX_OPEN) return;
  if (wickOpenPosStmt.get(coin)) return;

  const ex = await hlFetchPosition(coin);
  if (!ex.ok) { logger.warn({ coin, msg: ex.msg }, 'hl-momentum-live: position read failed before entry'); return; }
  if (ex.data) return; // shared one-way account: never stack on an existing live position

  const liq = await liveLiquidityCheck(coin, sig.side);
  if (!liq.ok) {
    logger.info({ coin, side: sig.side, reason: liq.reason, signal: sig.signal }, 'hl-momentum-live: signal skipped by liquidity filter');
    return;
  }

  liveLock(coin, `momentum-live pending ${sig.side}`);
  const cancelled = await cancelCoinOrders(coin);
  if (!cancelled) { liveDelLockStmt.run(coin); return; }

  const lev = await hlSetLeverage(coin, LIVE_LEVERAGE);
  if (!lev.ok) { liveDelLockStmt.run(coin); logger.warn({ coin, msg: lev.msg }, 'hl-momentum-live: leverage failed'); return; }
  const qty = LIVE_NOTIONAL_USD / last.c;
  const order = await hlMarketOrder({ coin, side: sig.side, qty });
  if (!order.ok) { liveDelLockStmt.run(coin); logger.error({ coin, side: sig.side, msg: order.msg }, 'hl-momentum-live: entry failed'); return; }

  const pos = await hlFetchPosition(coin);
  if (!pos.ok || !pos.data || pos.data.side !== sig.side) {
    logger.error({ coin, side: sig.side, pos: pos.ok ? pos.data : pos.msg }, 'hl-momentum-live: entry not confirmed');
    liveDelLockStmt.run(coin);
    return;
  }

  const openedAt = Date.now();
  const stop = stopPx(sig.side, pos.data.entryPx, params);
  const st = await hlPlaceStop({ coin, posSide: sig.side, qty: pos.data.size, triggerPx: stop });
  if (!st.ok) logger.error({ coin, msg: st.msg }, 'hl-momentum-live: exchange stop failed - poll is backup');
  liveOpenTxn(coin, sig.side, pos.data.entryPx, pos.data.size, openedAt, sig.signal);
  liveLock(coin, `momentum-live ${sig.side}`);
  logger.warn({ coin, side: sig.side, entry: pos.data.entryPx, stop, exStop: st.ok, spreadPct: liq.spreadPct, sideDepthUsd: liq.sideDepthUsd, params, signal: sig.signal }, 'hl-momentum-live: OPENED real position');
  void sendMessage({
    channel: 'logs',
    text: `🧭 <b>momentum-live OPENED</b>: ${coin} ${sig.side} @${pos.data.entryPx}\nстоп ${stop.toFixed(6)} (${pctNum(params.stopPct)}%) ${st.ok ? '(на бирже ✅)' : '(⚠️ только полл!)'} · trail after ${pctNum(params.trailActivatePct)}%, откат ${pctNum(params.trailGivebackPct)}%, lock ${pctNum(params.trailMinLockPct)}% · R:R ≥ 1:${MIN_RISK_REWARD}\n~$${LIVE_NOTIONAL_USD} · liq: spread ${liq.spreadPct.toFixed(2)}%, top3 $${liq.sideDepthUsd.toFixed(0)} · ${sig.signal}`,
  });
}

async function stepCoin(coin: string): Promise<void> {
  const cs = getCandles(coin);
  if (cs.length < 70) return;
  const livePos = liveGetPosStmt.get(coin);
  if (livePos) await liveManagePosition(livePos, cs);

  const pos = getPosStmt.get(coin);
  const paperStillOpen = pos ? !managePosition(pos, cs) : false;

  const sig = decide(coin, cs);
  if (!sig) return;
  const last = cs.at(-1)!;
  const params = riskParams(cs, last.t);
  const signal = appendRiskSignal(sig.signal, params);
  if (!paperStillOpen && !getPosStmt.get(coin)) {
    const qty = NOTIONAL_USD / last.c;
    openTxn(coin, sig.side, last.c, qty, last.t, signal);
    logger.info({ coin, side: sig.side, entry: +last.c.toFixed(6), params, signal }, 'hl-momentum-shadow: opened paper position');
  }
  if (!liveGetPosStmt.get(coin)) await liveMaybeOpen(coin, { side: sig.side, signal }, last, params);
}

function reportText(rows: LogRow[], open: Pos[]): string {
  const closed = rows.length;
  const sum = rows.reduce((s, r) => s + r.pnl_pct, 0);
  const wins = rows.filter((r) => r.pnl_pct > 0).length;
  const byReason = new Map<string, number>();
  const byCoin = new Map<string, number>();
  for (const r of rows) {
    byReason.set(r.close_reason ?? 'unknown', (byReason.get(r.close_reason ?? 'unknown') ?? 0) + 1);
    byCoin.set(r.coin, (byCoin.get(r.coin) ?? 0) + r.pnl_pct);
  }
  const leaders = [...byCoin.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, p]) => `${c} ${fmtPct(p)}`);
  const laggards = [...byCoin.entries()].sort((a, b) => a[1] - b[1]).slice(0, 3).map(([c, p]) => `${c} ${fmtPct(p)}`);
  const mix = [...byReason.entries()].map(([k, n]) => `${k} ${n}`).join(', ') || 'нет';

  return [
    `🧭 <b>HL Momentum Shadow</b>`,
    `Статус: all-market бумага, реальных ордеров нет`,
    `Последние ${closed}: ${fmtPct(sum)} · WR ${closed ? ((wins / closed) * 100).toFixed(0) : '0'}% · открыто ${open.length}`,
    `Выходы: ${esc(mix)}`,
    leaders.length ? `Сильные: ${esc(leaders.join(', '))}` : `Сильные: мало данных`,
    laggards.length ? `Слабые: ${esc(laggards.join(', '))}` : `Слабые: мало данных`,
    `<i>Идея: сканируем весь свежий HL-рынок и проверяем продолжение импульса с объёмом.</i>`,
  ].join('\n');
}

function liveReportText(rows: LogRow[], open: Pos[]): string {
  const closed = rows.length;
  const sum = rows.reduce((s, r) => s + r.pnl_pct, 0);
  const wins = rows.filter((r) => r.pnl_pct > 0).length;
  const mix = new Map<string, number>();
  for (const r of rows) mix.set(r.close_reason ?? 'unknown', (mix.get(r.close_reason ?? 'unknown') ?? 0) + 1);
  return [
    `🧭 <b>HL Momentum LIVE</b>`,
    `Статус: реальные деньги, all-market scan → liquidity-filtered live, ~$${LIVE_NOTIONAL_USD}, 1x`,
    `Последние ${closed}: ${fmtPct(sum)} · WR ${closed ? ((wins / closed) * 100).toFixed(0) : '0'}% · открыто ${open.length}`,
    `Выходы: ${[...mix.entries()].map(([k, n]) => `${k} ${n}`).join(', ') || 'нет'}`,
    `<i>Монета блокируется для wick-fade на время momentum-позиции, чтобы стратегии не конфликтовали.</i>`,
  ].join('\n');
}

let running = false;
async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const fresh = scanCoins();
    const coins = tickCoins();
    for (const coin of coins) await stepCoin(coin);
    logger.info({ coins: coins.length, fresh: fresh.length }, 'hl-momentum: scanned all-market universe + managed open positions');
  } catch (err) {
    logger.error({ err }, 'hl-momentum-shadow: tick failed');
  } finally {
    running = false;
  }
}

async function fastRadarTick(): Promise<void> {
  if (fastRadarRunning) return;
  fastRadarRunning = true;
  try {
    const raw = await allMids();
    const now = Date.now();
    const mids = new Map<string, number>();
    for (const [coin, value] of Object.entries(raw)) {
      const px = Number(value);
      if (!(px > 0) || !Number.isFinite(px)) continue;
      mids.set(coin, px);
      pushMid(coin, px, now);
    }
    await fastManageLivePositions(mids);

    if (now - lastFastAttemptAt < FAST_GLOBAL_ATTEMPT_GAP_MS) return;
    const candidates: EarlySignal[] = [];
    for (const [coin, mid] of mids) {
      if ((earlyCooldown.get(coin) ?? 0) > now) continue;
      if (liveGetPosStmt.get(coin) || getPosStmt.get(coin)) continue;
      const cs = getCandles(coin);
      const sig = earlyImpulse(coin, mid, now, cs);
      if (sig) candidates.push(sig);
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const sig of candidates.slice(0, FAST_MAX_CANDIDATES_PER_TICK)) {
      earlyCooldown.set(sig.coin, now + FAST_COIN_COOLDOWN_MS);
      lastFastAttemptAt = Date.now();
      const signal = appendRiskSignal(sig.signal, sig.params);
      if (!getPosStmt.get(sig.coin)) {
        const qty = NOTIONAL_USD / sig.last.c;
        openTxn(sig.coin, sig.side, sig.last.c, qty, now, signal);
        logger.info({ coin: sig.coin, side: sig.side, entry: +sig.last.c.toFixed(6), params: sig.params, signal }, 'hl-momentum-fast: opened paper position from mids radar');
      }
      if (!liveGetPosStmt.get(sig.coin)) await liveMaybeOpen(sig.coin, { side: sig.side, signal }, sig.last, sig.params);
    }
    if (candidates.length) {
      logger.info({ candidates: candidates.length, tried: Math.min(candidates.length, FAST_MAX_CANDIDATES_PER_TICK), mids: mids.size }, 'hl-momentum-fast: mids radar candidates');
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'hl-momentum-fast: mids radar failed');
  } finally {
    fastRadarRunning = false;
  }
}

export async function runHlMomentumShadowReport(opts: { force?: boolean; notify?: boolean } = {}): Promise<{ closed: number; open: number; sent: boolean }> {
  const rows = recentClosedStmt.all(120);
  const open = allPosStmt.all();
  const liveRows = liveRecentClosedStmt.all(120);
  const liveOpen = liveAllPosStmt.all();
  const maxId = maxClosedIdStmt.get()?.id ?? 0;
  const liveMaxId = liveMaxClosedIdStmt.get()?.id ?? 0;
  const lastReported = Number(getKvStmt.get(REPORT_KEY)?.value ?? 0);
  const liveLastReported = Number(getKvStmt.get(LIVE_REPORT_KEY)?.value ?? 0);
  const result = { closed: rows.length + liveRows.length, open: open.length + liveOpen.length, sent: false };
  if (!opts.force && maxId <= lastReported && liveMaxId <= liveLastReported) return result;
  if (opts.notify ?? true) {
    await sendMessage({ channel: 'logs', text: `${reportText(rows.reverse(), open)}\n\n${liveReportText(liveRows.reverse(), liveOpen)}`, disable_notification: true });
    result.sent = true;
  } else {
    logger.info({ text: `${reportText(rows.reverse(), open)}\n\n${liveReportText(liveRows.reverse(), liveOpen)}` }, 'hl-momentum-shadow report');
  }
  setKvStmt.run(REPORT_KEY, String(maxId), Date.now(), 'hl momentum shadow last report');
  setKvStmt.run(LIVE_REPORT_KEY, String(liveMaxId), Date.now(), 'hl momentum live last report');
  return result;
}

export function startHlMomentumShadowJob(): void {
  cron.schedule('* * * * *', () => { void tick(); });
  cron.schedule('29 */4 * * *', () => {
    void runHlMomentumShadowReport().catch((err) => logger.error({ err }, 'hl-momentum-shadow: report failed'));
  });
  const fast = setInterval(() => { void fastRadarTick(); }, FAST_MIDS_POLL_MS);
  fast.unref();
  setTimeout(() => { void fastRadarTick(); }, 10_000).unref();
  const t = setTimeout(() => { void tick(); }, 75_000);
  t.unref();
  logger.info({ live: LIVE_ENABLED, liveNotional: LIVE_NOTIONAL_USD, liveLeverage: LIVE_LEVERAGE, liveMaxOpen: LIVE_MAX_OPEN, fastMidsPollMs: FAST_MIDS_POLL_MS }, 'hl-momentum scheduled (2s allMids radar + 1m check, 5m candle signal, all-market shadow + filtered live micro)');
}
