import cron from 'node-cron';
import { existsSync } from 'node:fs';
import { logger } from '../lib/logger.js';
import {
  findActivePositions,
  findDecisionById,
  calcPnl,
  closePositionWithStats,
  updatePositionSl,
  type DecisionRow,
} from '../db/repos/decisions.js';
import { getLastPrice } from '../exchange/bybit-public.js';
import { sendMessage, sendPhoto } from '../telegram/bot.js';
import { resultPost } from '../telegram/result-template.js';

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

  // Logs-channel notification only — not noisy enough for Signals channel
  // (it's a mechanical BE move, no decision content).
  const tradeIdStr = `#${p.id.toString().padStart(4, '0')}`;
  void sendMessage({
    channel: 'logs',
    text: `🔒 <b>SL → безубыток</b> по сделке ${tradeIdStr} ${p.symbol}: 1R достигнут, SL подвинут с ${p.sl} на ${p.entry}.`,
    disable_notification: true,
  });

  return p.entry;
}

async function checkPosition(pInput: DecisionRow): Promise<void> {
  // Refresh from DB: between when tick() fetched activePositions and now,
  // monitor LLM may have updated SL via MODIFY, or another tpsl pass may
  // have moved SL to BE. Using the stale snapshot can cause:
  //   - false negatives (price crossed the NEW SL but we check the OLD one)
  //   - blind overwrites of a just-applied MODIFY by our own auto-BE logic
  // findDecisionById is one cheap indexed query — fine to call every tick.
  const fresh = findDecisionById(pInput.id);
  if (!fresh || fresh.status !== 'active') return;
  const p = fresh;

  if (!p.entry || !p.sl || !p.side) return;
  if (p.side !== 'long' && p.side !== 'short') return;
  const tp = p.tp_json ? Number(JSON.parse(p.tp_json)?.[0]) : null;

  const price = await getLastPrice(p.symbol);
  if (price == null) return;

  // Auto SL→BE check — may mutate p.sl in DB. We use the returned value for
  // the rest of this tick.
  const effectiveSl = maybeMoveSlToBe(p, price);

  let hit: 'sl' | 'tp' | null = null;
  let closePrice = price;

  if (p.side === 'long') {
    if (price <= effectiveSl) {
      hit = 'sl';
      closePrice = effectiveSl; // shadow fill at exact level
    } else if (tp != null && Number.isFinite(tp) && price >= tp) {
      hit = 'tp';
      closePrice = tp;
    }
  } else {
    // short
    if (price >= effectiveSl) {
      hit = 'sl';
      closePrice = effectiveSl;
    } else if (tp != null && Number.isFinite(tp) && price <= tp) {
      hit = 'tp';
      closePrice = tp;
    }
  }

  if (!hit) return;

  const reason = hit === 'tp' ? 'tp_hit' : 'sl_hit';
  // R-multiple is computed against the ORIGINAL SL — that's the risk we
  // actually took. p.sl in memory is still the original (the BE move only
  // updated DB and effectiveSl). A BE-stopped trade closes at entry → 0R.
  // A TP-hit after BE move still credits full R from the original setup.
  const { pnlPct, pnlR } = calcPnl(p.side, p.entry, p.sl, closePrice);

  closePositionWithStats({ id: p.id, closePrice, closeReason: reason, pnlPct, pnlR });

  logger.info(
    {
      position_id: p.id,
      symbol: p.symbol,
      side: p.side,
      hit,
      close_price: closePrice,
      tick_price: price,
      pnl_pct: pnlPct,
      pnl_r: pnlR,
    },
    'tpsl monitor: position closed',
  );

  const text = resultPost({
    parentTradeId: p.id,
    symbol: p.symbol,
    side: p.side,
    entry: p.entry,
    sl: p.sl,
    tp,
    closePrice,
    closeReason: reason,
    pnlPct,
    pnlR,
    durationMs: Date.now() - p.created_at,
  });

  if (p.screenshot_path && existsSync(p.screenshot_path)) {
    const sent = await sendPhoto({
      channel: 'signals',
      photoPath: p.screenshot_path,
      caption: text,
    });
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
    if (positions.length === 0) return;
    for (const p of positions) {
      try {
        await checkPosition(p);
      } catch (err) {
        logger.error({ err, position_id: p.id }, 'tpsl checkPosition failed');
      }
    }
  } finally {
    running = false;
  }
}

export function startTpslMonitorJob(): void {
  // Every minute. Bybit public API allows this with massive headroom.
  cron.schedule('* * * * *', () => {
    void tick();
  });
  logger.info('tpsl monitor cron started (every 1 min)');
}
