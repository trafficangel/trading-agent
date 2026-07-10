import cron from 'node-cron';
import { db } from '../db/client.js';
import { HL_MOMENTUM_CALIBRATION_VERSION, robustCalibration } from '../lib/hl-momentum-calibration.js';
import {
  CONFIRM_LONG_CANARY_POLICY,
  FAST_LONG_CANARY_POLICY,
  MOMENTUM_PROMOTION_POLICY,
  evaluateMomentumPromotion,
  evaluateMomentumSegment,
  type MomentumSegmentLayer,
} from '../lib/hl-momentum-segment-governor.js';
import { logger } from '../lib/logger.js';
import { sendMessage } from '../telegram/bot.js';

type Side = 'long' | 'short';
type TradeRow = {
  id: number;
  coin: string;
  side: Side;
  entry_px: number;
  signal: string;
  pnl_pct: number;
  close_reason: string | null;
  opened_at: number;
  closed_at: number;
};
type CandleRow = { t: number; h: number; l: number; c: number; v: number };
type SimOut = { pnl: number; reason: 'stop' | 'trail' | 'decay' | 'time' | 'end' };
type Metrics = { mfe: number; mae: number; volRatio: number; atrPct: number; closeNearHigh: number };
type ProbBucket = { bucket: string; n: number; avg_score: number | null; avg_prob: number | null; avg_ev: number | null };
type CalibrationRow = {
  id: number;
  pnl_pct: number;
  raw_prob: number | null;
  raw_expected_pnl: number | null;
  layer: string | null;
  closed_at: number;
};
type GovernorRow = { side: Side; pnl_pct: number; signal: string; closed_at: number; ts?: number };
type PromotionRow = {
  pnl_pct: number;
  net_pnl_usd: number | null;
  pnl_source: string | null;
  closed_at: number;
};
type GovernorSignalWindow = { total: number; live_open: number | null; paper: number | null; skipped: number | null };
type GovernorStats = { n: number; avg: number; wr: number; sum: number };
type RejectedSignalRow = {
  id: number;
  ts: number;
  coin: string;
  side: Side;
  layer: string;
  reason: string;
  ref_px: number | null;
  signal_px: number | null;
  signal: string;
};
type RejectSimOut = SimOut & { exitPx: number; closedAt: number; mfe: number; mae: number; horizonMin: number };

const REPORT_KEY = 'hl_momentum_doctor_last_report_id';
const RISK_MODEL_VERSION = 'fade-reversal-v1';
const COST_RT_PCT = 0.07;
const MIN_RR = 2;
const HOLD_MS = 30 * 60_000;
const TRAIL_HOLD_MS = 60 * 60_000;
const DECAY_EXIT_MS = 6 * 60_000;
const DECAY_MIN_MFE_R = 0.35;
const DECAY_LOSS_R = 0.30;
const ONLINE_CALIBRATION_LOOKBACK = 80;
const ONLINE_CALIBRATION_MIN_SAMPLE = 30;
const ONLINE_PROB_BIAS_MIN = -0.08;
const ONLINE_PROB_BIAS_MAX = 0.05;
const ONLINE_PROB_BIAS_MAX_STEP = 0.01;
const ONLINE_EV_BIAS_MIN = -0.50;
const ONLINE_EV_BIAS_MAX = 0.30;
const ONLINE_EV_BIAS_MAX_STEP = 0.03;
const GOVERNOR_SHADOW_RECENT_N = 120;
const GOVERNOR_SEGMENT_SCAN_N = 300;
const CONFIRM_LONG_CANARY_TAG = 'canary=confirm-long-v1';
const FAST_LONG_CANARY_TAG = 'canary=fast-long-v1';
const GOVERNOR_SIGNAL_WINDOW_MS = 6 * 60 * 60_000;
const REJECTED_EVAL_MIN_AGE_MS = 35 * 60_000;
const REJECTED_EVAL_DEFAULT_HORIZON_MIN = 70;
const REJECTED_EVAL_LIMIT = 180;

const closedStmt = db.prepare<[number], TradeRow>(`
  SELECT id, coin, side, entry_px, signal, pnl_pct, close_reason, opened_at, closed_at
   FROM hl_momentum_live_log
  WHERE closed_at IS NOT NULL AND pnl_pct IS NOT NULL
   ORDER BY id DESC
   LIMIT ?
`);
const maxClosedIdStmt = db.prepare<[], { id: number | null }>('SELECT MAX(id) AS id FROM hl_momentum_live_log WHERE closed_at IS NOT NULL');
const preCandlesStmt = db.prepare<[string, number, number], CandleRow>(`
  SELECT t, h, l, c, v FROM hl_candles
   WHERE coin = ? AND t <= ?
   ORDER BY t DESC
   LIMIT ?
`);
const afterCandlesStmt = db.prepare<[string, number, number], CandleRow>(`
  SELECT t, h, l, c, v FROM hl_candles
   WHERE coin = ? AND t > ? AND t <= ?
   ORDER BY t ASC
`);
const afterMinuteCandlesStmt = db.prepare<[string, number, number], CandleRow>(`
  SELECT t, h, l, c, v FROM hl_candles_1m
   WHERE coin = ? AND t > ? AND t <= ?
   ORDER BY t ASC
`);
const getKvStmt = db.prepare<[string], { value: string }>('SELECT value FROM runtime_config WHERE key = ?');
const setKvStmt = db.prepare<[string, string, number, string], void>(`
  INSERT INTO runtime_config (key, value, updated_at, reason)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, reason = excluded.reason
`);
const insertCalibrationHistoryStmt = db.prepare<[
  number, string, number, number, number, number, number, number,
  number, number, number, number, number, number, number, number
], void>(`
  INSERT INTO hl_momentum_calibration_history
    (created_at, calibration_version, sample_n, last_closed_id,
     actual_wr, raw_pred_wr, actual_avg_pnl_pct, raw_pred_ev_pct,
     robust_ev_residual, residual_cap, target_prob_bias, target_ev_bias_pct,
     old_prob_bias, new_prob_bias, old_ev_bias_pct, new_ev_bias_pct)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const delKvStmt = db.prepare<[string], void>('DELETE FROM runtime_config WHERE key = ?');
const probBucketStmt = db.prepare<[], ProbBucket>(`
  SELECT CASE
           WHEN calibrated_prob < 0.50 THEN '<50%'
           WHEN calibrated_prob < 0.55 THEN '50-55%'
           WHEN calibrated_prob < 0.60 THEN '55-60%'
           ELSE '60%+'
         END AS bucket,
         COUNT(*) AS n,
         AVG(score) AS avg_score,
         AVG(calibrated_prob) AS avg_prob,
         AVG(expected_pnl) AS avg_ev
    FROM hl_momentum_signal_journal
   WHERE calibrated_prob IS NOT NULL
   GROUP BY bucket
   ORDER BY MIN(calibrated_prob)
`);
const calibrationRowsStmt = db.prepare<[string, number, number], CalibrationRow>(`
  SELECT l.id,
         l.pnl_pct,
         l.closed_at,
         j.raw_prob,
         j.raw_expected_pnl,
         j.layer
    FROM hl_momentum_live_log l
    JOIN hl_momentum_signal_journal j
      ON j.id = (
        SELECT j2.id
          FROM hl_momentum_signal_journal j2
         WHERE j2.decision = 'live-open'
           AND j2.signal = l.signal
           AND j2.calibration_version = ?
         ORDER BY j2.ts DESC
         LIMIT 1
      )
   WHERE l.closed_at IS NOT NULL
     AND l.pnl_pct IS NOT NULL
     AND l.opened_at >= ?
   ORDER BY l.closed_at DESC
   LIMIT ?
`);
const shadowGovernorRowsStmt = db.prepare<[number], GovernorRow>(`
  SELECT side, pnl_pct, signal, closed_at
    FROM hl_momentum_shadow_log
   WHERE closed_at IS NOT NULL AND pnl_pct IS NOT NULL
   ORDER BY closed_at DESC
   LIMIT ?
`);
const longSegmentRowsStmt = db.prepare<[string, number], GovernorRow>(`
  SELECT side, pnl_pct, signal, closed_at
    FROM hl_momentum_shadow_log
   WHERE closed_at IS NOT NULL
     AND pnl_pct IS NOT NULL
     AND side = 'long'
     AND signal LIKE ?
   ORDER BY closed_at DESC
   LIMIT ?
`);
const liveGovernorRowsStmt = db.prepare<[number], GovernorRow>(`
  SELECT side, pnl_pct, signal, closed_at
    FROM hl_momentum_live_log
   WHERE closed_at IS NOT NULL AND pnl_pct IS NOT NULL
   ORDER BY closed_at DESC
   LIMIT ?
`);
const canaryPromotionRowsStmt = db.prepare<[string], PromotionRow>(`
  SELECT pnl_pct, net_pnl_usd, pnl_source, closed_at
    FROM hl_momentum_live_log
   WHERE closed_at IS NOT NULL
     AND pnl_pct IS NOT NULL
     AND signal LIKE ?
   ORDER BY closed_at ASC
`);
const signalWindowStmt = db.prepare<[number], GovernorSignalWindow>(`
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN decision = 'live-open' THEN 1 ELSE 0 END) AS live_open,
         SUM(CASE WHEN decision = 'paper' THEN 1 ELSE 0 END) AS paper,
         SUM(CASE WHEN decision = 'skip' THEN 1 ELSE 0 END) AS skipped
    FROM hl_momentum_signal_journal
   WHERE ts >= ?
