import { logger } from '../lib/logger.js';
import {
  findActiveOrPendingByTrack,
  forceClose,
  calcPnl,
  type DecisionRow,
} from '../db/repos/decisions.js';
import { getLastPrice } from '../exchange/bybit-public.js';
import { sendMessage } from '../telegram/bot.js';
import type { LuxAlgoPayload } from '../webhooks/luxalgo.schema.js';

/**
 * Counter-signal exit logic for Track B (signal-trader).
 *
 * Track C (LuxAlgo Strategy Builder) is **IMMUNE** — this module only
 * queries `findActiveOrPendingByTrack(symbol, 'signal')`, so Track C
 * positions are never touched. That's intentional: Track C exits are
 * fully owned by the strategy's Builtin Exits webhook.
 *
 * When a webhook arrives that REVERSES the active Track B position's
 * thesis, close the position early at market — don't wait for SL.
 *
 * Two rules:
 *   1. **Structural reversal** (high confidence): opposing CHoCH+ or BOS
 *      on the SAME or HIGHER timeframe as the position's trigger. These
 *      events represent confirmed structure breaks — the market has flipped,
 *      our thesis is dead.
 *   2. **Major signal reversal** (medium confidence): opposing bullish_plus
 *      or bearish_plus on a HIGHER timeframe only. (Same-TF counter-signal
 *      is too noisy on its own.)
 *
 * Reversal_signal_up/down are NOT used as counter-exits — they fire too
 * often on small swings and would chop us out of valid positions.
 *
 * If position is partial-closed (TP1 already hit), counter-exit still
 * applies — close remaining 50% at market. Weighted PnL becomes
 * 0.5×(+1R) + 0.5×(current R) which can be positive or negative.
 */

const STRUCTURAL_EVENTS_LONG = new Set(['choch_swing_plus_up', 'bos_swing_up']);
const STRUCTURAL_EVENTS_SHORT = new Set(['choch_swing_plus_down', 'bos_swing_down']);
const MAJOR_LONG = new Set(['bullish_plus']);
const MAJOR_SHORT = new Set(['bearish_plus']);

/** Order of TFs from smaller to larger. Higher index = higher (slower) TF. */
const TF_RANK: Record<string, number> = {
  '1': 0, '3': 1, '5': 2, '15': 3, '30': 4, '60': 5, '120': 6, '240': 7, '360': 8, '720': 9, 'D': 10,
};

function getTfRank(tf: string): number {
  return TF_RANK[tf] ?? -1;
}

/**
 * Called from webhook route after the raw signal is stored. Checks if the
 * signal qualifies as a counter to an active Track B position on the same
 * symbol; if so, force-closes the position.
 */
