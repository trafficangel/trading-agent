/**
 * 15m/30m RESEARCH families (batch 1) — the vetted survivors of the low-TF
 * Hyperliquid web-research sweep. Distinct in MECHANISM from our band/oscillator
 * mean-reversion + breakout/trend arsenal, so they diversify the book. Both are
 * pure decide() on OHLCV(+volume), strictly look-ahead-safe (see candles[0..i]).
 * Hypotheses to REFUTE via the kill-battery (cross-symbol + walk-forward +
 * cost-stress), shadow-only until they earn it.
 */

import { sma, atr, type Candle } from '../indicators.js';
import type { CustomStrategy, Signal } from '../strategy.js';

/**
 * #1 SESSION TIME-SERIES MOMENTUM (the only 'strong'-evidence candidate —
 * Reading BTC intraday-momentum paper). Thesis: the sign of the FIRST window
 * of the UTC day predicts the LAST window. Compute r_first = return over the
 * first J bars of the current UTC day (00:00 open → close of bar J); near the
 * end of the day (entryMin) take a position in sign(r_first); flatten at the
 * first bar of the next UTC day. Directional → TAKER; the engine's ATR slMode
 * is a crash guard, the day-boundary 'flat' is the real exit.
 *
 * @param entryMin minutes-into-UTC-day at/after which we enter (e.g. 1380=23:00)
 * @param J number of opening bars whose return forms the predictor
 * @param side 'both' (default; direction = sign of r_first) | 'long' | 'short'
 */
export function sessionMomentum(symbol: string, tf: string, entryMin = 1380, J = 1, side: 'both' | 'long' | 'short' = 'both', slPct = 0.08): CustomStrategy {
  const tfMin = Number(tf);
  const barsPerDay = Math.max(1, Math.round(1440 / tfMin));
  const dayOf = (t: number) => Math.floor(t / 86_400_000);
  const minsInto = (t: number) => Math.floor((t % 86_400_000) / 60_000);
  return {
    id: `sess${entryMin}_${J}${side === 'both' ? '' : side[0]}-${symbol}-${tf}`,
    code: 'session', name: `${symbol} Session-Momentum`, symbol, timeframe: tf, slPct,
    warmup: barsPerDay + 5,
    description: `Intraday session momentum: first ${J}-bar UTC-day return predicts the late-day move (enter ≥${Math.floor(entryMin / 60)}:00 UTC, flat at day roll)`,
    decide(c, i, pos): Signal {
      const cur = c[i]!;
      // EXIT: first bar of a new UTC day (robust to gaps — compares to prev bar).
      if (pos !== null) return i > 0 && dayOf(cur.t) !== dayOf(c[i - 1]!.t) ? 'flat' : null;
      // ENTRY: only in the late-day window.
      if (minsInto(cur.t) < entryMin) return null;
      const dk = dayOf(cur.t);
      let ds = i;
      while (ds > 0 && dayOf(c[ds - 1]!.t) === dk) ds--;
      // require a clean ~00:00 day-open and J bars elapsed since it
      if (minsInto(c[ds]!.t) >= tfMin) return null;
      if (i - ds < J) return null;
      const rFirst = c[ds + J - 1]!.c / c[ds]!.o - 1;
      if (rFirst > 0) return side === 'short' ? null : 'long';
      if (rFirst < 0) return side === 'long' ? null : 'short';
      return null;
    },
  };
}

/**
 * #2 LIQUIDATION-CASCADE FADE (OHLCV proxy — no liquidation feed). Thesis: a
 * forced-liquidation cascade overshoots and reverts once the book refills. We
 * PROXY a cascade as: a fast multi-bar displacement (velBars) beyond an
 * ATR-scaled threshold, ON a volume-spike bar (vol ≥ volK · SMA(vol)), with the
 * close near the far extreme (IBS gate). Fade it; the exit is the engine's
 * TIME stop (slMode time/atr+time) — decide() NEVER counter-closes. Distinct
 * from band/oscillator MR: it's a velocity+volume event, not a level.
 *
 * @param velBars displacement lookback (bars)
 * @param velMult threshold = velMult · ATR%/bar (ATR-relative, regime-adaptive)
 * @param volK volume-spike multiple vs SMA(vol, volLook)
 * @param ibsGate require close near the extreme (IBS<0.3 long / >0.7 short)
 * @param side 'both' | 'long' (fade down-cascades) | 'short' (fade up-cascades)
 */
export function cascadeFade(symbol: string, tf: string, velBars = 3, velMult = 1.5, volK = 3, volLook = 20, ibsGate = false, side: 'both' | 'long' | 'short' = 'both', slPct = 0.08): CustomStrategy {
  let key: Candle[] | null = null;
  let vSma: number[] = [];
  let a: number[] = [];
  const ens = (c: Candle[]) => { if (key !== c) { vSma = sma(c.map((x) => x.v), volLook); a = atr(c, 14); key = c; } };
  return {
    id: `casc${velBars}_${Math.round(velMult * 100)}v${volK}${ibsGate ? 'i' : ''}${side === 'both' ? '' : side[0]}-${symbol}-${tf}`,
    code: 'cascade', name: `${symbol} Cascade-Fade`, symbol, timeframe: tf, slPct,
    warmup: Math.max(velBars, volLook, 14) + 2,
    description: `Liquidation-cascade fade: fade a ${velBars}-bar ATR×${velMult} displacement on a ${volK}× volume spike (proxy), time-stop exit`,
    decide(c, i, pos): Signal {
      ens(c);
      if (pos !== null) return null; // time-stop owns the exit; never counter-close
      const b = c[i]!;
      if (!(vSma[i - 1]! > 0) || b.v < volK * vSma[i - 1]!) return null; // volume-spike gate
      const ap = a[i]! / b.c;
      if (!(ap > 0)) return null;
      const thr = velMult * ap;
      const ref = c[i - velBars]!.c;
      const ibs = b.h > b.l ? (b.c - b.l) / (b.h - b.l) : 0.5;
      const dispDown = (ref - b.c) / ref;
      const dispUp = (b.c - ref) / ref;
      if (side !== 'short' && dispDown >= thr && (!ibsGate || ibs < 0.3)) return 'long';
      if (side !== 'long' && dispUp >= thr && (!ibsGate || ibs > 0.7)) return 'short';
      return null;
    },
  };
}
