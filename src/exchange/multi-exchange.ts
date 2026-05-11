import { logger } from '../lib/logger.js';
import {
  getBinanceKlines,
  getBinanceLsRatio,
  getBinanceOiHistory,
  getBinanceOrderbook,
  getBinanceTicker,
} from './binance-public.js';
import {
  getBybitKlines,
  getBybitOrderbook,
  getBybitTicker,
  getMarketSentiment,
} from './bybit-public.js';
import { getOkxOrderbook, getOkxTicker } from './okx-public.js';
import type { Exchange } from './symbols.js';
import type { ExchangeOrderbook, ExchangeTicker, OrderbookLevel } from './types.js';

const TTL_MS = 30_000;

// ============================================================
// Aggregated sentiment
// ============================================================

export type AggregatedSentiment = {
  symbol: string;
  /** Per-exchange ticker snapshots (some may be null on fetch error). */
  perExchange: { bybit: ExchangeTicker | null; binance: ExchangeTicker | null; okx: ExchangeTicker | null };
  /** USD-OI weighted average funding rate. Null if no usable data. */
  weightedFunding: number | null;
  /** max - min funding across exchanges (absolute spread). Captures crowdedness divergence. */
  fundingDivergence: number | null;
  /** Bybit OI delta over 4h (% change), available because Bybit has its own series. */
  bybitOiDelta4hPct: number | null;
  binanceOiDelta4hPct: number | null;
  /** Aggregate L/S ratio (only Bybit + Binance expose it cleanly). */
  longShortRatio: number | null;
  /** Cross-exchange price spread: Binance lastPrice − Bybit lastPrice as % of Bybit. */
  binanceVsBybitSpreadPct: number | null;
  /** Total open interest across all 3 exchanges in USD. */
  totalOiUsd: number | null;
  fetchedAt: number;
};

const sentimentCache = new Map<string, { data: AggregatedSentiment; ts: number }>();

/**
 * Fetch sentiment from all three exchanges in parallel and combine. Each
 * exchange contributes when it returns data; if a fetch fails (network,
 * geoblock) we still return a result based on whatever responded.
 */
export async function getAggregatedSentiment(symbol: string): Promise<AggregatedSentiment | null> {
  const cached = sentimentCache.get(symbol);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  const [bybit, binance, okx, binanceOi, binanceLs] = await Promise.all([
    getBybitTicker(symbol).catch(() => null),
    getBinanceTicker(symbol).catch(() => null),
    getOkxTicker(symbol).catch(() => null),
    // Binance OI history for 4h delta (5 hourly snapshots = covers 4h ago vs now)
    getBinanceOiHistory(symbol, '1h', 5).catch(() => null),
    getBinanceLsRatio(symbol).catch(() => null),
  ]);

  if (!bybit && !binance && !okx) {
    logger.warn({ symbol }, 'aggregated sentiment: all three exchanges failed');
    return null;
  }

  // Weighted funding: weight each exchange's funding by its USD-OI share.
  let totalOiUsd = 0;
  let fundingNumerator = 0;
  const fundings: number[] = [];
  for (const t of [bybit, binance, okx]) {
    if (t && t.openInterestUsd && t.fundingRate !== null) {
      totalOiUsd += t.openInterestUsd;
      fundingNumerator += t.fundingRate * t.openInterestUsd;
      fundings.push(t.fundingRate);
    }
  }
  const weightedFunding = totalOiUsd > 0 ? fundingNumerator / totalOiUsd : null;
  const fundingDivergence =
    fundings.length >= 2 ? Math.max(...fundings) - Math.min(...fundings) : null;

  // One call to Bybit getMarketSentiment (cached 30s) — gives us both OI
  // delta and L/S ratio in a single hop. Previously this module made TWO
  // dynamic-import calls to the same function; ugly and redundant.
  const bybitMs = await getMarketSentiment(symbol).catch(() => null);
  const bybitOiDelta4hPct = bybitMs?.oiDelta4hPct ?? null;

  // Binance OI delta over 4h: oldest = index 4 (5 hourly snapshots → 4h ago)
  let binanceOiDelta4hPct: number | null = null;
  if (binanceOi && binanceOi.length >= 5) {
    const newest = binanceOi[0]?.openInterest ?? 0;
    const fourHoursAgo = binanceOi[4]?.openInterest ?? 0;
    if (fourHoursAgo > 0) {
      binanceOiDelta4hPct = Math.round(((newest - fourHoursAgo) / fourHoursAgo) * 10000) / 100;
    }
  }

  // L/S ratio: average Bybit + Binance when both available; else whichever exists.
  const lsValues: number[] = [];
  if (bybitMs?.longShortRatio !== null && bybitMs?.longShortRatio !== undefined) {
    lsValues.push(bybitMs.longShortRatio);
  }
  if (binanceLs !== null) lsValues.push(binanceLs);
  const longShortRatio =
    lsValues.length > 0
      ? Math.round((lsValues.reduce((a, b) => a + b, 0) / lsValues.length) * 100) / 100
      : null;

  const binanceVsBybitSpreadPct =
    binance && bybit && bybit.lastPrice > 0
      ? Math.round(((binance.lastPrice - bybit.lastPrice) / bybit.lastPrice) * 10000) / 100
      : null;

  const data: AggregatedSentiment = {
    symbol,
    perExchange: { bybit, binance, okx },
    weightedFunding: weightedFunding !== null ? Math.round(weightedFunding * 1e8) / 1e8 : null,
    fundingDivergence:
      fundingDivergence !== null ? Math.round(fundingDivergence * 1e8) / 1e8 : null,
    bybitOiDelta4hPct,
    binanceOiDelta4hPct,
    longShortRatio,
    binanceVsBybitSpreadPct,
    totalOiUsd: totalOiUsd > 0 ? Math.round(totalOiUsd) : null,
    fetchedAt: Date.now(),
  };

  sentimentCache.set(symbol, { data, ts: Date.now() });
  return data;
}

