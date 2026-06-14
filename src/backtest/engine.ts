/**
 * Phase U — backtest engine. Runs a CustomStrategy over a candle series
 * and emits a trades log IN THE SAME SHAPE as the LuxAlgo scrape files
 * (src/strategies/data/<id>.json), so audit-sl-distribution / kelly /
 * regime / vol-gate all consume custom strategies unchanged.
 *
 * Execution model (no look-ahead):
 *   - decide() runs on bar i's close; we act at that close price.
 *   - Position flips on opposite signal, closes flat on 'flat', holds on
 *     same-side/null. ALWAYS one position max (matches Track C).
 *   - NO safety SL is applied here on purpose: we log NATIVE exits + the
 *     true MAE (worst intra-trade excursion from OHLC). The existing audit
 *     then picks the optimal slPct exactly like it does for LuxAlgo logs.
 *     => one identical validation pipeline for LuxAlgo and custom alike.
 */

import type { Candle } from './indicators.js';
import type { CustomStrategy } from './strategy.js';

export type BtTrade = {
  num: number;
  side: 'long' | 'short';
  entryAt: number;
  entryPrice: number;
  exitAt: number;
  exitPrice: number;
  maePct: number;   // worst adverse excursion %, positive magnitude
  maePrice: number;
  exitReason: 'flip' | 'flat' | 'end';
  realizedPct: number; // signed native realized % (no SL, gross)
};

export type BtResult = {
  id: string;
  symbol: string;
  timeframe: string;
  bars: number;
  tradesLog: BtTrade[];
};

type Pos = {
  side: 'long' | 'short';
  entryAt: number;
  entryPrice: number;
  low: number;
  high: number;
};

export function runBacktest(strategy: CustomStrategy, candles: Candle[]): BtResult {
  const trades: BtTrade[] = [];
  let pos: Pos | null = null;
  let num = 0;

  const close = (c: Candle, reason: BtTrade['exitReason']): void => {
    if (!pos) return;
    const sign = pos.side === 'long' ? 1 : -1;
    const realized = (sign * (c.c - pos.entryPrice)) / pos.entryPrice;
    const maePrice = pos.side === 'long' ? pos.low : pos.high;
    const mae =
      pos.side === 'long'
        ? (pos.entryPrice - pos.low) / pos.entryPrice
        : (pos.high - pos.entryPrice) / pos.entryPrice;
    trades.push({
      num: ++num,
      side: pos.side,
      entryAt: pos.entryAt,
      entryPrice: pos.entryPrice,
      exitAt: c.t,
      exitPrice: c.c,
      maePct: Math.round(Math.max(0, mae) * 10000) / 100,
      maePrice: Math.round(maePrice * 1e6) / 1e6,
      exitReason: reason,
      realizedPct: Math.round(realized * 10000) / 100,
    });
    pos = null;
  };

  for (let i = strategy.warmup; i < candles.length; i++) {
    const c = candles[i]!;
    if (pos) {
      if (c.l < pos.low) pos.low = c.l;
      if (c.h > pos.high) pos.high = c.h;
    }
    const sig = strategy.decide(candles, i, pos ? pos.side : null);

    if (pos && (sig === 'flat' || (sig !== null && sig !== pos.side))) {
      const flip = sig !== 'flat'; // opposite-side signal
      close(c, flip ? 'flip' : 'flat');
      if (flip && (sig === 'long' || sig === 'short')) {
        pos = { side: sig, entryAt: c.t, entryPrice: c.c, low: c.l, high: c.h };
      }
      continue;
    }
    if (!pos && (sig === 'long' || sig === 'short')) {
      pos = { side: sig, entryAt: c.t, entryPrice: c.c, low: c.l, high: c.h };
    }
  }

  // Close any open position at the last bar so the log is complete.
  if (pos && candles.length) close(candles[candles.length - 1]!, 'end');

  return {
    id: strategy.id,
    symbol: strategy.symbol,
    timeframe: strategy.timeframe,
    bars: candles.length,
    tradesLog: trades,
  };
}
