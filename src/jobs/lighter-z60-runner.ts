import { request } from 'undici';
import { db } from '../db/client.js';
import {
  evaluateTrendFilteredZ60,
  evaluateVwz60,
  evaluateZ60,
  type Z60EntryMode,
  type Vwz60Bar,
} from '../lib/lighter-z60.js';
import { logger } from '../lib/logger.js';
import { queueLighterLuxalgoSignal } from '../strategies/lighter-luxalgo-lab.js';

const MINUTE_MS = 60_000;
const BAR_MS = 5 * MINUTE_MS;
const HISTORY_BARS = 66;
const TREND_HISTORY_BARS = 500;
const TIME_EXIT_BARS = 240;
// Lighter commonly publishes the fifth one-minute candle 15–25 seconds after
// the nominal 5m boundary. Waiting 25s avoids a guaranteed failed request while
// preserving the same effective evaluation time as the previous 15s retry.
const PUBLISH_GRACE_MS = 25_000;
const RETRY_MS = 15_000;

type RawCandle = {
  t?: unknown;
  o?: unknown;
  h?: unknown;
  l?: unknown;
  c?: unknown;
  v?: unknown;
};

type CandleResponse = {
  code?: unknown;
  message?: unknown;
  c?: RawCandle[];
};

type OpenRow = {
  side: 'long' | 'short';
  opened_at: number;
};

type LastClosedRow = {
  closed_at: number;
};

type NativeStrategy = {
  id: string;
  family: 'zscore' | 'vwz';
  mode: Z60EntryMode;
  threshold: number;
  trendFilter?: boolean;
};

type NativeFeed = {
  symbol: string;
  marketId: number;
  strategies: readonly NativeStrategy[];
};

const BASE_FEEDS: readonly NativeFeed[] = [
  {
    symbol: 'SOLUSDT',
    marketId: 2,
    strategies: [
      { id: 'sol-z60-reclaim', family: 'zscore', mode: 'reclaim', threshold: 3 },
      { id: 'sol-z60-touch', family: 'zscore', mode: 'touch', threshold: 3 },
    ],
  },
  {
    symbol: 'BNBUSDT',
    marketId: 25,
    strategies: [
      { id: 'bnb-z60-touch', family: 'zscore', mode: 'touch', threshold: 3 },
    ],
  },
  {
    symbol: 'LTCUSDT',
    marketId: 35,
    strategies: [
      { id: 'ltc-z60-touch', family: 'zscore', mode: 'touch', threshold: 2 },
    ],
  },
  {
    symbol: 'BTCUSDT',
    marketId: 1,
    strategies: [
      { id: 'btc-vwz60-touch', family: 'vwz', mode: 'touch', threshold: 3 },
    ],
  },
  {
    symbol: 'HYPEUSDT',
    marketId: 24,
    strategies: [
      { id: 'hype-vwz60-touch', family: 'vwz', mode: 'touch', threshold: 2.5 },
    ],
  },
];

