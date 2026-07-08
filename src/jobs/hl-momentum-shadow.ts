/**
 * HL Momentum Shadow — paper-only counterweight to wick-fade.
 *
 * Wick-fade sells panic/greed spikes and needs snap-back. This shadow strategy
 * tests the opposite regime: an impulse that holds and continues. It only reads
 * native Hyperliquid 5m candles from hl_candles and writes simulated fills to
 * hl_momentum_shadow_* tables. No exchange calls, no real orders.
 */
import cron from 'node-cron';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { sendMessage } from '../telegram/bot.js';
import { WF_CONFIG } from './wick-fade-runner.js';

type Side = 'long' | 'short';
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type Pos = { coin: string; side: Side; entry_px: number; qty: number; opened_at: number; signal: string };
type LogRow = { id: number; coin: string; side: Side; pnl_pct: number; close_reason: string | null; closed_at: number };

const COINS = WF_CONFIG.coins;
const NOTIONAL_USD = 12;
const COST_RT_PCT = 0.07; // shadow assumes taker entry + taker exit, conservative vs maker wick-fade
const HOLD_MS = 30 * 60_000;
const STOP_PCT = 0.012;
const TARGET_PCT = 0.018;
const IMPULSE_3BAR_PCT = 1.2;
const VOL_RATIO_MIN = 1.8;
const TREND_1H_PCT = 0.6;
const REPORT_KEY = 'hl_momentum_shadow_last_report_id';

const candlesStmt = db.prepare<[string, number], Candle>(`
  SELECT t, o, h, l, c, v FROM hl_candles
   WHERE coin = ?
   ORDER BY t DESC
   LIMIT ?
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

function pct(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

function pnlPct(side: Side, entry: number, exit: number): number {
  return (side === 'long' ? pct(entry, exit) : pct(exit, entry)) - COST_RT_PCT;
}

function fmtPct(n: number, digits = 2): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getCandles(coin: string, n = 90): Candle[] {
  return candlesStmt.all(coin, n).reverse();
}

function avgVolume(cs: Candle[], endExclusive: number, n: number): number {
  const from = Math.max(0, endExclusive - n);
  const slice = cs.slice(from, endExclusive);
  if (slice.length === 0) return 0;
  return slice.reduce((s, c) => s + c.v, 0) / slice.length;
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

  if (r3 >= IMPULSE_3BAR_PCT && r12 >= TREND_1H_PCT && volRatio >= VOL_RATIO_MIN && closeNearHigh >= 0.65) {
    return { side: 'long', signal: `${coin} up impulse r3=${r3.toFixed(2)} vol=${volRatio.toFixed(1)}x` };
  }
  if (r3 <= -IMPULSE_3BAR_PCT && r12 <= -TREND_1H_PCT && volRatio >= VOL_RATIO_MIN && closeNearHigh <= 0.35) {
    return { side: 'short', signal: `${coin} down impulse r3=${r3.toFixed(2)} vol=${volRatio.toFixed(1)}x` };
  }
  return null;
}

function managePosition(pos: Pos, cs: Candle[]): boolean {
  const last = cs.at(-1);
  if (!last || last.t <= pos.opened_at) return false;

  const stop = pos.side === 'long' ? pos.entry_px * (1 - STOP_PCT) : pos.entry_px * (1 + STOP_PCT);
  const target = pos.side === 'long' ? pos.entry_px * (1 + TARGET_PCT) : pos.entry_px * (1 - TARGET_PCT);
  const stopHit = pos.side === 'long' ? last.l <= stop : last.h >= stop;
  const targetHit = pos.side === 'long' ? last.h >= target : last.l <= target;
  const timed = last.t - pos.opened_at >= HOLD_MS;

  if (!stopHit && !targetHit && !timed) return false;

  // Conservative same-bar ordering: stop before target.
  const reason = stopHit ? 'stop' : targetHit ? 'target' : 'time-stop';
  const exit = stopHit ? stop : targetHit ? target : last.c;
  const pnl = pnlPct(pos.side, pos.entry_px, exit);
  closeTxn(pos.coin, exit, last.t, Math.round(pnl * 1000) / 1000, reason);
  logger.info({ coin: pos.coin, side: pos.side, pnl: +pnl.toFixed(3), reason }, 'hl-momentum-shadow: closed paper position');
  return true;
}

function stepCoin(coin: string): void {
  const cs = getCandles(coin);
  if (cs.length < 70) return;
  const pos = getPosStmt.get(coin);
  if (pos && managePosition(pos, cs)) return;
  if (pos) return;

  const sig = decide(coin, cs);
  if (!sig) return;
  const last = cs.at(-1)!;
  const qty = NOTIONAL_USD / last.c;
  openTxn(coin, sig.side, last.c, qty, last.t, sig.signal);
  logger.info({ coin, side: sig.side, entry: +last.c.toFixed(6), signal: sig.signal }, 'hl-momentum-shadow: opened paper position');
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
    `Статус: бумага, реальных ордеров нет`,
    `Последние ${closed}: ${fmtPct(sum)} · WR ${closed ? ((wins / closed) * 100).toFixed(0) : '0'}% · открыто ${open.length}`,
    `Выходы: ${esc(mix)}`,
    leaders.length ? `Сильные: ${esc(leaders.join(', '))}` : `Сильные: мало данных`,
    laggards.length ? `Слабые: ${esc(laggards.join(', '))}` : `Слабые: мало данных`,
    `<i>Идея: проверяем продолжение импульса с объёмом, как диверсификатор к wick-fade.</i>`,
  ].join('\n');
}

let running = false;
async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const coin of COINS) stepCoin(coin);
  } catch (err) {
    logger.error({ err }, 'hl-momentum-shadow: tick failed');
  } finally {
    running = false;
  }
}

export async function runHlMomentumShadowReport(opts: { force?: boolean; notify?: boolean } = {}): Promise<{ closed: number; open: number; sent: boolean }> {
  const rows = recentClosedStmt.all(120);
  const open = allPosStmt.all();
  const maxId = maxClosedIdStmt.get()?.id ?? 0;
  const lastReported = Number(getKvStmt.get(REPORT_KEY)?.value ?? 0);
  const result = { closed: rows.length, open: open.length, sent: false };
  if (!opts.force && maxId <= lastReported) return result;
  if (opts.notify ?? true) {
    await sendMessage({ channel: 'logs', text: reportText(rows.reverse(), open), disable_notification: true });
    result.sent = true;
  } else {
    logger.info({ text: reportText(rows.reverse(), open) }, 'hl-momentum-shadow report');
  }
  setKvStmt.run(REPORT_KEY, String(maxId), Date.now(), 'hl momentum shadow last report');
  return result;
}

export function startHlMomentumShadowJob(): void {
  cron.schedule('*/5 * * * *', () => { void tick(); });
  cron.schedule('29 */4 * * *', () => {
    void runHlMomentumShadowReport().catch((err) => logger.error({ err }, 'hl-momentum-shadow: report failed'));
  });
  const t = setTimeout(() => { void tick(); }, 75_000);
  t.unref();
  logger.info({ coins: COINS.length }, 'hl-momentum-shadow scheduled (5m, paper-only)');
}
