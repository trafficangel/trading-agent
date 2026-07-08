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
  qty: number;
  x: number | null;
  opened_at: number;
  exit_px: number | null;
  closed_at: number;
  pnl_pct: number;
  close_reason: string | null;
};

type CandleRow = { t: number; h: number; l: number; c: number };
type PauseRow = { paused_until: number; last_seen_trade_id: number };
type ActivePauseRow = { coin: string; side: Side; paused_until: number; reason: string };

const MODE = 'live';
const COST_RT_PCT = 0.05;
const STOP_PCT = 0.04;
const LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const REPORT_KEY = 'wick_fade_doctor_last_report_id';
const HOLD_TESTS = [15, 20, 25, 30, 40, 60] as const;

const closedSinceStmt = db.prepare<[string, number], TradeRow>(`
  SELECT id, coin, side, entry_px, qty, x, opened_at, exit_px, closed_at, pnl_pct, close_reason
    FROM wick_fade_log
   WHERE mode = ?
     AND closed_at IS NOT NULL
     AND closed_at >= ?
     AND pnl_pct IS NOT NULL
   ORDER BY closed_at ASC
`);

const closedTodayStmt = db.prepare<[string, number], TradeRow>(`
  SELECT id, coin, side, entry_px, qty, x, opened_at, exit_px, closed_at, pnl_pct, close_reason
    FROM wick_fade_log
   WHERE mode = ?
     AND closed_at IS NOT NULL
     AND closed_at >= ?
     AND pnl_pct IS NOT NULL
   ORDER BY closed_at ASC
`);

const recentClosedStmt = db.prepare<[string, number], TradeRow>(`
  SELECT id, coin, side, entry_px, qty, x, opened_at, exit_px, closed_at, pnl_pct, close_reason
    FROM wick_fade_log
   WHERE mode = ?
     AND closed_at IS NOT NULL
     AND pnl_pct IS NOT NULL
     AND x IS NOT NULL
   ORDER BY closed_at DESC
   LIMIT ?
`);

const maxClosedIdStmt = db.prepare<[string], { id: number | null }>(`
  SELECT MAX(id) AS id FROM wick_fade_log WHERE mode = ? AND closed_at IS NOT NULL
`);

const candlesStmt = db.prepare<[string, number, number], CandleRow>(`
  SELECT t, h, l, c FROM hl_candles
   WHERE coin = ? AND t >= ? AND t <= ?
   ORDER BY t ASC
`);

const getKvStmt = db.prepare<[string], { value: string }>('SELECT value FROM runtime_config WHERE key = ?');
const setKvStmt = db.prepare<[string, string, number, string], void>(`
  INSERT INTO runtime_config (key, value, updated_at, reason)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, reason = excluded.reason
`);

const getPauseStmt = db.prepare<[string, Side], PauseRow>(`
  SELECT paused_until, last_seen_trade_id
    FROM wick_fade_doctor_pause
   WHERE coin = ? AND side = ?
`);

const activePausesStmt = db.prepare<[number], ActivePauseRow>(`
  SELECT coin, side, paused_until, reason
    FROM wick_fade_doctor_pause
   WHERE paused_until > ?
   ORDER BY paused_until ASC, coin ASC, side ASC
`);

const upsertPauseStmt = db.prepare<[string, Side, number, string, number, number], void>(`
  INSERT INTO wick_fade_doctor_pause (coin, side, paused_until, reason, created_at, last_seen_trade_id)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(coin, side) DO UPDATE SET
    paused_until = excluded.paused_until,
    reason = excluded.reason,
    created_at = excluded.created_at,
    last_seen_trade_id = excluded.last_seen_trade_id
`);

