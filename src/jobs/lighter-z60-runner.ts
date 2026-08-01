import { request } from 'undici';
import { db } from '../db/client.js';
import { setRuntimeConfig } from '../db/repos/runtime-config.js';
import {
  LIGHTER_NATIVE_RUNNER_STATUS_KEY,
  nativeWaitingReason,
  type NativeRunnerEvaluation,
  type NativeRunnerStatus,
} from '../lib/lighter-native-runner-status.js';
import {
  allowsEntryByEfficiency,
  efficiencyRatio,
  evaluateTrendFilteredZ60,
  evaluateTrendStackZ60,
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
// EMA400 needs substantially more than one period of warmup. A 500-bar seed
// produced a live trend-side mismatch on LIT; 1,500 bars matched the full
// 180-day calculation on all 15 portfolio markets.
const TREND_HISTORY_BARS = 1_500;
const TREND_PAGE_BARS = 500;
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
  efficiencyMax?: number;
  trendFilter?: 'ema200' | 'ema200_400';
};

type NativeFeed = {
  symbol: string;
  marketId: number;
  strategies: readonly NativeStrategy[];
};

const BASE_FEEDS: readonly NativeFeed[] = [
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
  {
    symbol: 'XRPUSDT',
    marketId: 7,
    strategies: [
      { id: 'xrp-vwz60-touch', family: 'vwz', mode: 'touch', threshold: 3 },
    ],
  },
  {
    symbol: 'XLMUSDT',
    marketId: 119,
    strategies: [
      {
        id: 'xlm-vwz60-touch-er25',
        family: 'vwz',
        mode: 'touch',
        threshold: 3,
        efficiencyMax: 0.25,
      },
    ],
  },
  {
    symbol: 'DATAUSDT',
    marketId: 34,
    strategies: [
      { id: 'data-vwz60-touch', family: 'vwz', mode: 'touch', threshold: 2.5 },
    ],
  },
];

