/**
 * ORDER-FLOW families — strategies on the HL microstructure layer (CVD / OI /
 * book imbalance) that OHLCV can't express. They CLOSE OVER pre-aligned micro
 * arrays (loadMicroAligned in ../micro.ts) — same trick as families-xasset.ts,
 * no engine surgery, strictly look-ahead-safe (feature[i] is from bar i's own
 * minute window).
 *
 * NOTE: these are TEMPLATES, ready to backtest once the collector has built up
 * ~2-4 weeks of hl_micro. Until then the sweep reports thin coverage. Treat as
 * hypotheses to refute via the usual kill-battery once data exists.
 */

import { sma, type Candle } from '../indicators.js';
import type { CustomStrategy, Signal } from '../strategy.js';
import type { MicroAligned } from '../micro.js';

/**
 * CVD divergence + absorption. Price prints a new N-bar extreme but CUMULATIVE
 * CVD does NOT confirm it (higher CVD into a price low = buyers absorbing →
 * long; lower CVD into a price high → short). Exit on revert to the SMA(N).
 */
export function cvdDivergence(symbol: string, tf: string, micro: MicroAligned, N = 20, slPct = 0.06): CustomStrategy {
  let key: Candle[] | null = null;
  let m: number[] = [];
  const ens = (c: Candle[]) => { if (key !== c) { m = sma(c.map((x) => x.c), N); key = c; } };
  return {
    id: `cvddiv${N}-${symbol}-${tf}`, code: 'cvddiv', name: `${symbol} CVD-Divergence`, symbol, timeframe: tf, slPct, warmup: N + 1,
    description: `CVD divergence: price ${N}-bar extreme not confirmed by cumulative CVD → fade, exit at SMA(${N})`,
    decide(c, i, pos): Signal {
      ens(c);
      if (pos === null) {
        const cum = micro.cvdCum[i]; const cumN = micro.cvdCum[i - N];
        if (cum == null || cumN == null) return null;
        let lo = Infinity, hi = -Infinity;
        for (let j = Math.max(0, i - N + 1); j <= i; j++) { const cl = c[j]!.c; if (cl < lo) lo = cl; if (cl > hi) hi = cl; }
        if (c[i]!.c <= lo + 1e-12 && cum > cumN) return 'long';   // price low, CVD higher → absorption
        if (c[i]!.c >= hi - 1e-12 && cum < cumN) return 'short';
        return null;
      }
      if (pos === 'long') return c[i]!.c >= m[i]! ? 'flat' : null;
      return c[i]!.c <= m[i]! ? 'flat' : null;
    },
  };
}

/**
 * OI-quadrant trap-fade. Falling open interest = positions CLOSING, so the
 * move is exhaustion not conviction → fade it. dOI<0 & price down = longs
 * liquidating into a low → long; dOI<0 & price up = shorts covering into a
 * high → short. Exit via the engine time-stop (slMode time).
 */
export function oiQuadrant(symbol: string, tf: string, micro: MicroAligned, roc = 1, slPct = 0.06): CustomStrategy {
  return {
    id: `oiquad${roc}-${symbol}-${tf}`, code: 'oiquad', name: `${symbol} OI-Quadrant`, symbol, timeframe: tf, slPct, warmup: roc + 2,
    description: `OI-quadrant trap-fade: falling OI into a ${roc}-bar move = exhaustion → fade`,
    decide(c, i, pos): Signal {
      if (pos !== null) return null; // time-stop owns the exit
      const dOi = micro.dOi[i];
      if (dOi == null || dOi >= 0) return null; // only fade on CLOSING interest
      const ref = c[i - roc];
      if (!ref) return null;
      const up = c[i]!.c > ref.c; const down = c[i]!.c < ref.c;
      if (dOi < 0 && down) return 'long';  // long liquidation exhausting
      if (dOi < 0 && up) return 'short';   // short covering exhausting
      return null;
    },
  };
}

/** Causal rolling mean over `W`, treating null as 0. */
function rollMean(a: (number | null)[], W: number): number[] {
  const out = new Array<number>(a.length); let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] ?? 0;
    if (i >= W) sum -= a[i - W] ?? 0;
    out[i] = sum / Math.min(i + 1, W);
  }
  return out;
}

/**
 * LIQUIDATION-CASCADE FADE on REAL liquidation volume (Reservoir, not the OHLCV
 * proxy). A liq-volume SPIKE = forced flow that overshoots → fade it. Direction
 * is inferred from the price move (liq spike + sharp drop = long-liquidation
 * cascade → fade long; spike + sharp rise = short cascade → fade short). Exit is
 * the engine TIME stop; decide() never counter-closes.
 *
 * @param liqK   spike threshold: liq[i] ≥ liqK · rolling-mean(liq, W)
 * @param velBars / velThr  price must have moved ≥ velThr over velBars in the cascade dir
 */