`);
const liveOpenCountStmt = db.prepare<[], { n: number; long_n: number | null; short_n: number | null }>(`
  SELECT COUNT(*) AS n,
         SUM(CASE WHEN side = 'long' THEN 1 ELSE 0 END) AS long_n,
         SUM(CASE WHEN side = 'short' THEN 1 ELSE 0 END) AS short_n
    FROM hl_momentum_live_pos
`);
const pendingRejectedSignalsStmt = db.prepare<[number, number], RejectedSignalRow>(`
  SELECT id, ts, coin, side, layer, reason, ref_px, signal_px, signal
    FROM hl_momentum_signal_journal
   WHERE decision = 'skip'
     AND counterfactual_closed_at IS NULL
     AND ts <= ?
     AND (signal_px IS NOT NULL OR ref_px IS NOT NULL)
   ORDER BY ts ASC
   LIMIT ?
`);
const updateRejectedOutcomeStmt = db.prepare<[number, number, number, string, number, number, number, number], void>(`
  UPDATE hl_momentum_signal_journal
     SET counterfactual_exit_px = ?,
         counterfactual_closed_at = ?,
         counterfactual_pnl_pct = ?,
         counterfactual_reason = ?,
         counterfactual_mfe_pct = ?,
         counterfactual_mae_pct = ?,
         counterfactual_horizon_min = ?
   WHERE id = ?
`);
const rejectedGovernorRowsStmt = db.prepare<[number, number], GovernorRow>(`
  SELECT side, counterfactual_pnl_pct AS pnl_pct, signal, counterfactual_closed_at AS closed_at, ts
    FROM hl_momentum_signal_journal
   WHERE decision = 'skip'
     AND counterfactual_pnl_pct IS NOT NULL
     AND counterfactual_closed_at IS NOT NULL
     AND ts >= ?
   ORDER BY counterfactual_closed_at DESC
   LIMIT ?
`);

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pct(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

function fmtPct(n: number, digits = 2): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function pnlPct(side: Side, entry: number, exit: number): number {
  return (side === 'long' ? pct(entry, exit) : pct(exit, entry)) - COST_RT_PCT;
}

function layerOf(signal: string): 'fast' | 'confirm' | 'unknown' {
  if (signal.includes('layer=fast')) return 'fast';
  if (signal.includes('layer=confirm')) return 'confirm';
  if (signal.includes('fast up radar') || signal.includes('fast down radar')) return 'fast';
  if (signal.includes('up impulse') || signal.includes('down impulse')) return 'confirm';
  return 'unknown';
}

function preCandles(coin: string, t: number, n = 70): CandleRow[] {
  return preCandlesStmt.all(coin, t, n).reverse();
}

function afterCandles(coin: string, t: number, horizonMin = 90): CandleRow[] {
  return afterCandlesStmt.all(coin, t, t + horizonMin * 60_000);
}

function afterCounterfactualCandles(coin: string, t: number, horizonMin: number): CandleRow[] {
  const end = t + horizonMin * 60_000;
  const one = afterMinuteCandlesStmt.all(coin, t, end);
  if (one.length >= 2) return one;
  return afterCandlesStmt.all(coin, t, end);
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((acc, x) => acc + x, 0) / xs.length : 0;
}

function atrPct(cs: CandleRow[], lookback = 24): number {
  const ranges: number[] = [];
  const from = Math.max(1, cs.length - lookback);
  for (let i = from; i < cs.length; i += 1) {
    const c = cs[i]!;
    const prev = cs[i - 1]!;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
    if (c.c > 0 && Number.isFinite(tr)) ranges.push((tr / c.c) * 100);
  }
  return median(ranges);
}

function metrics(t: TradeRow): Metrics | null {
  const pre = preCandles(t.coin, t.opened_at);
  const last = pre.at(-1);
  if (!last) return null;
  const after = afterCandles(t.coin, t.opened_at, 120);
  let best = t.entry_px;
  let worst = t.entry_px;
  for (const c of after) {
    if (t.side === 'long') {
      best = Math.max(best, c.h);
      worst = Math.min(worst, c.l);
    } else {
      best = Math.min(best, c.l);
      worst = Math.max(worst, c.h);
    }
  }
  const volBase = pre.length > 49 ? avg(pre.slice(-49, -1).map((c) => c.v)) : 0;
  return {
    mfe: t.side === 'long' ? pct(t.entry_px, best) : pct(best, t.entry_px),
    mae: t.side === 'long' ? pct(t.entry_px, worst) : pct(worst, t.entry_px),
    volRatio: volBase > 0 ? last.v / volBase : 0,
    atrPct: atrPct(pre),
    closeNearHigh: (last.c - Math.min(last.l, last.h)) / Math.max(1e-12, Math.abs(last.h - last.l)),
  };
}

function simulate(t: TradeRow): SimOut {
  const risk = parseRiskSignal(t.signal);
  const stopPct = risk.stopPct;
  const givebackPct = risk.trailGivebackPct;
  const lockPct = risk.trailMinLockPct;
  const activatePct = risk.trailActivatePct;
  const bars = afterCandles(t.coin, t.opened_at, 90);
  let best = t.entry_px;
  let active = false;

  for (const c of bars) {
    best = t.side === 'long' ? Math.max(best, c.h) : Math.min(best, c.l);
    const move = t.side === 'long' ? (best - t.entry_px) / t.entry_px : (t.entry_px - best) / t.entry_px;
    const currentMove = t.side === 'long' ? (c.c - t.entry_px) / t.entry_px : (t.entry_px - c.c) / t.entry_px;
    if (move >= activatePct) active = true;
    const stop = t.side === 'long' ? t.entry_px * (1 - stopPct) : t.entry_px * (1 + stopPct);
    const trail = t.side === 'long'
      ? Math.max(t.entry_px * (1 + lockPct), best * (1 - givebackPct))
      : Math.min(t.entry_px * (1 - lockPct), best * (1 + givebackPct));
    const stopHit = t.side === 'long' ? c.l <= stop : c.h >= stop;
    const trailHit = active ? (t.side === 'long' ? c.l <= trail : c.h >= trail) : false;
    const decayed = c.t - t.opened_at >= DECAY_EXIT_MS && move < stopPct * DECAY_MIN_MFE_R && currentMove <= -stopPct * DECAY_LOSS_R;
    const timed = c.t - t.opened_at >= (active ? TRAIL_HOLD_MS : HOLD_MS);
    if (stopHit || trailHit || decayed || timed) {
      const exit = stopHit ? stop : trailHit ? trail : c.c;
      return { pnl: pnlPct(t.side, t.entry_px, exit), reason: stopHit ? 'stop' : trailHit ? 'trail' : decayed ? 'decay' : 'time' };
    }
  }

  const last = bars.at(-1);
  return { pnl: last ? pnlPct(t.side, t.entry_px, last.c) : t.pnl_pct, reason: 'end' };
}

function scoreRiskModel(rows: TradeRow[]): { sum: number; wins: number; reasons: string } {
  const sims = rows.map((r) => simulate(r));
  const mix = new Map<string, number>();
  for (const s of sims) mix.set(s.reason, (mix.get(s.reason) ?? 0) + 1);
  return {
    sum: sims.reduce((acc, s) => acc + s.pnl, 0),
    wins: sims.filter((s) => s.pnl > 0).length,
    reasons: [...mix.entries()].map(([k, v]) => `${k} ${v}`).join(', '),
  };
}

function runtimeBool(key: string, fallback: boolean): boolean {
  const value = getKvStmt.get(key)?.value;
  if (value == null || value.trim() === '') return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) ? raw >= 0.5 : fallback;
}

function runtimeNum(key: string, fallback: number): number {
  const raw = Number(getKvStmt.get(key)?.value ?? fallback);
  return Number.isFinite(raw) ? raw : fallback;
}

function ensureRiskModelState(nowMs: number): string[] {
  const currentVersion = getKvStmt.get('hl_momentum_risk_model_version')?.value;
  const currentStart = Number(getKvStmt.get('hl_momentum_risk_model_start_ms')?.value ?? 0);
  if (currentVersion === RISK_MODEL_VERSION && currentStart > 0) {
    return [`• risk model ${RISK_MODEL_VERSION}: активен с ${new Date(currentStart).toISOString()}`];
  }

  const maxClosedId = maxClosedIdStmt.get()?.id ?? 0;
  const reason = `hl momentum risk model ${RISK_MODEL_VERSION} reset`;
  setKvStmt.run('hl_momentum_risk_model_version', RISK_MODEL_VERSION, nowMs, reason);
  setKvStmt.run('hl_momentum_risk_model_start_ms', String(nowMs), nowMs, reason);
  setKvStmt.run('hl_momentum_prob_bias', '0.0000', nowMs, `${reason}: reset stale probability bias`);
  setKvStmt.run('hl_momentum_ev_bias_pct', '0.0000', nowMs, `${reason}: reset stale EV bias`);
  setKvStmt.run('hl_momentum_calibration_last_closed_id', String(maxClosedId), nowMs, `${reason}: ignore old live calibration`);
  for (const key of ['hl_momentum_min_stop_pct', 'hl_momentum_max_stop_pct', 'hl_momentum_doctor_autotune_enabled']) {
    delKvStmt.run(key);
  }
  return [
    `• risk model ${currentVersion ?? 'none'} → ${RISK_MODEL_VERSION}: сброшены stale p/EV bias`,
    `• old live до #${maxClosedId} оставлен для отчёта, но не калибрует новую risk-модель`,
  ];
}

