import cron from 'node-cron';
import { existsSync } from 'node:fs';
import { logger } from '../lib/logger.js';
import {
  findActivePositions,
  findDecisionById,
  findPendingLimits,
  activatePendingLimit,
  cancelPendingLimit,
  calcPnl,
  closePositionWithStats,
  updatePositionSl,
  partialCloseAtTp1,
  forceClose,
  type DecisionRow,
} from '../db/repos/decisions.js';
import { getLastPrice } from '../exchange/bybit-public.js';
import { sendMessage, sendPhoto } from '../telegram/bot.js';
import { resultPost } from '../telegram/result-template.js';
import { limitFilledCaption, limitCancelledCaption } from '../telegram/decision-template.js';
import { markTick } from '../lib/health-tracker.js';

let running = false;

/**
 * Hard SL→BE rule: when price has moved >= 1R in our favor and the SL is
 * still on the original (loss) side of entry, force-move SL to entry.
 *
 * Returns the (possibly updated) SL — caller uses this for the SL/TP hit
 * comparison so we don't accidentally trigger an SL-hit on the same tick
 * we just moved SL to BE.
 */
function maybeMoveSlToBe(p: DecisionRow, currentPrice: number): number {
  if (!p.entry || !p.sl || !p.side) return p.sl ?? 0;
  const slDist = Math.abs(p.entry - p.sl);
  if (slDist === 0) return p.sl;

  // PnL distance in our favor (positive when in profit)
  const pnlDist = p.side === 'long' ? currentPrice - p.entry : p.entry - currentPrice;
  if (pnlDist < slDist) return p.sl; // not at 1R yet

  // Already at-or-better than BE? (long: SL >= entry; short: SL <= entry)
  const slAtOrBetter =
    p.side === 'long' ? p.sl >= p.entry : p.sl <= p.entry;
  if (slAtOrBetter) return p.sl;

  // Move it. Atomically update the DB row.
  updatePositionSl(p.id, p.entry);
  logger.info(
    {
      position_id: p.id,
      symbol: p.symbol,
      side: p.side,
      entry: p.entry,
      old_sl: p.sl,
      new_sl: p.entry,
      pnl_dist: pnlDist,
      sl_dist: slDist,
    },
    'auto SL→BE: 1R reached',
  );

  // Post to BOTH Signals (full lifecycle visibility) and Logs (audit).
  // Signals gets disable_notification=true — visible in-channel but no
  // phone alert, since BE move is mechanical not a new trade decision.
  // Track-aware trade ID: 'S#XXXX' for signal track, '#XXXX' for LLM.
  const prefix = p.track === 'signal' ? 'S#' : '#';
  const tradeIdStr = `${prefix}${p.id.toString().padStart(4, '0')}`;
  const beText = [
    `🔒 <b>SL → безубыток</b> по сделке ${tradeIdStr} ${p.symbol}:`,
    `1R достигнут, SL подвинут с <code>${p.sl}</code> на <code>${p.entry}</code>.`,
    ``,
    `<i>⏸ Теперь проиграть невозможно — максимум выход на BE.</i>`,
  ].join('\n');
  void sendMessage({ channel: 'signals', text: beText, disable_notification: true });
  void sendMessage({ channel: 'logs', text: beText, disable_notification: true });

  return p.entry;
}

