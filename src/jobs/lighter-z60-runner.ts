import { request } from 'undici';
import { db } from '../db/client.js';
import { setRuntimeConfig } from '../db/repos/runtime-config.js';
import {
  LIGHTER_NATIVE_RUNNER_STATUS_KEY,
  nativeRsiWaitingReason,
  nativeWaitingReason,
  type NativeRunnerEvaluation,
  type NativeRunnerStatus,
} from '../lib/lighter-native-runner-status.js';
import {
  evaluateRsiTrendPullback,
  rsiTrendExit,
  type RsiTrendPullbackSnapshot,
} from '../lib/lighter-rsi-pullback.js';
import {
  evaluateRsiWilliamsTrend,
  evaluateVwzMfiTrend,
  rsiWilliamsExit,
  type RsiWilliamsSnapshot,
  type VwzMfiSnapshot,
} from '../lib/lighter-oscillator-confluence.js';
import {
  allowsEntryByEfficiency,
  efficiencyRatio,
  evaluateTrendFilteredZ60,
  evaluateTrendStackZ60,
  evaluateVwz60,
  evaluateZ60,
  type Z60EntryMode,
  type Z60Snapshot,
  type Vwz60Bar,
} from '../lib/lighter-z60.js';
import { logger } from '../lib/logger.js';
import { queueLighterLuxalgoSignal } from '../strategies/lighter-luxalgo-lab.js';

const MINUTE_MS = 60_000;
const BAR_MS = 5 * MINUTE_MS;
const HISTORY_BARS = 66;
// EMA400 needs substantially more than one period of warmup. A 500-bar seed
// produced a live trend-side mismatch on LIT; the original 1,500-bar seed
// matched the portfolio rules but missed two rare DATA confluence decisions.
// Four 500-bar pages are sufficient to reproduce full-history EMA400 entry
// decisions for the frozen oscillator candidates with zero signal mismatches.
const TREND_HISTORY_BARS = 2_000;
const TREND_PAGE_BARS = 500;
const TIME_EXIT_BARS = 240;
// Lighter commonly publishes the fifth one-minute candle 15–25 seconds after
// the nominal 5m boundary. Waiting 25s avoids a guaranteed failed request while
// preserving the same effective evaluation time as the previous 15s retry.
const PUBLISH_GRACE_MS = 25_000;
const RETRY_MS = 5_000;
const FETCH_CONCURRENCY = 4;

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
  family: 'zscore' | 'vwz' | 'rsi' | 'rsi_williams' | 'vwz_mfi';
  mode: Z60EntryMode;
  threshold: number;
  auxiliaryThreshold?: number;
  efficiencyMax?: number;
  trendFilter?: 'ema200' | 'ema400' | 'ema200_400';
  maxBars?: number;
  entryEnabled?: boolean;
};

type NativeSnapshot = Z60Snapshot | RsiTrendPullbackSnapshot
  | RsiWilliamsSnapshot | VwzMfiSnapshot;

type NativeFeed = {
  symbol: string;
  marketId: number;
  strategies: readonly NativeStrategy[];
};

