/**
 * Read-only Hyperliquid <-> Bybit USDT perpetual arbitrage scanner.
 *
 * No credentials and no order placement. It compares matched contract units,
 * then validates shortlisted opportunities against executable order-book VWAP.
 *
 * Usage:
 *   pnpm tsx scripts/scan-hl-bybit-arb.ts [notionalUsd] [minNetPct]
 *   bun scripts/scan-hl-bybit-arb.ts 1000 1
 */

/* eslint-disable no-console -- operator CLI intentionally prints a market scan */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HL_INFO = 'https://api.hyperliquid.xyz/info';
const BYBIT_API = 'https://api.bybit.com';
const HL_TAKER_SIDE_PCT = 0.045;
const BYBIT_TAKER_SIDE_PCT = 0.055;
const ROUND_TRIP_FEES_PCT = 2 * (HL_TAKER_SIDE_PCT + BYBIT_TAKER_SIDE_PCT);
const EXECUTION_BUFFER_PCT = 0.05;
const COLLATERAL_BUFFER_PCT = 0.03;
const FUNDING_BASIS_RISK_BUFFER_PCT = 0.25;
const MAX_BOOK_SKEW_MS = 2_000;
const BOOK_CONCURRENCY = 6;
const BOOK_SHORTLIST = 50;

type HlAsset = { name: string; maxLeverage?: number; isDelisted?: boolean };
type HlCtx = {
  funding: string;
  markPx?: string;
  midPx?: string;
  dayNtlVlm?: string;
};
type HlMeta = [{ universe: HlAsset[] }, HlCtx[]];
type HlLevel = { px: string; sz: string; n: number };
type HlBook = { coin: string; time: number; levels: [HlLevel[], HlLevel[]] };

type BybitTicker = {
  symbol: string;
  bid1Price: string;
  ask1Price: string;
  fundingRate?: string;
  fundingIntervalHour?: string;
  turnover24h?: string;
};
type BybitInstrument = {
  symbol: string;
  status: string;
  contractType?: string;
  settleCoin?: string;
  fundingInterval?: number;
  leverageFilter?: { maxLeverage?: string };
};
type BybitBook = { ts: number; b: [string, string][]; a: [string, string][] };

export type NumericLevel = { price: number; qty: number };
export type ArbDirection = 'LONG HL / SHORT BY' | 'LONG BY / SHORT HL';
export type ArbMarket = {
  asset: string;
  hlCoin: string;
  bybitSymbol: string;
  hlUnit: number;
  bybitUnit: number;
  hlMid: number;
  bybitMid: number;
  hlFundingHourly: number;
  bybitFundingHourly: number;
  hlMaxLeverage: number;
  bybitMaxLeverage: number;
  basisMidPct: number;
  funding24Pct: number;
};
export type ArbOpportunity = ArbMarket & {
  bookSkewMs: number;
  grossBasisPct: number;
  basisNetPct: number;
  basisNet8hPct: number;
  basisDirection: ArbDirection;
  fundingNet24Pct: number;
  fundingDirection: ArbDirection;
  basisCloseCostPct: number;
  basisTotalCostPct: number;
  fundingCloseCostPct: number;
  fundingTotalCostPct: number;
  maxCommonLeverage: number;
  targetUnderlyingQty: number;
  hlBuyPx: number;
  hlSellPx: number;
  bybitBuyPx: number;
  bybitSellPx: number;
};

export type ArbScanResult = {
  ts: number;
  notionalUsd: number;
  minNetPct: number;
  matchedMarkets: number;
  checkedBooks: number;
  requestedBooks: number;
  durationMs: number;
  basis: ArbOpportunity[];
  funding: ArbOpportunity[];
  qualifiedBasis: ArbOpportunity[];
  qualifiedFunding: ArbOpportunity[];
};

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return await response.json() as T;
}