function ensureCalibrationState(nowMs: number): string[] {
  const currentVersion = getKvStmt.get('hl_momentum_calibration_version')?.value;
  const currentStart = Number(getKvStmt.get('hl_momentum_calibration_start_ms')?.value ?? 0);
  if (currentVersion === HL_MOMENTUM_CALIBRATION_VERSION && currentStart > 0) {
    return [`• calibration ${HL_MOMENTUM_CALIBRATION_VERSION}: активна с ${new Date(currentStart).toISOString()}`];
  }

  const maxClosedId = maxClosedIdStmt.get()?.id ?? 0;
  const reason = `hl momentum calibration ${HL_MOMENTUM_CALIBRATION_VERSION} reset`;
  setKvStmt.run('hl_momentum_calibration_version', HL_MOMENTUM_CALIBRATION_VERSION, nowMs, reason);
  setKvStmt.run('hl_momentum_calibration_start_ms', String(nowMs), nowMs, reason);
  setKvStmt.run('hl_momentum_online_calibration_enabled', '1', nowMs, reason);
  setKvStmt.run('hl_momentum_prob_bias', '0.0000', nowMs, `${reason}: neutral bootstrap`);
  setKvStmt.run('hl_momentum_ev_bias_pct', '0.0000', nowMs, `${reason}: neutral bootstrap`);
  for (const key of [
    'hl_momentum_calibration_sample_n',
    'hl_momentum_calibration_actual_wr',
    'hl_momentum_calibration_pred_wr',
    'hl_momentum_calibration_brier',
    'hl_momentum_calibration_actual_pnl_pct',
    'hl_momentum_calibration_pred_ev_pct',
    'hl_momentum_calibration_robust_ev_residual',
    'hl_momentum_calibration_residual_cap',
    'hl_momentum_calibration_target_prob_bias',
    'hl_momentum_calibration_target_ev_bias_pct',
  ]) {
    setKvStmt.run(key, '0', nowMs, reason);
  }
  setKvStmt.run('hl_momentum_calibration_last_closed_id', String(maxClosedId), nowMs, `${reason}: ignore old calibration sample`);
  return [
    `• calibration ${currentVersion ?? 'none'} → ${HL_MOMENTUM_CALIBRATION_VERSION}: neutral bias`,
    `• ждём ${ONLINE_CALIBRATION_MIN_SAMPLE} новых live-сделок; old live до #${maxClosedId} исключён`,
  ];
}

function moveToward(current: number, target: number, maxStep: number): number {
  const delta = clamp(target - current, -maxStep, maxStep);
  return Math.round((current + delta) * 10_000) / 10_000;
}

function parseRiskSignal(signal: string): { stopPct: number; trailActivatePct: number; trailGivebackPct: number; trailMinLockPct: number } {
  const m = signal.match(/\[risk stop=([\d.]+) act=([\d.]+) gb=([\d.]+) lock=([\d.]+)/);
  if (!m) return { stopPct: 0.015, trailActivatePct: 0.0327, trailGivebackPct: 0.002, trailMinLockPct: 0.0307 };
  const nums = m.slice(1, 5).map((v) => Number(v) / 100);
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) return { stopPct: 0.015, trailActivatePct: 0.0327, trailGivebackPct: 0.002, trailMinLockPct: 0.0307 };
  return {
    stopPct: nums[0]!,
    trailActivatePct: nums[1]!,
    trailGivebackPct: nums[2]!,
    trailMinLockPct: nums[3]!,
  };
}

function riskModelLines(rows: TradeRow[]): string[] {
  const risks = rows.map((r) => parseRiskSignal(r.signal));
  if (risks.length === 0) return ['• ждём сделки с risk-параметрами в сигнале'];
  const netRrs = risks.map((r) => {
    const netWin = r.trailMinLockPct * 100 - COST_RT_PCT;
    const netLoss = r.stopPct * 100 + COST_RT_PCT;
    return netLoss > 0 ? netWin / netLoss : 0;
  }).filter((x) => Number.isFinite(x) && x > 0);
  const p = (x: number) => `${(x * 100).toFixed(2)}%`;
  const avgStop = avg(risks.map((r) => r.stopPct));
  const avgAct = avg(risks.map((r) => r.trailActivatePct));
  const avgGb = avg(risks.map((r) => r.trailGivebackPct));
  const avgLock = avg(risks.map((r) => r.trailMinLockPct));
  const sim = scoreRiskModel(rows);
  return [
    `• фактические параметры ${risks.length} сделок: stop ${p(avgStop)} · act ${p(avgAct)} · gb ${p(avgGb)} · lock ${p(avgLock)}`,
    `• net R:R ≈ 1:${(avg(netRrs) || MIN_RR).toFixed(2)} после комиссии; контрфакт по записанным risk: ${fmtPct(sim.sum)} · WR ${rows.length ? ((sim.wins / rows.length) * 100).toFixed(0) : '0'}% · ${sim.reasons}`,
    `• fixed stop floor отключён: новые сделки получают stop/giveback из распределения волатильности, а EV/Kelly решают, окупается ли риск`,
  ];
}