const BASE_FEEDS: readonly NativeFeed[] = [
  {
    symbol: 'HYPEUSDT',
    marketId: 24,
    strategies: [
      { id: 'hype-vwz60-touch', family: 'vwz', mode: 'touch', threshold: 2.5 },
      {
        id: 'hype-rsi14-willr14-ema400-challenger',
        family: 'rsi_williams',
        mode: 'touch',
        threshold: 30,
        auxiliaryThreshold: 20,
        trendFilter: 'ema400',
        maxBars: 120,
      },
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
    symbol: 'ZECUSDT',
    marketId: 90,
    strategies: [
      {
        id: 'zec-rsi14-willr14-ema400',
        family: 'rsi_williams',
        mode: 'touch',
        threshold: 30,
        auxiliaryThreshold: 20,
        trendFilter: 'ema400',
        maxBars: 120,
      },
      {
        id: 'zec-vwz60-mfi14-ema400-challenger',
        family: 'vwz_mfi',
        mode: 'touch',
        threshold: 2.5,
        auxiliaryThreshold: 35,
        trendFilter: 'ema400',
        maxBars: 120,
      },
    ],
  },
  {
    symbol: 'APTUSDT',
    marketId: 31,
    strategies: [
      {
        id: 'apt-rsi14-pullback-ema400',
        family: 'rsi',
        mode: 'touch',
        threshold: 25,
        trendFilter: 'ema400',
        maxBars: 120,
        // This strategy failed the frozen +1m executable-entry gate. Keep its
        // evaluator alive only to close the already-open Shadow position.
        entryEnabled: false,
      },
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
const trendBarCache = new Map<number, Vwz60Bar[]>();

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
    previousRsi: previous?.previousRsi ?? null,
    currentRsi: previous?.currentRsi ?? null,
    secondaryOscillator: previous?.secondaryOscillator ?? null,
    error,
  });
}

function recordEvaluation(
  strategy: NativeStrategy,
  feed: NativeFeed,
  target: number,
  snapshot: NativeSnapshot,
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
    mean: 'mean' in snapshot ? snapshot.mean : null,
    previousZ: 'previousZ' in snapshot ? snapshot.previousZ : null,
    currentZ: 'currentZ' in snapshot ? snapshot.currentZ : null,
    trendMean: snapshot.trendMean ?? null,
    slowTrendMean: 'slowTrendMean' in snapshot ? snapshot.slowTrendMean ?? null : null,
    efficiencyRatio60: er60,
    previousRsi: 'previousRsi' in snapshot ? snapshot.previousRsi : null,
    currentRsi: 'currentRsi' in snapshot ? snapshot.currentRsi : null,
    secondaryOscillator: 'currentWilliams' in snapshot
      ? snapshot.currentWilliams
      : 'currentMfi' in snapshot ? snapshot.currentMfi : null,
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
  const cached = trendBarCache.get(marketId);
  const cachedLastTime = cached?.at(-1)?.time;
  if (cachedLastTime === latestBarTime) return cached!;

  const unique = new Map<number, Vwz60Bar>();
  let pageEnd: number;
  let remaining: number;
  if (
    cached
    && cachedLastTime != null
    && cachedLastTime < latestBarTime
    && latestBarTime - cachedLastTime <= TREND_PAGE_BARS * BAR_MS
  ) {
    for (const bar of cached) unique.set(bar.time, bar);
    pageEnd = latestBarTime + BAR_MS;
    remaining = Math.round((latestBarTime - cachedLastTime) / BAR_MS);
  } else {
    pageEnd = latestBarTime + BAR_MS;
    remaining = TREND_HISTORY_BARS;
  }

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
      const high = finite(candle.h);
      const low = finite(candle.l);
      const volume = finite(candle.v) ?? 0;
      if (
        time == null
        || close == null
        || close <= 0
        || high == null
        || low == null
        || high < low
        || volume < 0
        || time % BAR_MS !== 0
        || time < pageStart
        || time >= pageEnd
      ) continue;
      unique.set(time, { time, close, high, low, volume });
    }
    pageEnd = pageStart;
    remaining -= pageBars;
  }
  const bars = [...unique.values()]
    .filter((bar) => bar.time <= latestBarTime)
    .sort((a, b) => a.time - b.time)
    .slice(-TREND_HISTORY_BARS);
  if (bars.length < TREND_HISTORY_BARS || bars.at(-1)?.time !== latestBarTime) {
    throw new Error('trend_history_incomplete');
  }
  const warmup = bars.slice(-TREND_HISTORY_BARS);
  for (let index = 1; index < warmup.length; index += 1) {
    if (warmup[index]!.time - warmup[index - 1]!.time !== BAR_MS) {
      throw new Error('trend_history_gap');
    }
  }
  trendBarCache.set(marketId, bars);
  return bars;
}