async function hlInfo<T>(body: Record<string, unknown>): Promise<T> {
  return getJson<T>(HL_INFO, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function bybitTickers(): Promise<BybitTicker[]> {
  const body = await getJson<{ retCode: number; retMsg: string; result?: { list?: BybitTicker[] } }>(
    `${BYBIT_API}/v5/market/tickers?category=linear`,
  );
  if (body.retCode !== 0) throw new Error(`Bybit tickers: ${body.retMsg}`);
  return body.result?.list ?? [];
}

async function bybitInstruments(): Promise<BybitInstrument[]> {
  const instruments: BybitInstrument[] = [];
  let cursor = '';
  do {
    const query = new URLSearchParams({ category: 'linear', limit: '1000' });
    if (cursor) query.set('cursor', cursor);
    const body = await getJson<{
      retCode: number;
      retMsg: string;
      result?: { list?: BybitInstrument[]; nextPageCursor?: string };
    }>(`${BYBIT_API}/v5/market/instruments-info?${query}`);
    if (body.retCode !== 0) throw new Error(`Bybit instruments: ${body.retMsg}`);
    instruments.push(...(body.result?.list ?? []));
    cursor = body.result?.nextPageCursor ?? '';
  } while (cursor);
  return instruments;
}

function hlAssetUnit(coin: string): { asset: string; unit: number } {
  return /^k[A-Z0-9]/.test(coin) ? { asset: coin.slice(1), unit: 1_000 } : { asset: coin, unit: 1 };
}

function bybitUnitCandidates(asset: string): Array<{ symbol: string; unit: number }> {
  return [
    { symbol: `${asset}USDT`, unit: 1 },
    { symbol: `1000${asset}USDT`, unit: 1_000 },
    { symbol: `10000${asset}USDT`, unit: 10_000 },
    { symbol: `1000000${asset}USDT`, unit: 1_000_000 },
  ];
}

function midFromTicker(ticker: BybitTicker): number | null {
  const bid = finite(ticker.bid1Price);
  const ask = finite(ticker.ask1Price);
  return bid != null && ask != null && bid > 0 && ask >= bid ? (bid + ask) / 2 : null;
}

function buildMarkets(meta: HlMeta, tickers: BybitTicker[], instruments: BybitInstrument[]): ArbMarket[] {
  const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
  const instrumentBySymbol = new Map(instruments
    .filter((instrument) => instrument.status === 'Trading'
      && instrument.contractType === 'LinearPerpetual'
      && instrument.settleCoin === 'USDT')
    .map((instrument) => [instrument.symbol, instrument]));
  const markets: ArbMarket[] = [];

  for (let index = 0; index < meta[0].universe.length; index += 1) {
    const hlAsset = meta[0].universe[index]!;
    const ctx = meta[1][index];
    const hlContractMid = finite(ctx?.midPx ?? ctx?.markPx);
    const hlFundingHourly = finite(ctx?.funding);
    if (hlAsset.isDelisted || hlContractMid == null || hlContractMid <= 0 || hlFundingHourly == null) continue;
    const normalized = hlAssetUnit(hlAsset.name);

    let best: { ticker: BybitTicker; instrument: BybitInstrument; unit: number; mid: number; distance: number } | null = null;
    for (const candidate of bybitUnitCandidates(normalized.asset)) {
      const ticker = tickerBySymbol.get(candidate.symbol);
      const instrument = instrumentBySymbol.get(candidate.symbol);
      const bybitContractMid = ticker ? midFromTicker(ticker) : null;
      if (!ticker || !instrument || bybitContractMid == null) continue;
      const hlUnderlyingMid = hlContractMid / normalized.unit;
      const bybitUnderlyingMid = bybitContractMid / candidate.unit;
      const distance = Math.abs(Math.log(bybitUnderlyingMid / hlUnderlyingMid));
      if (distance <= Math.log(1.15) && (!best || distance < best.distance)) {
        best = { ticker, instrument, unit: candidate.unit, mid: bybitContractMid, distance };
      }
    }
    if (!best) continue;

    const fundingIntervalHours = Math.max(
      1,
      Number(best.ticker.fundingIntervalHour)
        || Number(best.instrument.fundingInterval ?? 480) / 60,
    );
    const bybitFundingHourly = (finite(best.ticker.fundingRate) ?? 0) / fundingIntervalHours;
    const hlUnderlyingMid = hlContractMid / normalized.unit;
    const bybitUnderlyingMid = best.mid / best.unit;
    const averageMid = (hlUnderlyingMid + bybitUnderlyingMid) / 2;
    markets.push({
      asset: normalized.asset,
      hlCoin: hlAsset.name,
      bybitSymbol: best.ticker.symbol,
      hlUnit: normalized.unit,
      bybitUnit: best.unit,
      hlMid: hlContractMid,
      bybitMid: best.mid,
      hlFundingHourly,
      bybitFundingHourly,
      hlMaxLeverage: Number(hlAsset.maxLeverage ?? 1),
      bybitMaxLeverage: Number(best.instrument.leverageFilter?.maxLeverage ?? 1),
      basisMidPct: Math.abs(bybitUnderlyingMid - hlUnderlyingMid) / averageMid * 100,
      funding24Pct: Math.abs(bybitFundingHourly - hlFundingHourly) * 24 * 100,
    });
  }
  return markets;
}

async function bybitBook(symbol: string): Promise<BybitBook> {
  const body = await getJson<{ retCode: number; retMsg: string; result?: BybitBook }>(
    `${BYBIT_API}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=50`,
  );
  if (body.retCode !== 0 || !body.result) throw new Error(`Bybit book ${symbol}: ${body.retMsg}`);
  return body.result;
}

function levels(raw: Array<{ px: string; sz: string }> | [string, string][]): NumericLevel[] {
  return raw.map((level) => Array.isArray(level)
    ? { price: Number(level[0]), qty: Number(level[1]) }
    : { price: Number(level.px), qty: Number(level.sz) })
    .filter((level) => level.price > 0 && level.qty > 0 && Number.isFinite(level.price) && Number.isFinite(level.qty));
}

export function vwap(bookLevels: NumericLevel[], targetQty: number): number | null {
  let remaining = targetQty;
  let value = 0;
  for (const level of bookLevels) {
    const quantity = Math.min(remaining, level.qty);
    value += quantity * level.price;
    remaining -= quantity;
    if (remaining <= targetQty * 1e-9) return value / targetQty;
  }
  return null;
}

export function estimatedRoundTripCostPct(closeCrossPct: number): number {
  return ROUND_TRIP_FEES_PCT + closeCrossPct + EXECUTION_BUFFER_PCT + COLLATERAL_BUFFER_PCT;
}

export function estimatedBasisNetPct(grossBasisPct: number, closeCrossPct: number): number {
  return grossBasisPct - estimatedRoundTripCostPct(closeCrossPct);
}

export function estimatedFundingNetPct(fundingCarryPct: number, closeCrossPct: number): number {
  return fundingCarryPct - estimatedRoundTripCostPct(closeCrossPct) - FUNDING_BASIS_RISK_BUFFER_PCT;
}

/** Two equal delta-neutral legs each consume notional/leverage margin. */
export function totalMarginRoiPct(netNotionalPct: number, leverage: number): number {
  return netNotionalPct * leverage / 2;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function evaluateArbMarket(market: ArbMarket, notionalUsd: number): Promise<ArbOpportunity | null> {
  try {
    const [hlBook, byBook] = await Promise.all([
      hlInfo<HlBook>({ type: 'l2Book', coin: market.hlCoin }),
      bybitBook(market.bybitSymbol),
    ]);
    const bookSkewMs = Math.abs(hlBook.time - byBook.ts);
    if (bookSkewMs > MAX_BOOK_SKEW_MS) return null;

    const hlBids = levels(hlBook.levels[0]);
    const hlAsks = levels(hlBook.levels[1]);
    const byBids = levels(byBook.b);
    const byAsks = levels(byBook.a);
    const hlBestBid = hlBids[0]?.price;
    const hlBestAsk = hlAsks[0]?.price;
    const byBestBid = byBids[0]?.price;
    const byBestAsk = byAsks[0]?.price;
    if (!(hlBestBid && hlBestAsk && byBestBid && byBestAsk)) return null;

    const underlyingMid = ((hlBestBid + hlBestAsk) / 2 / market.hlUnit
      + (byBestBid + byBestAsk) / 2 / market.bybitUnit) / 2;
    const underlyingQty = notionalUsd / underlyingMid;
    const hlQty = underlyingQty / market.hlUnit;
    const byQty = underlyingQty / market.bybitUnit;
    const hlBuy = vwap(hlAsks, hlQty);
    const hlSell = vwap(hlBids, hlQty);
    const byBuy = vwap(byAsks, byQty);
    const bySell = vwap(byBids, byQty);
    if (hlBuy == null || hlSell == null || byBuy == null || bySell == null) return null;

    const hlBuyUnderlying = hlBuy / market.hlUnit;
    const hlSellUnderlying = hlSell / market.hlUnit;
    const byBuyUnderlying = byBuy / market.bybitUnit;
    const bySellUnderlying = bySell / market.bybitUnit;
    const longHlGross = (bySellUnderlying - hlBuyUnderlying) / underlyingMid * 100;
    const longByGross = (hlSellUnderlying - byBuyUnderlying) / underlyingMid * 100;
    const longHlCarryHourly = market.bybitFundingHourly - market.hlFundingHourly;
    const longByCarryHourly = -longHlCarryHourly;
    const basisLongHl = longHlGross >= longByGross;
    const grossBasisPct = basisLongHl ? longHlGross : longByGross;
    const basisCarryHourly = basisLongHl ? longHlCarryHourly : longByCarryHourly;
    const fundingLongHl = longHlCarryHourly >= 0;
    const fundingHourly = Math.abs(longHlCarryHourly);
    const hlUnderlyingBookMid = (hlBestBid + hlBestAsk) / 2 / market.hlUnit;
    const byUnderlyingBookMid = (byBestBid + byBestAsk) / 2 / market.bybitUnit;
    const longHlCloseCostPct = (
      (hlUnderlyingBookMid - hlSellUnderlying) + (byBuyUnderlying - byUnderlyingBookMid)
    ) / underlyingMid * 100;
    const longByCloseCostPct = (
      (byUnderlyingBookMid - bySellUnderlying) + (hlBuyUnderlying - hlUnderlyingBookMid)
    ) / underlyingMid * 100;
    const basisCloseCostPct = basisLongHl ? longHlCloseCostPct : longByCloseCostPct;
    const fundingCloseCostPct = fundingLongHl ? longHlCloseCostPct : longByCloseCostPct;
    const basisTotalCostPct = estimatedRoundTripCostPct(basisCloseCostPct);
    const fundingTotalCostPct = estimatedRoundTripCostPct(fundingCloseCostPct);

    return {
      ...market,
      bookSkewMs,
      grossBasisPct,
      basisNetPct: estimatedBasisNetPct(grossBasisPct, basisCloseCostPct),
      basisNet8hPct: estimatedBasisNetPct(grossBasisPct, basisCloseCostPct) + basisCarryHourly * 8 * 100,
      basisDirection: basisLongHl ? 'LONG HL / SHORT BY' : 'LONG BY / SHORT HL',
      fundingNet24Pct: estimatedFundingNetPct(fundingHourly * 24 * 100, fundingCloseCostPct),
      fundingDirection: fundingLongHl ? 'LONG HL / SHORT BY' : 'LONG BY / SHORT HL',
      basisCloseCostPct,
      basisTotalCostPct,
      fundingCloseCostPct,
      fundingTotalCostPct,
      maxCommonLeverage: Math.min(market.hlMaxLeverage, market.bybitMaxLeverage),
      targetUnderlyingQty: underlyingQty,
      hlBuyPx: hlBuy,
      hlSellPx: hlSell,
      bybitBuyPx: byBuy,
      bybitSellPx: bySell,
    };
  } catch {
    return null;
  }
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`;
}

function printOpportunity(opportunity: ArbOpportunity, kind: 'basis' | 'funding'): void {
  const net = kind === 'basis' ? opportunity.basisNetPct : opportunity.fundingNet24Pct;
  const direction = kind === 'basis' ? opportunity.basisDirection : opportunity.fundingDirection;
  const cost = kind === 'basis' ? opportunity.basisTotalCostPct : opportunity.fundingTotalCostPct;
  const roi3x = totalMarginRoiPct(net, 3);
  const lead = kind === 'basis'
    ? `gross ${signed(opportunity.grossBasisPct)} · net ${signed(net)} · net8h ${signed(opportunity.basisNet8hPct)}`
    : `carry24 ${signed(opportunity.funding24Pct)} · projected net ${signed(net)}`;
  console.log(
    `${opportunity.asset.padEnd(12)} ${direction.padEnd(20)} ${lead} · total-margin ROI@3x ${signed(roi3x)} `
    + `· cost ${cost.toFixed(3)}% · skew ${opportunity.bookSkewMs}ms · maxLev ${opportunity.maxCommonLeverage}x`,
  );
}

function compact(opportunity: ArbOpportunity): Record<string, string | number> {
  return {
    asset: opportunity.asset,
    basisDirection: opportunity.basisDirection,
    grossBasisPct: Number(opportunity.grossBasisPct.toFixed(4)),
    basisNetPct: Number(opportunity.basisNetPct.toFixed(4)),
    basisNet8hPct: Number(opportunity.basisNet8hPct.toFixed(4)),
    fundingDirection: opportunity.fundingDirection,
    funding24Pct: Number(opportunity.funding24Pct.toFixed(4)),
    fundingNet24Pct: Number(opportunity.fundingNet24Pct.toFixed(4)),
    basisCostPct: Number(opportunity.basisTotalCostPct.toFixed(4)),
    fundingCostPct: Number(opportunity.fundingTotalCostPct.toFixed(4)),
    bookSkewMs: opportunity.bookSkewMs,
    maxCommonLeverage: opportunity.maxCommonLeverage,
  };
}

export async function scanArbitrage(notionalUsd = 1_000, minNetPct = 1): Promise<ArbScanResult> {
  notionalUsd = Math.max(10, notionalUsd);
  minNetPct = Math.max(0, minNetPct);
  const startedAt = Date.now();
  const [meta, tickers, instruments] = await Promise.all([
    hlInfo<HlMeta>({ type: 'metaAndAssetCtxs' }),
    bybitTickers(),
    bybitInstruments(),
  ]);
  const markets = buildMarkets(meta, tickers, instruments);
  const shortlist = [...markets]
    .sort((a, b) => Math.max(b.basisMidPct, b.funding24Pct) - Math.max(a.basisMidPct, a.funding24Pct))
    .slice(0, BOOK_SHORTLIST);
  const opportunities = (await mapLimit(shortlist, BOOK_CONCURRENCY, (market) => evaluateArbMarket(market, notionalUsd)))
    .filter((opportunity): opportunity is ArbOpportunity => opportunity != null);
  const basis = [...opportunities].sort((a, b) => b.basisNetPct - a.basisNetPct);
  const funding = [...opportunities].sort((a, b) => b.fundingNet24Pct - a.fundingNet24Pct);
  const qualifiedBasis = basis.filter((opportunity) => opportunity.basisNetPct >= minNetPct);
  const qualifiedFunding = funding.filter((opportunity) => opportunity.fundingNet24Pct >= minNetPct);
  const completedAt = Date.now();

  return {
    ts: completedAt,
    notionalUsd,
    minNetPct,
    matchedMarkets: markets.length,
    checkedBooks: opportunities.length,
    requestedBooks: shortlist.length,
    durationMs: completedAt - startedAt,
    basis,
    funding,
    qualifiedBasis,
    qualifiedFunding,
  };
}

export async function runScan(args = process.argv.slice(2)): Promise<void> {
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const json = args.includes('--json');
  const scan = await scanArbitrage(Number(positional[0] ?? 1_000), Number(positional[1] ?? 1));

  if (json) {
    console.log(JSON.stringify({
      ts: scan.ts,
      notionalUsd: scan.notionalUsd,
      minNetPct: scan.minNetPct,
      matchedMarkets: scan.matchedMarkets,
      checkedBooks: scan.checkedBooks,
      requestedBooks: scan.requestedBooks,
      durationMs: scan.durationMs,
      topBasis: scan.basis.slice(0, 3).map(compact),
      topFunding: scan.funding.slice(0, 3).map(compact),
      qualifiedBasis: scan.qualifiedBasis.map(compact),
      qualifiedFunding: scan.qualifiedFunding.map(compact),
    }));
    return;
  }

  console.log(`\nHL <-> Bybit perpetual arb scan @ ${new Date(scan.ts).toISOString()}`);
  console.log(
    `matched ${scan.matchedMarkets} markets · checked ${scan.checkedBooks}/${scan.requestedBooks} books · target $${scan.notionalUsd.toFixed(0)} per leg `
    + `· fees ${ROUND_TRIP_FEES_PCT.toFixed(3)}% RT · threshold ${scan.minNetPct.toFixed(2)}% net · ${scan.durationMs}ms`,
  );
  console.log('\nBASIS: assumes the cross-venue spread converges; current funding is shown only for an 8h sensitivity.');
  for (const opportunity of scan.basis.slice(0, 10)) printOpportunity(opportunity, 'basis');
  console.log('\nFUNDING: 24h projection assumes the current rate differential persists; includes a 0.25% basis-risk buffer.');
  for (const opportunity of scan.funding.slice(0, 10)) printOpportunity(opportunity, 'funding');
  console.log(`\nQUALIFIED >= ${scan.minNetPct.toFixed(2)}% net: basis ${scan.qualifiedBasis.length}, funding ${scan.qualifiedFunding.length}`);
  for (const opportunity of scan.qualifiedBasis) printOpportunity(opportunity, 'basis');
  for (const opportunity of scan.qualifiedFunding) printOpportunity(opportunity, 'funding');
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) await runScan();
