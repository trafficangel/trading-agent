/**
 * Extra intraday families for the low-TF search — classic short-horizon
 * mean-reversion signals NOT covered by families.ts. These are maker-
 * executable (rest a limit at the level), so they're the realistic shot at
 * a 5m/15m edge once Hyperliquid maker fees are applied. All look-ahead-safe
 * (decide sees candles[0..i]); indicators memoised per array reference.
 */

import { ema, sma, atr, rsi, rollingStd, type Candle } from '../indicators.js';
import type { CustomStrategy, Signal } from '../strategy.js';

/** Internal Bar Strength: (close-low)/(high-low). Low IBS = close near the
 *  low = oversold bounce; high IBS = close near the high = pullback. */
export function ibsMr(symbol: string, tf: string, lo = 0.1, hi = 0.9, trendEma = 0): CustomStrategy {
  let key: Candle[] | null = null; let t: number[] = [];
  const ens = (c: Candle[]) => { if (key !== c) { t = trendEma > 0 ? ema(c.map((x) => x.c), trendEma) : []; key = c; } };
  return { id: `ibs${Math.round(lo * 100)}_${Math.round(hi * 100)}t${trendEma}-${symbol}-${tf}`, code: 'ibs', name: `${symbol} IBS`, symbol, timeframe: tf, slPct: 0.05, warmup: Math.max(2, trendEma + 1), description: `IBS mean-rev lo${lo}/hi${hi}${trendEma ? ` +EMA${trendEma}` : ''}`,
    decide(c, i, pos): Signal { ens(c); const b = c[i]!; const ibs = b.h > b.l ? (b.c - b.l) / (b.h - b.l) : 0.5; const up = trendEma > 0 ? b.c > t[i]! : true; const dn = trendEma > 0 ? b.c < t[i]! : true;
      if (pos === null) { if (ibs < lo && up) return 'long'; if (ibs > hi && dn) return 'short'; return null; }
      if (pos === 'long') return ibs > 0.5 ? 'flat' : null; return ibs < 0.5 ? 'flat' : null; } };
}

/** Connors RSI(2): in an uptrend (close>EMA200) buy when RSI(2) is washed
 *  out (<os); exit when it recovers past 50. Symmetric short below trend. */
export function rsi2(symbol: string, tf: string, os = 10, ob = 90, trendEma = 200): CustomStrategy {
  let key: Candle[] | null = null; let r: number[] = []; let t: number[] = [];
  const ens = (c: Candle[]) => { if (key !== c) { r = rsi(c, 2); t = trendEma > 0 ? ema(c.map((x) => x.c), trendEma) : []; key = c; } };
  return { id: `rsi2_${os}_${ob}t${trendEma}-${symbol}-${tf}`, code: 'rsi2', name: `${symbol} RSI2`, symbol, timeframe: tf, slPct: 0.05, warmup: Math.max(6, trendEma + 1), description: `Connors RSI(2) os${os}/ob${ob}${trendEma ? ` +EMA${trendEma}` : ''}`,
    decide(c, i, pos): Signal { ens(c); const v = r[i]!; const cl = c[i]!.c; const up = trendEma > 0 ? cl > t[i]! : true; const dn = trendEma > 0 ? cl < t[i]! : true;
      if (pos === null) { if (v < os && up) return 'long'; if (v > ob && dn) return 'short'; return null; }
      if (pos === 'long') return v > 50 ? 'flat' : null; return v < 50 ? 'flat' : null; } };
}

/** Z-score reversion vs SMA(period): long when z<−zThr, short when z>zThr,
 *  exit when z crosses back through 0. Longer lookback than Bollinger(20). */
