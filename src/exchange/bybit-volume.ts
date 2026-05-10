import { request } from 'undici';
import { logger } from '../lib/logger.js';

const BASE = 'https://api.bybit.com';
const CACHE_TTL_MS = 60_000; // klines refresh once per minute
const cache = new Map<string, { data: VolumeProfile; ts: number }>();

type KlineResp = {
  retCode: number;
  retMsg: string;
  result?: {
    list?: string[][]; // [start, open, high, low, close, volume, turnover]
  };
};

export type VolumeProfile = {
  symbol: string;
  /** Volume Point of Control — price level with the most traded volume in 24h */
  poc: number | null;
  /** Value Area High — top of the 70% volume zone */
  vah: number | null;
  /** Value Area Low — bottom of the 70% volume zone */
  val: number | null;
  /** Volume-weighted average price across the 24h window */
  vwap: number | null;
  /** ATR(14) on 15m — typical 15m bar range, in price units */
  atr14_15m: number | null;
  /** highest high in the 24h window */
  high24h: number | null;
  /** lowest low in the 24h window */
  low24h: number | null;
  fetchedAt: number;
};

/**
 * Fetch 15m klines for the last 24 hours and compute classic volume-profile
 * statistics. These are real, deterministic S/R levels that the model can
 * reference directly when placing SL/TP — much better than eyeballing the
 * chart.
 *
 * Output is text-injected into the LLM prompt; we do NOT pass these to risk
 * gating (the LLM should still justify why a level matters).
 */
export async function getVolumeProfile(symbol: string): Promise<VolumeProfile | null> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  // 96 × 15m = 24h
  const url = `${BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=15&limit=96`;
  let body: KlineResp;
  try {
    const res = await request(url, { method: 'GET', headersTimeout: 5_000, bodyTimeout: 5_000 });
    body = (await res.body.json()) as KlineResp;
  } catch (err) {
    logger.error({ err, symbol }, 'volume profile: kline fetch failed');
    return null;
  }
  if (body.retCode !== 0 || !body.result?.list || body.result.list.length === 0) {
    logger.warn({ retCode: body.retCode, msg: body.retMsg, symbol }, 'volume profile: kline non-OK');
    return null;
  }

  // Bybit returns newest-first. We want oldest-first for VWAP cumulative calc.
  const klines = [...body.result.list].reverse().map((k) => ({
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    turnover: Number(k[6]), // price × volume already pre-summed by Bybit
  }));

  if (klines.some((k) => !Number.isFinite(k.close) || !Number.isFinite(k.volume))) {
    logger.warn({ symbol }, 'volume profile: malformed kline numbers');
    return null;
  }

  // === VWAP (turnover-based — Bybit gives us pre-summed price*volume) ===
  let totalTurnover = 0;
  let totalVolume = 0;
  for (const k of klines) {
    totalTurnover += k.turnover;
    totalVolume += k.volume;
  }
  const vwap = totalVolume > 0 ? totalTurnover / totalVolume : null;

  // === Price range over 24h ===
  const high24h = Math.max(...klines.map((k) => k.high));
  const low24h = Math.min(...klines.map((k) => k.low));

  // === Volume profile: bin price range, sum volume per bin ===
  // Resolution: 50 buckets across [low24h, high24h]. Volume of each bar is
  // attributed to a single bin at its typical price (HLC/3).
  const NUM_BINS = 50;
  const binSize = (high24h - low24h) / NUM_BINS;
  let poc: number | null = null;
  let vah: number | null = null;
  let val: number | null = null;
  if (binSize > 0) {
    const bins = new Array<number>(NUM_BINS).fill(0);
    for (const k of klines) {
      const typical = (k.high + k.low + k.close) / 3;
      const idx = Math.min(NUM_BINS - 1, Math.max(0, Math.floor((typical - low24h) / binSize)));
      bins[idx] = (bins[idx] ?? 0) + k.volume;
    }
    // POC = bin with max volume. Price = bin center.
    let pocIdx = 0;
    let pocVol = -1;
    for (let i = 0; i < NUM_BINS; i++) {
      const v = bins[i] ?? 0;
      if (v > pocVol) {
        pocVol = v;
        pocIdx = i;
      }
    }
    poc = low24h + binSize * (pocIdx + 0.5);

    // Value Area: expand from POC outward until 70% of total volume is
    // covered. Standard market-profile algorithm.
    const target = totalVolume * 0.7;
    let lo = pocIdx;
    let hi = pocIdx;
    let acc = bins[pocIdx] ?? 0;
    while (acc < target && (lo > 0 || hi < NUM_BINS - 1)) {
      const upNext = hi < NUM_BINS - 1 ? (bins[hi + 1] ?? 0) : -1;
      const dnNext = lo > 0 ? (bins[lo - 1] ?? 0) : -1;
      if (upNext >= dnNext) {
        hi++;
        acc += upNext;
      } else {
        lo--;
        acc += dnNext;
      }
    }
    val = low24h + binSize * lo;
    vah = low24h + binSize * (hi + 1);
  }

  // === ATR(14) on 15m using last 14 bars (true range) ===
  let atr14_15m: number | null = null;
  if (klines.length >= 15) {
    const last15 = klines.slice(-15);
    let sumTr = 0;
    for (let i = 1; i < last15.length; i++) {
      const cur = last15[i]!;
      const prev = last15[i - 1]!;
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      );
      sumTr += tr;
    }
    atr14_15m = sumTr / 14;
  }

  // Round to a sensible precision based on price scale.
  const p = klines.at(-1)!.close;
  const decimals = p < 1 ? 6 : p < 100 ? 4 : p < 10000 ? 2 : 1;
  const r = (x: number | null) => (x === null ? null : Number(x.toFixed(decimals)));

  const data: VolumeProfile = {
    symbol,
    poc: r(poc),
    vah: r(vah),
    val: r(val),
    vwap: r(vwap),
    atr14_15m: r(atr14_15m),
    high24h: r(high24h),
    low24h: r(low24h),
    fetchedAt: Date.now(),
  };

  cache.set(symbol, { data, ts: Date.now() });
  return data;
}

export function formatVolumeProfile(vp: VolumeProfile | null): string {
  if (!vp) return '  (volume profile unavailable)';
  return [
    `  POC (max volume):  ${vp.poc ?? 'n/a'}`,
    `  VAH (70% upper):   ${vp.vah ?? 'n/a'}`,
    `  VAL (70% lower):   ${vp.val ?? 'n/a'}`,
    `  VWAP (24h):        ${vp.vwap ?? 'n/a'}`,
    `  24h range:         ${vp.low24h ?? 'n/a'} ↔ ${vp.high24h ?? 'n/a'}`,
    `  ATR(14) 15m:       ${vp.atr14_15m ?? 'n/a'}`,
  ].join('\n');
}
