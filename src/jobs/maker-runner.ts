/**
 * THE LAB — MAKER runner. Forward-tests the low-TF mean-reversion edges that
 * are net-negative at taker but positive at maker fees (Keltner/z-score @5m).
 *
 * Faithful maker paper model (the value over the backtest, which ASSUMED
 * fills): rest a limit at the band; it FILLS only when a later bar's range
 * touches the limit price. Lifecycle via decision status:
 *   none → quote(flat) gives an entry limit → insert status='pending'
 *   pending → next bar touched the limit? → status='active' (filled at limit)
 *             else reprice the resting limit to the new band (or cancel)
 *   active → quote(pos) gives an exit limit at the mean → bar touches → close
 *            (+ safety SL, + max-hold backstop)
 *
 * Fully isolated on track='lab-maker' (user_id NULL): tpsl-monitor skips it,
 * never fans out, never posts to Signals. Net PnL uses the maker commission.
 * VPS-only (Bybit klines). No-ops locally where Bybit is unreachable.
 */

import cron from 'node-cron';
import { getKlines, intervalStepMs } from '../backtest/klines.js';
import { MAKER_LAB_STRATEGIES, LAB_MAKER_TRACK, type LabStrategy } from '../strategies/lab-registry.js';
import { forceClose, type CloseReason } from '../db/repos/decisions.js';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';

const TTL_BARS = 20;       // cancel a resting entry limit if unfilled this long
// Time stop = 48 bars. The SL-mode audit (scripts/sl-mode-audit.ts) found the
// price stop barely matters for these 5m MR edges (5%≈8%≈no-SL) and ATR stops
// HURT — but a ~48-bar time stop improves OOS robustness + cuts drawdown (MR
// thesis: if it hasn't reverted to the mean in 4h, it failed → exit). Paired
// with the wide 8% catastrophe price stop on the strategies.
const MAX_HOLD_BARS = 48;


type OpenRow = { id: number; status: string; side: string; entry: number; sl: number; created_at: number; filled_at: number | null; features_json: string | null };

const findOpenStmt = db.prepare<[string, string], OpenRow>(`
  SELECT id, status, side, entry, sl, created_at, filled_at, features_json
  FROM decisions
  WHERE track = ? AND user_id IS NULL AND strategy_id = ? AND status IN ('pending', 'active')
  ORDER BY created_at DESC LIMIT 1
`);
const nextNumStmt = db.prepare<[string], { n: number }>(`SELECT COALESCE(MAX(strategy_trade_num), 0) + 1 AS n FROM decisions WHERE strategy_id = ? AND user_id IS NULL`);
const insertPendingStmt = db.prepare(`
  INSERT INTO decisions (created_at, symbol, confluence_score, signal_ids, decision, side, entry, sl, reasoning_short, reasoning_full, raw_response, status, features_json, track, original_sl, strategy_id, strategy_trade_num)
  VALUES (?, ?, 0, '[]', 'OPEN', ?, ?, ?, ?, ?, '{}', 'pending', ?, ?, ?, ?, ?)`);
const activateStmt = db.prepare(`UPDATE decisions SET status = 'active', filled_at = ?, entry = ? WHERE id = ?`);
const repriceStmt = db.prepare(`UPDATE decisions SET entry = ?, sl = ?, original_sl = ?, features_json = ? WHERE id = ?`);
const cancelStmt = db.prepare(`DELETE FROM decisions WHERE id = ?`);

function slFor(side: 'long' | 'short', limit: number, slPct: number): number {
  return side === 'long' ? limit * (1 - slPct) : limit * (1 + slPct);
}

function placePending(s: LabStrategy, side: 'long' | 'short', limit: number, barT: number): void {
  const num = nextNumStmt.get(s.id)?.n ?? 1;
  const sl = slFor(side, limit, s.slPct);
  insertPendingStmt.run(Date.now(), s.symbol, side, limit, sl, `maker ${s.code} ${side} limit`, s.description, JSON.stringify({ bar: barT, maker: true }), LAB_MAKER_TRACK, sl, s.id, num);
  logger.info({ id: s.id, side, limit: +limit.toFixed(6) }, 'maker-runner: placed entry limit');
}

