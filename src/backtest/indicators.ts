/**
 * Phase U — pure indicator math for the custom-strategy backtest engine.
 *
 * All functions are CAUSAL: out[i] uses only candles 0..i. No look-ahead.
 * Arrays return the same length as the input; warmup positions hold the
 * best causal estimate (the engine ignores trades before warmup anyway).
 * No I/O, no deps — unit-testable.
 */

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

/** Exponential moving average over a value series. */
export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? (values[0] ?? 0) : values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Simple moving average (causal; early bars average what's available). */
export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(sum / Math.min(i + 1, period));
  }
  return out;
}

/** Wilder-style ATR(period) via simple rolling mean of True Range. */
export function atr(candles: Candle[], period = 14): number[] {
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const pc = i ? candles[i - 1]!.c : candles[i]!.o;
    tr.push(Math.max(candles[i]!.h - candles[i]!.l, Math.abs(candles[i]!.h - pc), Math.abs(candles[i]!.l - pc)));
  }
  return sma(tr, period);
}

/** Donchian channel: highest high / lowest low over the PRIOR `period`
 *  bars (excludes the current bar, so a breakout of out.upper[i] by
 *  candle i is a genuine new high — no look-ahead). Warmup bars return
 *  ±Infinity so nothing triggers until enough history exists. */
export function donchian(candles: Candle[], period: number): { upper: number[]; lower: number[] } {
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period) {
      upper.push(Number.POSITIVE_INFINITY);
      lower.push(Number.NEGATIVE_INFINITY);
      continue;
    }
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period; j < i; j++) {
      if (candles[j]!.h > hi) hi = candles[j]!.h;
      if (candles[j]!.l < lo) lo = candles[j]!.l;
    }
    upper.push(hi);
    lower.push(lo);
  }
  return { upper, lower };
}

/** Wilder RSI(period) on close. out in [0,100]; warmup bars = 50 (neutral). */
export function rsi(candles: Candle[], period = 14): number[] {
  const out: number[] = [];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { out.push(50); continue; }
    const change = candles[i]!.c - candles[i - 1]!.c;
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      out.push(50);
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      out.push(100 - 100 / (1 + rs));
    }
  }
  return out;
}

/** Rolling standard deviation of close over `period` (causal). */
export function rollingStd(values: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - period + 1);
    const w = values.slice(lo, i + 1);
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    const v = w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length;
    out.push(Math.sqrt(v));
  }
  return out;
}