function simulateRejectedSignal(row: RejectedSignalRow, nowMs: number): RejectSimOut | null {
  const entry = row.signal_px ?? row.ref_px;
  if (!(entry != null && entry > 0 && Number.isFinite(entry))) return null;
  const horizonMin = Math.round(clamp(runtimeNum('hl_momentum_reject_eval_horizon_min', REJECTED_EVAL_DEFAULT_HORIZON_MIN), 35, 120));
  const bars = afterCounterfactualCandles(row.coin, row.ts, horizonMin);
  if (bars.length === 0) return null;

  const risk = parseRiskSignal(row.signal);
  let best = entry;
  let worst = entry;
  let active = false;
  let mfe = 0;
  let mae = 0;

  for (const c of bars) {
    if (row.side === 'long') {
      best = Math.max(best, c.h);
      worst = Math.min(worst, c.l);
      mfe = Math.max(mfe, pct(entry, best));
      mae = Math.min(mae, pct(entry, worst));
    } else {
      best = Math.min(best, c.l);
      worst = Math.max(worst, c.h);
      mfe = Math.max(mfe, pct(best, entry));
      mae = Math.min(mae, pct(worst, entry));
    }

    const move = row.side === 'long' ? (best - entry) / entry : (entry - best) / entry;
    const currentMove = row.side === 'long' ? (c.c - entry) / entry : (entry - c.c) / entry;
    if (move >= risk.trailActivatePct) active = true;

    const stop = row.side === 'long' ? entry * (1 - risk.stopPct) : entry * (1 + risk.stopPct);
    const trail = row.side === 'long'
      ? Math.max(entry * (1 + risk.trailMinLockPct), best * (1 - risk.trailGivebackPct))
      : Math.min(entry * (1 - risk.trailMinLockPct), best * (1 + risk.trailGivebackPct));
    const stopHit = row.side === 'long' ? c.l <= stop : c.h >= stop;
    const trailHit = active ? (row.side === 'long' ? c.l <= trail : c.h >= trail) : false;
    const decayed = c.t - row.ts >= DECAY_EXIT_MS && move < risk.stopPct * DECAY_MIN_MFE_R && currentMove <= -risk.stopPct * DECAY_LOSS_R;
    const timed = c.t - row.ts >= (active ? TRAIL_HOLD_MS : HOLD_MS);

    if (stopHit || trailHit || decayed || timed) {
      const exitPx = stopHit ? stop : trailHit ? trail : c.c;
      return {
        exitPx,
        closedAt: c.t,
        pnl: Math.round(pnlPct(row.side, entry, exitPx) * 1000) / 1000,
        reason: stopHit ? 'stop' : trailHit ? 'trail' : decayed ? 'decay' : 'time',
        mfe: Math.round(mfe * 1000) / 1000,
        mae: Math.round(mae * 1000) / 1000,
        horizonMin,
      };
    }
  }

  const last = bars.at(-1);
  if (!last || nowMs < row.ts + horizonMin * 60_000) return null;
  return {
    exitPx: last.c,
    closedAt: last.t,
    pnl: Math.round(pnlPct(row.side, entry, last.c) * 1000) / 1000,
    reason: 'end',
    mfe: Math.round(mfe * 1000) / 1000,
    mae: Math.round(mae * 1000) / 1000,
    horizonMin,
  };
}

function runRejectedSignalLearning(nowMs: number): string[] {
  if (!runtimeBool('hl_momentum_rejected_learning_enabled', true)) {
    setKvStmt.run('hl_momentum_rejected_learning_state', 'off', nowMs, 'hl momentum rejected learning disabled');
    return ['• SKIP learning выключен'];
  }

  const limit = Math.round(clamp(runtimeNum('hl_momentum_reject_eval_limit', REJECTED_EVAL_LIMIT), 20, 500));
  const pending = pendingRejectedSignalsStmt.all(nowMs - REJECTED_EVAL_MIN_AGE_MS, limit);
  let resolved = 0;
  for (const row of pending) {
    const sim = simulateRejectedSignal(row, nowMs);
    if (!sim) continue;
    updateRejectedOutcomeStmt.run(sim.exitPx, sim.closedAt, sim.pnl, sim.reason, sim.mfe, sim.mae, sim.horizonMin, row.id);
    resolved += 1;
  }

  const recentN = Math.round(clamp(runtimeNum('hl_momentum_rejected_recent_n', 120), 30, 300));
  const riskStartMs = runtimeNum('hl_momentum_risk_model_start_ms', 0);
  const rows = rejectedGovernorRowsStmt.all(riskStartMs, recentN);
  const st = statsOf(rows);
  setKvStmt.run('hl_momentum_rejected_sample_n', String(st.n), nowMs, 'hl momentum rejected counterfactual sample');
  setKvStmt.run('hl_momentum_rejected_avg_pct', st.avg.toFixed(4), nowMs, 'hl momentum rejected counterfactual avg');
  setKvStmt.run('hl_momentum_rejected_wr', st.wr.toFixed(4), nowMs, 'hl momentum rejected counterfactual win-rate');
  setKvStmt.run('hl_momentum_rejected_last_ms', String(nowMs), nowMs, 'hl momentum rejected counterfactual timestamp');

  const verdict = st.n < 20
    ? 'мало данных'
    : st.avg > 0.05
      ? 'фильтр, возможно, слишком строгий'
      : st.avg < -0.05
        ? 'фильтр спасает от минуса'
        : 'фильтр около нейтрали';
  return [
    `• resolved ${resolved}/${pending.length} pending SKIP · recent ${st.n}: ${fmtPct(st.avg)} · WR ${(st.wr * 100).toFixed(0)}%`,
    `• вывод: ${verdict}`,
  ];
}

