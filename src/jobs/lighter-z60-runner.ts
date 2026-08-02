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
import { assertNativeStandaloneLifecycle } from '../lib/lighter-native-strategy-lifecycle.js';
import {
  aggregateCompleteNativeBars,
  nativeEntryDecisionDelayMs,
  NATIVE_MINUTE_MS,
  targetCompletedNativeBar,
  type NativeRawCandle,
} from '../lib/lighter-native-timeframe.js';
import { queueLighterLuxalgoSignal } from '../strategies/lighter-luxalgo-lab.js';

const MINUTE_MS = NATIVE_MINUTE_MS;
const BAR_MS = 5 * MINUTE_MS;
const HISTORY_BARS = 66;
// EMA400 needs substantially more than one period of warmup. A 500-bar seed
// produced a live trend-side mismatch on LIT; the original 1,500-bar seed
// matched the portfolio rules but missed two rare DATA confluence decisions.
// Twenty 500-minute pages are sufficient to reproduce full-history EMA400
// entry decisions from the exact aggregated source used by frozen research.
const TREND_HISTORY_BARS = 2_000;
const TREND_PAGE_MINUTES = 500;
const TREND_PAGE_BARS = TREND_PAGE_MINUTES / 5;
const TIME_EXIT_BARS = 240;
// Lighter commonly publishes the fifth one-minute candle 15–25 seconds after
// the nominal 5m boundary. Waiting 25s avoids a guaranteed failed request while
// preserving the same effective evaluation time as the previous 15s retry.
const PUBLISH_GRACE_MS = 25_000;
const RETRY_MS = 5_000;
const FETCH_CONCURRENCY = 4;
// Lighter's public candle API throttles bursty cold starts. Serialize all
// page requests to a measured-safe global cadence; feed concurrency still
// overlaps parsing/evaluation while the request queue protects the provider.
const CANDLE_REQUEST_INTERVAL_MS = 450;
const CANDLE_REQUEST_MAX_ATTEMPTS = 5;
// Historical research assumes at most a conservative +1m decision delay.
// Exits remain allowed after this boundary, but a late cold-start signal must
// never be converted into a new position at an unaudited price.
const MAX_ENTRY_DECISION_DELAY_MS = 60_000;

type CandleResponse = {
  code?: unknown;
  message?: unknown;
  c?: NativeRawCandle[];
};

let candleRequestTail: Promise<void> = Promise.resolve();
let nextCandleRequestAt = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function scheduleCandleRequest<T>(work: () => Promise<T>): Promise<T> {
  const scheduled = candleRequestTail.then(async () => {
    const waitMs = Math.max(0, nextCandleRequestAt - Date.now());
    if (waitMs > 0) await delay(waitMs);
    nextCandleRequestAt = Date.now() + CANDLE_REQUEST_INTERVAL_MS;
    return work();
  });
  candleRequestTail = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

async function requestCandlePage(url: URL, label: string): Promise<CandleResponse> {
  for (let attempt = 0; attempt < CANDLE_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    const body = await scheduleCandleRequest(async () => {
      const response = await request(url, {
        headersTimeout: 8_000,
        bodyTimeout: 8_000,
      });
      return response.body.json() as Promise<CandleResponse>;
    });
    if (Number(body.code) === 200) return body;
    if (
      Number(body.code) !== 23_000
      || attempt === CANDLE_REQUEST_MAX_ATTEMPTS - 1
    ) {
      throw new Error(`${label}_${String(body.code)}:${String(body.message ?? 'unknown')}`);
    }
    await delay(1_000 * 2 ** attempt);
  }
  throw new Error(`${label}_retry_exhausted`);
}

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

assertNativeStandaloneLifecycle(
  BASE_FEEDS.flatMap((feed) => feed.strategies.map((strategy) => strategy.id)),
);

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
  return targetCompletedNativeBar(now, 5, PUBLISH_GRACE_MS);
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

  const body = await requestCandlePage(url, 'candles');
  const bars = aggregateCompleteNativeBars(body.c ?? [], 5, latestBarTime);
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
    // The research and frozen latency audit build every completed 5m candle
    // from five native 1m candles. Fetch the same source here; direct exchange
    // 5m OHLC can diverge and would make Williams/MFI signals non-reproducible.
    const pageBars = Math.min(TREND_PAGE_BARS, remaining);
    const pageStart = pageEnd - pageBars * BAR_MS;
    const url = new URL('https://mainnet.zklighter.elliot.ai/api/v1/candles');
    url.searchParams.set('market_id', String(marketId));
    url.searchParams.set('resolution', '1m');
    url.searchParams.set('start_timestamp', String(pageStart));
    url.searchParams.set('end_timestamp', String(pageEnd));
    url.searchParams.set('count_back', String(pageBars * 5));
    url.searchParams.set('set_timestamp_to_end', 'false');

    const body = await requestCandlePage(url, 'trend_candles');
    for (const bar of aggregateCompleteNativeBars(
      body.c ?? [],
      5,
      pageEnd - BAR_MS,
    )) {
      if (bar.time >= pageStart && bar.time < pageEnd) unique.set(bar.time, bar);
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
      source: 'native-1m-aggregate-trend',
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
    const closeToDataReadyMs = nativeEntryDecisionDelayMs(target, 5, Date.now());
    if (pendingFeeds.length > 0) {
      logger.info({
        target,
        feeds: pendingFeeds.length,
        fetchMs: Date.now() - pollStartedAt,
        closeToDataReadyMs,
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

          if (snapshot.signal && closeToDataReadyMs > MAX_ENTRY_DECISION_DELAY_MS) {
            recordEvaluation(
              strategy,
              feed,
              target,
              snapshot,
              er60,
              'waiting',
              `decision_latency_${closeToDataReadyMs}ms_above_${MAX_ENTRY_DECISION_DELAY_MS}ms`,
            );
          } else if (snapshot.signal && strategy.entryEnabled === false) {
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