// Max position age before time-guard force-close kicks in (24h).
// Reason: positions older than this without reaching TP1 are usually
// "stranded" — the market has moved on and SL/TP just won't trigger.
// 24h covers all current TFs: 5m/15m/1H/4H all reasonably resolve in <24h.
const TIME_GUARD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function checkPosition(pInput: DecisionRow): Promise<void> {
  // Refresh from DB on each tick — see comment in previous version. Concurrent
  // mutations (BE move, partial close, MODIFY) require fresh state.
  const fresh = findDecisionById(pInput.id);
  if (!fresh || fresh.status !== 'active') return;
  const p = fresh;

  if (!p.entry || !p.sl || !p.side) return;
  if (p.side !== 'long' && p.side !== 'short') return;

  // Parse tp_json — may be [tp1, tp2] (multi-TP) or [tp] (legacy single-TP).
  const tpArr = p.tp_json ? (JSON.parse(p.tp_json) as unknown[]).filter((x) => typeof x === 'number') as number[] : [];
  const isMultiTp = p.tp1_price !== null && tpArr.length >= 2;
  const tp1 = isMultiTp ? (p.tp1_price as number) : null;
  const tpFinal = isMultiTp ? (tpArr[1] as number) : tpArr[0] ?? null;

  const price = await getLastPrice(p.symbol);
  if (price == null) return;

  // === TIME GUARD ===
  // Position open too long without resolution → force-close at market.
  const ageMs = Date.now() - (p.filled_at ?? p.created_at);
  if (ageMs > TIME_GUARD_MAX_AGE_MS) {
    const slForR = p.original_sl ?? p.sl;
    const { pnlPct, pnlR } = computeWeightedPnl(p, price, slForR);
    const closed = forceClose({
      id: p.id,
      closePrice: price,
      closeReason: 'manual',
      pnlPct,
      pnlR,
      forceReason: 'time_guard',
    });
    if (closed) {
      logger.info(
        { position_id: p.id, age_h: Math.round(ageMs / 3600000), pnlR },
        'tpsl: time-guard force-close',
      );
      await postCloseMessage(p, price, 'manual', pnlPct, pnlR, '⏱ time-guard (24h)');
    }
    return;
  }

  // === MULTI-TP path ===
  if (isMultiTp && tp1 !== null && tpFinal !== null) {
    // Stage 1: pre-TP1 (partial_closed_pct = 0)
    if (p.partial_closed_pct === 0) {
      // SL hit before TP1 — full close at original SL, -1R
      const slHit = (p.side === 'long' && price <= p.sl) || (p.side === 'short' && price >= p.sl);
      if (slHit) {
        return closeFull(p, p.sl, 'sl_hit', '🛑 SL hit (до TP1)');
      }
      // TP1 hit — partial close 50% + move SL to BE
      const tp1Hit = (p.side === 'long' && price >= tp1) || (p.side === 'short' && price <= tp1);
      if (tp1Hit) {
        const partialDone = partialCloseAtTp1(p.id, tp1, p.entry);
        if (partialDone) {
          logger.info(
            { position_id: p.id, tp1, newSl: p.entry },
            'tpsl: TP1 hit — 50% closed, SL → BE',
          );
          await postPartialClose(p, tp1);
        }
        return;
      }
      return; // no hit yet
    }

    // Stage 2: post-TP1 (partial_closed_pct = 50)
    // SL is now at entry (BE). Remaining 50% lives until TP2 or BE-touch.
    if (p.partial_closed_pct === 50) {
      const slHit = (p.side === 'long' && price <= p.sl) || (p.side === 'short' && price >= p.sl);
      if (slHit) {
        // BE-touch on remainder. Weighted PnL: 50%×(+1R) + 50%×(0R) = +0.5R
        return closeFull(p, p.sl, 'sl_hit', '🔄 BE-touch (после TP1) — итог +0.5R');
      }
      const tp2Hit = (p.side === 'long' && price >= tpFinal) || (p.side === 'short' && price <= tpFinal);
      if (tp2Hit) {
        // Full TP2. Weighted PnL: 50%×(+1R) + 50%×(+2R) = +1.5R
        return closeFull(p, tpFinal, 'tp_hit', '🎉 TP2 — итог +1.5R');
      }
      return; // no final hit yet
    }
    return; // partial_closed_pct=100 shouldn't reach here (status would be 'closed')
  }

  // === LEGACY single-TP path (Track A historical rows) ===
  // Original behaviour: maybeMoveSlToBe → SL/TP hit detection.
  const effectiveSl = maybeMoveSlToBe(p, price);
  let hit: 'sl' | 'tp' | null = null;
  let closePrice = price;
  if (p.side === 'long') {
    if (price <= effectiveSl) { hit = 'sl'; closePrice = effectiveSl; }
    else if (tpFinal != null && price >= tpFinal) { hit = 'tp'; closePrice = tpFinal; }
  } else {
    if (price >= effectiveSl) { hit = 'sl'; closePrice = effectiveSl; }
    else if (tpFinal != null && price <= tpFinal) { hit = 'tp'; closePrice = tpFinal; }
  }
  if (!hit) return;
  const reason = hit === 'tp' ? 'tp_hit' : 'sl_hit';
  return closeFull(p, closePrice, reason, hit === 'tp' ? '🎉 TP' : '🛑 SL');
}

