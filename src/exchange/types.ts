import type { Exchange } from './symbols.js';

/**
 * Normalized cross-exchange shapes. Each exchange adapter returns these so
 * the multi-exchange aggregator doesn't need to know per-API quirks.
 *
 * All numeric fields use base-coin units (volume, openInterest) or USD
 * (turnover, openInterestUsd). Funding rate is fractional (0.0001 = 0.01%).
 */

export type ExchangeTicker = {
  exchange: Exchange;
  /** canonical symbol (e.g. TONUSDT) */
  symbol: string;
  lastPrice: number;
  /** funding rate for next 8h window; null if unsupported/unfetched */
  fundingRate: number | null;
  /** open interest in base coin units */
  openInterest: number | null;
  /** open interest in USD (price × OI) */
  openInterestUsd: number | null;
  /** percent price change over last 24h, side-agnostic (raw) */
  priceChange24hPct: number | null;
  fetchedAt: number;
};

export type OrderbookLevel = {
  price: number;
  /** quantity in base-coin units */
  qty: number;
  /** notional in USD (price × qty) */
  usd: number;
};

export type ExchangeOrderbook = {
  exchange: Exchange;
  symbol: string;
  /** mid price = (bestBid + bestAsk) / 2 */
  midPrice: number;
  /** sorted descending by price (best bid first) */
  bids: OrderbookLevel[];
  /** sorted ascending by price (best ask first) */
  asks: OrderbookLevel[];
  fetchedAt: number;
};

export type ExchangeKline = {
  /** bar open time, ms */
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** volume in base-coin units */
  volume: number;
  /** turnover in USD (price × volume) */
  turnover: number;
};

export type OiHistoryPoint = {
  ts: number;
  /** open interest in base-coin units (or contracts — exchange dependent;
   *  delta calculations are scale-invariant) */
  openInterest: number;
};

export type LongShortRatio = {
  exchange: Exchange;
  symbol: string;
  /** ratio of long accounts to short accounts, e.g. 1.5 = 60% long */
  ratio: number;
  fetchedAt: number;
};
