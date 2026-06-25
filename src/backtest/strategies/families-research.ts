/**
 * 15m/30m RESEARCH families (batch 1) — the vetted survivors of the low-TF
 * Hyperliquid web-research sweep. Distinct in MECHANISM from our band/oscillator
 * mean-reversion + breakout/trend arsenal, so they diversify the book. Both are
 * pure decide() on OHLCV(+volume), strictly look-ahead-safe (see candles[0..i]).
 * Hypotheses to REFUTE via the kill-battery (cross-symbol + walk-forward +
 * cost-stress), shadow-only until they earn it.
 */

import { sma, atr, rollingStd, donchian, type Candle } from '../indicators.js';
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

/**
 * #3 ABSORPTION-FAIL RETEST (volume-climax wick-rejection — the design-sweep's
 * lone adversarial survivor). A two-bar SINGLE climax event: bar k=i-1 is a
 * volume climax (v ≥ volK·SMA(vol)) that prints a long REJECTION wick and a poor
 * close (IBS) — aggressors hit resting liquidity and got absorbed. Bar i CONFIRMS
 * the absorption held: price did NOT extend past the climax extreme and closed
 * adversely → fade. The "no new high/low vs the climax bar" is the microstructure
 * proof (resting liquidity won), which is what makes it distinct from cascadeFade
 * (ATR-velocity displacement) and from band-MR (no level/mean reference at all).
 * Exit is the engine TIME-stop only; decide() never counter-closes.
 *
 * @param volK   climax volume multiple vs SMA(vol, volLook) measured BEFORE the bar
 * @param wickFrac rejection wick ≥ this fraction of the climax bar's range
 * @param ibsLo  up-climax requires IBS ≤ ibsLo (poor close near the low)
 * @param ibsHi  down-climax requires IBS ≥ ibsHi (strong close near the high)
 */
export function absorptionFailRetest(symbol: string, tf: string, volK = 3, volLook = 20, wickFrac = 0.5, ibsLo = 0.4, ibsHi = 0.6, slPct = 0.08): CustomStrategy {
  let key: Candle[] | null = null;
  let vSma: number[] = [];
  const ens = (c: Candle[]) => { if (key !== c) { vSma = sma(c.map((x) => x.v), volLook); key = c; } };
  return {
    id: `absorp${volK}_${volLook}w${Math.round(wickFrac * 100)}i${Math.round(ibsLo * 100)}-${symbol}-${tf}`,
    code: 'absorp', name: `${symbol} Absorption-Fail`, symbol, timeframe: tf, slPct,
    warmup: volLook + 3,
    description: `Volume-climax wick-rejection absorption fade: fade a ${volK}× volume climax with a ≥${Math.round(wickFrac * 100)}% rejection wick once the next bar fails to extend, time-stop exit`,
    decide(c, i, pos): Signal {
      ens(c);
      if (pos !== null) return null; // time-stop owns the exit; never counter-close
      const k = i - 1;
      const kb = c[k]; const b = c[i];
      if (!kb || !b) return null;
      if (!(vSma[k - 1]! > 0) || kb.v < volK * vSma[k - 1]!) return null; // volume climax at k (vs avg BEFORE it)
      const rng = kb.h - kb.l;
      if (!(rng > 0)) return null;
      const ibsK = (kb.c - kb.l) / rng;
      const upperWick = (kb.h - Math.max(kb.o, kb.c)) / rng;
      const lowerWick = (Math.min(kb.o, kb.c) - kb.l) / rng;
      // up-climax (big upper wick + poor close): short if bar i failed to make a new high and closed lower
      if (upperWick >= wickFrac && ibsK <= ibsLo && b.h < kb.h && b.c < kb.c) return 'short';
      // down-climax (big lower wick + strong close): long if bar i failed to make a new low and closed higher
      if (lowerWick >= wickFrac && ibsK >= ibsHi && b.l > kb.l && b.c > kb.c) return 'long';
      return null;
    },
  };
}

/* ── VOL-COMPRESSION family ── squeeze (low realized vol) → directional EXPANSION breakout.
 * Thesis: intraday volatility clusters; a tight compression resolves with a directional
 * thrust. All three are pure breakout entries (signal only when FLAT; the engine SlMode —
 * time or atr+time — owns the exit, like cascadeFade), and strictly causal: the breakout
 * level comes from bars < i and the trigger is candle[i]'s close (known at close). Distinct
 * from Donchian trend-breakout (which is unconditional) by the COMPRESSION precondition.    */

/**
 * #4 NR-SQUEEZE EXPANSION. The setup bar k=i-1 has the narrowest range in the last `nrLook`
 * bars (a volatility squeeze); bar i then makes a range ≥ `expandK`× that squeeze range AND
 * closes beyond the squeeze bar's extreme → ride the expansion in the break direction.
 */