// ============================================================
// Aggregated orderbook
// ============================================================

export type Wall = {
  /** mid-relative bin price (rounded) */
  price: number;
  /** total USD across all exchanges contributing to this bin */
  usd: number;
  /** which exchanges contributed */
  exchanges: Exchange[];
  /** distance from mid in % (positive = above mid for asks; negative for bids) */
  distancePct: number;
};

export type AggregatedOrderbook = {
  symbol: string;
  midPrice: number;
  /** top 5 ask walls (above mid), sorted by price ascending */
  topAskWalls: Wall[];
  /** top 5 bid walls (below mid), sorted by price descending */
  topBidWalls: Wall[];
  /** Σ bids USD / Σ asks USD within ±2% of mid. <1 means asks heavier (sellers). */
  bidAskRatio2pct: number | null;
  /** how many of the top-10 walls (5 ask + 5 bid) are confirmed on >=2 exchanges */
  crossExchangeConfirmedCount: number;
  perExchange: {
    bybit: ExchangeOrderbook | null;
    binance: ExchangeOrderbook | null;
    okx: ExchangeOrderbook | null;
  };
  fetchedAt: number;
};

const orderbookCache = new Map<string, { data: AggregatedOrderbook; ts: number }>();

/**
 * Bin orderbook levels by 0.05% of mid-price across ±2%. Sum USD per bin
 * across all three exchanges. Walls = bins with USD significantly above the
 * surrounding average (z-score-ish).
 */
function aggregateBins(
  books: ExchangeOrderbook[],
  midPrice: number,
  side: 'bid' | 'ask',
): Map<number, { usd: number; exchanges: Set<Exchange> }> {
  const bins = new Map<number, { usd: number; exchanges: Set<Exchange> }>();
  // Bin step: 0.05% of mid. We round *down* to bin floor.
  const binStep = midPrice * 0.0005;
  const range = midPrice * 0.02;

  for (const book of books) {
    const levels = side === 'bid' ? book.bids : book.asks;
    for (const lvl of levels) {
      const dist = side === 'bid' ? midPrice - lvl.price : lvl.price - midPrice;
      if (dist < 0 || dist > range) continue;
      const binIdx = Math.floor(dist / binStep);
      const binPrice =
        side === 'bid' ? midPrice - (binIdx + 0.5) * binStep : midPrice + (binIdx + 0.5) * binStep;
      const key = Math.round(binPrice * 1e8) / 1e8;
      const existing = bins.get(key);
      if (existing) {
        existing.usd += lvl.usd;
        existing.exchanges.add(book.exchange);
      } else {
        bins.set(key, { usd: lvl.usd, exchanges: new Set([book.exchange]) });
      }
    }
  }
  return bins;
}