const TREND_PORTFOLIO_FEEDS: readonly NativeFeed[] = [
  { symbol: 'BTCUSDT', marketId: 1, strategies: [{ id: 'z60stack25-btc', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
  { symbol: 'ETHUSDT', marketId: 0, strategies: [{ id: 'z60stack25-eth', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
  { symbol: 'SOLUSDT', marketId: 2, strategies: [{ id: 'z60stack25-sol', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
  { symbol: 'BNBUSDT', marketId: 25, strategies: [{ id: 'z60stack25-bnb', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
  { symbol: 'LTCUSDT', marketId: 35, strategies: [{ id: 'z60stack25-ltc', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
  { symbol: 'HYPEUSDT', marketId: 24, strategies: [{ id: 'z60stack25-hype', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
  { symbol: 'ZECUSDT', marketId: 90, strategies: [{ id: 'z60stack25-zec', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
  { symbol: 'DOGEUSDT', marketId: 3, strategies: [{ id: 'z60stack25-doge', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
  { symbol: 'NEARUSDT', marketId: 10, strategies: [{ id: 'z60stack25-near', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
  { symbol: 'JUPUSDT', marketId: 26, strategies: [{ id: 'z60stack25-jup', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
  { symbol: 'LITUSDT', marketId: 120, strategies: [{ id: 'z60stack25-lit', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
  { symbol: 'GRAMUSDT', marketId: 12, strategies: [{ id: 'z60stack25-gram', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
  { symbol: 'XMRUSDT', marketId: 77, strategies: [{ id: 'z60stack25-xmr', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
  { symbol: 'ENAUSDT', marketId: 29, strategies: [{ id: 'z60stack25-ena', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
  { symbol: 'TAOUSDT', marketId: 13, strategies: [{ id: 'z60stack25-tao', family: 'zscore', mode: 'touch', threshold: 2.5, trendFilter: 'ema200_400' }] },
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
const runnerEvaluations = new Map<string, NativeRunnerEvaluation>();

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function recordError(
  strategy: NativeStrategy,
  feed: NativeFeed,
  target: number,
  state: 'data_error' | 'evaluation_error',
  error: string,
): void {
  const previous = runnerEvaluations.get(strategy.id);
  runnerEvaluations.set(strategy.id, {
    strategyId: strategy.id,
    symbol: feed.symbol,
    marketId: feed.marketId,
    family: strategy.family,
    mode: strategy.mode,
    threshold: strategy.threshold,
    trendFilter: strategy.trendFilter ?? null,
    attemptedBarTime: target,
    barTime: previous?.barTime ?? null,
    evaluatedAt: Date.now(),
    state,
    reason: state,
    side: null,
    close: previous?.close ?? null,
    mean: previous?.mean ?? null,
    previousZ: previous?.previousZ ?? null,
    currentZ: previous?.currentZ ?? null,
    trendMean: previous?.trendMean ?? null,
    slowTrendMean: previous?.slowTrendMean ?? null,
    efficiencyRatio60: previous?.efficiencyRatio60 ?? null,
    error,
  });
}

function recordEvaluation(
  strategy: NativeStrategy,
  feed: NativeFeed,
  target: number,
  snapshot: NonNullable<ReturnType<typeof evaluateZ60>>,
  er60: number | null,
  state: NativeRunnerEvaluation['state'],
  reason: string,
  side: 'long' | 'short' | null = null,
): void {
  runnerEvaluations.set(strategy.id, {
    strategyId: strategy.id,
    symbol: feed.symbol,
    marketId: feed.marketId,
    family: strategy.family,
    mode: strategy.mode,
    threshold: strategy.threshold,
    trendFilter: strategy.trendFilter ?? null,
    attemptedBarTime: target,
    barTime: target,
    evaluatedAt: Date.now(),
    state,
    reason,
    side,
    close: snapshot.close,
    mean: snapshot.mean,
    previousZ: snapshot.previousZ,
    currentZ: snapshot.currentZ,
    trendMean: snapshot.trendMean ?? null,
    slowTrendMean: snapshot.slowTrendMean ?? null,
    efficiencyRatio60: er60,
    error: null,
  });
}

function persistRunnerStatus(target: number): void {
  const status: NativeRunnerStatus = {
    version: 1,
    heartbeatAt: Date.now(),
    targetBarTime: target,
    evaluations: [...runnerEvaluations.values()]
      .sort((a, b) => a.strategyId.localeCompare(b.strategyId)),
  };
  setRuntimeConfig(
    LIGHTER_NATIVE_RUNNER_STATUS_KEY,
    JSON.stringify(status),
    'native completed-bar runner heartbeat and last decision',
  );
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

export async function fetchTrendBars(
  latestBarTime: number,
  marketId: number,
): Promise<Vwz60Bar[]> {
  const unique = new Map<number, Vwz60Bar>();
  let pageEnd = latestBarTime + BAR_MS;
  let remaining = TREND_HISTORY_BARS;
  while (remaining > 0) {
    const pageBars = Math.min(TREND_PAGE_BARS, remaining);
    const pageStart = pageEnd - pageBars * BAR_MS;
    const url = new URL('https://mainnet.zklighter.elliot.ai/api/v1/candles');
    url.searchParams.set('market_id', String(marketId));
    url.searchParams.set('resolution', '5m');
    url.searchParams.set('start_timestamp', String(pageStart));
    url.searchParams.set('end_timestamp', String(pageEnd));
    url.searchParams.set('count_back', String(pageBars));
    url.searchParams.set('set_timestamp_to_end', 'false');

    const response = await request(url, {
      headersTimeout: 8_000,
      bodyTimeout: 8_000,
    });
    const body = await response.body.json() as CandleResponse;
    if (Number(body.code) !== 200) {
      throw new Error(`trend_candles_${String(body.code)}:${String(body.message ?? 'unknown')}`);
    }
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
        || time < pageStart
        || time >= pageEnd
      ) continue;
      unique.set(time, { time, close, volume });
    }
    pageEnd = pageStart;
    remaining -= pageBars;
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
  er60: number | null,
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
  }, { efficiencyRatio60: er60 });
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
          const message = (error as Error).message;
          for (const strategy of pending.filter((row) => !row.trendFilter)) {
            recordError(strategy, feed, target, 'data_error', message);
          }
          logger.warn({
            error: message,
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
          const message = (error as Error).message;
          for (const strategy of pending.filter((row) => row.trendFilter)) {
            recordError(strategy, feed, target, 'data_error', message);
          }
          logger.warn({
            error: message,
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
            ? strategy.trendFilter === 'ema200_400'
              ? evaluateTrendStackZ60(
                strategyBars,
                60,
                strategy.threshold,
                strategy.mode,
                200,
                400,
              )
              : evaluateTrendFilteredZ60(
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
          const er60 = efficiencyRatio(strategyBars, 60);

          const open = openPosition.get(strategy.id);
          if (open) {
            const meanExit = open.side === 'long'
              ? snapshot.close >= snapshot.mean
              : snapshot.close <= snapshot.mean;
            const timeExit = target + BAR_MS - open.opened_at >= TIME_EXIT_BARS * BAR_MS;
            if (meanExit || timeExit) {
              emit(strategy, feed.symbol, 'exit', open.side, target, snapshot.close, er60);
              recordEvaluation(
                strategy,
                feed,
                target,
                snapshot,
                er60,
                'exit_emitted',
                meanExit
                  ? strategy.family === 'vwz' ? 'vwma60_cross' : 'sma60_cross'
                  : 'time_240_bars',
                open.side,
              );
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
            } else {
              recordEvaluation(
                strategy,
                feed,
                target,
                snapshot,
                er60,
                'position_open',
                'waiting_mean_or_time_exit',
                open.side,
              );
            }
            lastEvaluatedBars.set(strategy.id, target);
            continue;
          }

          // A protective stop that filled during this same completed candle
          // must not be followed by an immediate same-bar re-entry.
          const closed = lastClosed.get(strategy.id);
          if (closed && Math.floor(closed.closed_at / BAR_MS) * BAR_MS === target) {
            recordEvaluation(
              strategy,
              feed,
              target,
              snapshot,
              er60,
              'same_bar_reentry_blocked',
              'same_bar_stop_or_close',
            );
            lastEvaluatedBars.set(strategy.id, target);
            continue;
          }

          if (snapshot.signal && !allowsEntryByEfficiency(er60, strategy.efficiencyMax)) {
            recordEvaluation(
              strategy,
              feed,
              target,
              snapshot,
              er60,
              'waiting',
              er60 == null
                ? 'er60_history_incomplete'
                : `er60_above_${strategy.efficiencyMax}`,
            );
          } else if (snapshot.signal) {
            emit(strategy, feed.symbol, 'entry', snapshot.signal, target, snapshot.close, er60);
            recordEvaluation(
              strategy,
              feed,
              target,
              snapshot,
              er60,
              'signal_emitted',
              'entry_signal',
              snapshot.signal,
            );
            logger.info({
              strategyId: strategy.id,
              symbol: feed.symbol,
              family: strategy.family,
              mode: strategy.mode,
              threshold: strategy.threshold,
              efficiencyMax: strategy.efficiencyMax,
              side: snapshot.signal,
              barTime: target,
              close: snapshot.close,
              previousZ: snapshot.previousZ,
              currentZ: snapshot.currentZ,
              trendMean: snapshot.trendMean,
              efficiencyRatio60: er60,
            }, 'lighter-z60: native entry signal');
          } else {
            recordEvaluation(
              strategy,
              feed,
              target,
              snapshot,
              er60,
              'waiting',
              nativeWaitingReason({
                mode: strategy.mode,
                threshold: strategy.threshold,
                previousZ: snapshot.previousZ,
                currentZ: snapshot.currentZ,
                close: snapshot.close,
                trendMean: snapshot.trendMean,
                slowTrendMean: snapshot.slowTrendMean,
              }),
            );
          }
          lastEvaluatedBars.set(strategy.id, target);
        } catch (error) {
          const message = (error as Error).message;
          recordError(strategy, feed, target, 'evaluation_error', message);
          logger.warn({
            error: message,
            target,
            symbol: feed.symbol,
            marketId: feed.marketId,
            strategyId: strategy.id,
          }, 'lighter-z60: strategy evaluation failed');
        }
      }
    }
  } finally {
    try {
      persistRunnerStatus(target);
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'lighter-z60: status heartbeat failed');
    }
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