export async function maybeCounterExit(payload: LuxAlgoPayload): Promise<void> {
  // Only Track B positions are subject to counter-exit. Track A has its
  // own LLM-driven re-evaluation flow.
  const active = findActiveOrPendingByTrack(payload.symbol, 'signal');
  if (!active || active.status !== 'active' || !active.side) return;

  // Classify the incoming event vs active position direction.
  const isCounterLong = active.side === 'long' && (STRUCTURAL_EVENTS_SHORT.has(payload.event) || MAJOR_SHORT.has(payload.event));
  const isCounterShort = active.side === 'short' && (STRUCTURAL_EVENTS_LONG.has(payload.event) || MAJOR_LONG.has(payload.event));
  if (!isCounterLong && !isCounterShort) return;

  // Get position's trigger TF from features_json.
  let positionTf: string | null = null;
  if (active.features_json) {
    try {
      const f = JSON.parse(active.features_json) as { trigger_tf?: string };
      positionTf = f.trigger_tf ?? null;
    } catch {
      // ignore malformed
    }
  }
  const posTfRank = positionTf ? getTfRank(positionTf) : -1;
  const sigTfRank = getTfRank(payload.timeframe);

  const isStructural = STRUCTURAL_EVENTS_LONG.has(payload.event) || STRUCTURAL_EVENTS_SHORT.has(payload.event);
  const isMajor = MAJOR_LONG.has(payload.event) || MAJOR_SHORT.has(payload.event);

  let shouldClose = false;
  let reason: string = '';
  if (isStructural && sigTfRank >= posTfRank) {
    // Structural reversal on same or higher TF — strong reason to exit
    shouldClose = true;
    reason = 'counter_structural';
  } else if (isMajor && sigTfRank > posTfRank) {
    // Major reversal on STRICTLY higher TF (not same — too noisy)
    shouldClose = true;
    reason = 'counter_signal';
  }
  if (!shouldClose) return;

  // Force-close at market.
  const price = await getLastPrice(payload.symbol);
  if (price == null) {
    logger.warn(
      { position_id: active.id, event: payload.event, tf: payload.timeframe },
      'counter-exit: matched but price unavailable, skipping',
    );
    return;
  }

  const slForR = active.original_sl ?? active.sl ?? active.entry ?? price;
  if (!active.entry) return;
  // Narrow side to the union calcPnl expects (we already checked it's set above)
  const side = active.side as 'long' | 'short';

  // Weighted PnL if partial-closed:
  //   partial=0: standard calcPnl on full 100% at price
  //   partial=50: 0.5×(TP1 R) + 0.5×(current R)
  let pnlPct: number;
  let pnlR: number;
  if (active.partial_closed_pct === 50 && active.partial_close_price !== null) {
    const partial = calcPnl(side, active.entry, slForR, active.partial_close_price);
    const final = calcPnl(side, active.entry, slForR, price);
    pnlPct = (partial.pnlPct + final.pnlPct) / 2;
    pnlR = Math.round((partial.pnlR + final.pnlR) * 0.5 * 100) / 100;
  } else {
    const r = calcPnl(side, active.entry, slForR, price);
    pnlPct = r.pnlPct;
    pnlR = r.pnlR;
  }

  const closed = forceClose({
    id: active.id,
    closePrice: price,
    closeReason: 'manual',
    pnlPct,
    pnlR,
    forceReason: reason,
  });
  if (!closed) {
    logger.info({ position_id: active.id }, 'counter-exit: already closed by another path');
    return;
  }

  logger.info(
    {
      position_id: active.id,
      side: active.side,
      event: payload.event,
      sig_tf: payload.timeframe,
      pos_tf: positionTf,
      reason,
      pnl_pct: pnlPct,
      pnl_r: pnlR,
    },
    `counter-exit: force-closed Track B position by ${reason}`,
  );

  await sendCounterExitPost(active, payload, price, pnlPct, pnlR, reason);
}

async function sendCounterExitPost(
  p: DecisionRow,
  payload: LuxAlgoPayload,
  price: number,
  pnlPct: number,
  pnlR: number,
  reason: string,
): Promise<void> {
  const tradeIdStr = `S#${p.id.toString().padStart(4, '0')}`;
  const sideE = p.side === 'long' ? '🟢' : '🔴';
  const reasonRu =
    reason === 'counter_structural'
      ? 'структурный разворот'
      : reason === 'counter_signal'
        ? 'противоположный сигнал на старшем TF'
        : reason;
  const pnlSign = pnlPct >= 0 ? '+' : '';
  const rSign = pnlR >= 0 ? '+' : '';

  const text = [
    `⚡ <b>Досрочный выход</b> · ${tradeIdStr}  ${sideE} ${p.symbol}`,
    ``,
    `Причина: ${reasonRu}`,
    `Триггер: <code>${payload.event}</code> на <code>${payload.timeframe}m</code>`,
    ``,
    `📤 Выход:  <code>${price}</code> (по рынку)`,
    `📊 Результат: <b>${pnlSign}${pnlPct.toFixed(2)}%</b>  ·  ${rSign}${pnlR.toFixed(2)}R`,
    p.partial_closed_pct === 50
      ? `<i>Закрыли остаток после TP1.</i>`
      : `<i>Закрыли всю позицию.</i>`,
  ].join('\n');
  await sendMessage({ channel: 'signals', text });
  await sendMessage({ channel: 'logs', text, disable_notification: true });
}