function findWalls(
  bins: Map<number, { usd: number; exchanges: Set<Exchange> }>,
  midPrice: number,
  side: 'bid' | 'ask',
  topN: number,
): Wall[] {
  const entries = Array.from(bins.entries());
  if (entries.length === 0) return [];
  // Wall threshold: bin USD >= 2× the average bin USD (rough "stands out").
  const avg = entries.reduce((a, [, b]) => a + b.usd, 0) / entries.length;
  const threshold = Math.max(avg * 2, 5_000); // require >= $5k absolute too
  const candidates = entries
    .filter(([, b]) => b.usd >= threshold)
    .map(([price, b]) => {
      const sign = side === 'ask' ? 1 : -1;
      const distancePct = Math.round(((price - midPrice) / midPrice) * 100 * 100 * sign) / 100;
      return {
        price,
        usd: Math.round(b.usd),
        exchanges: Array.from(b.exchanges).sort(),
        distancePct,
      };
    })
    .sort((a, b) => b.usd - a.usd)
    .slice(0, topN);

  // Sort output by price for human readability:
  return candidates.sort((a, b) => (side === 'ask' ? a.price - b.price : b.price - a.price));
}

export async function getAggregatedOrderbook(symbol: string): Promise<AggregatedOrderbook | null> {
  const cached = orderbookCache.get(symbol);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  const [bybit, binance, okx] = await Promise.all([
    getBybitOrderbook(symbol, 200).catch(() => null),
    getBinanceOrderbook(symbol, 500).catch(() => null),
    getOkxOrderbook(symbol, 400).catch(() => null),
  ]);

  const books = [bybit, binance, okx].filter((b): b is ExchangeOrderbook => b !== null);
  if (books.length === 0) return null;

  // Mid: average of available exchanges' midPrices, weighted by spread tightness
  // (tighter spread = more liquidity = more credible mid). Simple mean works fine
  // when spreads are similar at the top of book.
  const midPrice = books.reduce((a, b) => a + b.midPrice, 0) / books.length;

  const bidBins = aggregateBins(books, midPrice, 'bid');
  const askBins = aggregateBins(books, midPrice, 'ask');

  const topAskWalls = findWalls(askBins, midPrice, 'ask', 5);
  const topBidWalls = findWalls(bidBins, midPrice, 'bid', 5);

  // Bid/ask ratio within ±2%: just sum the bin USDs.
  let bidUsd2 = 0;
  let askUsd2 = 0;
  for (const v of bidBins.values()) bidUsd2 += v.usd;
  for (const v of askBins.values()) askUsd2 += v.usd;
  const bidAskRatio2pct =
    askUsd2 > 0 ? Math.round((bidUsd2 / askUsd2) * 100) / 100 : null;

  // Cross-exchange confirmation count (walls present on >= 2 exchanges).
  const allWalls = [...topAskWalls, ...topBidWalls];
  const crossExchangeConfirmedCount = allWalls.filter((w) => w.exchanges.length >= 2).length;

  const data: AggregatedOrderbook = {
    symbol,
    midPrice: Math.round(midPrice * 1e8) / 1e8,
    topAskWalls,
    topBidWalls,
    bidAskRatio2pct,
    crossExchangeConfirmedCount,
    perExchange: { bybit, binance, okx },
    fetchedAt: Date.now(),
  };

  orderbookCache.set(symbol, { data, ts: Date.now() });
  return data;
}

// ============================================================
// Stop-cluster zones from swing structure
// ============================================================

export type StopCluster = {
  /** zone bottom price */
  low: number;
  /** zone top price */
  high: number;
  /** which side this zone catches: 'above' = long stops + short entries above price */
  side: 'above' | 'below';
  /** swing time (ms) the zone is built around */
  swingTime: number;
  /** "above" zones came from swing highs; "below" from swing lows */
  sourcePrice: number;
};

export type StopClustersResult = {
  symbol: string;
  /** Zones above current price (where long-stops and short-entries sit). */
  above: StopCluster[];
  /** Zones below current price. */
  below: StopCluster[];
  fetchedAt: number;
};