export function liqCascadeFade(symbol: string, tf: string, micro: MicroAligned, liqK = 4, W = 96, velBars = 3, velThr = 0.01, side: 'both' | 'long' | 'short' = 'both', slPct = 0.06): CustomStrategy {
  const liqAvg = rollMean(micro.liq, W);
  return {
    id: `liqc${liqK}_${velBars}_${Math.round(velThr * 1000)}-${symbol}-${tf}`, code: 'liqcasc', name: `${symbol} Liq-Cascade Fade`, symbol, timeframe: tf, slPct, warmup: Math.max(W, velBars) + 1,
    description: `Fade a ${liqK}× liquidation-volume spike + ${velThr * 100}% / ${velBars}-bar move (real liq data), time-stop exit`,
    decide(c, i, pos): Signal {
      if (pos !== null) return null;
      const lq = micro.liq[i];
      if (lq == null || !(lq > 0) || !(liqAvg[i]! > 0) || lq < liqK * liqAvg[i]!) return null;
      const ref = c[i - velBars];
      if (!ref) return null;
      const down = (ref.c - c[i]!.c) / ref.c;  // >0 = price fell into the liq spike
      if (side !== 'short' && down >= velThr) return 'long';
      if (side !== 'long' && -down >= velThr) return 'short';
      return null;
    },
  };
}

/**
 * BOOK-IMBALANCE signal on top-5 L2 depth imbalance (Reservoir, from ~Dec-2025).
 * imb in [-1,1] (bid-heavy positive). mode 'mom' = trade toward the heavy side
 * (depth predicts the next move); 'rev' = fade it. Exit via the engine time-stop.
 */
export function bookImbalance(symbol: string, tf: string, micro: MicroAligned, imbThr = 0.4, mode: 'mom' | 'rev' = 'mom', slPct = 0.05): CustomStrategy {
  return {
    id: `bookimb${Math.round(imbThr * 100)}${mode}-${symbol}-${tf}`, code: 'bookimb', name: `${symbol} Book-Imbalance`, symbol, timeframe: tf, slPct, warmup: 2,
    description: `Top-5 book imbalance ±${imbThr} → ${mode === 'mom' ? 'follow' : 'fade'} the heavy side, time-stop exit`,
    decide(c, i, pos): Signal {
      if (pos !== null) return null;
      const im = micro.imb[i];
      if (im == null) return null;
      if (im >= imbThr) return mode === 'mom' ? 'long' : 'short';
      if (im <= -imbThr) return mode === 'mom' ? 'short' : 'long';
      return null;
    },
  };
}

/**
 * CVD-EXHAUSTION LIQUIDATION-CLIMAX FADE (1m event-driven). The prior taker
 * liqCascadeFade died OOS because it fired on EVERY liq spike — including
 * cascades still FEEDING. The fix is a SEQUENTIAL two-minute pattern bars can't
 * express: a CLIMAX minute k (liq ≫ avg AND |CVD| ≫ avg) followed within
 * `lookback` minutes by an EXHAUSTION minute i (liq back to normal AND |CVD|
 * collapsed AND no new price extreme) = the forced flow is DONE → fade it.
 * Rare + multi-R → taker cost negligible. Run at tf='1' on liq+cvd (both in the
 * loader). Exit via the engine time/atr+time stop.
 */
export function cvdExhaustionFade(symbol: string, tf: string, micro: MicroAligned, liqK = 5, cvdK = 4, W = 240, exhLiqK = 1.5, exhCvdFrac = 0.5, lookback = 3, slPct = 0.08): CustomStrategy {
  const liqAvg = rollMean(micro.liq, W);
  const cvdAbsAvg = rollMean(micro.cvd.map((v) => (v == null ? null : Math.abs(v))), W);
  return {
    id: `cvdexh${liqK}_${cvdK}_${Math.round(exhCvdFrac * 100)}-${symbol}-${tf}`, code: 'cvdexh', name: `${symbol} CVD-Exhaustion Fade`, symbol, timeframe: tf, slPct, warmup: W + lookback + 1,
    description: `Fade a liq+CVD climax (${liqK}×/${cvdK}×) confirmed by an exhaustion minute (liq<${exhLiqK}×, |CVD|<${exhCvdFrac}× climax), no new extreme — time-stop exit`,
    decide(c, i, pos): Signal {
      if (pos !== null) return null;
      const cvI = micro.cvd[i]; const lqI = micro.liq[i];
      if (cvI == null || lqI == null || liqAvg[i] == null) return null;
      for (let k = i - 1; k >= i - lookback; k--) {                          // look back for the CLIMAX minute
        const cvK = micro.cvd[k]; const lqK = micro.liq[k];
        if (cvK == null || lqK == null || cvdAbsAvg[k] == null || liqAvg[k] == null) continue;
        const climax = lqK >= liqK * liqAvg[k]! && Math.abs(cvK) >= cvdK * cvdAbsAvg[k]!;
        if (!climax) continue;
        const exhausted = lqI < exhLiqK * liqAvg[i]! && Math.abs(cvI) < exhCvdFrac * Math.abs(cvK);
        if (!exhausted) continue;
        if (cvK < 0) {                                                        // down-cascade (forced selling)
          if (c[i]!.l < c[k]!.l) continue;                                    // still making new lows → not done
          return 'long';
        }
        if (c[i]!.h > c[k]!.h) continue;                                      // up-cascade still extending
        return 'short';
      }
      return null;
    },
  };
}
