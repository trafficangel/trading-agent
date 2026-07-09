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
  hlAccountValue,
} from '../exchange/hyperliquid-private.js';
import { upsertHlMinuteCandlesFromMids } from './hl-minute-candle-collector.js';

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
type SignalLayer = 'fast' | 'confirm';
type SignalMetrics = {
  r30?: number;
  r90?: number;
  r3?: number;
  r12?: number;
  fromLast?: number;
  volRatio?: number;
  closeNearHigh?: number;
  extensionPct?: number;
  vol5mPct?: number;
  impulseRatio?: number;
  fast30Ratio?: number;
  fast90Ratio?: number;
  fastFromRatio?: number;
  h1Ratio?: number;
};
type MomentumSignal = {
  coin: string;
  side: Side;
  layer: SignalLayer;
  signal: string;
  score: number;
  modelProb: number;
  prob: number;
  probConfidence: number;
  expectedPnl: number;
  metrics: SignalMetrics;
};
type LiveSizing = {
  notionalUsd: number;
  kellyFraction: number;
  confidence: number;
  equityUsd: number | null;
  source: 'kelly' | 'fallback';
};
type PerfStats = { n: number; avg: number | null; wins: number | null; sum: number | null };
type ShadowProofRow = { side: Side; pnl_pct: number; close_reason: string | null; signal: string };
type ProofStats = { n: number; avg: number; wr: number; sum: number };

const NOTIONAL_USD = 12;
const LIVE_ENABLED = true;
const LIVE_NOTIONAL_USD = 12;
const LIVE_MIN_NOTIONAL_USD = 11;
const LIVE_MAX_NOTIONAL_USD = 24;
const LIVE_LEVERAGE = 1;
const LIVE_MAX_OPEN = 4;
const LIVE_DAILY_STOP_PCT = -10;
const LIVE_DAILY_STOP_USD_MIN = -500;
const LIVE_DAILY_STOP_USD_MAX = -1;
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
const STOP_MEDIAN_MULT = 1.35;
const STOP_TAIL_MULT = 1.05;
const STOP_RECENT_MULT = 1.20;
const GIVEBACK_MEDIAN_MULT = 0.80;
const GIVEBACK_TAIL_MULT = 0.45;
const GIVEBACK_RECENT_MULT = 0.55;
const RISK_SANITY_MIN_PCT = 0.0005;
const RISK_SANITY_MAX_PCT = 0.08;
const IMPULSE_VOL_MULT = 1.25;
const TREND_VOL_MULT = 0.35;
const VOLUME_QUANTILE = 0.80;
const CLOSE_EDGE_BASE = 0.62;
const REPORT_KEY = 'hl_momentum_shadow_last_report_id';
const LIVE_REPORT_KEY = 'hl_momentum_live_last_report_id';
const FRESH_CANDLE_MAX_AGE_MS = 25 * 60_000;
const FRESH_1M_CANDLE_MAX_AGE_MS = 4 * 60_000;
const ONE_MINUTE_MS = 60_000;
const FIVE_MINUTE_MS = 5 * 60_000;
const FAST_MIDS_POLL_MS = 2_000;
const FAST_MIDS_HISTORY_MS = 5 * 60_000;
const FAST_MOVE_VOL_MULT = 1.60;
const FAST_FROM_LAST_CLOSE_VOL_MULT = 1.05;
const FAST_MAX_AGAINST_VOL_MULT = 0.35;
const FAST_STRICT_MULT = 1.0;
const FAST_BREAKOUT_LOOKBACK = 0;
const FAST_BREAKOUT_BUFFER_PCT = 0.0;
const FAST_MAX_CANDIDATES_PER_TICK = 2;
const FAST_COIN_COOLDOWN_MS = 5 * 60_000;
const FAST_GLOBAL_ATTEMPT_GAP_MS = 6_000;
const ENTRY_FAIL_COOLDOWN_MS = 2 * 60_000;
const MIN_LIVE_SCORE = 68;
const MIN_EXPECTED_PNL_PCT = 0.10;
const MIN_CALIBRATED_PROB = 0.49;
const MAX_EXTENSION_R_MULT = 1.25;
const MAX_LIVE_SAME_SIDE = 3;
const HIGH_SCORE_OVERRIDE = 84;
const REGIME_MOVE_90S_PCT = 0.20;
const REGIME_BREADTH_WARN = 80;
const KELLY_RISK_SCALE = 0.0015;
const KELLY_MIN_LIVE_SAMPLE = 30;
const KELLY_MIN_LAYER_SAMPLE = 12;
const MODEL_PROB_WEIGHT = 0.35;
const PROB_PRIOR_N = 18;
const PROB_BIAS_DEFAULT = 0;
const EV_BIAS_PCT_DEFAULT = 0;
const CLUSTER_WINDOW_MS = 3 * 60_000;
const MAX_CLUSTER_SAME_SIDE = 2;
const DECAY_EXIT_MS = 6 * 60_000;
const DECAY_MIN_MFE_R = 0.35;
const DECAY_LOSS_R = 0.30;
const SHADOW_PROOF_RECENT_N = 120;
const SHADOW_PROOF_MIN_SAMPLE = 20;
const SHADOW_PROOF_MIN_AVG_PCT = 0;
const SHADOW_PROOF_MIN_WR = 0.45;
const CONFIRM_MAX_IMPULSE_RATIO = 1.42;