function runOnlineCalibration(nowMs: number): string[] {
  const enabled = runtimeBool('hl_momentum_online_calibration_enabled', true);
  const calibrationStartMs = runtimeNum('hl_momentum_calibration_start_ms', nowMs);
  const rows = calibrationRowsStmt
    .all(HL_MOMENTUM_CALIBRATION_VERSION, calibrationStartMs, ONLINE_CALIBRATION_LOOKBACK)
    .filter((r): r is CalibrationRow & { raw_prob: number; raw_expected_pnl: number } =>
      r.raw_prob != null
      && r.raw_expected_pnl != null
      && Number.isFinite(r.raw_prob)
      && Number.isFinite(r.raw_expected_pnl),
    );

  const n = rows.length;
  setKvStmt.run('hl_momentum_calibration_sample_n', String(n), nowMs, 'hl momentum robust calibration sample size');
  if (n === 0) return [`• robust ${HL_MOMENTUM_CALIBRATION_VERSION}: ждём новые закрытые сделки`];
  const latestClosedId = Math.max(...rows.map((r) => r.id));
  const lastCalibratedId = Number(getKvStmt.get('hl_momentum_calibration_last_closed_id')?.value ?? 0);
  const calibration = robustCalibration(rows.map((r) => ({
    pnlPct: r.pnl_pct,
    rawProb: r.raw_prob,
    rawExpectedPnl: r.raw_expected_pnl,
  })), {
    probBiasMin: ONLINE_PROB_BIAS_MIN,
    probBiasMax: ONLINE_PROB_BIAS_MAX,
    evBiasMin: ONLINE_EV_BIAS_MIN,
    evBiasMax: ONLINE_EV_BIAS_MAX,
  });
  const fastRows = rows.filter((r) => r.layer === 'fast');
  const fastPnl = fastRows.length ? avg(fastRows.map((r) => r.pnl_pct)) : null;
  const currentProbBias = clamp(runtimeNum('hl_momentum_prob_bias', 0), ONLINE_PROB_BIAS_MIN, ONLINE_PROB_BIAS_MAX);
  const currentEvBias = clamp(runtimeNum('hl_momentum_ev_bias_pct', 0), ONLINE_EV_BIAS_MIN, ONLINE_EV_BIAS_MAX);
  const nextProbBias = moveToward(currentProbBias, calibration.targetProbBias, ONLINE_PROB_BIAS_MAX_STEP);
  const nextEvBias = moveToward(currentEvBias, calibration.targetEvBias, ONLINE_EV_BIAS_MAX_STEP);

  setKvStmt.run('hl_momentum_calibration_actual_wr', calibration.actualWr.toFixed(4), nowMs, 'hl momentum robust calibration actual win-rate');
  setKvStmt.run('hl_momentum_calibration_pred_wr', calibration.avgRawProb.toFixed(4), nowMs, 'hl momentum robust calibration raw predicted win-rate');
  setKvStmt.run('hl_momentum_calibration_brier', calibration.brier.toFixed(4), nowMs, 'hl momentum robust calibration raw brier score');
  setKvStmt.run('hl_momentum_calibration_actual_pnl_pct', calibration.avgActualPnl.toFixed(4), nowMs, 'hl momentum robust calibration actual avg pnl');
  setKvStmt.run('hl_momentum_calibration_pred_ev_pct', calibration.avgRawExpectedPnl.toFixed(4), nowMs, 'hl momentum robust calibration raw predicted ev');
  setKvStmt.run('hl_momentum_calibration_robust_ev_residual', calibration.robustEvResidual.toFixed(4), nowMs, 'hl momentum robust calibration winsorized residual');
  setKvStmt.run('hl_momentum_calibration_residual_cap', calibration.residualCap.toFixed(4), nowMs, 'hl momentum robust calibration residual cap');
  setKvStmt.run('hl_momentum_calibration_target_prob_bias', calibration.targetProbBias.toFixed(4), nowMs, 'hl momentum robust calibration absolute probability target');
  setKvStmt.run('hl_momentum_calibration_target_ev_bias_pct', calibration.targetEvBias.toFixed(4), nowMs, 'hl momentum robust calibration absolute EV target');
  setKvStmt.run('hl_momentum_calibration_last_ms', String(nowMs), nowMs, 'hl momentum robust calibration timestamp');

  const lines = [
    `• robust ${HL_MOMENTUM_CALIBRATION_VERSION} ${n}/${ONLINE_CALIBRATION_LOOKBACK}: факт WR ${(calibration.actualWr * 100).toFixed(1)}% vs raw ${(calibration.avgRawProb * 100).toFixed(1)}% · Brier ${calibration.brier.toFixed(3)}`,
    `• PnL факт ${fmtPct(calibration.avgActualPnl)} vs raw EV ${fmtPct(calibration.avgRawExpectedPnl)} · residual ${fmtPct(calibration.robustEvResidual)} cap ±${calibration.residualCap.toFixed(2)}${fastPnl == null ? '' : ` · fast факт ${fmtPct(fastPnl)}`}`,
    `• absolute target: p ${calibration.targetProbBias.toFixed(3)} · EV ${fmtPct(calibration.targetEvBias)}`,
  ];

  if (!enabled) {
    lines.push(`• режим: выключен, только измеряем ошибку`);
    return lines;
  }
  if (n < ONLINE_CALIBRATION_MIN_SAMPLE) {
    lines.push(`• ждём ${ONLINE_CALIBRATION_MIN_SAMPLE} новых сделок, bias остаётся нейтральным`);
    return lines;
  }
  if (latestClosedId <= lastCalibratedId) {
    lines.push(`• bias уже учтён до live #${lastCalibratedId}, ждём новую закрытую сделку`);
    return lines;
  }

  if (Math.abs(nextProbBias - currentProbBias) > 0.0001) {
    setKvStmt.run('hl_momentum_prob_bias', nextProbBias.toFixed(4), nowMs, 'hl momentum robust calibration probability bias');
  }
  if (Math.abs(nextEvBias - currentEvBias) > 0.0001) {
    setKvStmt.run('hl_momentum_ev_bias_pct', nextEvBias.toFixed(4), nowMs, 'hl momentum robust calibration EV bias');
  }
  insertCalibrationHistoryStmt.run(
    nowMs,
    HL_MOMENTUM_CALIBRATION_VERSION,
    n,
    latestClosedId,
    calibration.actualWr,
    calibration.avgRawProb,
    calibration.avgActualPnl,
    calibration.avgRawExpectedPnl,
    calibration.robustEvResidual,
    calibration.residualCap,
    calibration.targetProbBias,
    calibration.targetEvBias,
    currentProbBias,
    nextProbBias,
    currentEvBias,
    nextEvBias,
  );
  setKvStmt.run('hl_momentum_calibration_last_closed_id', String(latestClosedId), nowMs, 'hl momentum robust calibration last closed trade');
  lines.push(`• bias: p ${currentProbBias.toFixed(3)} → ${nextProbBias.toFixed(3)} · EV ${fmtPct(currentEvBias)} → ${fmtPct(nextEvBias)}`);
  return lines;
}

function statsOf(rows: Pick<GovernorRow, 'pnl_pct'>[]): GovernorStats {
  const n = rows.length;
  if (n === 0) return { n: 0, avg: 0, wr: 0, sum: 0 };
  const sum = rows.reduce((acc, r) => acc + r.pnl_pct, 0);
  const wins = rows.filter((r) => r.pnl_pct > 0).length;
  return { n, avg: sum / n, wr: wins / n, sum };
}

function layerFromSignal(signal: string): 'fast' | 'confirm' | 'unknown' {
  if (signal.includes('layer=fast') || signal.includes('fast up radar') || signal.includes('fast down radar')) return 'fast';
  if (signal.includes('layer=confirm') || signal.includes('up impulse') || signal.includes('down impulse')) return 'confirm';
  return 'unknown';
}

