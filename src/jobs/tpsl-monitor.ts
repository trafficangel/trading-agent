import cron from 'node-cron';
import { existsSync } from 'node:fs';
import { logger } from '../lib/logger.js';
import {
  findActivePositions,
  calcPnl,
  closePositionWithStats,
  type DecisionRow,
} from '../db/repos/decisions.js';
import { getLastPrice } from '../exchange/bybit-public.js';
import { sendMessage, sendPhoto } from '../telegram/bot.js';
import { resultPost } from '../telegram/result-template.js';

let running = false;

async function checkPosition(p: DecisionRow): Promise<void> {
  if (!p.entry || !p.sl || !p.side) return;
  if (p.side !== 'long' && p.side !== 'short') return;
  const tp = p.tp_json ? Number(JSON.parse(p.tp_json)?.[0]) : null;

  const price = await getLastPrice(p.symbol);
  if (price == null) return;

  let hit: 'sl' | 'tp' | null = null;
  let closePrice = price;

  if (p.side === 'long') {
    if (price <= p.sl) {
      hit = 'sl';
      closePrice = p.sl; // shadow fill at exact level
    } else if (tp != null && Number.isFinite(tp) && price >= tp) {
      hit = 'tp';
      closePrice = tp;
    }
  } else {
    // short
    if (price >= p.sl) {
      hit = 'sl';
      closePrice = p.sl;
    } else if (tp != null && Number.isFinite(tp) && price <= tp) {
      hit = 'tp';
      closePrice = tp;
    }
  }

  if (!hit) return;

  const reason = hit === 'tp' ? 'tp_hit' : 'sl_hit';
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
