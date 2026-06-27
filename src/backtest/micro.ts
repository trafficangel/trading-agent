/**
 * MICRO-FEATURE LOADER — bridges the hl_micro collector ([[hl-micro-layer]])
 * to the backtest engine. Reads per-minute microstructure rows, aggregates
 * them into the strategy's timeframe, and returns arrays INDEX-ALIGNED with a
 * candle series, so an order-flow strategy factory can close over them (the
 * same closed-over-array trick as families-xasset.ts — no engine surgery).
 *
 * DB-touching (unlike the pure engine/indicators) → used by sweep scripts on
 * the VPS where hl_micro + klines both live. Look-ahead-safe: feature[i] is
 * built ONLY from micro rows inside candle i's [t, t+tf) window (no future).
 */

import { db } from '../db/client.js';
import type { Candle } from './indicators.js';

export type MicroAligned = {
  /** per-bar CVD delta (sum of minute cvd_delta inside the bar) */
  cvd: (number | null)[];
  /** cumulative CVD from the first bar with data */
  cvdCum: (number | null)[];
  /** open interest at bar close (last non-null minute in the bar) */
  oi: (number | null)[];
  /** OI change vs the previous bar */
  dOi: (number | null)[];
  funding: (number | null)[];
  /** mean top-5 book imbalance over the bar, [-1,1] */
  imb: (number | null)[];
  /** total liquidation volume in the bar (base units) */
  liq: (number | null)[];
  /** aggressive BUY volume in the bar (taker buys) */
  buyVol: (number | null)[];
  /** aggressive SELL volume in the bar (taker sells) */
  sellVol: (number | null)[];
  /** fraction of candles that have ANY micro data */
  coverage: number;
  /** count of candles with micro data */
  withData: number;
};

type MicroRow = { ts: number; cvd_delta: number; buy_vol: number | null; sell_vol: number | null; oi: number | null; funding: number | null; book_imb: number | null; liq_vol: number | null };

/** Load + aggregate hl_micro for `coin` (HL bare name, e.g. 'BTC'), aligned to
 *  `candles` (whose .t is the bar-open ms) at timeframe `tf` minutes. */