const TREND_PORTFOLIO_FEEDS: readonly NativeFeed[] = [
  { symbol: 'BTCUSDT', marketId: 1, strategies: [{ id: 'z60t25-btc', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
  { symbol: 'ETHUSDT', marketId: 0, strategies: [{ id: 'z60t25-eth', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
  { symbol: 'SOLUSDT', marketId: 2, strategies: [{ id: 'z60t25-sol', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
  { symbol: 'BNBUSDT', marketId: 25, strategies: [{ id: 'z60t25-bnb', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
  { symbol: 'LTCUSDT', marketId: 35, strategies: [{ id: 'z60t25-ltc', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
  { symbol: 'HYPEUSDT', marketId: 24, strategies: [{ id: 'z60t25-hype', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
  { symbol: 'ZECUSDT', marketId: 90, strategies: [{ id: 'z60t25-zec', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
  { symbol: 'DOGEUSDT', marketId: 3, strategies: [{ id: 'z60t25-doge', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
  { symbol: 'NEARUSDT', marketId: 10, strategies: [{ id: 'z60t25-near', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
  { symbol: 'JUPUSDT', marketId: 26, strategies: [{ id: 'z60t25-jup', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
  { symbol: 'LITUSDT', marketId: 120, strategies: [{ id: 'z60t25-lit', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
  { symbol: 'GRAMUSDT', marketId: 12, strategies: [{ id: 'z60t25-gram', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
  { symbol: 'XMRUSDT', marketId: 77, strategies: [{ id: 'z60t25-xmr', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
  { symbol: 'ENAUSDT', marketId: 29, strategies: [{ id: 'z60t25-ena', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
  { symbol: 'TAOUSDT', marketId: 13, strategies: [{ id: 'z60t25-tao', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: true }] },
];

const feedByMarket = new Map<number, NativeFeed>();
for (const feed of [...BASE_FEEDS, ...TREND_PORTFOLIO_FEEDS]) {
  const existing = feedByMarket.get(feed.marketId);
  feedByMarket.set(feed.marketId, existing
    ? { ...existing, strategies: [...existing.strategies, ...feed.strategies] }
    : feed);
}
const FEEDS: readonly NativeFeed[] = [...feedByMarket.values()];

const openPosition = db.prepare<[string], OpenRow>(`
  SELECT side, opened_at
  FROM lighter_lux_trades
  WHERE strategy_id = ? AND closed_at IS NULL
  LIMIT 1`);

const lastClosed = db.prepare<[string], LastClosedRow>(`
  SELECT closed_at
  FROM lighter_lux_trades
  WHERE strategy_id = ? AND closed_at IS NOT NULL
  ORDER BY closed_at DESC
  LIMIT 1`);

let timer: ReturnType<typeof setInterval> | null = null;
let started = false;
let running = false;
const lastEvaluatedBars = new Map<string, number>();

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function targetCompletedBar(now: number): number {
  return Math.floor((now - PUBLISH_GRACE_MS) / BAR_MS) * BAR_MS - BAR_MS;
}

function aggregateCompleteFiveMinuteBars(
  raw: readonly RawCandle[],
  latestBarTime: number,
): Vwz60Bar[] {
  const buckets = new Map<number, {
    candles: Map<number, { close: number; volume: number }>;
  }>();

  for (const candle of raw) {
    const time = finite(candle.t);
    const close = finite(candle.c);
    // Lighter omits zero-valued fields from candle responses. A missing `v`
    // therefore means zero volume, not a missing minute.
    const volume = finite(candle.v) ?? 0;
    if (
      time == null
      || close == null
      || close <= 0
      || volume < 0
      || time % MINUTE_MS !== 0
    ) continue;
    const bucket = Math.floor(time / BAR_MS) * BAR_MS;
    if (bucket > latestBarTime) continue;
    const state = buckets.get(bucket) ?? {
      candles: new Map<number, { close: number; volume: number }>(),
    };
    state.candles.set(time, { close, volume });
    buckets.set(bucket, state);
  }

  return [...buckets.entries()]
    .filter(([bucket, state]) => {
      if (state.candles.size !== 5) return false;
      for (let offset = 0; offset < 5; offset += 1) {
        if (!state.candles.has(bucket + offset * MINUTE_MS)) return false;
      }
      return true;
    })
    .sort(([a], [b]) => a - b)
    .map(([time, state]) => ({
      time,
      close: state.candles.get(time + 4 * MINUTE_MS)!.close,
      volume: [...state.candles.values()].reduce((total, candle) => total + candle.volume, 0),
    }));
}

async function fetchBars(latestBarTime: number, marketId: number): Promise<Vwz60Bar[]> {
  const start = latestBarTime - (HISTORY_BARS - 1) * BAR_MS;
  // Lighter treats end_timestamp as exclusive, so request the boundary after
  // the fifth one-minute candle rather than the final candle's own timestamp.
  const end = latestBarTime + BAR_MS;
  const url = new URL('https://mainnet.zklighter.elliot.ai/api/v1/candles');
  url.searchParams.set('market_id', String(marketId));
  url.searchParams.set('resolution', '1m');
  url.searchParams.set('start_timestamp', String(start));
  url.searchParams.set('end_timestamp', String(end));
  // Lighter currently defaults count_back=0 to a short 10-candle response,
  // which is insufficient to reconstruct the 60 completed five-minute bars.
  // Request the documented maximum explicitly; start/end still bound the
  // response to the exact history window used by the evaluator.
  url.searchParams.set('count_back', '500');
  url.searchParams.set('set_timestamp_to_end', 'false');

  const response = await request(url, {
    headersTimeout: 8_000,
    bodyTimeout: 8_000,
  });
  const body = await response.body.json() as CandleResponse;
  if (Number(body.code) !== 200) {
    throw new Error(`candles_${String(body.code)}:${String(body.message ?? 'unknown')}`);
  }
  const bars = aggregateCompleteFiveMinuteBars(body.c ?? [], latestBarTime);
  if (bars.at(-1)?.time !== latestBarTime) throw new Error('latest_completed_bar_missing');
  return bars;
}

async function fetchTrendBars(
  latestBarTime: number,
  marketId: number,
): Promise<Vwz60Bar[]> {
  const start = latestBarTime - (TREND_HISTORY_BARS - 1) * BAR_MS;
  const url = new URL('https://mainnet.zklighter.elliot.ai/api/v1/candles');
  url.searchParams.set('market_id', String(marketId));
  url.searchParams.set('resolution', '5m');
  url.searchParams.set('start_timestamp', String(start));
  url.searchParams.set('end_timestamp', String(latestBarTime + BAR_MS));
  url.searchParams.set('count_back', String(TREND_HISTORY_BARS));
  url.searchParams.set('set_timestamp_to_end', 'false');

  const response = await request(url, {
    headersTimeout: 8_000,
    bodyTimeout: 8_000,
  });
  const body = await response.body.json() as CandleResponse;
  if (Number(body.code) !== 200) {
    throw new Error(`trend_candles_${String(body.code)}:${String(body.message ?? 'unknown')}`);
  }
  const unique = new Map<number, Vwz60Bar>();
  for (const candle of body.c ?? []) {
    const time = finite(candle.t);
    const close = finite(candle.c);
    const volume = finite(candle.v) ?? 0;
    if (
      time == null
      || close == null
      || close <= 0
      || volume < 0
      || time % BAR_MS !== 0
      || time > latestBarTime
    ) continue;
    unique.set(time, { time, close, volume });
  }
  const bars = [...unique.values()].sort((a, b) => a.time - b.time);
  if (bars.length < TREND_HISTORY_BARS || bars.at(-1)?.time !== latestBarTime) {
    throw new Error('trend_history_incomplete');
  }
  const warmup = bars.slice(-TREND_HISTORY_BARS);
  for (let index = 1; index < warmup.length; index += 1) {
    if (warmup[index]!.time - warmup[index - 1]!.time !== BAR_MS) {
      throw new Error('trend_history_gap');
    }
  }
  return bars;
}

function emit(
  strategy: NativeStrategy,
  symbol: string,
  action: 'entry' | 'exit',
  side: 'long' | 'short',
  barTime: number,
  price: number,
): void {
  queueLighterLuxalgoSignal({
    kind: 'strategy',
    strategy_id: strategy.id,
    action,
    side,
    strategy_event: action === 'entry' ? side : `exit_${side}`,
    symbol,
    timeframe: '5',
    price,
    bar_time: barTime,
  });
}

async function poll(): Promise<void> {
  if (running) return;
  const target = targetCompletedBar(Date.now());
  running = true;
  try {
    for (const feed of FEEDS) {
      const pending = feed.strategies.filter(
        (strategy) => target > (lastEvaluatedBars.get(strategy.id) ?? 0),
      );
      if (!pending.length) continue;
      let baseBars: Vwz60Bar[] | null = null;
      let trendBars: Vwz60Bar[] | null = null;

      if (pending.some((strategy) => !strategy.trendFilter)) {
        try {
          baseBars = await fetchBars(target, feed.marketId);
        } catch (error) {
          logger.warn({
            error: (error as Error).message,
            target,
            symbol: feed.symbol,
            marketId: feed.marketId,
            source: '1m-aggregate',
          }, 'lighter-z60: market poll failed');
        }
      }
      if (pending.some((strategy) => strategy.trendFilter)) {
        try {
          trendBars = await fetchTrendBars(target, feed.marketId);
        } catch (error) {
          logger.warn({
            error: (error as Error).message,
            target,
            symbol: feed.symbol,
            marketId: feed.marketId,
            source: 'native-5m-trend',
          }, 'lighter-z60: market poll failed');
        }
      }

      for (const strategy of pending) {
        const strategyBars = strategy.trendFilter ? trendBars : baseBars;
        if (!strategyBars) continue;
        try {
          const snapshot = strategy.trendFilter
            ? evaluateTrendFilteredZ60(
              strategyBars,
              60,
              strategy.threshold,
              strategy.mode,
              200,
            )
            : strategy.family === 'vwz'
            ? evaluateVwz60(strategyBars, 60, strategy.threshold, strategy.mode)
            : evaluateZ60(strategyBars, 60, strategy.threshold, strategy.mode);
          if (!snapshot) throw new Error('z60_history_incomplete');

          const open = openPosition.get(strategy.id);
          if (open) {
            const meanExit = open.side === 'long'
              ? snapshot.close >= snapshot.mean
              : snapshot.close <= snapshot.mean;
            const timeExit = target + BAR_MS - open.opened_at >= TIME_EXIT_BARS * BAR_MS;
            if (meanExit || timeExit) {
              emit(strategy, feed.symbol, 'exit', open.side, target, snapshot.close);
              logger.info({
                strategyId: strategy.id,
                symbol: feed.symbol,
                side: open.side,
                barTime: target,
                close: snapshot.close,
                mean: snapshot.mean,
                reason: meanExit
                  ? strategy.family === 'vwz' ? 'vwma60_cross' : 'sma60_cross'
                  : 'time_240_bars',
              }, 'lighter-z60: native exit signal');
            }
            lastEvaluatedBars.set(strategy.id, target);
            continue;
          }

          // A protective stop that filled during this same completed candle
          // must not be followed by an immediate same-bar re-entry.
          const closed = lastClosed.get(strategy.id);
          if (closed && Math.floor(closed.closed_at / BAR_MS) * BAR_MS === target) {
            lastEvaluatedBars.set(strategy.id, target);
            continue;
          }

          if (snapshot.signal) {
            emit(strategy, feed.symbol, 'entry', snapshot.signal, target, snapshot.close);
            logger.info({
              strategyId: strategy.id,
              symbol: feed.symbol,
              family: strategy.family,
              mode: strategy.mode,
              threshold: strategy.threshold,
              side: snapshot.signal,
              barTime: target,
              close: snapshot.close,
              previousZ: snapshot.previousZ,
              currentZ: snapshot.currentZ,
              trendMean: snapshot.trendMean,
            }, 'lighter-z60: native entry signal');
          }
          lastEvaluatedBars.set(strategy.id, target);
        } catch (error) {
          logger.warn({
            error: (error as Error).message,
            target,
            symbol: feed.symbol,
            marketId: feed.marketId,
            strategyId: strategy.id,
          }, 'lighter-z60: strategy evaluation failed');
        }
      }
    }
  } finally {
    running = false;
  }
}

export function startLighterZ60Runner(): void {
  if (started) return;
  started = true;
  logger.info({
    strategies: FEEDS.flatMap((feed) => feed.strategies.map((strategy) => ({
      id: strategy.id,
      symbol: feed.symbol,
      family: strategy.family,
      mode: strategy.mode,
      threshold: strategy.threshold,
      trendFilter: strategy.trendFilter ?? false,
    }))),
    timeframe: '5m',
    commissionPct: 0,
  }, 'lighter-z60: native shadow runner scheduled');
  const initial = setTimeout(() => void poll(), 5_000);
  initial.unref();
  timer = setInterval(() => void poll(), RETRY_MS);
  timer.unref();
}
