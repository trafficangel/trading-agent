import cron from 'node-cron';
import { db } from '../db/client.js';
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

const REPORT_KEY = 'hl_momentum_doctor_last_report_id';
const COST_RT_PCT = 0.07;
const MIN_SAMPLE_FOR_AUTOTUNE = 30;
const MIN_AUTOTUNE_EDGE_PCT = 2;
const STOP_CANDIDATES = [0.012, 0.015, 0.018] as const;
const MAX_STOP_PCT = 0.018;
const MIN_RR = 2;
const HOLD_MS = 30 * 60_000;
const TRAIL_HOLD_MS = 60 * 60_000;
const DECAY_EXIT_MS = 6 * 60_000;
const DECAY_MIN_MFE_R = 0.35;
const DECAY_LOSS_R = 0.30;

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
const getKvStmt = db.prepare<[string], { value: string }>('SELECT value FROM runtime_config WHERE key = ?');
const setKvStmt = db.prepare<[string, string, number, string], void>(`
  INSERT INTO runtime_config (key, value, updated_at, reason)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, reason = excluded.reason
`);
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

function simulate(t: TradeRow, minStopPct: number): SimOut {
  const m = metrics(t);
  const stopPct = clamp(((m?.atrPct ?? 0) / 100) * 1.15, minStopPct, MAX_STOP_PCT);
  const givebackPct = clamp(((m?.atrPct ?? 0) / 100) * 0.35, 0.002, 0.0045);
  const lockPct = MIN_RR * stopPct + COST_RT_PCT / 100;
  const activatePct = lockPct + givebackPct;
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

function score(rows: TradeRow[], minStopPct: number): { minStopPct: number; sum: number; wins: number; reasons: string } {
  const sims = rows.map((r) => simulate(r, minStopPct));
  const mix = new Map<string, number>();
  for (const s of sims) mix.set(s.reason, (mix.get(s.reason) ?? 0) + 1);
  return {
    minStopPct,
    sum: sims.reduce((acc, s) => acc + s.pnl, 0),
    wins: sims.filter((s) => s.pnl > 0).length,
    reasons: [...mix.entries()].map(([k, v]) => `${k} ${v}`).join(', '),
  };
}

function runtimePct(key: string, fallback: number): number {
  const raw = Number(getKvStmt.get(key)?.value ?? fallback);
  return Number.isFinite(raw) ? raw : fallback;
}

function runtimeBool(key: string, fallback: boolean): boolean {
  const value = getKvStmt.get(key)?.value;
  if (value == null || value.trim() === '') return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) ? raw >= 0.5 : fallback;
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
  const rows = closedStmt.all(160).reverse();
  const maxId = maxClosedIdStmt.get()?.id ?? 0;
  const lastReported = Number(getKvStmt.get(REPORT_KEY)?.value ?? 0);
  const pnl = rows.reduce((acc, r) => acc + r.pnl_pct, 0);

  if (!opts.force && maxId <= lastReported) {
    logger.info({ maxId }, 'hl-momentum doctor: no new closed trades');
    return { sent: false, closed: rows.length, pnl };
  }

  const scores = STOP_CANDIDATES.map((s) => score(rows, s)).sort((a, b) => b.sum - a.sum);
  const currentMin = runtimePct('hl_momentum_min_stop_pct', 0.015);
  const current = score(rows, currentMin);
  const best = scores[0];
  const metricsRows = rows.map((r) => ({ r, m: metrics(r) })).filter((x): x is { r: TradeRow; m: Metrics } => x.m != null);
  const entryExtreme = metricsRows.filter((x) => x.r.side === 'long' ? x.m.closeNearHigh >= 0.75 : x.m.closeNearHigh <= 0.25);
  const entryExtremePnl = entryExtreme.reduce((acc, x) => acc + x.r.pnl_pct, 0);
  const noMfe = metricsRows.filter((x) => x.m.mfe < 1).map((x) => `${x.r.coin} ${fmtPct(x.r.pnl_pct)}`).slice(0, 6);
  const decayCandidates = metricsRows.filter((x) => x.m.mfe < Math.max(0.45, x.m.atrPct * DECAY_MIN_MFE_R) && x.r.pnl_pct < 0);
  const decayCandidatePnl = decayCandidates.reduce((acc, x) => acc + x.r.pnl_pct, 0);
  const probLines = probabilityBuckets();
  const actions: string[] = [];
  const autotuneEnabled = runtimeBool('hl_momentum_doctor_autotune_enabled', true);

  if (autotuneEnabled && best && rows.length >= MIN_SAMPLE_FOR_AUTOTUNE && best.sum >= current.sum + MIN_AUTOTUNE_EDGE_PCT) {
    setKvStmt.run('hl_momentum_min_stop_pct', best.minStopPct.toFixed(4), nowMs, 'hl momentum doctor auto-tune stop floor');
    actions.push(`auto-tune stop floor: ${(currentMin * 100).toFixed(2)}% → ${(best.minStopPct * 100).toFixed(2)}%`);
  }

  const lines = [
    `🧭🩺 <b>Momentum Doctor</b>`,
    `Live sample: <b>${rows.length}</b> closed · ${fmtPct(pnl)} · WR ${rows.length ? ((rows.filter((r) => r.pnl_pct > 0).length / rows.length) * 100).toFixed(0) : '0'}%`,
    `Закрытия: ${esc(reasonMix(rows))}`,
    `Слои: ${esc(layerMix(rows))}`,
    ``,
    `<b>Стоп-пол: контрфакт</b>`,
    ...scores.map((s) => `• floor ${(s.minStopPct * 100).toFixed(1)}%: ${fmtPct(s.sum)} · WR ${rows.length ? ((s.wins / rows.length) * 100).toFixed(0) : '0'}% · ${esc(s.reasons)}`),
    ``,
    `<b>Качество входа</b>`,
    `• close-extreme фильтр: ${entryExtreme.length}/${rows.length} сделок · фактический PnL ${fmtPct(entryExtremePnl)}`,
    `• dead-impulse кандидаты: ${decayCandidates.length}/${rows.length} · фактический PnL ${fmtPct(decayCandidatePnl)}`,
    noMfe.length ? `• слабый MFE (&lt;1%): ${esc(noMfe.join(', '))}` : `• слабый MFE (&lt;1%): нет`,
    ``,
    `<b>Калибровка вероятности</b>`,
    ...(probLines.length ? probLines.map(esc) : [`• ждём новые сигналы с calibrated_prob`]),
    ``,
    `<b>Автотюнинг</b>`,
    autotuneEnabled ? `• режим: включён` : `• режим: выключен, только отчёт`,
    actions.length ? actions.map((a) => `• ${esc(a)}`).join('\n') : `• без автоправки: нужно &gt;=${MIN_SAMPLE_FOR_AUTOTUNE} закрытых live-сделок и преимущество &gt;=${MIN_AUTOTUNE_EDGE_PCT}%`,
    ``,
    `<i>Доктор может менять только ограниченные runtime-параметры риска. Размер, плечо и включение новой стратегии не меняются автоматически.</i>`,
  ];

  let sent = false;
  if (opts.notify ?? true) {
    await sendMessage({ channel: 'logs', text: lines.join('\n'), disable_notification: actions.length === 0 });
    sent = true;
  } else {
    logger.info({ text: lines.join('\n') }, 'hl-momentum doctor report');
  }
  setKvStmt.run(REPORT_KEY, String(maxId), nowMs, 'hl momentum doctor last reported closed trade id');
  return { sent, closed: rows.length, pnl };
}

export function startHlMomentumDoctorJob(): void {
  cron.schedule('37 */4 * * *', () => {
    void runHlMomentumDoctor().catch((err) => logger.error({ err }, 'hl-momentum doctor tick failed'));
  });
  const t = setTimeout(() => {
    void runHlMomentumDoctor().catch((err) => logger.error({ err }, 'hl-momentum doctor startup failed'));
  }, 180_000);
  t.unref();
  logger.info('hl-momentum doctor cron started (every 4h)');
}