function segmentMoveFromSignal(signal: string, layer: MomentumSegmentLayer): number | null {
  const metric = layer === 'fast' ? 'r90' : 'r3';
  const match = signal.match(new RegExp(`\\b${metric}=([-+]?\\d+(?:\\.\\d+)?)`));
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

function setGovernorKv(key: string, value: string | number, nowMs: number, reason: string): void {
  setKvStmt.run(key, String(value), nowMs, reason);
}

function runActivityGovernor(nowMs: number): string[] {
  if (!runtimeBool('hl_momentum_governor_enabled', true)) {
    setGovernorKv('hl_momentum_governor_state', 'off', nowMs, 'hl momentum governor disabled');
    return ['• governor выключен'];
  }

  const shadowN = Math.round(clamp(runtimeNum('hl_momentum_governor_shadow_n', GOVERNOR_SHADOW_RECENT_N), 40, 300));
  const shadowRows = shadowGovernorRowsStmt.all(shadowN);
  const segmentScanN = Math.round(clamp(runtimeNum('hl_momentum_segment_scan_n', GOVERNOR_SEGMENT_SCAN_N), 120, 600));
  const segmentSourceRows = longSegmentRowsStmt.all(`%cv=${HL_MOMENTUM_CALIBRATION_VERSION}%`, segmentScanN);
  const liveRows = liveGovernorRowsStmt.all(20);
  const riskStartMs = runtimeNum('hl_momentum_risk_model_start_ms', 0);
  const calibrationStartMs = runtimeNum('hl_momentum_calibration_start_ms', 0);
  const currentLiveRows = riskStartMs > 0 ? liveRows.filter((r) => r.closed_at >= riskStartMs) : liveRows;
  const currentShadowRows = riskStartMs > 0 ? shadowRows.filter((r) => r.closed_at >= riskStartMs) : shadowRows;
  const governorRows = riskStartMs > 0 ? currentShadowRows : shadowRows;
  const liveGovRows = riskStartMs > 0 ? currentLiveRows : liveRows;
  const rejectedRows = rejectedGovernorRowsStmt.all(
    riskStartMs,
    Math.round(clamp(runtimeNum('hl_momentum_rejected_recent_n', 120), 30, 300)),
  );
  const signalSinceMs = riskStartMs > 0 ? Math.max(nowMs - GOVERNOR_SIGNAL_WINDOW_MS, riskStartMs) : nowMs - GOVERNOR_SIGNAL_WINDOW_MS;
  const signalWindow = signalWindowStmt.get(signalSinceMs) ?? { total: 0, live_open: 0, paper: 0, skipped: 0 };
  const open = liveOpenCountStmt.get() ?? { n: 0, long_n: 0, short_n: 0 };

  const shadow = statsOf(governorRows);
  const currentShadow = statsOf(currentShadowRows);
  const rejected = statsOf(rejectedRows);
  const confirm = statsOf(governorRows.filter((r) => layerFromSignal(r.signal) === 'confirm'));
  const fast = statsOf(governorRows.filter((r) => layerFromSignal(r.signal) === 'fast'));
  const confirmLong = statsOf(governorRows.filter((r) => r.side === 'long' && layerFromSignal(r.signal) === 'confirm'));
  const confirmShort = statsOf(governorRows.filter((r) => r.side === 'short' && layerFromSignal(r.signal) === 'confirm'));
  const live = statsOf(liveGovRows);
  const currentLive = statsOf(currentLiveRows);
  const segmentStartMs = Math.max(riskStartMs, calibrationStartMs);
  const segmentRows = segmentSourceRows
    .filter((r) => r.closed_at >= segmentStartMs)
    .map((r) => {
      const layer = layerFromSignal(r.signal);
      return { side: r.side, layer, pnlPct: r.pnl_pct, r3Pct: segmentMoveFromSignal(r.signal, layer) ?? NaN };
    });
  const confirmLongPolicy = {
    sampleSize: Math.round(clamp(runtimeNum('hl_momentum_confirm_long_sample_n', CONFIRM_LONG_CANARY_POLICY.sampleSize), 20, 100)),
    recentSize: Math.round(clamp(runtimeNum('hl_momentum_confirm_long_recent_n', CONFIRM_LONG_CANARY_POLICY.recentSize), 10, 50)),
    minAveragePct: clamp(runtimeNum('hl_momentum_confirm_long_min_avg_pct', CONFIRM_LONG_CANARY_POLICY.minAveragePct), -0.10, 0.30),
    minRecentAveragePct: clamp(runtimeNum('hl_momentum_confirm_long_min_recent_avg_pct', CONFIRM_LONG_CANARY_POLICY.minRecentAveragePct), -0.10, 0.30),
    minAbsR3Pct: clamp(runtimeNum('hl_momentum_confirm_long_min_abs_r3_pct', CONFIRM_LONG_CANARY_POLICY.minAbsR3Pct), 0.22, 1.50),
  };
  const confirmLongProof = evaluateMomentumSegment(segmentRows, 'confirm', 'long', confirmLongPolicy);
  const fastLongPolicy = {
    sampleSize: Math.round(clamp(runtimeNum('hl_momentum_fast_long_sample_n', FAST_LONG_CANARY_POLICY.sampleSize), 20, 100)),
    recentSize: Math.round(clamp(runtimeNum('hl_momentum_fast_long_recent_n', FAST_LONG_CANARY_POLICY.recentSize), 10, 50)),
    minAveragePct: clamp(runtimeNum('hl_momentum_fast_long_min_avg_pct', FAST_LONG_CANARY_POLICY.minAveragePct), -0.10, 0.50),
    minRecentAveragePct: clamp(runtimeNum('hl_momentum_fast_long_min_recent_avg_pct', FAST_LONG_CANARY_POLICY.minRecentAveragePct), -0.10, 0.50),
    minAbsR3Pct: clamp(runtimeNum('hl_momentum_fast_long_min_abs_r90_pct', FAST_LONG_CANARY_POLICY.minAbsR3Pct), 0.45, 2.50),
  };
  const fastLongProof = evaluateMomentumSegment(segmentRows, 'fast', 'long', fastLongPolicy);
  const sideAwareEnabled = runtimeBool('hl_momentum_side_aware_enabled', true);
  const canaryTrades = canaryPromotionRowsStmt.all(`%${CONFIRM_LONG_CANARY_TAG}%`).map((row) => ({
    pnlPct: row.pnl_pct,
    netPnlUsd: row.net_pnl_usd,
    exact: row.pnl_source === 'fills-v1',
    closedAt: row.closed_at,
  }));
  const promotion = evaluateMomentumPromotion(
    canaryTrades,
    sideAwareEnabled && confirmLongProof.enabled,
    nowMs,
    MOMENTUM_PROMOTION_POLICY,
  );
  const confirmLongCanary = promotion.liveEnabled;
  const fastLongTrades = canaryPromotionRowsStmt.all(`%${FAST_LONG_CANARY_TAG}%`).map((row) => ({
    pnlPct: row.pnl_pct,
    netPnlUsd: row.net_pnl_usd,
    exact: row.pnl_source === 'fills-v1',
    closedAt: row.closed_at,
  }));
  const fastLongPromotion = evaluateMomentumPromotion(
    fastLongTrades,
    sideAwareEnabled && fastLongProof.enabled,
    nowMs,
    MOMENTUM_PROMOTION_POLICY,
  );
  const fastLongCanary = fastLongPromotion.liveEnabled;

  const confirmGood = confirm.n >= 12 && confirm.avg > 0 && confirm.wr >= 0.48;
  const confirmHot = confirm.n >= 20 && confirm.avg >= 0.10 && confirm.wr >= 0.52;
  const noLiveButSignals = (signalWindow.live_open ?? 0) === 0 && (signalWindow.paper ?? 0) >= 20;
  const fastGood = fast.n >= 20 && fast.avg >= 0.05 && fast.wr >= 0.48;
  const rejectedMissedEdge = rejected.n >= 25 && rejected.avg >= 0.08 && rejected.wr >= 0.52;
  const rejectedSavedLoss = rejected.n >= 25 && rejected.avg <= -0.08 && rejected.wr <= 0.45;
  const liveBad = currentLive.n >= 5 && (currentLive.avg < -0.20 || currentLive.wr < 0.40);
  const shadowBad = currentShadow.n >= 40 && currentShadow.avg < -0.10;

  let state: 'defensive' | 'probe' | 'normal' | 'hot';
  if ((rejectedSavedLoss && !confirmGood) || liveBad || (!confirmGood && shadowBad)) state = 'defensive';
  else if (confirmHot && !shadowBad && live.n >= 5 && live.avg > 0 && live.wr >= 0.50) state = 'hot';
  else if (confirmGood && !shadowBad && !noLiveButSignals) state = 'normal';
  else if (confirmGood || noLiveButSignals || rejectedMissedEdge) state = 'probe';
  else state = 'defensive';

  const riskModel = getKvStmt.get('hl_momentum_risk_model_version')?.value ?? '';
  const fadeReversal = riskModel.startsWith('fade-reversal');
  const cfg = state === 'defensive'
    ? { minP: 0.49, minEv: fadeReversal ? 0.05 : 0.35, maxOpen: 2, maxSame: 1, ir: fadeReversal ? 2.50 : 1.25, fastLive: 0 }
    : state === 'probe'
      ? { minP: 0.465, minEv: 0.05, maxOpen: 4, maxSame: 2, ir: 1.30, fastLive: fastGood ? 1 : 0 }
      : state === 'normal'
        ? { minP: 0.46, minEv: 0.10, maxOpen: 6, maxSame: 3, ir: 1.42, fastLive: fastGood ? 1 : 0 }
        : { minP: 0.45, minEv: 0.05, maxOpen: 8, maxSame: 4, ir: 1.50, fastLive: fastGood ? 1 : 0 };

  const reason = `hl momentum governor ${state}`;
  setGovernorKv('hl_momentum_governor_state', state, nowMs, reason);
  setGovernorKv('hl_momentum_governor_shadow_avg_pct', shadow.avg.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_governor_shadow_wr', shadow.wr.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_governor_confirm_avg_pct', confirm.avg.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_governor_confirm_wr', confirm.wr.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_governor_fast_avg_pct', fast.avg.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_governor_fast_wr', fast.wr.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_governor_live_avg_pct', live.avg.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_governor_live_wr', live.wr.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_governor_rejected_avg_pct', rejected.avg.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_governor_rejected_wr', rejected.wr.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_governor_last_ms', nowMs, nowMs, reason);

  setGovernorKv('hl_momentum_min_calibrated_prob', cfg.minP.toFixed(3), nowMs, reason);
  setGovernorKv('hl_momentum_min_expected_pnl_pct', cfg.minEv.toFixed(2), nowMs, reason);
  setGovernorKv('hl_momentum_live_max_open', cfg.maxOpen, nowMs, reason);
  setGovernorKv('hl_momentum_max_same_side', cfg.maxSame, nowMs, reason);
  setGovernorKv('hl_momentum_confirm_max_impulse_ratio', cfg.ir.toFixed(2), nowMs, reason);
  const fastLive = sideAwareEnabled ? (fastLongCanary ? 1 : 0) : cfg.fastLive;
  setGovernorKv('hl_momentum_fast_live_enabled', fastLive, nowMs, fastLongCanary ? `${reason}: fast-long canary` : fastGood ? `${reason}: fast proven but no live segment` : `${reason}: fast not proven`);
  setGovernorKv('hl_momentum_confirm_long_live_enabled', confirmLongCanary ? 1 : 0, nowMs, `${reason}: ${promotion.reason}`);
  setGovernorKv('hl_momentum_confirm_short_live_enabled', 0, nowMs, `${reason}: confirm-short remains shadow-only`);
  setGovernorKv('hl_momentum_fast_long_live_enabled', fastLongCanary ? 1 : 0, nowMs, `${reason}: ${fastLongPromotion.reason}`);
  setGovernorKv('hl_momentum_fast_short_live_enabled', 0, nowMs, `${reason}: fast-short remains shadow-only`);
  setGovernorKv('hl_momentum_confirm_long_canary_max_open', promotion.maxOpen, nowMs, `${reason}: promotion ${promotion.stage}`);
  setGovernorKv('hl_momentum_confirm_long_shadow_n', confirmLongProof.sample.n, nowMs, reason);
  setGovernorKv('hl_momentum_confirm_long_shadow_avg_pct', confirmLongProof.sample.averagePct.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_confirm_long_recent_avg_pct', confirmLongProof.recent.averagePct.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_confirm_long_canary_live_n', promotion.n, nowMs, reason);
  setGovernorKv('hl_momentum_confirm_long_canary_live_avg_pct', promotion.averagePct.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_promotion_stage', promotion.stage, nowMs, promotion.reason);
  setGovernorKv('hl_momentum_promotion_exact_n', promotion.exactN, nowMs, promotion.reason);
  setGovernorKv('hl_momentum_promotion_net_usd', promotion.netPnlUsd.toFixed(6), nowMs, promotion.reason);
  setGovernorKv('hl_momentum_promotion_profit_factor', promotion.profitFactor == null ? 'inf' : promotion.profitFactor.toFixed(4), nowMs, promotion.reason);
  setGovernorKv('hl_momentum_promotion_max_drawdown_pct', promotion.maxDrawdownPct.toFixed(4), nowMs, promotion.reason);
  setGovernorKv('hl_momentum_promotion_next_stage', promotion.nextStage ?? 'complete', nowMs, promotion.reason);
  setGovernorKv('hl_momentum_promotion_next_min_trades', promotion.nextMinTrades ?? 0, nowMs, promotion.reason);
  setGovernorKv('hl_momentum_promotion_retry_after_ms', promotion.retryAfter ?? 0, nowMs, promotion.reason);
  setGovernorKv('hl_momentum_fast_long_canary_max_open', fastLongPromotion.maxOpen, nowMs, `${reason}: promotion ${fastLongPromotion.stage}`);
  setGovernorKv('hl_momentum_fast_long_shadow_n', fastLongProof.sample.n, nowMs, reason);
  setGovernorKv('hl_momentum_fast_long_shadow_avg_pct', fastLongProof.sample.averagePct.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_fast_long_recent_avg_pct', fastLongProof.recent.averagePct.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_fast_long_canary_live_n', fastLongPromotion.n, nowMs, reason);
  setGovernorKv('hl_momentum_fast_long_canary_live_avg_pct', fastLongPromotion.averagePct.toFixed(4), nowMs, reason);
  setGovernorKv('hl_momentum_fast_long_promotion_stage', fastLongPromotion.stage, nowMs, fastLongPromotion.reason);
  setGovernorKv('hl_momentum_fast_long_promotion_exact_n', fastLongPromotion.exactN, nowMs, fastLongPromotion.reason);
  setGovernorKv('hl_momentum_fast_long_promotion_net_usd', fastLongPromotion.netPnlUsd.toFixed(6), nowMs, fastLongPromotion.reason);
  setGovernorKv('hl_momentum_fast_long_promotion_profit_factor', fastLongPromotion.profitFactor == null ? 'inf' : fastLongPromotion.profitFactor.toFixed(4), nowMs, fastLongPromotion.reason);
  setGovernorKv('hl_momentum_fast_long_promotion_max_drawdown_pct', fastLongPromotion.maxDrawdownPct.toFixed(4), nowMs, fastLongPromotion.reason);
  setGovernorKv('hl_momentum_fast_long_promotion_next_stage', fastLongPromotion.nextStage ?? 'complete', nowMs, fastLongPromotion.reason);
  setGovernorKv('hl_momentum_fast_long_promotion_next_min_trades', fastLongPromotion.nextMinTrades ?? 0, nowMs, fastLongPromotion.reason);
  setGovernorKv('hl_momentum_fast_long_promotion_retry_after_ms', fastLongPromotion.retryAfter ?? 0, nowMs, fastLongPromotion.reason);

  const bestSide = confirmLong.avg >= confirmShort.avg ? `long ${fmtPct(confirmLong.avg)}` : `short ${fmtPct(confirmShort.avg)}`;
  return [
    `• state <b>${state}</b>: p≥${cfg.minP.toFixed(3)} · EV≥${cfg.minEv.toFixed(2)}% · maxOpen ${cfg.maxOpen} · sameSide ${cfg.maxSame} · ir≤${cfg.ir.toFixed(2)} · fast ${fastLive ? 'on' : 'off'}`,
    `• shadow ${shadow.n}: ${fmtPct(shadow.avg)} · WR ${(shadow.wr * 100).toFixed(0)}%; confirm ${confirm.n}: ${fmtPct(confirm.avg)} · WR ${(confirm.wr * 100).toFixed(0)}%; fast ${fast.n}: ${fmtPct(fast.avg)} · WR ${(fast.wr * 100).toFixed(0)}%`,
    `• promotion <b>${promotion.stage}</b>: live ${promotion.n} · exact ${promotion.exactN}/${promotion.n} · ${fmtPct(promotion.averagePct)} · PF ${promotion.profitFactor == null ? (promotion.netPnlUsd > 0 ? '∞' : '—') : promotion.profitFactor.toFixed(2)} · maxDD ${promotion.maxDrawdownPct.toFixed(2)}% · maxOpen ${promotion.maxOpen}`,
    `• confirm-long canary ${confirmLongCanary ? '<b>on</b>' : 'off'}: |r3|≥${confirmLongPolicy.minAbsR3Pct.toFixed(2)}% · shadow ${confirmLongProof.sample.n}/${confirmLongPolicy.sampleSize} ${fmtPct(confirmLongProof.sample.averagePct)} · recent ${confirmLongProof.recent.n}/${confirmLongPolicy.recentSize} ${fmtPct(confirmLongProof.recent.averagePct)} · ${promotion.reason}`,
    `• fast-long canary ${fastLongCanary ? '<b>on</b>' : 'off'}: |r90|≥${fastLongPolicy.minAbsR3Pct.toFixed(2)}% · shadow ${fastLongProof.sample.n}/${fastLongPolicy.sampleSize} ${fmtPct(fastLongProof.sample.averagePct)} · recent ${fastLongProof.recent.n}/${fastLongPolicy.recentSize} ${fmtPct(fastLongProof.recent.averagePct)} · ${fastLongPromotion.reason}`,
    `• current risk sample: live ${currentLive.n}/5 ${fmtPct(currentLive.avg)} · shadow ${currentShadow.n}/40 ${fmtPct(currentShadow.avg)}${currentLive.n < 5 ? ' · old live не блокирует новую модель' : ''}`,
    `• rejected/SKIP ${rejected.n}: ${fmtPct(rejected.avg)} · WR ${(rejected.wr * 100).toFixed(0)}%${rejectedMissedEdge ? ' · missed edge' : rejectedSavedLoss ? ' · saved loss' : ''}`,
    `• live ${live.n}: ${fmtPct(live.avg)} · WR ${(live.wr * 100).toFixed(0)}%; open ${open.n} (${open.long_n ?? 0}L/${open.short_n ?? 0}S); best confirm side ${bestSide}`,
  ];
}

function reasonMix(rows: TradeRow[]): string {
  const mix = new Map<string, number>();
  for (const r of rows) mix.set(r.close_reason ?? 'unknown', (mix.get(r.close_reason ?? 'unknown') ?? 0) + 1);
  return [...mix.entries()].map(([k, v]) => `${k} ${v}`).join(', ') || 'нет';
}

function layerMix(rows: TradeRow[]): string {
  const byLayer = new Map<string, { n: number; pnl: number; wins: number }>();
  for (const r of rows) {
    const k = layerOf(r.signal);
    const e = byLayer.get(k) ?? { n: 0, pnl: 0, wins: 0 };
    e.n += 1; e.pnl += r.pnl_pct; if (r.pnl_pct > 0) e.wins += 1;
    byLayer.set(k, e);
  }
  return [...byLayer.entries()]
    .map(([k, e]) => `${k}: ${e.n} · ${fmtPct(e.pnl)} · WR ${((e.wins / e.n) * 100).toFixed(0)}%`)
    .join('; ') || 'нет';
}

function probabilityBuckets(): string[] {
  return probBucketStmt.all().map((r) =>
    `• ${r.bucket}: ${r.n} сигн. · score ${(r.avg_score ?? 0).toFixed(0)} · p ${(((r.avg_prob ?? 0) * 100)).toFixed(1)}% · EV ${fmtPct(r.avg_ev ?? 0)}`,
  );
}

export async function runHlMomentumDoctor(opts: { force?: boolean; notify?: boolean; nowMs?: number } = {}): Promise<{ sent: boolean; closed: number; pnl: number }> {
  const nowMs = opts.nowMs ?? Date.now();
  const riskStateLines = ensureRiskModelState(nowMs);
  const calibrationStateLines = ensureCalibrationState(nowMs);
  const rejectedLearningLines = runRejectedSignalLearning(nowMs);
  const governorLines = runActivityGovernor(nowMs);
  const rows = closedStmt.all(160).reverse();
  const maxId = maxClosedIdStmt.get()?.id ?? 0;
  const lastReported = Number(getKvStmt.get(REPORT_KEY)?.value ?? 0);
  const pnl = rows.reduce((acc, r) => acc + r.pnl_pct, 0);

  if (!opts.force && maxId <= lastReported) {
    logger.info({ maxId, governor: governorLines.join(' | ') }, 'hl-momentum doctor: no new closed trades');
    return { sent: false, closed: rows.length, pnl };
  }

  const metricsRows = rows.map((r) => ({ r, m: metrics(r) })).filter((x): x is { r: TradeRow; m: Metrics } => x.m != null);
  const entryExtreme = metricsRows.filter((x) => x.r.side === 'long' ? x.m.closeNearHigh >= 0.75 : x.m.closeNearHigh <= 0.25);
  const entryExtremePnl = entryExtreme.reduce((acc, x) => acc + x.r.pnl_pct, 0);
  const noMfe = metricsRows.filter((x) => x.m.mfe < 1).map((x) => `${x.r.coin} ${fmtPct(x.r.pnl_pct)}`).slice(0, 6);
  const decayCandidates = metricsRows.filter((x) => x.m.mfe < Math.max(0.45, x.m.atrPct * DECAY_MIN_MFE_R) && x.r.pnl_pct < 0);
  const decayCandidatePnl = decayCandidates.reduce((acc, x) => acc + x.r.pnl_pct, 0);
  const probLines = probabilityBuckets();
  const onlineCalibrationLines = runOnlineCalibration(nowMs);
  const riskLines = riskModelLines(rows);

  const lines = [
    `🧭🩺 <b>Momentum Doctor</b>`,
    `Live sample: <b>${rows.length}</b> closed · ${fmtPct(pnl)} · WR ${rows.length ? ((rows.filter((r) => r.pnl_pct > 0).length / rows.length) * 100).toFixed(0) : '0'}%`,
    `Закрытия: ${esc(reasonMix(rows))}`,
    `Слои: ${esc(layerMix(rows))}`,
    ``,
    `<b>Риск-модель: stop/trail → EV</b>`,
    ...riskLines.map(esc),
    ...riskStateLines.map(esc),
    ...calibrationStateLines.map(esc),
    ``,
    `<b>Качество входа</b>`,
    `• close-extreme фильтр: ${entryExtreme.length}/${rows.length} сделок · фактический PnL ${fmtPct(entryExtremePnl)}`,
    `• dead-impulse кандидаты: ${decayCandidates.length}/${rows.length} · фактический PnL ${fmtPct(decayCandidatePnl)}`,
    noMfe.length ? `• слабый MFE (&lt;1%): ${esc(noMfe.join(', '))}` : `• слабый MFE (&lt;1%): нет`,
    ``,
    `<b>Калибровка вероятности</b>`,
    ...(probLines.length ? probLines.map(esc) : [`• ждём новые сигналы с calibrated_prob`]),
    ``,
    `<b>Online calibration: прогноз → факт</b>`,
    ...onlineCalibrationLines.map(esc),
    ``,
    `<b>SKIP learning: отклонённые сигналы → факт</b>`,
    ...rejectedLearningLines.map(esc),
    ``,
    `<b>Activity governor: дыхание системы</b>`,
    ...governorLines.map(esc),
    ``,
    `<b>Автотюнинг</b>`,
    `• floor/max stop больше не тюнятся: риск берётся из рынка, а Doctor калибрует p/EV, SKIP-learning и режим Governor`,
    ``,
    `<i>Доктор может менять только ограниченные runtime-параметры риска. Размер, плечо и включение новой стратегии не меняются автоматически.</i>`,
  ];

  let sent = false;
  if (opts.notify ?? true) {
    await sendMessage({ channel: 'logs', text: lines.join('\n'), disable_notification: true });
    sent = true;
  } else {
    logger.info({ text: lines.join('\n') }, 'hl-momentum doctor report');
  }
  setKvStmt.run(REPORT_KEY, String(maxId), nowMs, 'hl momentum doctor last reported closed trade id');
  return { sent, closed: rows.length, pnl };
}

export function startHlMomentumDoctorJob(): void {
  cron.schedule('* * * * *', () => {
    void runHlMomentumDoctor({ notify: false }).catch((err) => logger.error({ err }, 'hl-momentum doctor online calibration tick failed'));
  });
  cron.schedule('37 */4 * * *', () => {
    void runHlMomentumDoctor().catch((err) => logger.error({ err }, 'hl-momentum doctor tick failed'));
  });
  const t = setTimeout(() => {
    void runHlMomentumDoctor().catch((err) => logger.error({ err }, 'hl-momentum doctor startup failed'));
  }, 1_000);
  t.unref();
  logger.info('hl-momentum doctor cron started (online calibration every 1m, report every 4h)');
}
