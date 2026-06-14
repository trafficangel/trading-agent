/**
 * Shared strategy-family factories — the single source of truth for the
 * sweep AND the verification battery, so verification tests the EXACT same
 * logic (no copy-paste drift that would invalidate the test).
 *
 * Every factory returns a look-ahead-safe CustomStrategy (decide sees only
 * candles[0..i]); indicators are memoised per candle-array reference.
 */

import { ema, sma, rsi, donchian, rollingStd, type Candle } from '../indicators.js';
import type { CustomStrategy, Signal } from '../strategy.js';

export function smaTrend(symbol: string, tf: string, period: number, slPct = 0.12): CustomStrategy {
  let key: Candle[] | null = null; let s: number[] = [];
  const ens = (c: Candle[]) => { if (key !== c) { s = sma(c.map((x) => x.c), period); key = c; } };
  return { id: `sma${period}-${symbol}-${tf}`, code: `sma${period}`, name: `${symbol} SMA${period}`, symbol, timeframe: tf, slPct, warmup: period + 1, description: `SMA${period} trend`,
    decide(c, i, pos): Signal { ens(c); const up = c[i]!.c > s[i]!; if (pos === null) return up ? 'long' : null; if (pos === 'long') return up ? null : 'flat'; return null; } };
}

export function emaCross(symbol: string, tf: string, fast: number, slow: number, slPct = 0.12): CustomStrategy {
  let key: Candle[] | null = null; let f: number[] = []; let sl: number[] = [];
  const ens = (c: Candle[]) => { if (key !== c) { const cl = c.map((x) => x.c); f = ema(cl, fast); sl = ema(cl, slow); key = c; } };
  return { id: `ema${fast}x${slow}-${symbol}-${tf}`, code: `ema${fast}x${slow}`, name: `${symbol} EMA${fast}x${slow}`, symbol, timeframe: tf, slPct, warmup: slow + 1, description: `EMA${fast}x${slow} cross`,
    decide(c, i, pos): Signal { ens(c); const up = f[i]! > sl[i]!; if (pos === null) return up ? 'long' : null; if (pos === 'long') return up ? null : 'flat'; return null; } };
}

export function donchianFlip(symbol: string, tf: string, period: number, slPct = 0.10): CustomStrategy {
  let key: Candle[] | null = null; let up: number[] = []; let lo: number[] = [];
  const ens = (c: Candle[]) => { if (key !== c) { const d = donchian(c, period); up = d.upper; lo = d.lower; key = c; } };
  return { id: `donch${period}-${symbol}-${tf}`, code: `donch${period}`, name: `${symbol} Donchian${period}`, symbol, timeframe: tf, slPct, warmup: period + 1, description: `Donchian(${period}) breakout flip`,
    decide(c, i): Signal { ens(c); const x = c[i]!.c; if (x > up[i]!) return 'long'; if (x < lo[i]!) return 'short'; return null; } };
}

export function momentumRoc(symbol: string, tf: string, look: number, slPct = 0.12): CustomStrategy {
  return { id: `mom${look}-${symbol}-${tf}`, code: `mom${look}`, name: `${symbol} Momentum${look}`, symbol, timeframe: tf, slPct, warmup: look + 1, description: `ROC(${look}) momentum`,
    decide(c, i, pos): Signal { const up = c[i]!.c > c[i - look]!.c; if (pos === null) return up ? 'long' : null; if (pos === 'long') return up ? null : 'flat'; return null; } };
}

export function rsiMr(symbol: string, tf: string, os: number, ob: number, trendEma: number, slPct = 0.05): CustomStrategy {
  let key: Candle[] | null = null; let r: number[] = []; let t: number[] = [];
  const ens = (c: Candle[]) => { if (key !== c) { r = rsi(c, 14); t = trendEma > 0 ? ema(c.map((x) => x.c), trendEma) : []; key = c; } };
  return { id: `rsi${os}_${ob}t${trendEma}-${symbol}-${tf}`, code: `rsi${os}_${ob}t${trendEma}`, name: `${symbol} RSI MR`, symbol, timeframe: tf, slPct, warmup: Math.max(42, trendEma + 1), description: `RSI(14) mean-rev os${os}/ob${ob}${trendEma ? ` +EMA${trendEma}` : ''}`,
    decide(c, i, pos): Signal { ens(c); const v = r[i]!; const cl = c[i]!.c; const up = trendEma > 0 ? cl > t[i]! : true; const dn = trendEma > 0 ? cl < t[i]! : true;
      if (pos === null) { if (v < os && up) return 'long'; if (v > ob && dn) return 'short'; return null; }
      if (pos === 'long') return v >= 50 ? 'flat' : null; return v <= 50 ? 'flat' : null; } };
}

export function bollMr(symbol: string, tf: string, period: number, k: number, trendEma: number, slPct = 0.05): CustomStrategy {
  let key: Candle[] | null = null; let mid: number[] = []; let sd: number[] = []; let t: number[] = [];
  const ens = (c: Candle[]) => { if (key !== c) { const cl = c.map((x) => x.c); mid = sma(cl, period); sd = rollingStd(cl, period); t = trendEma > 0 ? ema(cl, trendEma) : []; key = c; } };
  return { id: `boll${period}_${k}t${trendEma}-${symbol}-${tf}`, code: `boll${period}_${k}t${trendEma}`, name: `${symbol} Bollinger MR`, symbol, timeframe: tf, slPct, warmup: Math.max(period + 1, trendEma + 1), description: `Bollinger(${period},${k}) mean-rev${trendEma ? ` +EMA${trendEma} filter` : ''}`,
    decide(c, i, pos): Signal { ens(c); const cl = c[i]!.c; const m = mid[i]!; const up = m + k * sd[i]!; const dn = m - k * sd[i]!;
      const tu = trendEma > 0 ? cl > t[i]! : true; const td = trendEma > 0 ? cl < t[i]! : true;
      if (pos === null) { if (cl < dn && tu) return 'long'; if (cl > up && td) return 'short'; return null; }
      if (pos === 'long') return cl >= m ? 'flat' : null; return cl <= m ? 'flat' : null; } };
}