/**
 * Compute weighted PnL for a position that may be partially closed.
 *   partial_closed_pct = 0  → standard calcPnl on remaining 100%
 *   partial_closed_pct = 50 → 0.5×(TP1 R) + 0.5×(final R)
 */
function computeWeightedPnl(
  p: DecisionRow,
  finalClosePrice: number,
  slForR: number,
): { pnlPct: number; pnlR: number } {
  if (p.partial_closed_pct === 50 && p.partial_close_price !== null && p.entry !== null && p.side) {
    const partialResult = calcPnl(p.side as 'long' | 'short', p.entry, slForR, p.partial_close_price);
    const finalResult = calcPnl(p.side as 'long' | 'short', p.entry, slForR, finalClosePrice);
    return {
      pnlPct: (partialResult.pnlPct + finalResult.pnlPct) / 2,
      pnlR: Math.round((partialResult.pnlR + finalResult.pnlR) * 0.5 * 100) / 100,
    };
  }
  return calcPnl(p.side as 'long' | 'short', p.entry!, slForR, finalClosePrice);
}

/** Close the full (or remaining) position with computed weighted PnL. */
async function closeFull(
  p: DecisionRow,
  closePrice: number,
  reason: 'tp_hit' | 'sl_hit' | 'manual',
  hint: string,
): Promise<void> {
  if (!p.entry || !p.side) return;
  const slForR = p.original_sl ?? p.sl ?? p.entry;
  const { pnlPct, pnlR } = computeWeightedPnl(p, closePrice, slForR);
  const closed = closePositionWithStats({ id: p.id, closePrice, closeReason: reason, pnlPct, pnlR });
  if (!closed) {
    logger.info({ position_id: p.id, reason }, 'tpsl: already closed elsewhere, skip post');
    return;
  }
  logger.info(
    { position_id: p.id, reason, closePrice, pnlPct, pnlR, hint, partial: p.partial_closed_pct },
    'tpsl monitor: position closed',
  );
  await postCloseMessage(p, closePrice, reason, pnlPct, pnlR, hint);
}

/** Send the result post (used by all close paths). */
async function postCloseMessage(
  p: DecisionRow,
  closePrice: number,
  reason: 'tp_hit' | 'sl_hit' | 'manual',
  pnlPct: number,
  pnlR: number,
  _hint: string,
): Promise<void> {
  if (!p.entry || !p.side || !p.sl) return;
  const tpFinal = p.tp_json ? (JSON.parse(p.tp_json) as number[]).at(-1) ?? null : null;
  const text = resultPost({
    parentTradeId: p.id,
    symbol: p.symbol,
    side: p.side as 'long' | 'short',
    entry: p.entry,
    sl: p.sl,
    tp: tpFinal,
    closePrice,
    closeReason: reason,
    pnlPct,
    pnlR,
    durationMs: Date.now() - (p.filled_at ?? p.created_at),
    track: p.track,
  });
  if (p.screenshot_path && existsSync(p.screenshot_path)) {
    const sent = await sendPhoto({ channel: 'signals', photoPath: p.screenshot_path, caption: text });
    if (!sent) await sendMessage({ channel: 'signals', text });
  } else {
    await sendMessage({ channel: 'signals', text });
  }
  await sendMessage({ channel: 'logs', text, disable_notification: true });
}