const candlesStmt = db.prepare<[string, number], Candle>(`
  SELECT t, o, h, l, c, v FROM hl_candles
   WHERE coin = ?
   ORDER BY t DESC
   LIMIT ?
`);
const minuteCandlesStmt = db.prepare<[string, number, number], Candle>(`
  SELECT t, o, h, l, c, v FROM hl_candles_1m
   WHERE coin = ? AND t < ?
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
const freshMinuteCoinsStmt = db.prepare<[number], { coin: string }>(`
  SELECT coin
    FROM hl_candles_1m
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
const shadowProofRowsStmt = db.prepare<[number], ShadowProofRow>(`
  SELECT side, pnl_pct, close_reason, signal
    FROM hl_momentum_shadow_log
   WHERE closed_at IS NOT NULL AND pnl_pct IS NOT NULL
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
const liveSessionUsdStmt = db.prepare<[number], { usd: number | null }>(`
  SELECT SUM((pnl_pct / 100.0) * qty * entry_px) AS usd FROM hl_momentum_live_log
   WHERE closed_at IS NOT NULL AND pnl_pct IS NOT NULL AND closed_at >= ?
`);
const liveCoinSideStatsStmt = db.prepare<[string, Side], { n: number; avg: number | null; wins: number | null }>(`
  SELECT COUNT(*) AS n,
         AVG(pnl_pct) AS avg,
         SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS wins
    FROM hl_momentum_live_log
   WHERE coin = ? AND side = ? AND closed_at IS NOT NULL AND pnl_pct IS NOT NULL
`);
const liveAllStatsStmt = db.prepare<[], PerfStats>(`
  SELECT COUNT(*) AS n,
         AVG(pnl_pct) AS avg,
         SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
         SUM(pnl_pct) AS sum
    FROM hl_momentum_live_log
   WHERE closed_at IS NOT NULL AND pnl_pct IS NOT NULL
`);
const liveLayerStatsStmt = db.prepare<[string, string, string], PerfStats>(`
  SELECT COUNT(*) AS n,
         AVG(pnl_pct) AS avg,
         SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
         SUM(pnl_pct) AS sum
    FROM hl_momentum_live_log
   WHERE closed_at IS NOT NULL AND pnl_pct IS NOT NULL
     AND (signal LIKE ? OR signal LIKE ? OR signal LIKE ?)
`);
const liveRecentStatsStmt = db.prepare<[number], PerfStats>(`
  SELECT COUNT(*) AS n,
         AVG(pnl_pct) AS avg,
         SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
         SUM(pnl_pct) AS sum
    FROM (
      SELECT pnl_pct
        FROM hl_momentum_live_log
       WHERE closed_at IS NOT NULL AND pnl_pct IS NOT NULL
       ORDER BY closed_at DESC
       LIMIT ?
    )
`);
const insSignalJournalStmt = db.prepare<[
  number, string, Side, SignalLayer, number, number, string, string,
  number | null, number | null, number | null, number | null, number | null, number | null,
  number | null, number | null, number | null, number | null, number, number, string,
  number | null, number | null, number | null, number | null, number | null, number | null, number | null
], void>(`
  INSERT INTO hl_momentum_signal_journal
    (ts, coin, side, layer, score, expected_pnl, decision, reason, ref_px, signal_px,
     r30, r90, r3, r12, from_last, vol_ratio, spread_pct, side_depth_usd,
     open_total, open_same_side, signal, notional_usd, kelly_fraction, equity_usd,
     model_prob, calibrated_prob, prob_confidence, kelly_confidence)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

function liveDailyStopPct(): number {
  return runtimePct('hl_momentum_live_daily_stop_pct', LIVE_DAILY_STOP_PCT, -25, -1);
}

function liveDailyStopUsd(): number | null {
  const value = getKvStmt.get('hl_momentum_live_daily_stop_usd')?.value;
  if (value == null || value.trim() === '') return null;
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw === 0) return null;
  const negativeStop = raw > 0 ? -raw : raw;
  return clamp(negativeStop, LIVE_DAILY_STOP_USD_MIN, LIVE_DAILY_STOP_USD_MAX);
}

function liveDailyPnlStart(nowMs: number): number {
  const utcDayStart = todayStartUtc(nowMs);
  const resetMs = Number(getKvStmt.get('hl_momentum_live_day_reset_ms')?.value ?? 0);
  if (Number.isFinite(resetMs) && resetMs > utcDayStart && resetMs <= nowMs + 60_000) return resetMs;
  return utcDayStart;
}

function runtimeNum(key: string, fallback: number, lo: number, hi: number): number {
  const raw = Number(getKvStmt.get(key)?.value ?? fallback);
  return Number.isFinite(raw) ? clamp(raw, lo, hi) : fallback;
}

function signalTimeframeMin(): number {
  return Math.round(runtimeNum('hl_momentum_signal_tf_min', 1, 1, 5));
}

function liveMaxOpen(): number {
  return Math.round(runtimeNum('hl_momentum_live_max_open', LIVE_MAX_OPEN, 1, 20));
}

function fastStrictMult(): number {
  return runtimeNum('hl_momentum_fast_strict_mult', FAST_STRICT_MULT, 1, 2);
}

function fastBreakoutLookback(): number {
  return Math.round(runtimeNum('hl_momentum_fast_breakout_lookback', FAST_BREAKOUT_LOOKBACK, 0, 8));
}

function fastBreakoutBufferPct(): number {
  return runtimeNum('hl_momentum_fast_breakout_buffer_pct', FAST_BREAKOUT_BUFFER_PCT, 0, 0.50);
}

function learnedProbBias(): number {
  return runtimeNum('hl_momentum_prob_bias', PROB_BIAS_DEFAULT, -0.12, 0.08);
}

function learnedEvBiasPct(): number {
  return runtimeNum('hl_momentum_ev_bias_pct', EV_BIAS_PCT_DEFAULT, -1.25, 0.50);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function minuteBucket(ms: number): number {
  return Math.floor(ms / ONE_MINUTE_MS) * ONE_MINUTE_MS;
}

function getFiveMinuteCandles(coin: string, n = 90): Candle[] {
  return candlesStmt.all(coin, n).reverse();
}

function getMinuteCandles(coin: string, n = 180): Candle[] {
  return minuteCandlesStmt.all(coin, minuteBucket(Date.now()), n).reverse();
}

function getMomentumCandles(coin: string): Candle[] {
  if (signalTimeframeMin() <= 1) {
    const one = getMinuteCandles(coin);
    if (one.length >= 70) return one;
  }
  return getFiveMinuteCandles(coin);
}

function scanCoins(): string[] {
  if (signalTimeframeMin() <= 1) {
    const one = freshMinuteCoinsStmt.all(Date.now() - FRESH_1M_CANDLE_MAX_AGE_MS).map((r) => r.coin);
    if (one.length) return one;
  }
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

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const xs = [...values].sort((a, b) => a - b);
  const pos = (xs.length - 1) * clamp(q, 0, 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo]!;
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (pos - lo);
}

function candleStepMs(cs: Candle[]): number {
  const diffs: number[] = [];
  for (let i = Math.max(1, cs.length - 40); i < cs.length; i += 1) {
    const d = cs[i]!.t - cs[i - 1]!.t;
    if (d > 0 && Number.isFinite(d)) diffs.push(d);
  }
  const step = median(diffs);
  if (step >= 30_000 && step <= 10 * 60_000) return step;
  return FIVE_MINUTE_MS;
}

function volatilityPctAt(cs: Candle[], atMs: number): number {
  return riskVolShapeAt(cs, atMs).median;
}

function riskVolShapeAt(cs: Candle[], atMs: number): { median: number; q70: number; q85: number; q95: number; recent: number } {
  const end = cs.findIndex((c) => c.t > atMs);
  const endExclusive = end === -1 ? cs.length : end;
  const stepMs = candleStepMs(cs);
  const targetMinutes = runtimeNum('hl_momentum_vol_lookback_minutes', 120, 30, 360);
  const lookbackBars = Math.max(VOL_LOOKBACK_BARS, Math.round((targetMinutes * 60_000) / stepMs));
  const from = Math.max(1, endExclusive - lookbackBars);
  const ranges: number[] = [];
  for (let i = from; i < endExclusive; i += 1) {
    const c = cs[i]!;
    const prev = cs[i - 1]!;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
    if (c.c > 0 && Number.isFinite(tr)) ranges.push(tr / c.c);
  }
  const fallback = LEGACY_STOP_PCT / STOP_MEDIAN_MULT;
  const recentBars = Math.max(4, Math.round(12 * (ONE_MINUTE_MS / stepMs)));
  const recent = ranges.slice(-recentBars);
  return {
    median: median(ranges) || fallback,
    q70: quantile(ranges, 0.70) || median(ranges) || fallback,
    q85: quantile(ranges, 0.85) || quantile(ranges, 0.70) || median(ranges) || fallback,
    q95: quantile(ranges, 0.95) || quantile(ranges, 0.85) || median(ranges) || fallback,
    recent: median(recent) || quantile(ranges, 0.70) || median(ranges) || fallback,
  };
}

function saneRiskPct(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return clamp(n, RISK_SANITY_MIN_PCT, RISK_SANITY_MAX_PCT);
}

function minGrossLockPct(stopPct: number): number {
  const cost = COST_RT_PCT / 100;
  return MIN_RISK_REWARD * (stopPct + cost) + cost;
}

function riskParams(cs: Candle[], atMs: number): RiskParams {
  const shape = riskVolShapeAt(cs, atMs);
  const costFloor = (COST_RT_PCT / 100) * 2.5;
  const rawStop = Math.max(
    shape.median * STOP_MEDIAN_MULT,
    shape.q85 * STOP_TAIL_MULT,
    shape.recent * STOP_RECENT_MULT,
    costFloor,
  );
  const stopPct = saneRiskPct(rawStop, LEGACY_STOP_PCT);
  const rawGiveback = Math.max(
    shape.median * GIVEBACK_MEDIAN_MULT,
    shape.q70 * GIVEBACK_TAIL_MULT,
    shape.recent * GIVEBACK_RECENT_MULT,
    (COST_RT_PCT / 100) * 1.2,
  );
  const trailGivebackPct = saneRiskPct(rawGiveback, Math.max(shape.median, (COST_RT_PCT / 100) * 1.2));
  const trailMinLockPct = saneRiskPct(minGrossLockPct(stopPct), stopPct * MIN_RISK_REWARD);
  return {
    stopPct,
    trailGivebackPct,
    trailMinLockPct,
    trailActivatePct: trailMinLockPct + trailGivebackPct,
    volPct: shape.median,
  };
}

function legacyRiskParams(): RiskParams {
  return {
    stopPct: LEGACY_STOP_PCT,
    trailActivatePct: LEGACY_TRAIL_ACTIVATE_PCT,
    trailGivebackPct: LEGACY_TRAIL_GIVEBACK_PCT,
    trailMinLockPct: LEGACY_TRAIL_MIN_LOCK_PCT,
    volPct: LEGACY_STOP_PCT / STOP_MEDIAN_MULT,
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

function favorableMove(pos: Pos, px: number): number {
  return pos.side === 'long'
    ? (px - pos.entry_px) / pos.entry_px
    : (pos.entry_px - px) / pos.entry_px;
}

function decayExit(pos: Pos, currentPx: number, bestMovePct: number, params: RiskParams, nowMs: number): boolean {
  if (nowMs - pos.opened_at < DECAY_EXIT_MS) return false;
  if (bestMovePct >= params.stopPct * DECAY_MIN_MFE_R) return false;
  return favorableMove(pos, currentPx) <= -params.stopPct * DECAY_LOSS_R;
}

function classifyRecoveredFlat(pos: Pos, exitPx: number | null, cs: Candle[]): string {
  if (exitPx == null) return 'reconciled-flat';
  const params = posRiskParams(pos);
  const stop = stopPx(pos.side, pos.entry_px, params);
  const trail = trailingState(pos, cs, params);
  const stopLike = pos.side === 'long' ? exitPx <= stop * 1.002 : exitPx >= stop * 0.998;
  const trailLike = trail?.active && trail.trailPx != null
    ? (pos.side === 'long' ? exitPx <= trail.trailPx * 1.002 : exitPx >= trail.trailPx * 0.998)
    : false;
  if (stopLike) return 'exchange-stop';
  if (trailLike) return 'exchange-trailing-stop';
  return favorableMove(pos, exitPx) >= 0 ? 'external-flat-profit' : 'external-flat-loss';
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

type AdaptiveThresholds = {
  vol5mPct: number;
  impulse3Pct: number;
  trend1hPct: number;
  volRatioMin: number;
  longCloseMin: number;
  shortCloseMax: number;
  fast30Pct: number;
  fast90Pct: number;
  fastFromLastPct: number;
  fastMaxAgainst1hPct: number;
};

function adaptiveThresholds(cs: Candle[], atMs: number): AdaptiveThresholds {
  const vol5mPct = volatilityPctAt(cs, atMs) * 100;
  const stepMs = candleStepMs(cs);
  const stepSec = Math.max(30, stepMs / 1000);
  const strict = fastStrictMult();
  const vols = cs.slice(Math.max(0, cs.length - 97), Math.max(0, cs.length - 1)).map((c) => c.v).filter((v) => v > 0);
  const volAvg = vols.length ? vols.reduce((s, v) => s + v, 0) / vols.length : 0;
  const volQ = quantile(vols, VOLUME_QUANTILE);
  const volRatioMin = volAvg > 0 ? clamp(volQ / volAvg, 1.15, 2.60) : 1.60;
  const edge = clamp(CLOSE_EDGE_BASE + Math.min(0.20, vol5mPct / 12), 0.62, 0.84);
  return {
    vol5mPct,
    impulse3Pct: clamp(vol5mPct * Math.sqrt(3) * IMPULSE_VOL_MULT, stepMs <= ONE_MINUTE_MS * 1.5 ? 0.22 : 0.70, 2.80),
    trend1hPct: clamp(vol5mPct * Math.sqrt(12) * TREND_VOL_MULT, stepMs <= ONE_MINUTE_MS * 1.5 ? 0.10 : 0.20, 1.60),
    volRatioMin,
    longCloseMin: edge,
    shortCloseMax: 1 - edge,
    fast30Pct: clamp(vol5mPct * Math.sqrt(30 / stepSec) * FAST_MOVE_VOL_MULT * strict, 0.18 * strict, 1.80),
    fast90Pct: clamp(vol5mPct * Math.sqrt(90 / stepSec) * FAST_MOVE_VOL_MULT * strict, 0.30 * strict, 2.60),
    fastFromLastPct: clamp(vol5mPct * FAST_FROM_LAST_CLOSE_VOL_MULT * strict, 0.30 * strict, 2.60),
    fastMaxAgainst1hPct: clamp(vol5mPct * FAST_MAX_AGAINST_VOL_MULT, 0.12, 0.90),
  };
}

function thSignal(th: AdaptiveThresholds): string {
  const strict = fastStrictMult();
  const strictText = strict > 1 ? ` strict=${strict.toFixed(2)}` : '';
  return `thr volBar=${th.vol5mPct.toFixed(2)} imp3=${th.impulse3Pct.toFixed(2)} tr12=${th.trend1hPct.toFixed(2)} volx=${th.volRatioMin.toFixed(2)} edge=${th.longCloseMin.toFixed(2)} fast30=${th.fast30Pct.toFixed(2)} fast90=${th.fast90Pct.toFixed(2)} fastRef=${th.fastFromLastPct.toFixed(2)}${strictText}`;
}

function coinQualityAdj(coin: string, side: Side): number {
  const st = liveCoinSideStatsStmt.get(coin, side);
  const n = st?.n ?? 0;
  if (n < 3) return 0;
  const avgPnl = st?.avg ?? 0;
  const wr = n > 0 ? (st?.wins ?? 0) / n : 0.5;
  return clamp(avgPnl * 8 + (wr - 0.5) * 18, -14, 14);
}

function portfolioState(side: Side): { total: number; sameSide: number } {
  const open = liveAllPosStmt.all();
  return { total: open.length, sameSide: open.filter((p) => p.side === side).length };
}

function recentSideCluster(side: Side, now = Date.now()): number {
  return liveAllPosStmt.all().filter((p) => p.side === side && now - p.opened_at <= CLUSTER_WINDOW_MS).length;
}

function modelContinuationProb(score: number): number {
  return clamp(0.38 + (score - 50) / 120, 0.18, 0.78);
}

function layerStats(layer: SignalLayer): PerfStats {
  const patterns: [string, string, string] = layer === 'fast'
    ? ['%layer=fast%', '%fast up radar%', '%fast down radar%']
    : ['%layer=confirm%', '%up impulse%', '%down impulse%'];
  return liveLayerStatsStmt.get(...patterns) ?? { n: 0, avg: null, wins: null, sum: null };
}

function signalLayer(signal: string): SignalLayer | 'unknown' {
  if (signal.includes('layer=fast') || signal.includes('fast up radar') || signal.includes('fast down radar')) return 'fast';
  if (signal.includes('layer=confirm') || signal.includes('up impulse') || signal.includes('down impulse')) return 'confirm';
  return 'unknown';
}

function proofStats(rows: ShadowProofRow[]): ProofStats {
  const n = rows.length;
  if (n === 0) return { n: 0, avg: 0, wr: 0, sum: 0 };
  const sum = rows.reduce((acc, r) => acc + r.pnl_pct, 0);
  const wins = rows.filter((r) => r.pnl_pct > 0).length;
  return { n, avg: sum / n, wr: wins / n, sum };
}

function shadowProofGate(sig: MomentumSignal): string | null {
  if (runtimeNum('hl_momentum_shadow_proof_enabled', 1, 0, 1) < 0.5) return null;

  const recentN = Math.round(runtimeNum('hl_momentum_shadow_proof_recent_n', SHADOW_PROOF_RECENT_N, 40, 300));
  const rows = shadowProofRowsStmt.all(recentN);
  const family = rows.filter((r) => r.side === sig.side && signalLayer(r.signal) === sig.layer);
  const familyStats = proofStats(family);
  const minSample = Math.round(runtimeNum('hl_momentum_shadow_proof_min_sample', SHADOW_PROOF_MIN_SAMPLE, 8, 80));
  const minAvg = runtimeNum('hl_momentum_shadow_proof_min_avg_pct', SHADOW_PROOF_MIN_AVG_PCT, -0.25, 0.50);
  const minWr = runtimeNum('hl_momentum_shadow_proof_min_wr', SHADOW_PROOF_MIN_WR, 0.25, 0.70);

  if (sig.layer === 'confirm') {
    const maxImpulseRatio = runtimeNum('hl_momentum_confirm_max_impulse_ratio', CONFIRM_MAX_IMPULSE_RATIO, 1.05, 2.50);
    const impulseRatio = sig.metrics.impulseRatio;
    if (impulseRatio != null && impulseRatio > maxImpulseRatio) {
      return `confirm overextended ${impulseRatio.toFixed(2)}x > ${maxImpulseRatio.toFixed(2)}x`;
    }
    if (familyStats.n >= minSample && familyStats.avg < -0.25 && familyStats.wr < 0.35) {
      return `confirm family red n=${familyStats.n} avg=${familyStats.avg.toFixed(2)} wr=${(familyStats.wr * 100).toFixed(0)}%`;
    }
    return null;
  }

  const fastLiveEnabled = runtimeNum('hl_momentum_fast_live_enabled', 0, 0, 1) >= 0.5;
  if (!fastLiveEnabled) {
    return `fast live paused: shadow fast is unproven`;
  }
  if (familyStats.n < minSample) {
    return `fast shadow sample ${familyStats.n}/${minSample}`;
  }
  if (familyStats.avg < minAvg || familyStats.wr < minWr) {
    return `fast shadow red n=${familyStats.n} avg=${familyStats.avg.toFixed(2)} wr=${(familyStats.wr * 100).toFixed(0)}%`;
  }
  return null;
}

function posteriorWinProb(st: Pick<PerfStats, 'n' | 'wins'>, priorP = 0.5, priorN = PROB_PRIOR_N): number {
  return ((st.wins ?? 0) + priorP * priorN) / (st.n + priorN);
}

function calibratedContinuation(sig: Pick<MomentumSignal, 'coin' | 'side' | 'layer'>, modelProb: number): { prob: number; confidence: number } {
  const all = liveAllStatsStmt.get() ?? { n: 0, avg: null, wins: null, sum: null };
  const layer = layerStats(sig.layer);
  const recent = liveRecentStatsStmt.get(30) ?? { n: 0, avg: null, wins: null, sum: null };
  const coin = liveCoinSideStatsStmt.get(sig.coin, sig.side) ?? { n: 0, avg: null, wins: null };

  const allW = clamp(all.n / 100, 0, 0.25);
  const layerW = clamp(layer.n / 60, 0, 0.22);
  const coinW = coin.n >= 3 ? clamp(coin.n / 30, 0, 0.12) : 0;
  const empiricalW = allW + layerW + coinW;
  const modelW = Math.max(0.18, MODEL_PROB_WEIGHT - empiricalW * 0.25);
  const baseW = Math.max(0, 1 - modelW - empiricalW);

  let p = baseW * 0.5
    + modelW * modelProb
    + allW * posteriorWinProb(all)
    + layerW * posteriorWinProb(layer)
    + coinW * posteriorWinProb(coin);

  if (all.n >= 12 && (all.avg ?? 0) < 0) p = Math.min(p, 0.58);
  if (layer.n >= 6 && (layer.avg ?? 0) < 0) p = Math.min(p, 0.56);
  if (recent.n >= 10 && (recent.avg ?? 0) < 0) p = Math.min(p, 0.55);

  return {
    prob: Math.round(clamp(p, 0.35, 0.72) * 10000) / 10000,
    confidence: Math.round(clamp(empiricalW, 0, 0.59) * 1000) / 1000,
  };
}

function scoreSignal(sig: Omit<MomentumSignal, 'score' | 'modelProb' | 'prob' | 'probConfidence' | 'expectedPnl'>, params: RiskParams): MomentumSignal {
  const m = sig.metrics;
  const vol5m = Math.max(0.12, m.vol5mPct ?? params.volPct * 100);
  const moveStrength = sig.layer === 'fast'
    ? ((Math.abs(m.r90 ?? 0) / Math.max(0.1, vol5m)) * 16) + ((Math.abs(m.fromLast ?? 0) / Math.max(0.1, vol5m)) * 12)
    : ((Math.abs(m.r3 ?? 0) / Math.max(0.1, vol5m * Math.sqrt(3))) * 22);
  const trendStrength = Math.min(14, Math.abs(m.r12 ?? 0) / Math.max(0.1, vol5m) * 5);
  const volumeStrength = m.volRatio != null ? clamp((m.volRatio - 1) * 10, -4, 16) : 0;
  const edge = m.closeNearHigh == null ? 0 : sig.side === 'long'
    ? clamp((m.closeNearHigh - 0.5) * 18, -8, 8)
    : clamp((0.5 - m.closeNearHigh) * 18, -8, 8);
  const extensionPenalty = Math.max(0, ((m.extensionPct ?? 0) / Math.max(0.1, params.stopPct * 100) - MAX_EXTENSION_R_MULT) * 16);
  const coinAdj = coinQualityAdj(sig.coin, sig.side);
  const raw = 48 + moveStrength + trendStrength + volumeStrength + edge + coinAdj - extensionPenalty;
  const score = Math.round(clamp(raw, 0, 100));
  const modelProb = Math.round(modelContinuationProb(score) * 10000) / 10000;
  const calibrated = calibratedContinuation(sig, modelProb);
  const p = Math.round(clamp(calibrated.prob + learnedProbBias(), 0.30, 0.72) * 10000) / 10000;
  const winPnl = (params.trailMinLockPct * 100) - COST_RT_PCT;
  const lossPnl = params.stopPct * 100 + COST_RT_PCT;
  const expectedPnl = Math.round((p * winPnl - (1 - p) * lossPnl + learnedEvBiasPct()) * 1000) / 1000;
  return { ...sig, score, modelProb, prob: p, probConfidence: calibrated.confidence, expectedPnl };
}

function appendScoreSignal(signal: string, sig: MomentumSignal): string {
  return `${signal} [score=${sig.score} p=${sig.prob.toFixed(3)} mp=${sig.modelProb.toFixed(3)} pc=${sig.probConfidence.toFixed(2)} ev=${sig.expectedPnl.toFixed(2)} layer=${sig.layer}]`;
}

function kellyFraction(sig: MomentumSignal, params: RiskParams): number {
  const p = sig.prob;
  const q = 1 - p;
  const winPct = (params.trailMinLockPct * 100) - COST_RT_PCT;
  const lossPct = params.stopPct * 100 + COST_RT_PCT;
  const b = lossPct > 0 ? winPct / lossPct : 0;
  if (!(b > 0)) return 0;
  return clamp((b * p - q) / b, 0, 1);
}

function statWinRate(st: Pick<PerfStats, 'n' | 'wins'>): number {
  return st.n > 0 ? (st.wins ?? 0) / st.n : 0;
}

function liveKellyConfidence(sig: MomentumSignal): { confidence: number; reason: string } {
  const all = liveAllStatsStmt.get() ?? { n: 0, avg: null, wins: null, sum: null };
  const layer = layerStats(sig.layer);
  const recent = liveRecentStatsStmt.get(30) ?? { n: 0, avg: null, wins: null, sum: null };
  const coin = liveCoinSideStatsStmt.get(sig.coin, sig.side) ?? { n: 0, avg: null, wins: null };

  const allAvg = all.avg ?? 0;
  const layerAvg = layer.avg ?? 0;
  const recentAvg = recent.avg ?? 0;
  if (all.n < KELLY_MIN_LIVE_SAMPLE) return { confidence: 0, reason: `sample ${all.n}/${KELLY_MIN_LIVE_SAMPLE}` };
  if (layer.n < KELLY_MIN_LAYER_SAMPLE) return { confidence: 0, reason: `${sig.layer} sample ${layer.n}/${KELLY_MIN_LAYER_SAMPLE}` };
  if (allAvg <= 0 || layerAvg <= 0 || recentAvg <= 0) {
    return { confidence: 0, reason: `edge not proven avg=${allAvg.toFixed(2)} layer=${layerAvg.toFixed(2)} recent=${recentAvg.toFixed(2)}` };
  }

  const sampleConfidence = clamp((all.n - KELLY_MIN_LIVE_SAMPLE) / 70, 0, 1);
  const layerConfidence = clamp((layer.n - KELLY_MIN_LAYER_SAMPLE) / 40, 0, 1);
  const quality = clamp(((statWinRate(all) - 0.48) / 0.20 + (allAvg / 0.35)) / 2, 0, 1);
  const coinPenalty = coin.n >= 3 && (coin.avg ?? 0) < 0 ? 0.55 : 1;
  const confidence = clamp((0.45 * sampleConfidence + 0.30 * layerConfidence + 0.25 * quality) * coinPenalty, 0, 1);
  return { confidence, reason: `conf=${confidence.toFixed(2)} n=${all.n} layer=${layer.n}` };
}

async function liveSizing(sig: MomentumSignal, params: RiskParams): Promise<LiveSizing> {
  const minNotional = runtimeNum('hl_momentum_min_notional_usd', LIVE_MIN_NOTIONAL_USD, 4, LIVE_NOTIONAL_USD);
  const maxNotional = runtimeNum('hl_momentum_max_notional_usd', LIVE_MAX_NOTIONAL_USD, minNotional, 60);
  const baseNotional = runtimeNum('hl_momentum_base_notional_usd', LIVE_NOTIONAL_USD, minNotional, maxNotional);
  const kellyOn = runtimeNum('hl_momentum_kelly_enabled', 1, 0, 1) >= 0.5;
  if (!kellyOn) return { notionalUsd: baseNotional, kellyFraction: 0, confidence: 0, equityUsd: null, source: 'fallback' };
  const eq = await hlAccountValue();
  if (!eq.ok || eq.degraded || !(eq.data > 0)) {
    logger.warn({ msg: eq.ok ? 'equity read degraded' : eq.msg }, 'hl-momentum-live: Kelly sizing fallback');
    return { notionalUsd: baseNotional, kellyFraction: 0, confidence: 0, equityUsd: eq.ok ? eq.data : null, source: 'fallback' };
  }
  const trust = liveKellyConfidence(sig);
  const k = kellyFraction(sig, params) * trust.confidence;
  const riskScale = runtimeNum('hl_momentum_kelly_risk_scale', KELLY_RISK_SCALE, 0.0001, 0.01);
  const riskUsd = eq.data * k * riskScale;
  const rawNotional = params.stopPct > 0 ? riskUsd / (params.stopPct + COST_RT_PCT / 100) : baseNotional;
  const trustedMaxNotional = minNotional + (maxNotional - minNotional) * trust.confidence;
  const fallbackNotional = Math.min(baseNotional, trustedMaxNotional || minNotional);
  const notionalUsd = k > 0 ? clamp(rawNotional, minNotional, trustedMaxNotional) : fallbackNotional;
  if (trust.confidence <= 0) {
    logger.info({ coin: sig.coin, side: sig.side, reason: trust.reason }, 'hl-momentum-live: Kelly held at minimum until edge is proven');
  }
  return {
    notionalUsd: Math.round(notionalUsd * 100) / 100,
    kellyFraction: Math.round(k * 10000) / 10000,
    confidence: Math.round(trust.confidence * 1000) / 1000,
    equityUsd: Math.round(eq.data * 100) / 100,
    source: 'kelly',
  };
}

function appendSizingSignal(signal: string, sizing: LiveSizing): string {
  return `${signal} [size=${sizing.notionalUsd.toFixed(2)} k=${sizing.kellyFraction.toFixed(3)} conf=${sizing.confidence.toFixed(2)} eq=${sizing.equityUsd != null ? sizing.equityUsd.toFixed(2) : 'na'} src=${sizing.source}]`;
}

function recordSignal(sig: MomentumSignal, decision: 'paper' | 'live-open' | 'skip', reason: string, px: { ref?: number | null; signal?: number | null; spreadPct?: number | null; sideDepthUsd?: number | null; sizing?: LiveSizing | null } = {}): void {
  try {
    const pf = portfolioState(sig.side);
    insSignalJournalStmt.run(
      Date.now(), sig.coin, sig.side, sig.layer, sig.score, sig.expectedPnl, decision, reason,
      px.ref ?? null, px.signal ?? null,
      sig.metrics.r30 ?? null, sig.metrics.r90 ?? null, sig.metrics.r3 ?? null, sig.metrics.r12 ?? null,
      sig.metrics.fromLast ?? null, sig.metrics.volRatio ?? null,
      px.spreadPct ?? null, px.sideDepthUsd ?? null,
      pf.total, pf.sameSide, sig.signal,
      px.sizing?.notionalUsd ?? null, px.sizing?.kellyFraction ?? null, px.sizing?.equityUsd ?? null,
      sig.modelProb, sig.prob, sig.probConfidence, px.sizing?.confidence ?? null,
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, coin: sig.coin, decision }, 'hl-momentum: signal journal write failed');
  }
}

function preTradeGate(sig: MomentumSignal, params: RiskParams): string | null {
  const minScore = runtimeNum('hl_momentum_min_live_score', MIN_LIVE_SCORE, 45, 95);
  const minEv = runtimeNum('hl_momentum_min_expected_pnl_pct', MIN_EXPECTED_PNL_PCT, -0.25, 1.5);
  const minProb = runtimeNum('hl_momentum_min_calibrated_prob', MIN_CALIBRATED_PROB, 0.35, 0.65);
  if (sig.score < minScore) return `score ${sig.score} < ${minScore}`;
  if (sig.prob < minProb) return `p ${sig.prob.toFixed(3)} < ${minProb.toFixed(3)}`;
  if (sig.expectedPnl < minEv) return `ev ${sig.expectedPnl.toFixed(2)}% < ${minEv.toFixed(2)}%`;
  const shadowGate = shadowProofGate(sig);
  if (shadowGate) return shadowGate;
  const extensionR = (sig.metrics.extensionPct ?? 0) / Math.max(0.1, params.stopPct * 100);
  if (extensionR > MAX_EXTENSION_R_MULT && sig.score < HIGH_SCORE_OVERRIDE) return `late extension ${extensionR.toFixed(2)}R`;
  const pf = portfolioState(sig.side);
  const maxSameSide = Math.round(runtimeNum('hl_momentum_max_same_side', MAX_LIVE_SAME_SIDE, 1, 10));
  if (pf.sameSide >= maxSameSide) return `max same side ${sig.side} ${pf.sameSide}/${maxSameSide}`;
  if (pf.sameSide >= MAX_LIVE_SAME_SIDE && sig.score < HIGH_SCORE_OVERRIDE) return `portfolio crowding ${sig.side} ${pf.sameSide}`;
  const clustered = recentSideCluster(sig.side);
  if (clustered >= MAX_CLUSTER_SAME_SIDE) return `impulse cluster ${sig.side} ${clustered}/${MAX_CLUSTER_SAME_SIDE}`;
  if (Date.now() - lastRegime.ts < 20_000) {
    if (sig.side === 'long' && lastRegime.label === 'risk-off' && sig.score < HIGH_SCORE_OVERRIDE) return `regime risk-off breadth ${lastRegime.down}`;
    if (sig.side === 'short' && lastRegime.label === 'risk-on' && sig.score < HIGH_SCORE_OVERRIDE) return `regime risk-on breadth ${lastRegime.up}`;
    const crowdedWithMarket = (sig.side === 'long' && lastRegime.up >= REGIME_BREADTH_WARN) || (sig.side === 'short' && lastRegime.down >= REGIME_BREADTH_WARN);
    if (crowdedWithMarket && pf.sameSide >= 2 && sig.score < HIGH_SCORE_OVERRIDE) return `systemic ${sig.side} crowding breadth ${sig.side === 'long' ? lastRegime.up : lastRegime.down}`;
  }
  return null;
}

async function liveLiquidityCheck(coin: string, side: Side, notionalUsd: number): Promise<{ ok: true; spreadPct: number; sideDepthUsd: number } | { ok: false; reason: string }> {
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
    if (notionalUsd / sideDepthUsd > LIVE_MAX_NOTIONAL_TO_DEPTH) return { ok: false, reason: `order/depth ${(notionalUsd / sideDepthUsd * 100).toFixed(1)}% > ${(LIVE_MAX_NOTIONAL_TO_DEPTH * 100).toFixed(0)}%` };
    return { ok: true, spreadPct, sideDepthUsd };
  } catch (err) {
    return { ok: false, reason: `book read failed: ${(err as Error).message}` };
  }
}

function signalVolumeRatio(coin: string, cs: Candle[], endExclusive: number): number {
  const last = cs[endExclusive]!;
  const volBase = avgVolume(cs, endExclusive, 48);
  if (last.v > 0 && volBase > 0) return last.v / volBase;

  const five = getFiveMinuteCandles(coin, 60);
  if (five.length < 12) return 1;
  const i5 = five.length - 1;
  const fiveBase = avgVolume(five, i5, 48);
  return fiveBase > 0 ? five[i5]!.v / fiveBase : 1;
}

function decide(coin: string, cs: Candle[]): MomentumSignal | null {
  if (cs.length < 70) return null;
  const i = cs.length - 1;
  const last = cs[i]!;
  const r3 = pct(cs[i - 3]!.c, last.c);
  const r12 = pct(cs[i - 12]!.c, last.c);
  const stepMs = candleStepMs(cs);
  const contextBars = stepMs <= ONE_MINUTE_MS * 1.5 ? 60 : 12;
  const h1 = i >= contextBars ? pct(cs[i - contextBars]!.c, last.c) : r12;
  const volRatio = signalVolumeRatio(coin, cs, i);
  const closeNearHigh = (last.c - last.l) / Math.max(1e-12, last.h - last.l);
  const th = adaptiveThresholds(cs, last.t);
  const params = riskParams(cs, last.t);
  const baseMetrics: SignalMetrics = {
    r3, r12, volRatio, closeNearHigh, vol5mPct: th.vol5mPct,
    extensionPct: Math.abs(r3),
    impulseRatio: Math.abs(r3) / Math.max(0.1, th.impulse3Pct),
    h1Ratio: Math.abs(h1) / Math.max(0.1, th.trend1hPct),
  };

  if (r3 >= th.impulse3Pct && r12 >= th.trend1hPct && h1 >= -th.fastMaxAgainst1hPct && volRatio >= th.volRatioMin && closeNearHigh >= th.longCloseMin) {
    return scoreSignal({ coin, side: 'long', layer: 'confirm', metrics: baseMetrics, signal: `${coin} up impulse r3=${r3.toFixed(2)} r12m=${r12.toFixed(2)} h1=${h1.toFixed(2)} ir=${baseMetrics.impulseRatio?.toFixed(2)} vol=${volRatio.toFixed(1)}x close=${closeNearHigh.toFixed(2)} tf=${Math.round(stepMs / 60_000)}m [${thSignal(th)}]` }, params);
  }
  if (r3 <= -th.impulse3Pct && r12 <= -th.trend1hPct && h1 <= th.fastMaxAgainst1hPct && volRatio >= th.volRatioMin && closeNearHigh <= th.shortCloseMax) {
    return scoreSignal({ coin, side: 'short', layer: 'confirm', metrics: baseMetrics, signal: `${coin} down impulse r3=${r3.toFixed(2)} r12m=${r12.toFixed(2)} h1=${h1.toFixed(2)} ir=${baseMetrics.impulseRatio?.toFixed(2)} vol=${volRatio.toFixed(1)}x close=${closeNearHigh.toFixed(2)} tf=${Math.round(stepMs / 60_000)}m [${thSignal(th)}]` }, params);
  }
  return null;
}

type MidPoint = { t: number; px: number };
type EarlySignal = MomentumSignal & { last: Candle; params: RiskParams };
const midHistory = new Map<string, MidPoint[]>();
const earlyCooldown = new Map<string, number>();
const liveFastBestPx = new Map<string, number>();
const liveFastClosing = new Set<string>();
const liveEntryFailCooldown = new Map<string, number>();
let lastRegime: { ts: number; up: number; down: number; label: 'risk-on' | 'risk-off' | 'mixed' } = { ts: 0, up: 0, down: 0, label: 'mixed' };
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

function fastBreakoutGate(side: Side, mid: number, cs: Candle[]): string | null {
  const lookback = fastBreakoutLookback();
  if (lookback <= 0 || cs.length < lookback + 2) return null;
  const bufferPct = fastBreakoutBufferPct();
  const prev = cs.slice(Math.max(0, cs.length - lookback - 1), cs.length - 1);
  if (prev.length < lookback) return null;

  if (side === 'long') {
    const level = Math.max(...prev.map((c) => c.c)) * (1 + bufferPct / 100);
    return mid >= level ? null : `fast long no breakout ${mid.toFixed(6)} < prev${lookback} close ${level.toFixed(6)}`;
  }

  const level = Math.min(...prev.map((c) => c.c)) * (1 - bufferPct / 100);
  return mid <= level ? null : `fast short no breakdown ${mid.toFixed(6)} > prev${lookback} close ${level.toFixed(6)}`;
}

function updateMarketRegime(mids: Map<string, number>, now: number): void {
  let up = 0;
  let down = 0;
  for (const [coin, mid] of mids) {
    const r90 = pctFromMid(coin, mid, now, 90_000);
    if (r90 == null) continue;
    if (r90 >= REGIME_MOVE_90S_PCT) up++;
    else if (r90 <= -REGIME_MOVE_90S_PCT) down++;
  }
  const label = up >= REGIME_BREADTH_WARN && up > down * 1.5 ? 'risk-on'
    : down >= REGIME_BREADTH_WARN && down > up * 1.5 ? 'risk-off'
      : 'mixed';
  lastRegime = { ts: now, up, down, label };
}

function earlyImpulse(coin: string, mid: number, now: number, cs: Candle[]): EarlySignal | null {
  if (cs.length < 70) return null;
  const last = cs.at(-1)!;
  const stepMs = candleStepMs(cs);
  const maxAge = stepMs <= ONE_MINUTE_MS * 1.5 ? FRESH_1M_CANDLE_MAX_AGE_MS : FRESH_CANDLE_MAX_AGE_MS;
  if (now - last.t > maxAge) return null;
  const r30 = pctFromMid(coin, mid, now, 30_000);
  const r90 = pctFromMid(coin, mid, now, 90_000);
  if (r30 == null || r90 == null) return null;
  const r12 = pct(cs[cs.length - 13]!.c, last.c);
  const contextBars = stepMs <= ONE_MINUTE_MS * 1.5 ? 60 : 12;
  const h1 = cs.length > contextBars ? pct(cs[cs.length - 1 - contextBars]!.c, last.c) : r12;
  const fromLast = pct(last.c, mid);
  const params = riskParams(cs, now);
  const th = adaptiveThresholds(cs, now);
  const fromLabel = `from${Math.round(stepMs / 60_000)}m`;
  const fastMetrics = (side: Side): SignalMetrics => ({
    r30, r90, r12, fromLast, vol5mPct: th.vol5mPct,
    extensionPct: Math.abs(fromLast) + Math.max(0, Math.abs(r90) - th.fast90Pct),
    fast30Ratio: Math.abs(r30) / Math.max(0.1, th.fast30Pct),
    fast90Ratio: Math.abs(r90) / Math.max(0.1, th.fast90Pct),
    fastFromRatio: Math.abs(fromLast) / Math.max(0.1, th.fastFromLastPct),
    h1Ratio: Math.abs(h1) / Math.max(0.1, th.trend1hPct),
    closeNearHigh: side === 'long' ? 1 : 0,
  });
  const up = r30 >= th.fast30Pct
    && r90 >= th.fast90Pct
    && fromLast >= th.fastFromLastPct
    && h1 >= -th.fastMaxAgainst1hPct;
  if (up) {
    const structureBlock = fastBreakoutGate('long', mid, cs);
    if (structureBlock) return null;
    const scored = scoreSignal({
      coin,
      side: 'long',
      layer: 'fast',
      metrics: fastMetrics('long'),
      signal: `${coin} fast up radar r30=${r30.toFixed(2)} r90=${r90.toFixed(2)} ${fromLabel}=${fromLast.toFixed(2)} h1=${h1.toFixed(2)} [${thSignal(th)}]`,
    }, params);
    return { ...scored, last: { ...last, t: now, h: Math.max(last.h, mid), l: Math.min(last.l, mid), c: mid }, params };
  }
  const down = r30 <= -th.fast30Pct
    && r90 <= -th.fast90Pct
    && fromLast <= -th.fastFromLastPct
    && h1 <= th.fastMaxAgainst1hPct;
  if (down) {
    const structureBlock = fastBreakoutGate('short', mid, cs);
    if (structureBlock) return null;
    const scored = scoreSignal({
      coin,
      side: 'short',
      layer: 'fast',
      metrics: fastMetrics('short'),
      signal: `${coin} fast down radar r30=${r30.toFixed(2)} r90=${r90.toFixed(2)} ${fromLabel}=${fromLast.toFixed(2)} h1=${h1.toFixed(2)} [${thSignal(th)}]`,
    }, params);
    return { ...scored, last: { ...last, t: now, h: Math.max(last.h, mid), l: Math.min(last.l, mid), c: mid }, params };
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
  const decayed = trail ? decayExit(pos, last.c, trail.movePct / 100, params, last.t) : false;
  const timed = last.t - pos.opened_at >= (trail?.active ? TRAIL_HOLD_MS : HOLD_MS);

  if (!stopHit && !trailHit && !decayed && !timed) return false;

  // Conservative same-bar ordering: hard stop before profit trail.
  const reason = stopHit ? 'stop' : trailHit ? 'trailing-stop' : decayed ? 'momentum-decay' : 'time-stop';
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
    const reason = classifyRecoveredFlat(pos, exitPx, cs);
    liveCloseTxn(pos.coin, exitPx, Date.now(), pnl, reason);
    logger.warn({ coin: pos.coin, exitPx, pnl, reason }, 'hl-momentum-live: exchange flat -> reconciled');
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
  const decayed = trail ? decayExit(pos, last.c, trail.movePct / 100, params, last.t) : false;
  const timed = last.t - pos.opened_at >= (trail?.active ? TRAIL_HOLD_MS : HOLD_MS);
  if (!stopHit && !trailHit && !decayed && !timed) {
    if (trail?.active && trail.trailPx != null) await refreshLiveStop(pos, ex.data.size, trail.trailPx, 'trail');
    return;
  }

  const reason = stopHit ? 'stop' : trailHit ? 'trailing-stop' : decayed ? 'momentum-decay' : 'time-stop';
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
    text: `${pnl >= 0 ? '🟢' : '🔴'} <b>momentum-live CLOSED</b>: ${esc(pos.coin)} ${pos.side} <b>${pnl > 0 ? '+' : ''}${pnl}%</b> (${esc(reason)})\n${pos.entry_px} → ${exit.toFixed(6)}${trail?.active ? `\ntrail best ${trail.bestPx.toFixed(6)} · protected ${trail.trailPx?.toFixed(6)}` : ''}`,
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
    if (!close.ok) {
      const checkFlat = await hlFetchPosition(pos.coin);
      if (checkFlat.ok && !checkFlat.data) {
        liveFastBestPx.delete(pos.coin);
        logger.warn({ coin: pos.coin, msg: close.msg, reason }, 'hl-momentum-fast: close skipped because exchange is already flat');
        return;
      }
      logger.error({ coin: pos.coin, msg: close.msg, reason }, 'hl-momentum-fast: close failed');
      return;
    }
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
      text: `${pnl >= 0 ? '🟢' : '🔴'} <b>momentum-fast CLOSED</b>: ${esc(pos.coin)} ${pos.side} <b>${pnl > 0 ? '+' : ''}${pnl}%</b> (${esc(reason)})\n${pos.entry_px} → ${exit.toFixed(6)}${trail?.active ? `\nfast trail best ${trail.bestPx.toFixed(6)} · protected ${trail.trailPx?.toFixed(6)}` : ''}`,
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
    const decayed = decayExit(pos, mid, trail.movePct / 100, params, Date.now());
    const timed = Date.now() - pos.opened_at >= (trail.active ? TRAIL_HOLD_MS : HOLD_MS);
    if (!stopHit && !trailHit && !decayed && !timed) continue;
    await fastCloseLivePosition(pos, stopHit ? 'fast-stop' : trailHit ? 'fast-trailing-stop' : decayed ? 'fast-momentum-decay' : 'fast-time-stop', mid, trail);
  }
}

async function liveMaybeOpen(coin: string, sig: MomentumSignal, last: Candle, params: RiskParams): Promise<void> {
  if (!LIVE_ENABLED) return;
  if (liveFastClosing.has(coin)) return;
  const nowMs = Date.now();
  const cooldownUntil = liveEntryFailCooldown.get(coin) ?? 0;
  if (cooldownUntil > nowMs) { recordSignal(sig, 'skip', `entry cooldown ${Math.ceil((cooldownUntil - nowMs) / 1000)}s`, { ref: last.c, signal: last.c }); return; }
  const pnlStart = liveDailyPnlStart(nowMs);
  const dailyStopUsd = liveDailyStopUsd();
  if (dailyStopUsd != null) {
    const sessionUsd = liveSessionUsdStmt.get(pnlStart)?.usd ?? 0;
    if (sessionUsd <= dailyStopUsd) { recordSignal(sig, 'skip', `session dollar stop $${sessionUsd.toFixed(2)} <= $${dailyStopUsd.toFixed(2)}`); return; }
  } else {
    const dayPnl = liveTodayPnlStmt.get(pnlStart)?.pnl ?? 0;
    const dailyStopPct = liveDailyStopPct();
    if (dayPnl <= dailyStopPct) { recordSignal(sig, 'skip', `daily stop ${dayPnl.toFixed(2)} <= ${dailyStopPct}`); return; }
  }
  if (liveGetPosStmt.get(coin)) { recordSignal(sig, 'skip', 'live position already open'); return; }
  const maxOpen = liveMaxOpen();
  if (liveAllPosStmt.all().length >= maxOpen) { recordSignal(sig, 'skip', `max live open ${maxOpen}`); return; }
  if (wickOpenPosStmt.get(coin)) { recordSignal(sig, 'skip', 'wick-fade has coin'); return; }
  const gate = preTradeGate(sig, params);
  if (gate) { recordSignal(sig, 'skip', gate, { ref: last.c, signal: last.c }); return; }

  const ex = await hlFetchPosition(coin);
  if (!ex.ok) { recordSignal(sig, 'skip', `position read failed: ${ex.msg}`); logger.warn({ coin, msg: ex.msg }, 'hl-momentum-live: position read failed before entry'); return; }
  if (ex.data) { recordSignal(sig, 'skip', 'exchange position already open'); return; } // shared one-way account: never stack on an existing live position

  const sizing = await liveSizing(sig, params);
  const sizedSig: MomentumSignal = { ...sig, signal: appendSizingSignal(sig.signal, sizing) };
  const liq = await liveLiquidityCheck(coin, sig.side, sizing.notionalUsd);
  if (!liq.ok) {
    recordSignal(sizedSig, 'skip', `liquidity: ${liq.reason}`, { ref: last.c, signal: last.c, sizing });
    logger.info({ coin, side: sig.side, reason: liq.reason, notionalUsd: sizing.notionalUsd, signal: sizedSig.signal }, 'hl-momentum-live: signal skipped by liquidity filter');
    return;
  }

  liveLock(coin, `momentum-live pending ${sig.side}`);
  const cancelled = await cancelCoinOrders(coin);
  if (!cancelled) { recordSignal(sizedSig, 'skip', 'cancel resting orders failed', { ref: last.c, signal: last.c, spreadPct: liq.spreadPct, sideDepthUsd: liq.sideDepthUsd, sizing }); liveDelLockStmt.run(coin); return; }

  const lev = await hlSetLeverage(coin, LIVE_LEVERAGE);
  if (!lev.ok) { recordSignal(sizedSig, 'skip', `leverage failed: ${lev.msg}`, { ref: last.c, signal: last.c, spreadPct: liq.spreadPct, sideDepthUsd: liq.sideDepthUsd, sizing }); liveDelLockStmt.run(coin); logger.warn({ coin, msg: lev.msg }, 'hl-momentum-live: leverage failed'); return; }
  const qty = sizing.notionalUsd / last.c;
  const order = await hlMarketOrder({ coin, side: sig.side, qty });
  if (!order.ok) {
    liveEntryFailCooldown.set(coin, Date.now() + ENTRY_FAIL_COOLDOWN_MS);
    recordSignal(sizedSig, 'skip', `entry failed: ${order.msg}`, { ref: last.c, signal: last.c, spreadPct: liq.spreadPct, sideDepthUsd: liq.sideDepthUsd, sizing });
    liveDelLockStmt.run(coin);
    logger.error({ coin, side: sig.side, msg: order.msg, notionalUsd: sizing.notionalUsd }, 'hl-momentum-live: entry failed');
    return;
  }

  const pos = await hlFetchPosition(coin);
  if (!pos.ok || !pos.data || pos.data.side !== sig.side) {
    liveEntryFailCooldown.set(coin, Date.now() + ENTRY_FAIL_COOLDOWN_MS);
    recordSignal(sizedSig, 'skip', 'entry not confirmed', { ref: last.c, signal: last.c, spreadPct: liq.spreadPct, sideDepthUsd: liq.sideDepthUsd, sizing });
    logger.error({ coin, side: sig.side, pos: pos.ok ? pos.data : pos.msg }, 'hl-momentum-live: entry not confirmed');
    liveDelLockStmt.run(coin);
    return;
  }

  const openedAt = Date.now();
  const stop = stopPx(sig.side, pos.data.entryPx, params);
  const st = await hlPlaceStop({ coin, posSide: sig.side, qty: pos.data.size, triggerPx: stop });
  if (!st.ok) logger.error({ coin, msg: st.msg }, 'hl-momentum-live: exchange stop failed - poll is backup');
  liveOpenTxn(coin, sig.side, pos.data.entryPx, pos.data.size, openedAt, sizedSig.signal);
  liveLock(coin, `momentum-live ${sig.side}`);
  recordSignal(sizedSig, 'live-open', 'opened', { ref: last.c, signal: pos.data.entryPx, spreadPct: liq.spreadPct, sideDepthUsd: liq.sideDepthUsd, sizing });
  logger.warn({ coin, side: sig.side, entry: pos.data.entryPx, notionalUsd: sizing.notionalUsd, kellyFraction: sizing.kellyFraction, equityUsd: sizing.equityUsd, stop, exStop: st.ok, spreadPct: liq.spreadPct, sideDepthUsd: liq.sideDepthUsd, score: sig.score, expectedPnl: sig.expectedPnl, params, signal: sizedSig.signal }, 'hl-momentum-live: OPENED real position');
  void sendMessage({
    channel: 'logs',
    text: `🧭 <b>momentum-live OPENED</b>: ${esc(coin)} ${sig.side} @${pos.data.entryPx}\nстоп ${stop.toFixed(6)} (${pctNum(params.stopPct)}%) ${st.ok ? '(на бирже ✅)' : '(⚠️ только полл!)'} · trail after ${pctNum(params.trailActivatePct)}%, откат ${pctNum(params.trailGivebackPct)}%, lock ${pctNum(params.trailMinLockPct)}% · R:R ≥ 1:${MIN_RISK_REWARD}\n~$${sizing.notionalUsd.toFixed(2)} Kelly · k=${sizing.kellyFraction.toFixed(3)} · liq: spread ${liq.spreadPct.toFixed(2)}%, top3 $${liq.sideDepthUsd.toFixed(0)} · ${esc(sizedSig.signal)}`,
  });
}

async function stepCoin(coin: string): Promise<void> {
  const cs = getMomentumCandles(coin);
  if (cs.length < 70) return;
  const livePos = liveGetPosStmt.get(coin);
  if (livePos) await liveManagePosition(livePos, cs);

  const pos = getPosStmt.get(coin);
  const paperStillOpen = pos ? !managePosition(pos, cs) : false;

  const sig = decide(coin, cs);
  if (!sig) return;
  const last = cs.at(-1)!;
  const params = riskParams(cs, last.t);
  const fullSig: MomentumSignal = { ...sig, signal: appendRiskSignal(appendScoreSignal(sig.signal, sig), params) };
  if (!paperStillOpen && !getPosStmt.get(coin)) {
    const qty = NOTIONAL_USD / last.c;
    openTxn(coin, fullSig.side, last.c, qty, last.t, fullSig.signal);
    recordSignal(fullSig, 'paper', 'paper-open', { ref: last.c, signal: last.c });
    logger.info({ coin, side: fullSig.side, entry: +last.c.toFixed(6), score: fullSig.score, expectedPnl: fullSig.expectedPnl, params, signal: fullSig.signal }, 'hl-momentum-shadow: opened paper position');
  }
  if (!liveGetPosStmt.get(coin)) await liveMaybeOpen(coin, fullSig, last, params);
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
    `Статус: реальные деньги, all-market scan → score/EV/Kelly sizing → liquidity-filtered live, ~$${LIVE_MIN_NOTIONAL_USD}-${LIVE_MAX_NOTIONAL_USD}, 1x`,
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
    upsertHlMinuteCandlesFromMids(mids, now);
    updateMarketRegime(mids, now);
    await fastManageLivePositions(mids);

    if (now - lastFastAttemptAt < FAST_GLOBAL_ATTEMPT_GAP_MS) return;
    const candidates: EarlySignal[] = [];
    for (const [coin, mid] of mids) {
      if ((earlyCooldown.get(coin) ?? 0) > now) continue;
      if (liveGetPosStmt.get(coin) || getPosStmt.get(coin)) continue;
      const cs = getMomentumCandles(coin);
      const sig = earlyImpulse(coin, mid, now, cs);
      if (sig) candidates.push(sig);
    }
    candidates.sort((a, b) => (b.score - a.score) || (b.expectedPnl - a.expectedPnl));
    for (const sig of candidates.slice(0, FAST_MAX_CANDIDATES_PER_TICK)) {
      earlyCooldown.set(sig.coin, now + FAST_COIN_COOLDOWN_MS);
      lastFastAttemptAt = Date.now();
      const fullSig: EarlySignal = { ...sig, signal: appendRiskSignal(appendScoreSignal(sig.signal, sig), sig.params) };
      if (!getPosStmt.get(sig.coin)) {
        const qty = NOTIONAL_USD / sig.last.c;
        openTxn(fullSig.coin, fullSig.side, fullSig.last.c, qty, now, fullSig.signal);
        recordSignal(fullSig, 'paper', 'paper-open', { ref: sig.last.c, signal: sig.last.c });
        logger.info({ coin: fullSig.coin, side: fullSig.side, entry: +fullSig.last.c.toFixed(6), score: fullSig.score, expectedPnl: fullSig.expectedPnl, params: fullSig.params, signal: fullSig.signal }, 'hl-momentum-fast: opened paper position from mids radar');
      }
      if (!liveGetPosStmt.get(fullSig.coin)) await liveMaybeOpen(fullSig.coin, fullSig, fullSig.last, fullSig.params);
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
  logger.info({
    live: LIVE_ENABLED,
    liveNotionalMin: LIVE_MIN_NOTIONAL_USD,
    liveNotionalMax: LIVE_MAX_NOTIONAL_USD,
    liveLeverage: LIVE_LEVERAGE,
    liveMaxOpen: liveMaxOpen(),
    fastMidsPollMs: FAST_MIDS_POLL_MS,
    fastStrictMult: fastStrictMult(),
    fastBreakoutLookback: fastBreakoutLookback(),
    fastBreakoutBufferPct: fastBreakoutBufferPct(),
  }, 'hl-momentum scheduled (2s allMids radar + score/EV/Kelly sizing + filtered live micro)');
}