export function zscoreMr(symbol: string, tf: string, period = 50, zThr = 2, trendEma = 0): CustomStrategy {
  let key: Candle[] | null = null; let m: number[] = []; let sd: number[] = []; let t: number[] = [];
  const ens = (c: Candle[]) => { if (key !== c) { const cl = c.map((x) => x.c); m = sma(cl, period); sd = rollingStd(cl, period); t = trendEma > 0 ? ema(cl, trendEma) : []; key = c; } };
  return { id: `z${period}_${zThr}t${trendEma}-${symbol}-${tf}`, code: 'zscore', name: `${symbol} Z-score`, symbol, timeframe: tf, slPct: 0.05, warmup: Math.max(period + 1, trendEma + 1), description: `Z-score(${period}) reversion ±${zThr}σ${trendEma ? ` +EMA${trendEma}` : ''}`,
    decide(c, i, pos): Signal { ens(c); const s = sd[i]!; if (!(s > 0)) return null; const z = (c[i]!.c - m[i]!) / s; const up = trendEma > 0 ? c[i]!.c > t[i]! : true; const dn = trendEma > 0 ? c[i]!.c < t[i]! : true;
      if (pos === null) { if (z < -zThr && up) return 'long'; if (z > zThr && dn) return 'short'; return null; }
      if (pos === 'long') return z >= 0 ? 'flat' : null; return z <= 0 ? 'flat' : null; } };
}

/** N consecutive down closes → oversold bounce (long); N up closes → short.
 *  Exit on the first opposite close. Pure microstructure mean-reversion. */
export function consecMr(symbol: string, tf: string, k = 3, trendEma = 0): CustomStrategy {
  let key: Candle[] | null = null; let t: number[] = [];
  const ens = (c: Candle[]) => { if (key !== c) { t = trendEma > 0 ? ema(c.map((x) => x.c), trendEma) : []; key = c; } };
  return { id: `consec${k}t${trendEma}-${symbol}-${tf}`, code: 'consec', name: `${symbol} Consec${k}`, symbol, timeframe: tf, slPct: 0.05, warmup: Math.max(k + 1, trendEma + 1), description: `${k} consecutive down→long / up→short${trendEma ? ` +EMA${trendEma}` : ''}`,
    decide(c, i, pos): Signal { ens(c); let down = 0; for (let j = i; j > 0 && c[j]!.c < c[j - 1]!.c; j--) down++; let upn = 0; for (let j = i; j > 0 && c[j]!.c > c[j - 1]!.c; j--) upn++;
      const up = trendEma > 0 ? c[i]!.c > t[i]! : true; const dn = trendEma > 0 ? c[i]!.c < t[i]! : true;
      if (pos === null) { if (down >= k && up) return 'long'; if (upn >= k && dn) return 'short'; return null; }
      if (pos === 'long') return c[i]!.c > c[i - 1]!.c ? 'flat' : null; return c[i]!.c < c[i - 1]!.c ? 'flat' : null; } };
}

/** Keltner channel reversion: EMA(emaP) ± mult·ATR(atrP). Fade the band,
 *  exit at the mid. ATR-based (vs Bollinger's std). */
export function keltnerMr(symbol: string, tf: string, emaP = 20, atrP = 10, mult = 2, trendEma = 0): CustomStrategy {
  let key: Candle[] | null = null; let mid: number[] = []; let a: number[] = []; let t: number[] = [];
  const ens = (c: Candle[]) => { if (key !== c) { const cl = c.map((x) => x.c); mid = ema(cl, emaP); a = atr(c, atrP); t = trendEma > 0 ? ema(cl, trendEma) : []; key = c; } };
  return { id: `kelt${emaP}_${atrP}_${mult}t${trendEma}-${symbol}-${tf}`, code: 'keltner', name: `${symbol} Keltner`, symbol, timeframe: tf, slPct: 0.05, warmup: Math.max(emaP, atrP, trendEma) + 1, description: `Keltner(${emaP},${atrP},${mult}) reversion${trendEma ? ` +EMA${trendEma}` : ''}`,
    decide(c, i, pos): Signal { ens(c); const upB = mid[i]! + mult * a[i]!; const dnB = mid[i]! - mult * a[i]!; const cl = c[i]!.c; const tu = trendEma > 0 ? cl > t[i]! : true; const td = trendEma > 0 ? cl < t[i]! : true;
      if (pos === null) { if (cl < dnB && tu) return 'long'; if (cl > upB && td) return 'short'; return null; }
      if (pos === 'long') return cl >= mid[i]! ? 'flat' : null; return cl <= mid[i]! ? 'flat' : null; } };
}