/** Send TP1 partial-close notification (50% closed + SL → BE). */
async function postPartialClose(p: DecisionRow, tp1Price: number): Promise<void> {
  const prefix = p.track === 'signal' ? 'S#' : '#';
  const tradeIdStr = `${prefix}${p.id.toString().padStart(4, '0')}`;
  const sideE = p.side === 'long' ? '🟢' : '🔴';
  const text = [
    `💰 <b>TP1 взят</b> · ${tradeIdStr}  ${sideE} ${p.symbol}`,
    ``,
    `Закрыли 50% позиции на <code>${tp1Price}</code> (+1R)`,
    `SL подвинут в безубыток (<code>${p.entry}</code>)`,
    ``,
    `<i>Оставшиеся 50% едут к TP2 (+2R). Минимальный итог = +0.5R.</i>`,
  ].join('\n');
  await sendMessage({ channel: 'signals', text, disable_notification: true });
  await sendMessage({ channel: 'logs', text, disable_notification: true });
}

/**
 * Pending-limit watcher. For each pending limit:
 *   - If now > pending_until → cancel + post
 *   - Else fetch latest price; if it touched the entry level, promote
 *     to status='active' + post "filled"
 *
 * Touch rule:
 *   LONG limit @ X is filled when price <= X (we sell into the bid? no,
 *   we BUY at X when price drops down to it). Exchange would fill at X.
 *   SHORT limit @ X is filled when price >= X.
 */
async function checkPendingLimit(p: DecisionRow): Promise<void> {
  if (!p.entry || !p.side || (p.side !== 'long' && p.side !== 'short')) return;

  // Expiry check first — cheaper than price fetch
  if (p.pending_until && Date.now() > p.pending_until) {
    if (cancelPendingLimit(p.id)) {
      logger.info({ position_id: p.id }, 'pending limit expired, cancelled');
      const text = limitCancelledCaption({
        symbol: p.symbol,
        side: p.side,
        entry: p.entry,
        reason: 'expired',
      });
      await sendMessage({ channel: 'signals', text });
      await sendMessage({ channel: 'logs', text, disable_notification: true });
    }
    return;
  }

  const price = await getLastPrice(p.symbol);
  if (price == null) return;

  const touched = p.side === 'long' ? price <= p.entry : price >= p.entry;
  if (!touched) return;

  // Activate. activatePendingLimit returns false if someone beat us to it.
  if (activatePendingLimit(p.id, Date.now())) {
    logger.info(
      { position_id: p.id, fill_price: p.entry, tick_price: price },
      'pending limit FILLED — promoted to active',
    );
    const text = limitFilledCaption({
      decisionId: p.id,
      symbol: p.symbol,
      side: p.side,
      entry: p.entry,
    });
    await sendMessage({ channel: 'signals', text });
    await sendMessage({ channel: 'logs', text, disable_notification: true });
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Process active positions (TP/SL hit + auto-BE)
    const positions = findActivePositions();
    for (const p of positions) {
      try {
        await checkPosition(p);
      } catch (err) {
        logger.error({ err, position_id: p.id }, 'tpsl checkPosition failed');
      }
    }

    // Process pending limit orders (fill or expire)
    const pending = findPendingLimits();
    for (const p of pending) {
      try {
        await checkPendingLimit(p);
      } catch (err) {
        logger.error({ err, position_id: p.id }, 'tpsl checkPendingLimit failed');
      }
    }
  } finally {
    running = false;
    markTick('tpsl');
  }
}

export function startTpslMonitorJob(): void {
  // Every minute. Bybit public API allows this with massive headroom.
  cron.schedule('* * * * *', () => {
    void tick();
  });
  logger.info('tpsl monitor cron started (every 1 min)');
}