const stopClusterCache = new Map<string, { data: StopClustersResult; ts: number }>();

/**
 * Detect swing highs/lows in 4H klines and mark a zone +/- 0.1-0.3% past
 * each swing as a likely stop-cluster. Two passes:
 *   - swing high: bar h such that bars[h-2..h-1] high < bar[h].high > bars[h+1..h+2].high
 *   - swing low: mirror
 * Zones are filtered to be near current price (within ±5%) and merged when overlapping.
 *
 * We use Binance klines (highest volume on most alts) when available, falling
 * back to Bybit. OKX kline integration is possible but not needed when we
 * already have two reliable sources.
 */
export async function getStopClusters(
  symbol: string,
  currentPrice: number,
): Promise<StopClustersResult | null> {
  const cached = stopClusterCache.get(symbol);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  // Try Binance first (deeper volume on most alts). If unavailable (regional
  // block / fstream issue), fall back to Bybit klines — same shape, same
  // algorithm works. Last resort: return null and let the LLM proceed without
  // stop-cluster context.
  let klines = await getBinanceKlines(symbol, '4h', 60).catch(() => null);
  if (!klines || klines.length < 10) {
    logger.debug({ symbol }, 'stop clusters: Binance klines unavailable, trying Bybit');
    klines = await getBybitKlines(symbol, '4h', 60).catch(() => null);
  }
  if (!klines || klines.length < 10) {
    return null;
  }

  // Sort oldest-first (Binance already does).
  klines = klines.filter((k) => Number.isFinite(k.high) && Number.isFinite(k.low));

  const swings: { side: 'high' | 'low'; price: number; time: number }[] = [];
  for (let i = 2; i < klines.length - 2; i++) {
    const k = klines[i]!;
    const k1 = klines[i - 1]!;
    const k2 = klines[i - 2]!;
    const k3 = klines[i + 1]!;
    const k4 = klines[i + 2]!;
    if (k.high > k1.high && k.high > k2.high && k.high > k3.high && k.high > k4.high) {
      swings.push({ side: 'high', price: k.high, time: k.start });
    } else if (k.low < k1.low && k.low < k2.low && k.low < k3.low && k.low < k4.low) {
      swings.push({ side: 'low', price: k.low, time: k.start });
    }
  }

  // Filter to near-price (within ±5%) and create zones.
  const above: StopCluster[] = [];
  const below: StopCluster[] = [];
  for (const s of swings) {
    const distPct = Math.abs((s.price - currentPrice) / currentPrice) * 100;
    if (distPct > 5) continue;
    if (s.side === 'high' && s.price > currentPrice) {
      // Stop zone: 0.1% past the swing
      above.push({
        low: Math.round(s.price * 1.001 * 1e6) / 1e6,
        high: Math.round(s.price * 1.003 * 1e6) / 1e6,
        side: 'above',
        swingTime: s.time,
        sourcePrice: s.price,
      });
    } else if (s.side === 'low' && s.price < currentPrice) {
      below.push({
        low: Math.round(s.price * 0.997 * 1e6) / 1e6,
        high: Math.round(s.price * 0.999 * 1e6) / 1e6,
        side: 'below',
        swingTime: s.time,
        sourcePrice: s.price,
      });
    }
  }

  // Merge overlapping zones (keep earliest swing time as anchor).
  const merge = (zones: StopCluster[]): StopCluster[] => {
    if (zones.length === 0) return [];
    const sorted = [...zones].sort((a, b) => a.low - b.low);
    const out: StopCluster[] = [sorted[0]!];
    for (let i = 1; i < sorted.length; i++) {
      const cur = sorted[i]!;
      const last = out[out.length - 1]!;
      if (cur.low <= last.high) {
        last.high = Math.max(last.high, cur.high);
        last.swingTime = Math.min(last.swingTime, cur.swingTime);
      } else {
        out.push(cur);
      }
    }
    return out;
  };

  const data: StopClustersResult = {
    symbol,
    above: merge(above)
      .sort((a, b) => a.low - b.low)
      .slice(0, 4),
    below: merge(below)
      .sort((a, b) => b.high - a.high)
      .slice(0, 4),
    fetchedAt: Date.now(),
  };
  stopClusterCache.set(symbol, { data, ts: Date.now() });
  return data;
}