export function loadMicroAligned(coin: string, tf: string, candles: Candle[]): MicroAligned {
  const n = candles.length;
  const out: MicroAligned = { cvd: Array(n).fill(null), cvdCum: Array(n).fill(null), oi: Array(n).fill(null), dOi: Array(n).fill(null), funding: Array(n).fill(null), imb: Array(n).fill(null), liq: Array(n).fill(null), buyVol: Array(n).fill(null), sellVol: Array(n).fill(null), coverage: 0, withData: 0 };
  if (n === 0) return out;
  const tfMs = Number(tf) * 60_000;
  const from = candles[0]!.t;
  const to = candles[n - 1]!.t + tfMs;
  const rows = db.prepare<[string, number, number], MicroRow>(
    `SELECT ts, cvd_delta, buy_vol, sell_vol, oi, funding, book_imb, liq_vol FROM hl_micro WHERE coin = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  ).all(coin, from, to);
  if (rows.length === 0) return out;

  // bucket minute rows into candle windows (both sorted ascending)
  let ri = 0;
  let cum = 0; let cumStarted = false; let prevOi: number | null = null;
  for (let i = 0; i < n; i++) {
    const start = candles[i]!.t; const end = start + tfMs;
    let cvdSum = 0; let imbSum = 0; let imbCnt = 0; let liqSum = 0; let buyVSum = 0; let sellVSum = 0; let flowAny = false; let lastOi: number | null = null; let lastFund: number | null = null; let any = false;
    while (ri < rows.length && rows[ri]!.ts < start) ri++; // skip rows before this bar (gaps)
    while (ri < rows.length && rows[ri]!.ts < end) {
      const r = rows[ri]!;
      cvdSum += r.cvd_delta; any = true;
      if (r.buy_vol != null) { buyVSum += r.buy_vol; flowAny = true; }
      if (r.sell_vol != null) { sellVSum += r.sell_vol; flowAny = true; }
      if (r.oi != null) lastOi = r.oi;
      if (r.funding != null) lastFund = r.funding;
      if (r.book_imb != null) { imbSum += r.book_imb; imbCnt++; }
      if (r.liq_vol != null) liqSum += r.liq_vol;
      ri++;
    }
    if (!any) continue;
    out.withData++;
    out.liq[i] = Math.round(liqSum * 1e4) / 1e4;
    out.buyVol[i] = flowAny ? Math.round(buyVSum * 1e4) / 1e4 : null;
    out.sellVol[i] = flowAny ? Math.round(sellVSum * 1e4) / 1e4 : null;
    out.cvd[i] = Math.round(cvdSum * 1e4) / 1e4;
    cum += cvdSum; cumStarted = true; out.cvdCum[i] = Math.round(cum * 1e4) / 1e4;
    out.oi[i] = lastOi;
    out.dOi[i] = lastOi != null && prevOi != null ? Math.round((lastOi - prevOi) * 1e4) / 1e4 : null;
    if (lastOi != null) prevOi = lastOi;
    out.funding[i] = lastFund;
    out.imb[i] = imbCnt > 0 ? Math.round((imbSum / imbCnt) * 1e4) / 1e4 : null;
  }
  void cumStarted;
  out.coverage = Math.round((out.withData / n) * 1000) / 1000;
  return out;
}

export type BybitAligned = {
  /** Bybit OI snapshot inside bar i (base contracts; use RELATIVE — percentile/z — not absolute). */
  oi: (number | null)[];
  /** Bybit 8h funding rate forward-filled: the last settled 8h stamp with ts <= bar-open (constant
   *  within its window). null until the first stamp. */
  funding: (number | null)[];
  /** fraction of bars with an OI value */
  oiCov: number;
  /** fraction of bars with a (forward-filled) funding value */
  fndCov: number;
};

/** Load + align bybit_micro (cross-venue OI 1h + funding 8h) to `candles`, INDEX-ALIGNED, causal.
 *  OI[i]  = last OI snapshot inside bar i's [t, t+tf) window (Bybit OI is hourly at the bar open).
 *  fnd[i] = last settled 8h funding stamp with ts <= bar OPEN, forward-filled (the rate in effect
 *           during the bar; known by close[i]). Both read only ts <= decision time → no look-ahead. */
export function loadBybitAligned(coin: string, tf: string, candles: Candle[]): BybitAligned {
  const n = candles.length;
  const out: BybitAligned = { oi: Array(n).fill(null), funding: Array(n).fill(null), oiCov: 0, fndCov: 0 };
  if (n === 0) return out;
  const tfMs = Number(tf) * 60_000;
  const from = candles[0]!.t;
  const to = candles[n - 1]!.t + tfMs;
  const seed = from - 8 * 3_600_000; // pull one 8h window earlier to seed the funding forward-fill
  const rows = db.prepare<[string, number, number], { ts: number; oi: number | null; funding: number | null }>(
    `SELECT ts, oi, funding FROM bybit_micro WHERE coin = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  ).all(coin, seed, to);
  if (rows.length === 0) return out;

  let fi = 0; let lastFund: number | null = null; let oiN = 0; let fndN = 0; let oiRi = 0;
  for (let i = 0; i < n; i++) {
    const start = candles[i]!.t; const end = start + tfMs;
    // forward-fill funding: consume every row with ts <= bar open, keeping the latest settled stamp
    while (fi < rows.length && rows[fi]!.ts <= start) { if (rows[fi]!.funding != null) lastFund = rows[fi]!.funding; fi++; }
    out.funding[i] = lastFund; if (lastFund != null) fndN++;
    // OI: last non-null oi inside [start, end) (does NOT advance the shared pointer past the bar)
    while (oiRi < rows.length && rows[oiRi]!.ts < start) oiRi++;
    let lastOi: number | null = null;
    for (let j = oiRi; j < rows.length && rows[j]!.ts < end; j++) { if (rows[j]!.oi != null) lastOi = rows[j]!.oi; }
    out.oi[i] = lastOi; if (lastOi != null) oiN++;
  }
  out.oiCov = Math.round((oiN / n) * 1000) / 1000;
  out.fndCov = Math.round((fndN / n) * 1000) / 1000;
  return out;
}
