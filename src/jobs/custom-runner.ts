/**
 * THE LAB runner — drives the in-house (code-defined) strategies on a
 * PAPER account, every bar close. This is the live counterpart of the
 * backtest engine: the SAME CustomStrategy.decide() module runs here, so
 * backtest == paper, zero divergence.
 *
 * Isolation: every position is written with track='lab' (user_id NULL), so
 * it never touches the live book, the risk circuit-breaker, fan-out, or the
 * public /strategies list — only /lab.
 *
 * Idempotency: the engine model is "desired position", not events. We act
 * only on CLOSED bars and converge to the desired state, so re-running on
 * the same forming bar is a no-op (already in the right position). No bar-
 * cursor bookkeeping needed.
 *
 * Must run where Bybit klines are reachable (the VPS). Locally getKlines
 * throws → each step logs and skips (no-op), which is fine.
 */

import cron from 'node-cron';
import { getKlines, intervalStepMs } from '../backtest/klines.js';
import { LAB_STRATEGIES, LAB_TRACK, type LabStrategy } from '../strategies/lab-registry.js';
import { insertDecision, forceClose, type CloseReason } from '../db/repos/decisions.js';
import { labLiveOnOpen, labLiveOnClose, logLabLivePlan } from '../strategies/lab-live.js';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';

type LabPos = { id: number; side: string; entry: number; sl: number };

const activeLabStmt = db.prepare<[string, string], LabPos>(`
  SELECT id, side, entry, sl FROM decisions
   WHERE track = ? AND user_id IS NULL AND status = 'active' AND strategy_id = ?
   ORDER BY created_at DESC LIMIT 1
`);

function openLab(s: LabStrategy, side: 'long' | 'short', entry: number, barTime: number): void {
  const sl = side === 'long' ? entry * (1 - s.slPct) : entry * (1 + s.slPct);
  insertDecision({
    track: LAB_TRACK,
    userId: null,
    strategyId: s.id,
    symbol: s.symbol,
    side,
    entry,
    sl,
    reasoningShort: `lab ${s.code} ${side}`,
    reasoningFull: s.description,
    rawResponse: '{}',
    features: { bar: barTime, engine: 'custom', slPct: s.slPct },
  });
  logger.info({ id: s.id, side, entry: +entry.toFixed(6) }, 'lab-runner: opened paper position');
}

function closeLab(pos: LabPos, closePrice: number, closeReason: CloseReason, forceReason: string, slPct: number): void {
  const sign = pos.side === 'long' ? 1 : -1;
  const pnlPct = (sign * (closePrice - pos.entry)) / pos.entry * 100;
  const pnlR = slPct > 0 ? pnlPct / (slPct * 100) : 0;
  forceClose({
    id: pos.id,
    closePrice,
    closeReason,
    pnlPct: Math.round(pnlPct * 100) / 100,
    pnlR: Math.round(pnlR * 100) / 100,
    forceReason,
  });
  logger.info({ id: pos.id, closePrice: +closePrice.toFixed(6), closeReason, forceReason }, 'lab-runner: closed paper position');
}

async function step(s: LabStrategy, nowMs: number): Promise<void> {
  const stepMs = intervalStepMs(s.timeframe); // supports 'D'/'W' too, not just numeric minutes
  // Fetch enough history for warmup (EMA200 etc.) plus a buffer.
  const lookback = (s.warmup + 60) * stepMs;
  let candles;
  try {
    candles = await getKlines(s.symbol, s.timeframe, nowMs - lookback, nowMs);
  } catch (err) {
    logger.warn({ err: (err as Error).message, id: s.id }, 'lab-runner: klines fetch failed (Bybit unreachable?) — skipping');
    return;
  }
  // Act only on CLOSED bars (drop the still-forming current bar).
  const closed = candles.filter((c) => c.t + stepMs <= nowMs);
  if (closed.length <= s.warmup) return;
  const i = closed.length - 1;
  const bar = closed[i]!;

  let pos = activeLabStmt.get(LAB_TRACK, s.id) ?? null;

  // 1) Safety SL first — did this bar's range breach the stop?
  if (pos) {
    const slHit = pos.side === 'long' ? bar.l <= pos.sl : bar.h >= pos.sl;
    if (slHit) {
      const slPrice = pos.sl;
      closeLab(pos, slPrice, 'sl_hit', 'safety_sl', s.slPct);
      await labLiveOnClose(s, slPrice, bar.t); // mirror to the live book (no-op unless deployed + mode!=off)
      pos = null;
    }
  }

  // 2) Strategy decision on the bar close.
  const sig = s.decide(closed, i, pos ? (pos.side as 'long' | 'short') : null);

  if (pos) {
    if (sig === 'flat' || (sig !== null && sig !== pos.side)) {
      const flip = sig !== 'flat';
      closeLab(pos, bar.c, 'manual', flip ? 'reverse_signal' : 'strategy_exit', s.slPct);
      await labLiveOnClose(s, bar.c, bar.t);
      if (flip && (sig === 'long' || sig === 'short')) { openLab(s, sig, bar.c, bar.t); await labLiveOnOpen(s, sig, bar.c, bar.t); }
    }
  } else if (sig === 'long' || sig === 'short') {
    openLab(s, sig, bar.c, bar.t);
    await labLiveOnOpen(s, sig, bar.c, bar.t);
  }
}

let running = false;

/** Schedule the lab runner: every minute, step each lab strategy. A simple
 *  in-flight guard prevents overlap if a fetch is slow. */
export function startCustomRunner(): void {
  if (LAB_STRATEGIES.length === 0) return;
  cron.schedule('* * * * *', () => {
    if (running) return;
    running = true;
    const now = Date.now();
    void (async () => {
      for (const s of LAB_STRATEGIES) {
        try {
          await step(s, now);
        } catch (err) {
          logger.error({ err, id: s.id }, 'lab-runner: step failed');
        }
      }
    })().finally(() => {
      running = false;
    });
  });
  logger.info({ n: LAB_STRATEGIES.length }, 'lab-runner scheduled (every 1m, paper/track=lab)');
  logLabLivePlan(); // logs the live-deploy plan + sizing if LAB_LIVE.mode != 'off'
}