// ============================================================
// Formatters for LLM prompt
// ============================================================

export function formatAggregatedSentiment(s: AggregatedSentiment | null): string {
  if (!s) return '  (multi-exchange sentiment unavailable)';
  const fmtFunding = (r: number | null) => (r === null ? 'n/a' : `${(r * 100).toFixed(4)}%`);
  const fmtPct = (n: number | null) => (n === null ? 'n/a' : `${n >= 0 ? '+' : ''}${n}%`);
  const fmtUsd = (n: number | null) => (n === null ? 'n/a' : `$${(n / 1e6).toFixed(1)}M`);

  const lines = [
    `  Funding (8h):    Bybit ${fmtFunding(s.perExchange.bybit?.fundingRate ?? null)}, Binance ${fmtFunding(s.perExchange.binance?.fundingRate ?? null)}, OKX ${fmtFunding(s.perExchange.okx?.fundingRate ?? null)}`,
    `    weighted by OI: ${fmtFunding(s.weightedFunding)} | divergence: ${fmtFunding(s.fundingDivergence)}`,
    `  OI 4h Δ:         Bybit ${fmtPct(s.bybitOiDelta4hPct)}, Binance ${fmtPct(s.binanceOiDelta4hPct)}`,
    `  Total OI:        ${fmtUsd(s.totalOiUsd)} (Bybit+Binance+OKX)`,
    `  L/S avg:         ${s.longShortRatio ?? 'n/a'}`,
    `  Binance vs Bybit price spread: ${fmtPct(s.binanceVsBybitSpreadPct)} (positive = Binance higher → leading up)`,
  ];
  return lines.join('\n');
}

export function formatAggregatedOrderbook(ob: AggregatedOrderbook | null): string {
  if (!ob) return '  (aggregated orderbook unavailable)';
  const fmtWall = (w: Wall) => {
    const conf = w.exchanges.length >= 2 ? ` ✓${w.exchanges.length}x` : ` (${w.exchanges[0]} only)`;
    const usdM = w.usd >= 1e6 ? `$${(w.usd / 1e6).toFixed(2)}M` : `$${(w.usd / 1e3).toFixed(0)}k`;
    return `    ${w.price} (${w.distancePct >= 0 ? '+' : ''}${w.distancePct}%): ${usdM}${conf}`;
  };

  const lines = [
    `  Mid: ${ob.midPrice}`,
    `  Top ask walls (above):`,
    ...(ob.topAskWalls.length > 0 ? ob.topAskWalls.map(fmtWall) : ['    (none significant)']),
    `  Top bid walls (below):`,
    ...(ob.topBidWalls.length > 0 ? ob.topBidWalls.map(fmtWall) : ['    (none significant)']),
    `  Bid/ask depth ratio (±2%): ${ob.bidAskRatio2pct ?? 'n/a'} ${
      ob.bidAskRatio2pct !== null && ob.bidAskRatio2pct < 0.85
        ? '← asks heavier (sellers pressing)'
        : ob.bidAskRatio2pct !== null && ob.bidAskRatio2pct > 1.15
          ? '← bids heavier (buyers absorbing)'
          : ''
    }`,
    `  Cross-exchange confirmed walls: ${ob.crossExchangeConfirmedCount} of ${ob.topAskWalls.length + ob.topBidWalls.length}`,
  ];
  return lines.join('\n');
}

export function formatStopClusters(sc: StopClustersResult | null): string {
  if (!sc) return '  (stop clusters unavailable)';
  const fmt = (z: StopCluster) =>
    `    ${z.low} – ${z.high}  (за ${z.side === 'above' ? 'свинг-хаем' : 'свинг-лоу'} ${z.sourcePrice} от ${new Date(z.swingTime).toISOString().slice(5, 16)})`;
  const lines = [
    `  Above price (long stops + short entries get hunted here):`,
    ...(sc.above.length > 0 ? sc.above.map(fmt) : ['    (none nearby)']),
    `  Below price (short stops + long entries):`,
    ...(sc.below.length > 0 ? sc.below.map(fmt) : ['    (none nearby)']),
  ];
  return lines.join('\n');
}