export function nrSqueezeExpansion(symbol: string, tf: string, nrLook = 7, expandK = 1.5, slPct = 0.08): CustomStrategy {
  const rng = (x: Candle) => x.h - x.l;
  return {
    id: `nrsq${nrLook}x${Math.round(expandK * 100)}-${symbol}-${tf}`,
    code: 'volcomp', name: `${symbol} NR-Squeeze Expansion`, symbol, timeframe: tf, slPct,
    warmup: nrLook + 2,
    description: `Narrow-range(${nrLook}) squeeze → directional expansion breakout (≥${expandK}× the squeeze range), SlMode exit`,
    decide(c, i, pos): Signal {
      if (pos !== null) return null; // SlMode owns the exit; pure breakout entry
      const k = i - 1; const kb = c[k]; const b = c[i];
      if (!kb || !b || k - nrLook + 1 < 0) return null;
      const setupRng = rng(kb);
      if (!(setupRng > 0)) return null;
      for (let j = k - nrLook + 1; j < k; j++) if (rng(c[j]!) <= setupRng) return null; // k must be the strict NR bar
      if (rng(b) < expandK * setupRng) return null;                                     // require a real expansion
      if (b.c > kb.h) return 'long';
      if (b.c < kb.l) return 'short';
      return null;
    },
  };
}

/**
 * #5 BBW-SQUEEZE PERCENTILE-RANK BREAKOUT. Bollinger band-width bbw=2·std/mid; when bbw[i]
 * sits in its lowest `pctile` over the last `rankLook` bars (a regime-relative squeeze, à la
 * TTM) and the close breaks the prior Donchian(`bbLook`) range → trade the breakout.
 */
export function bbwSqueezePctRank(symbol: string, tf: string, bbLook = 20, rankLook = 100, pctile = 0.2, slPct = 0.08): CustomStrategy {
  let key: Candle[] | null = null;
  let bbw: number[] = []; let dUp: number[] = []; let dLo: number[] = [];
  const ens = (c: Candle[]) => {
    if (key === c) return;
    const close = c.map((x) => x.c);
    const mid = sma(close, bbLook); const sd = rollingStd(close, bbLook);
    bbw = sd.map((s, j) => (mid[j]! > 0 ? (2 * s) / mid[j]! : Number.POSITIVE_INFINITY));
    const d = donchian(c, bbLook); dUp = d.upper; dLo = d.lower;
    key = c;
  };
  return {
    id: `bbwsq${bbLook}r${rankLook}p${Math.round(pctile * 100)}-${symbol}-${tf}`,
    code: 'volcomp', name: `${symbol} BBW-Squeeze Breakout`, symbol, timeframe: tf, slPct,
    warmup: bbLook + rankLook + 2,
    description: `Bollinger band-width in its lowest ${Math.round(pctile * 100)}th pct over ${rankLook} bars (squeeze) → Donchian(${bbLook}) breakout, SlMode exit`,
    decide(c, i, pos): Signal {
      ens(c);
      if (pos !== null) return null;
      const b = c[i]; if (!b || i - rankLook < 0) return null;
      const cur = bbw[i]!;
      if (!(cur > 0) || !(cur < Number.POSITIVE_INFINITY)) return null;
      let below = 0; let cnt = 0;
      for (let j = i - rankLook; j < i; j++) { const v = bbw[j]!; if (v < Number.POSITIVE_INFINITY) { cnt++; if (v <= cur) below++; } }
      if (cnt < rankLook / 2 || below / cnt > pctile) return null; // not a (regime-relative) squeeze
      if (b.c > dUp[i]!) return 'long';                            // break the prior bbLook-bar high
      if (b.c < dLo[i]!) return 'short';
      return null;
    },
  };
}

/**
 * #6 INSIDE-BAR COIL. `minInside` consecutive inside bars (each h≤prev.h & l≥prev.l) = a
 * volatility coil; the break of the mother bar's range (the bar before the coil) is the
 * release. Close beyond the mother's high/low → trade the break.
 */
export function insideBarCoil(symbol: string, tf: string, minInside = 2, slPct = 0.08): CustomStrategy {
  return {
    id: `coil${minInside}-${symbol}-${tf}`,
    code: 'volcomp', name: `${symbol} Inside-Bar Coil`, symbol, timeframe: tf, slPct,
    warmup: minInside + 3,
    description: `${minInside}+ consecutive inside bars (volatility coil) → break of the mother-bar range, SlMode exit`,
    decide(c, i, pos): Signal {
      if (pos !== null) return null;
      const b = c[i]; const motherIdx = i - minInside - 1;
      if (!b || motherIdx < 0) return null;
      for (let m = 1; m <= minInside; m++) { const cur = c[i - m]!; const prev = c[i - m - 1]!; if (!(cur.h <= prev.h && cur.l >= prev.l)) return null; }
      const mother = c[motherIdx]!;
      if (b.c > mother.h) return 'long';
      if (b.c < mother.l) return 'short';
      return null;
    },
  };
}
