/**
 * CROSS-ASSET families — relative-value spreads. Our whole arsenal is
 * single-series; nothing exploits cross-asset cointegration. The alt/BTC
 * ratio is far more stationary than either leg, so its reversion is cleaner
 * than single-asset MR. This is the one medium-plausibility 15/30m survivor
 * of the research vetting (ratio-spread-reversion).
 *
 * Engine-fit WITHOUT touching the engine: the factory CLOSES OVER a reference
 * close series (`refClose`) that the sweep pre-aligns 1:1 with the strategy's
 * own candles (refClose[i] = BTC close at the SAME bar as candles[i]). decide()
 * reads refClose[i] — same bar, known at close → strictly look-ahead-safe.
 */

import { sma, rollingStd, type Candle } from '../indicators.js';
import type { CustomStrategy, Signal } from '../strategy.js';

/** Rolling-OLS beta of logAlt on logBtc over window W (incremental, O(n)).
 *  W=0 → fixed beta=1 (pure log-ratio). Returns the z-score of the spread. */
function spreadZ(c: Candle[], refClose: number[], N: number, W: number): number[] {
  const n = c.length;
  const la = new Array<number>(n);
  const lb = new Array<number>(n);
  for (let j = 0; j < n; j++) { la[j] = Math.log(c[j]!.c); lb[j] = Math.log(refClose[j]! || c[j]!.c); }
  const spread = new Array<number>(n);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let j = 0; j < n; j++) {
    let beta = 1;
    if (W > 0) {
      sx += lb[j]!; sy += la[j]!; sxx += lb[j]! * lb[j]!; sxy += lb[j]! * la[j]!;
      if (j >= W) { const o = j - W; sx -= lb[o]!; sy -= la[o]!; sxx -= lb[o]! * lb[o]!; sxy -= lb[o]! * la[o]!; }
      const m = Math.min(j + 1, W);
      if (m >= 2) { const denom = m * sxx - sx * sx; if (denom !== 0) beta = (m * sxy - sx * sy) / denom; }
    }
    spread[j] = la[j]! - beta * lb[j]!;
  }
  const mean = sma(spread, N);
  const sd = rollingStd(spread, N);
  const z = new Array<number>(n);
  for (let j = 0; j < n; j++) z[j] = sd[j]! > 0 ? (spread[j]! - mean[j]!) / sd[j]! : NaN;
  return z;
}

/**
 * alt/BTC log-spread z-score mean-reversion. LONG the alt when the spread is
 * cheap (z ≤ −entryZ), SHORT when rich (z ≥ +entryZ); exit toward the mean
 * (|z| ≤ exitZ); hard de-cointegration stop at |z| ≥ stopZ. Pair the engine's
 * time-stop slMode as a backstop.
 *
 * @param refClose BTC close aligned 1:1 with `candles` (sweep builds it)
 * @param betaWin rolling-OLS hedge-ratio window; 0 = fixed β=1 (pure ratio)
 */
export function ratioSpread(symbol: string, tf: string, refClose: number[], entryZ = 2, exitZ = 0.25, N = 60, betaWin = 0, stopZ = 3, slPct = 0.08): CustomStrategy {
  let key: Candle[] | null = null;
  let z: number[] = [];
  const ens = (c: Candle[]) => { if (key !== c) { z = spreadZ(c, refClose, N, betaWin); key = c; } };
  return {
    id: `xrs${entryZ}_${exitZ}N${N}b${betaWin}-${symbol}-${tf}`,
    code: 'xratio', name: `${symbol} Ratio-MR vs BTC`, symbol, timeframe: tf, slPct,
    warmup: Math.max(N, betaWin, 2) + 2,
    description: `alt/BTC log-spread z(${N}) reversion ±${entryZ}σ${betaWin ? ` β(${betaWin})` : ' β=1'}, exit |z|≤${exitZ}, stop |z|≥${stopZ}`,
    decide(c, i, pos): Signal {
      ens(c);
      const zi = z[i];
      if (zi == null || !Number.isFinite(zi)) return pos === null ? null : null;
      if (pos === null) { if (zi <= -entryZ) return 'long'; if (zi >= entryZ) return 'short'; return null; }
      if (Math.abs(zi) >= stopZ) return 'flat';                 // de-cointegration / regime break
      if (pos === 'long') return zi >= -exitZ ? 'flat' : null;  // reverted toward the mean
      return zi <= exitZ ? 'flat' : null;
    },
  };
}
