import cron from 'node-cron';
import { existsSync } from 'node:fs';
import { logger } from '../lib/logger.js';
import {
  findActivePositions,
  findDecisionById,
  calcPnl,
  closePositionWithStats,
  forceClose,
  type DecisionRow,
} from '../db/repos/decisions.js';
import { getLastPrice } from '../exchange/bybit-public.js';
import { sendMessage, sendPhoto } from '../telegram/bot.js';
import { resultPost } from '../telegram/result-template.js';
import { markTick } from '../lib/health-tracker.js';

let running = false;

/**
 * Track C tpsl-monitor — safety SL only.
 *
 * LuxAlgo Strategy Builder positions delegate primary exit logic to the
 * strategy's own "Builtin Exits" via webhook (handled in
 * src/strategies/strategy-trader.ts). This monitor is the safety net for:
 *   - Strategy didn't send exit in time (or webhook lost in transit) AND
 *     price moved against us beyond the configured safety SL.
 *
 * No TP detection, no SL→BE move, no multi-TP / partial-close logic —
 * those were Track A/B concepts and have been removed.
 *
 * Time-guard: Track C positions are INTENTIONALLY exempt from the 24h
 * time-cap. LuxAlgo backtests routinely hold positions multiple days
 * (avg duration on STRAT-001 ≈ 39h on 15m), and force-closing at 24h
 * bypasses the strategy's own edge.
 */

async function checkPosition(pInput: DecisionRow): Promise<void> {
  // Refresh from DB on each tick. Concurrent mutations (force_close
  // from a strategy_exit webhook) require fresh state.
  const fresh = findDecisionById(pInput.id);
  if (!fresh || fresh.status !== 'active') return;
  const p = fresh;

  if (!p.entry || !p.sl || !p.side) return;
  if (p.side !== 'long' && p.side !== 'short') return;

  const price = await getLastPrice(p.symbol);
  if (price == null) return;

  // Safety SL check — Track C is SL-only, no TP, no BE move.
  const slHit = (p.side === 'long' && price <= p.sl) || (p.side === 'short' && price >= p.sl);
  if (slHit) {
    return closeFull(p, p.sl, 'sl_hit', '🛡 Safety SL');
  }
}

/** Close the position with computed PnL (R is computed from original SL
 *  so partial fills / SL moves never inflate the realised-R number). */
async function closeFull(
  p: DecisionRow,
  closePrice: number,
  reason: 'tp_hit' | 'sl_hit' | 'manual',
  hint: string,
): Promise<void> {
  if (!p.entry || !p.side) return;
  const slForR = p.original_sl ?? p.sl ?? p.entry;
  const { pnlPct, pnlR } = calcPnl(p.side as 'long' | 'short', p.entry, slForR, closePrice);
  const closed = closePositionWithStats({ id: p.id, closePrice, closeReason: reason, pnlPct, pnlR });
  if (!closed) {
    logger.info({ position_id: p.id, reason }, 'tpsl: already closed elsewhere, skip post');
    return;
  }
  logger.info(
    { position_id: p.id, reason, closePrice, pnlPct, pnlR, hint },
    'tpsl monitor: position closed',
  );
  await postCloseMessage(p, closePrice, reason, pnlPct, pnlR);
}

async function postCloseMessage(
  p: DecisionRow,
  closePrice: number,
  reason: 'tp_hit' | 'sl_hit' | 'manual',
  pnlPct: number,
  pnlR: number,
): Promise<void> {
  if (!p.entry || !p.side || !p.sl) return;
  // Track C extras: USD P&L on $1000 notional, STRAT-XXX badge,
  // per-strategy counter, landing link. Lazy-imported to avoid
  // circular import between tpsl-monitor → track-c-config.
  let notionalUsd: number | undefined;
  let strategyCode: string | null = null;
  let strategyName: string | null = null;
  let landingUrl: string | null = null;
  if (p.track === 'strategy') {
    const { TRACK_C_NOTIONAL_USD, getStrategyConfig, LANDING_BASE_URL } =
      await import('../strategies/track-c-config.js');
    notionalUsd = TRACK_C_NOTIONAL_USD;
    if (p.strategy_id) {
      const cfg = getStrategyConfig(p.strategy_id);
      strategyCode = cfg?.code ?? null;
      strategyName = cfg?.name ?? null;
      if (strategyCode) landingUrl = `${LANDING_BASE_URL}/strategies/${strategyCode}`;
    }
  }
  const text = resultPost({
    parentTradeId: p.id,
    symbol: p.symbol,
    side: p.side as 'long' | 'short',
    entry: p.entry,
    sl: p.sl,
    tp: null,
    closePrice,
    closeReason: reason,
    pnlPct,
    pnlR,
    durationMs: Date.now() - (p.filled_at ?? p.created_at),
    track: p.track,
    notionalUsd,
    forceCloseReason: p.force_close_reason ?? null,
    strategyCode,
    strategyName,
    strategyTradeNum: p.strategy_trade_num,
    landingUrl,
  });
  if (p.screenshot_path && existsSync(p.screenshot_path)) {
    const sent = await sendPhoto({ channel: 'signals', photoPath: p.screenshot_path, caption: text });
    if (!sent) await sendMessage({ channel: 'signals', text });
  } else {
    await sendMessage({ channel: 'signals', text });
  }
  await sendMessage({ channel: 'logs', text, disable_notification: true });
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const positions = findActivePositions();
    for (const p of positions) {
      try {
        await checkPosition(p);
      } catch (err) {
        logger.error({ err, position_id: p.id }, 'tpsl checkPosition failed');
      }
    }
  } finally {
    running = false;
    markTick('tpsl');
  }
}

// Re-export for forceClose users (none currently outside the monitor itself,
// but kept here so jobs that import forceClose see one source of truth).
export { forceClose };

export function startTpslMonitorJob(): void {
  // Every minute. Bybit public API allows this with massive headroom.
  cron.schedule('* * * * *', () => {
    void tick();
  });
  logger.info('tpsl monitor cron started (every 1 min)');
}
