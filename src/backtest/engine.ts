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
 *   - SL MODE (optional). Default 'none' → no safety SL: we log NATIVE exits
 *     + true MAE, and audit-sl-distribution picks the optimal static SL (the
 *     original pipeline, unchanged). Pass a real slMode to SIMULATE that stop
 *     inside the loop instead — used by the SL-mode audit to compare static
 *     vs ATR-dynamic vs time-stop per strategy on the SAME trade set. The SL
 *     is checked intrabar (bar low/high) BEFORE decide(), so it fires first.
 */

import { atr, type Candle } from './indicators.js';
import type { CustomStrategy } from './strategy.js';

export type SlMode =
  | { kind: 'none' }
  | { kind: 'static'; pct: number }                       // SL = entry ∓ pct
  | { kind: 'atr'; mult: number; period: number }         // SL = entry ∓ mult·ATR(period) at entry
  | { kind: 'time'; bars: number }                        // exit after `bars` bars
  | { kind: 'atr+time'; mult: number; period: number; bars: number };

export type BtTrade = {
  num: number;
  side: 'long' | 'short';
  entryAt: number;
  entryPrice: number;
  exitAt: number;
  exitPrice: number;
  maePct: number;   // worst adverse excursion %, positive magnitude
  maePrice: number;
  exitReason: 'flip' | 'flat' | 'end' | 'sl' | 'time';
  realizedPct: number; // signed realized % (gross, no commission)
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
  entryIdx: number;
  entryPrice: number;
  slPrice: number | null;
  low: number;
  high: number;
};

export function runBacktest(strategy: CustomStrategy, candles: Candle[], slMode: SlMode = { kind: 'none' }): BtResult {
  const trades: BtTrade[] = [];
  let pos: Pos | null = null;
  let num = 0;

  const needsAtr = slMode.kind === 'atr' || slMode.kind === 'atr+time';
  const atrArr = needsAtr ? atr(candles, (slMode as { period: number }).period) : [];
  const timeBars = slMode.kind === 'time' || slMode.kind === 'atr+time' ? (slMode as { bars: number }).bars : null;

  const slPriceFor = (side: 'long' | 'short', entryPrice: number, entryIdx: number): number | null => {
    if (slMode.kind === 'static') return side === 'long' ? entryPrice * (1 - slMode.pct) : entryPrice * (1 + slMode.pct);
    if (needsAtr) {
      const a = atrArr[entryIdx];
      if (a == null || !(a > 0)) return null;
      const mult = (slMode as { mult: number }).mult;
      return side === 'long' ? entryPrice - mult * a : entryPrice + mult * a;
    }
    return null;
  };

  const mkPos = (side: 'long' | 'short', c: Candle, i: number): Pos =>
    ({ side, entryAt: c.t, entryIdx: i, entryPrice: c.c, slPrice: slPriceFor(side, c.c, i), low: c.l, high: c.h });

  // Records an exit for `p` (passed explicitly so TS tracks the pos lifecycle
  // via direct assignments below, not through closure mutation).
  const recordExit = (p: Pos, exitPrice: number, exitT: number, reason: BtTrade['exitReason']): void => {
    const sign = p.side === 'long' ? 1 : -1;
    const realized = (sign * (exitPrice - p.entryPrice)) / p.entryPrice;
    const mae = p.side === 'long' ? (p.entryPrice - p.low) / p.entryPrice : (p.high - p.entryPrice) / p.entryPrice;
    const maePrice = p.side === 'long' ? p.low : p.high;
    trades.push({
      num: ++num,
      side: p.side,
      entryAt: p.entryAt,
      entryPrice: p.entryPrice,
      exitAt: exitT,
      exitPrice,
      maePct: Math.round(Math.max(0, mae) * 10000) / 100,
      maePrice: Math.round(maePrice * 1e6) / 1e6,
      exitReason: reason,
      realizedPct: Math.round(realized * 10000) / 100,
    });
  };

  for (let i = strategy.warmup; i < candles.length; i++) {
    const c = candles[i]!;
    if (pos) {
      if (c.l < pos.low) pos.low = c.l;
      if (c.h > pos.high) pos.high = c.h;
      // Safety SL first (intrabar): close at the stop price.
      if (pos.slPrice !== null && (pos.side === 'long' ? c.l <= pos.slPrice : c.h >= pos.slPrice)) {
        recordExit(pos, pos.slPrice, c.t, 'sl');
        pos = null;
        continue;
      }
      // Time stop: held too long.
      if (timeBars !== null && i - pos.entryIdx >= timeBars) {
        recordExit(pos, c.c, c.t, 'time');
        pos = null;
        continue;
      }
    }

    const sig = strategy.decide(candles, i, pos ? pos.side : null);

    if (pos && (sig === 'flat' || (sig !== null && sig !== pos.side))) {
      const isFlip = sig !== 'flat';
      recordExit(pos, c.c, c.t, isFlip ? 'flip' : 'flat');
      pos = null;
      if (isFlip && (sig === 'long' || sig === 'short')) pos = mkPos(sig, c, i);
      continue;
    }
    if (!pos && (sig === 'long' || sig === 'short')) pos = mkPos(sig, c, i);
  }

  if (pos && candles.length) {
    const last = candles[candles.length - 1]!;
    recordExit(pos, last.c, last.t, 'end');
    pos = null;
  }

  return {
    id: strategy.id,
    symbol: strategy.symbol,
    timeframe: strategy.timeframe,
    bars: candles.length,
    tradesLog: trades,
  };
}