async function mapWithConcurrency<T, R>(
  rows: readonly T[],
  concurrency: number,
  worker: (row: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(rows.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), rows.length) },
    async () => {
      while (nextIndex < rows.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(rows[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

type PendingFeed = {
  feed: NativeFeed;
  pending: NativeStrategy[];
};

type PreparedFeed = PendingFeed & {
  baseBars: Vwz60Bar[] | null;
  trendBars: Vwz60Bar[] | null;
};

async function prepareFeed(
  target: number,
  { feed, pending }: PendingFeed,
): Promise<PreparedFeed> {
  const needsBase = pending.some((strategy) => !strategy.trendFilter);
  const needsTrend = pending.some((strategy) => strategy.trendFilter);
  const [baseResult, trendResult] = await Promise.all([
    needsBase
      ? fetchBars(target, feed.marketId).then(
        (bars) => ({ bars, error: null }),
        (error: Error) => ({ bars: null, error }),
      )
      : Promise.resolve({ bars: null, error: null }),
    needsTrend
      ? fetchTrendBars(target, feed.marketId).then(
        (bars) => ({ bars, error: null }),
        (error: Error) => ({ bars: null, error }),
      )
      : Promise.resolve({ bars: null, error: null }),
  ]);

  if (baseResult.error) {
    const message = baseResult.error.message;
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
  if (trendResult.error) {
    const message = trendResult.error.message;
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

  return {
    feed,
    pending,
    baseBars: baseResult.bars,
    trendBars: trendResult.bars,
  };
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
  const pollStartedAt = Date.now();
  running = true;
  try {
    const pendingFeeds = FEEDS
      .map((feed): PendingFeed => ({
        feed,
        pending: feed.strategies.filter(
          (strategy) => target > (lastEvaluatedBars.get(strategy.id) ?? 0),
        ),
      }))
      .filter((row) => row.pending.length > 0);
    const preparedFeeds = await mapWithConcurrency(
      pendingFeeds,
      FETCH_CONCURRENCY,
      (row) => prepareFeed(target, row),
    );
    if (pendingFeeds.length > 0) {
      logger.info({
        target,
        feeds: pendingFeeds.length,
        fetchMs: Date.now() - pollStartedAt,
        closeToDataReadyMs: Date.now() - (target + BAR_MS),
      }, 'lighter-z60: completed-bar data prepared');
    }

    for (const { feed, pending, baseBars, trendBars } of preparedFeeds) {
      for (const strategy of pending) {
        const strategyBars = strategy.trendFilter ? trendBars : baseBars;
        if (!strategyBars) continue;
        try {
          const snapshot: NativeSnapshot | null = strategy.family === 'rsi'
            ? evaluateRsiTrendPullback(
              strategyBars,
              14,
              strategy.threshold,
              strategy.trendFilter === 'ema400' ? 400 : 200,
            )
            : strategy.family === 'rsi_williams'
            ? evaluateRsiWilliamsTrend(
              strategyBars,
              14,
              strategy.threshold,
              14,
              strategy.auxiliaryThreshold ?? 20,
              400,
            )
            : strategy.family === 'vwz_mfi'
            ? evaluateVwzMfiTrend(
              strategyBars,
              60,
              strategy.threshold,
              14,
              strategy.auxiliaryThreshold ?? 35,
              400,
            )
            : strategy.trendFilter
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
          if (!snapshot) throw new Error(`${strategy.family}_history_incomplete`);
          const er60 = efficiencyRatio(strategyBars, 60);

          const open = openPosition.get(strategy.id);
          if (open) {
            const indicatorExit = strategy.family === 'rsi'
              ? rsiTrendExit(snapshot as RsiTrendPullbackSnapshot, open.side)
              : strategy.family === 'rsi_williams'
              ? rsiWilliamsExit(snapshot as RsiWilliamsSnapshot, open.side)
              : open.side === 'long'
                ? snapshot.close >= (snapshot as Z60Snapshot).mean
                : snapshot.close <= (snapshot as Z60Snapshot).mean;
            const maxBars = strategy.maxBars ?? TIME_EXIT_BARS;
            const timeExit = target + BAR_MS - open.opened_at >= maxBars * BAR_MS;
            if (indicatorExit || timeExit) {
              emit(strategy, feed.symbol, 'exit', open.side, target, snapshot.close, er60);
              recordEvaluation(
                strategy,
                feed,
                target,
                snapshot,
                er60,
                'exit_emitted',
                indicatorExit
                  ? strategy.family === 'rsi' || strategy.family === 'rsi_williams'
                    ? 'rsi50_cross'
                    : strategy.family === 'vwz' || strategy.family === 'vwz_mfi'
                      ? 'vwma60_cross' : 'sma60_cross'
                  : `time_${maxBars}_bars`,
                open.side,
              );
              logger.info({
                strategyId: strategy.id,
                symbol: feed.symbol,
                side: open.side,
                barTime: target,
                close: snapshot.close,
                mean: 'mean' in snapshot ? snapshot.mean : null,
                currentRsi: 'currentRsi' in snapshot ? snapshot.currentRsi : null,
                reason: indicatorExit
                  ? strategy.family === 'rsi' || strategy.family === 'rsi_williams'
                    ? 'rsi50_cross'
                    : strategy.family === 'vwz' || strategy.family === 'vwz_mfi'
                      ? 'vwma60_cross' : 'sma60_cross'
                  : `time_${maxBars}_bars`,
                }, 'lighter-z60: native exit signal');
            } else {
              recordEvaluation(
                strategy,
                feed,
                target,
                snapshot,
                er60,
                'position_open',
                strategy.family === 'rsi' || strategy.family === 'rsi_williams'
                  ? 'waiting_rsi50_or_time_exit'
                  : 'waiting_mean_or_time_exit',
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

          if (snapshot.signal && strategy.entryEnabled === false) {
            recordEvaluation(
              strategy,
              feed,
              target,
              snapshot,
              er60,
              'waiting',
              'latency_gate_failed_entry_disabled',
            );
          } else if (snapshot.signal && !allowsEntryByEfficiency(er60, strategy.efficiencyMax)) {
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
              previousZ: 'previousZ' in snapshot ? snapshot.previousZ : null,
              currentZ: 'currentZ' in snapshot ? snapshot.currentZ : null,
              previousRsi: 'previousRsi' in snapshot ? snapshot.previousRsi : null,
              currentRsi: 'currentRsi' in snapshot ? snapshot.currentRsi : null,
              trendMean: snapshot.trendMean,
              efficiencyRatio60: er60,
            }, 'lighter-z60: native entry signal');
          } else {
            const waitingReason = strategy.family === 'rsi'
              ? nativeRsiWaitingReason({
                level: strategy.threshold,
                currentRsi: (snapshot as RsiTrendPullbackSnapshot).currentRsi,
                close: snapshot.close,
                trendMean: snapshot.trendMean!,
              })
              : strategy.family === 'rsi_williams'
              ? (() => {
                const value = snapshot as RsiWilliamsSnapshot;
                if (value.currentRsi >= strategy.threshold
                  && value.currentRsi <= 100 - strategy.threshold) return 'rsi_inside_threshold';
                if (value.currentRsi < strategy.threshold
                  && value.currentWilliams >= -100 + (strategy.auxiliaryThreshold ?? 20)) {
                  return 'williams_not_confirmed';
                }
                if (value.currentRsi > 100 - strategy.threshold
                  && value.currentWilliams <= -(strategy.auxiliaryThreshold ?? 20)) {
                  return 'williams_not_confirmed';
                }
                return nativeRsiWaitingReason({
                  level: strategy.threshold,
                  currentRsi: value.currentRsi,
                  close: value.close,
                  trendMean: value.trendMean,
                });
              })()
              : strategy.family === 'vwz_mfi'
              ? (() => {
                const value = snapshot as VwzMfiSnapshot;
                const mfiLevel = strategy.auxiliaryThreshold ?? 35;
                if (value.currentZ < -strategy.threshold && value.currentMfi >= mfiLevel) {
                  return 'mfi_not_confirmed';
                }
                if (value.currentZ > strategy.threshold && value.currentMfi <= 100 - mfiLevel) {
                  return 'mfi_not_confirmed';
                }
                return nativeWaitingReason({
                  mode: strategy.mode,
                  threshold: strategy.threshold,
                  previousZ: value.previousZ,
                  currentZ: value.currentZ,
                  close: value.close,
                  trendMean: value.trendMean,
                });
              })()
              : nativeWaitingReason({
                mode: strategy.mode,
                threshold: strategy.threshold,
                previousZ: (snapshot as Z60Snapshot).previousZ,
                currentZ: (snapshot as Z60Snapshot).currentZ,
                close: snapshot.close,
                trendMean: snapshot.trendMean,
                slowTrendMean: (snapshot as Z60Snapshot).slowTrendMean,
              });
            recordEvaluation(
              strategy,
              feed,
              target,
              snapshot,
              er60,
              'waiting',
              waitingReason,
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
      entryEnabled: strategy.entryEnabled !== false,
    }))),
    timeframe: '5m',
    commissionPct: 0,
  }, 'lighter-z60: native shadow runner scheduled');
  const initial = setTimeout(() => void poll(), 5_000);
  initial.unref();
  timer = setInterval(() => void poll(), RETRY_MS);
  timer.unref();
}