function closeMaker(o: OpenRow, closePrice: number, slPct: number, reason: CloseReason, force: string): void {
  const sign = o.side === 'long' ? 1 : -1;
  const pnlPct = (sign * (closePrice - o.entry)) / o.entry * 100;
  forceClose({ id: o.id, closePrice, closeReason: reason, pnlPct: Math.round(pnlPct * 100) / 100, pnlR: slPct > 0 ? Math.round((pnlPct / (slPct * 100)) * 100) / 100 : 0, forceReason: force });
  logger.info({ id: o.id, closePrice: +closePrice.toFixed(6), force }, 'maker-runner: closed paper position');
}

async function step(s: LabStrategy, nowMs: number): Promise<void> {
  if (!s.quote) return;
  const stepMs = intervalStepMs(s.timeframe);
  let candles;
  try { candles = await getKlines(s.symbol, s.timeframe, nowMs - (s.warmup + 60) * stepMs, nowMs); }
  catch (err) { logger.warn({ err: (err as Error).message, id: s.id }, 'maker-runner: klines fetch failed — skip'); return; }
  const closed = candles.filter((c) => c.t + stepMs <= nowMs);
  if (closed.length <= s.warmup) return;
  const i = closed.length - 1;
  const bar = closed[i]!;
  const open = findOpenStmt.get(LAB_MAKER_TRACK, s.id) ?? null;

  if (open && open.status === 'active') {
    const side = open.side as 'long' | 'short';
    // safety SL (taker stop, rare)
    if (side === 'long' ? bar.l <= open.sl : bar.h >= open.sl) { closeMaker(open, open.sl, s.slPct, 'sl_hit', 'safety_sl'); return; }
    // max-hold backstop
    if (nowMs - (open.filled_at ?? open.created_at) > MAX_HOLD_BARS * stepMs) { closeMaker(open, bar.c, s.slPct, 'manual', 'max_hold'); return; }
    // maker exit: rest a limit at the mean, fill on touch
    const q = s.quote(closed, i, side);
    if (q && q.kind === 'exit') {
      const hit = side === 'long' ? bar.h >= q.limit : bar.l <= q.limit;
      if (hit) closeMaker(open, q.limit, s.slPct, 'manual', 'maker_exit');
    }
    return;
  }

  if (open && open.status === 'pending') {
    const placedBarT = (() => { try { return (JSON.parse(open.features_json ?? '{}') as { bar?: number }).bar ?? 0; } catch { return 0; } })();
    const side = open.side as 'long' | 'short';
    if (bar.t > placedBarT) {
      const touched = side === 'long' ? bar.l <= open.entry : bar.h >= open.entry;
      if (touched) { activateStmt.run(nowMs, open.entry, open.id); logger.info({ id: s.id, side, fill: +open.entry.toFixed(6) }, 'maker-runner: limit filled'); return; }
      // not filled → reprice to the current band, or cancel
      if (nowMs - open.created_at > TTL_BARS * stepMs) { cancelStmt.run(open.id); return; }
      const q = s.quote(closed, i, null);
      if (q && q.kind === 'entry' && q.side === side) { const sl = slFor(side, q.limit, s.slPct); repriceStmt.run(q.limit, sl, sl, JSON.stringify({ bar: bar.t, maker: true }), open.id); }
      else if (q && q.kind === 'entry') { cancelStmt.run(open.id); placePending(s, q.side, q.limit, bar.t); }
      else cancelStmt.run(open.id);
    }
    return;
  }

  // flat, no resting order → place an entry limit if the strategy quotes one
  const q = s.quote(closed, i, null);
  if (q && q.kind === 'entry') placePending(s, q.side, q.limit, bar.t);
}

let running = false;
export function startMakerRunner(): void {
  if (MAKER_LAB_STRATEGIES.length === 0) return;
  cron.schedule('* * * * *', () => {
    if (running) return;
    running = true;
    const now = Date.now();
    void (async () => {
      for (const s of MAKER_LAB_STRATEGIES) {
        try { await step(s, now); } catch (err) { logger.error({ err, id: s.id }, 'maker-runner: step failed'); }
      }
    })().finally(() => { running = false; });
  });
  logger.info({ n: MAKER_LAB_STRATEGIES.length }, 'maker-runner scheduled (every 1m, paper/track=lab-maker)');
}