function utcDayStart(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtPct(n: number, digits = 2): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function sum(rows: TradeRow[]): number {
  return rows.reduce((acc, r) => acc + r.pnl_pct, 0);
}

function winRate(rows: TradeRow[]): number {
  return rows.length ? (rows.filter((r) => r.pnl_pct > 0).length / rows.length) * 100 : 0;
}

function targetPx(t: TradeRow): number {
  const x = t.x ?? 0;
  return t.side === 'long' ? t.entry_px / (1 - x) : t.entry_px / (1 + x);
}

function stopPx(t: TradeRow): number {
  return t.side === 'long' ? t.entry_px * (1 - STOP_PCT) : t.entry_px * (1 + STOP_PCT);
}

function pnlPct(side: Side, entry: number, exit: number): number {
  return (side === 'long' ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100) - COST_RT_PCT;
}

function simulateHold(t: TradeRow, holdMin: number): { pnl: number; kind: 'target' | 'catastrophe' | 'time' } | null {
  if (t.x == null) return null;
  const from = Math.floor(t.opened_at / 300_000) * 300_000;
  const deadline = t.opened_at + holdMin * 60_000;
  const to = deadline + 10 * 60_000;
  const candles = candlesStmt.all(t.coin, from, to);
  if (candles.length === 0) return null;

  const target = targetPx(t);
  const stop = stopPx(t);
  let lastClose = candles[0]!.c;

  for (const c of candles) {
    lastClose = c.c;
    if (c.t > deadline) break;
    const cat = t.side === 'long' ? c.l <= stop : c.h >= stop;
    const hitTarget = t.side === 'long' ? c.h >= target : c.l <= target;
    if (cat) return { pnl: pnlPct(t.side, t.entry_px, stop), kind: 'catastrophe' };
    if (hitTarget) return { pnl: pnlPct(t.side, t.entry_px, target), kind: 'target' };
  }

  const exit = candles.find((c) => c.t >= deadline)?.c ?? lastClose;
  return { pnl: pnlPct(t.side, t.entry_px, exit), kind: 'time' };
}

function holdCounterfactual(rows: TradeRow[]): string[] {
  const lines: string[] = [];
  const sample = rows.filter((r) => r.x != null).slice(0, 120);
  if (sample.length < 12) return ['контрфакт тайм-стопа: мало данных'];

  let best: { hold: number; total: number } | null = null;
  const totals = new Map<number, number>();
  for (const hold of HOLD_TESTS) {
    const sims = sample.map((r) => simulateHold(r, hold)).filter((r): r is NonNullable<typeof r> => r != null);
    if (sims.length < Math.max(10, sample.length * 0.7)) continue;
    const total = sims.reduce((acc, r) => acc + r.pnl, 0);
    const wr = (sims.filter((r) => r.pnl > 0).length / sims.length) * 100;
    const cats = sims.filter((r) => r.kind === 'catastrophe').length;
    totals.set(hold, total);
    if (!best || total > best.total) best = { hold, total };
    lines.push(`${hold}м ${fmtPct(total, 1)} · WR ${wr.toFixed(0)}% · стопов ${cats}`);
  }

  if (best) lines.unshift(`лучший быстрый тест: <b>${best.hold}м</b> (${fmtPct(best.total, 1)})`);
  const h25 = totals.get(25);
  const h30 = totals.get(30);
  if (h25 != null && h30 != null && h25 > h30 + 2) {
    lines.unshift(`рекомендация: <b>25м</b> кандидат вместо 30м, преимущество ${fmtPct(h25 - h30, 1)} на выборке`);
  }
  return lines.length ? lines : ['контрфакт тайм-стопа: не хватило свечей'];
}

type SideBucket = {
  coin: string;
  side: Side;
  n: number;
  wins: number;
  sum: number;
  timeN: number;
  timeWins: number;
  timeSum: number;
  catN: number;
  maxId: number;
};

function sideBuckets(rows: TradeRow[]): SideBucket[] {
  const m = new Map<string, SideBucket>();
  for (const r of rows) {
    const key = `${r.coin}:${r.side}`;
    let b = m.get(key);
    if (!b) {
      b = { coin: r.coin, side: r.side, n: 0, wins: 0, sum: 0, timeN: 0, timeWins: 0, timeSum: 0, catN: 0, maxId: 0 };
      m.set(key, b);
    }
    b.n++;
    b.sum += r.pnl_pct;
    if (r.pnl_pct > 0) b.wins++;
    if (r.close_reason === 'time-stop') {
      b.timeN++;
      b.timeSum += r.pnl_pct;
      if (r.pnl_pct > 0) b.timeWins++;
    }
    if (r.close_reason === 'catastrophe' || (r.close_reason === 'reconciled-flat' && r.pnl_pct <= -2)) b.catN++;
    b.maxId = Math.max(b.maxId, r.id);
  }
  return [...m.values()];
}

function pauseReason(b: SideBucket): string | null {
  if (b.n >= 5 && b.sum <= -2) return `${b.n} сделок за 7д / ${fmtPct(b.sum)} суммарно`;
  if (b.timeN >= 3 && b.timeWins === 0 && b.timeSum <= -1.5) {
    return `${b.timeN} тайм-стопа подряд без плюса / ${fmtPct(b.timeSum)} суммарно`;
  }
  if (b.catN >= 2) return `${b.catN} катастрофических выхода за 7д`;
  return null;
}

function applyProtectivePauses(buckets: SideBucket[], nowMs: number): string[] {
  const actions: string[] = [];
  for (const b of buckets) {
    const reason = pauseReason(b);
    if (!reason) continue;
    const existing = getPauseStmt.get(b.coin, b.side);
    if (existing?.last_seen_trade_id === b.maxId) continue;
    const pauseMs = b.catN >= 2 ? 72 * 60 * 60_000 : 24 * 60 * 60_000;
    const until = nowMs + pauseMs;
    upsertPauseStmt.run(b.coin, b.side, until, reason, nowMs, b.maxId);
    actions.push(`${b.coin} ${b.side}: пауза до ${new Date(until).toISOString().slice(0, 16)} UTC — ${reason}`);
  }
  return actions;
}

function renderReasonMix(rows: TradeRow[]): string {
  const mix = new Map<string, number>();
  for (const r of rows) mix.set(r.close_reason ?? 'unknown', (mix.get(r.close_reason ?? 'unknown') ?? 0) + 1);
  return [...mix.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'нет закрытий';
}

function renderSideLine(b: SideBucket): string {
  const wr = b.n ? (b.wins / b.n) * 100 : 0;
  return `${b.coin} ${b.side}: ${b.n} сделок · ${fmtPct(b.sum)} · WR ${wr.toFixed(0)}%`;
}

function renderPauseLine(p: ActivePauseRow): string {
  return `${p.coin} ${p.side}: до ${new Date(p.paused_until).toISOString().slice(0, 16)} UTC — ${p.reason}`;
}

export type WickFadeDoctorResult = {
  closedToday: number;
  dayPnlPct: number;
  lookbackClosed: number;
  lookbackPnlPct: number;
  pauseActions: string[];
  sent: boolean;
};

export async function runWickFadeDoctor(opts: { force?: boolean; notify?: boolean; nowMs?: number } = {}): Promise<WickFadeDoctorResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const today = closedTodayStmt.all(MODE, utcDayStart(nowMs));
  const lookback = closedSinceStmt.all(MODE, nowMs - LOOKBACK_MS);
  const buckets = sideBuckets(lookback);
  const pauseActions = applyProtectivePauses(buckets, nowMs);
  const maxId = maxClosedIdStmt.get(MODE)?.id ?? 0;
  const lastReported = Number(getKvStmt.get(REPORT_KEY)?.value ?? 0);

  const result: WickFadeDoctorResult = {
    closedToday: today.length,
    dayPnlPct: sum(today),
    lookbackClosed: lookback.length,
    lookbackPnlPct: sum(lookback),
    pauseActions,
    sent: false,
  };

  if (!opts.force && maxId <= lastReported && pauseActions.length === 0) {
    logger.info({ maxId }, 'wick-fade doctor: no new closed trades');
    return result;
  }

  const recent = recentClosedStmt.all(MODE, 120);
  const activePauses = activePausesStmt.all(nowMs);
  const laggards = buckets.filter((b) => b.n >= 2).sort((a, b) => a.sum - b.sum).slice(0, 5);
  const leaders = buckets.filter((b) => b.n >= 2).sort((a, b) => b.sum - a.sum).slice(0, 3);
  const holdLines = holdCounterfactual(recent);

  const lines = [
    `🩺 <b>Wick-Fade Doctor</b>`,
    `Сегодня: <b>${today.length}</b> сделок · ${fmtPct(sum(today))} · WR ${winRate(today).toFixed(0)}%`,
    `7д: <b>${lookback.length}</b> сделок · ${fmtPct(sum(lookback))} · WR ${winRate(lookback).toFixed(0)}%`,
    `Закрытия: ${esc(renderReasonMix(today))}`,
    ``,
    `<b>Тайм-стоп: что было бы</b>`,
    ...holdLines.map((l) => `• ${l}`),
    ``,
    `<b>Слабые стороны</b>`,
    ...(laggards.length ? laggards.map((b) => `• ${esc(renderSideLine(b))}`) : ['• слабых сторон пока нет']),
    ``,
    `<b>Сильные стороны</b>`,
    ...(leaders.length ? leaders.map((b) => `• ${esc(renderSideLine(b))}`) : ['• мало данных']),
    ``,
    `<b>Автозащита</b>`,
    ...(pauseActions.length ? pauseActions.map((a) => `• новая: ${esc(a)}`) : ['• новых пауз нет']),
    ...(activePauses.length ? activePauses.map((p) => `• активна: ${esc(renderPauseLine(p))}`) : []),
    ``,
    `<i>Правило: доктор может только снижать риск. Увеличение размера/плеча — вручную.</i>`,
  ];

  if (opts.notify ?? true) {
    await sendMessage({ channel: 'logs', text: lines.join('\n'), disable_notification: pauseActions.length === 0 });
    result.sent = true;
  } else {
    logger.info({ text: lines.join('\n') }, 'wick-fade doctor report');
  }

  setKvStmt.run(REPORT_KEY, String(maxId), nowMs, 'wick-fade doctor last reported closed trade id');
  return result;
}

export function startWickFadeDoctorJob(): void {
  cron.schedule('17 */4 * * *', () => {
    void runWickFadeDoctor().catch((err) => logger.error({ err }, 'wick-fade doctor tick failed'));
  });
  const t = setTimeout(() => {
    void runWickFadeDoctor().catch((err) => logger.error({ err }, 'wick-fade doctor startup failed'));
  }, 90_000);
  t.unref();
  logger.info('wick-fade doctor cron started (every 4h)');
}
