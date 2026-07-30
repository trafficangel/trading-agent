import { request } from 'undici';
import { db } from '../db/client.js';
import { evaluateZ60Reclaim, type Z60Bar } from '../lib/lighter-z60.js';
import { logger } from '../lib/logger.js';
import { queueLighterLuxalgoSignal } from '../strategies/lighter-luxalgo-lab.js';

const STRATEGY_ID = 'sol-z60-reclaim';
const SYMBOL = 'SOLUSDT';
const MARKET_ID = 2;
const MINUTE_MS = 60_000;
const BAR_MS = 5 * MINUTE_MS;
const HISTORY_BARS = 66;
const TIME_EXIT_BARS = 240;
const PUBLISH_GRACE_MS = 10_000;
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
let lastEvaluatedBar = 0;

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
): Z60Bar[] {
  const buckets = new Map<number, {
    closes: Map<number, number>;
  }>();

  for (const candle of raw) {
    const time = finite(candle.t);
    const close = finite(candle.c);
    if (time == null || close == null || close <= 0 || time % MINUTE_MS !== 0) continue;
    const bucket = Math.floor(time / BAR_MS) * BAR_MS;
    if (bucket > latestBarTime) continue;
    const state = buckets.get(bucket) ?? { closes: new Map<number, number>() };
    state.closes.set(time, close);
    buckets.set(bucket, state);
  }

  return [...buckets.entries()]
    .filter(([bucket, state]) => {
      if (state.closes.size !== 5) return false;
      for (let offset = 0; offset < 5; offset += 1) {
        if (!state.closes.has(bucket + offset * MINUTE_MS)) return false;
      }
      return true;
    })
    .sort(([a], [b]) => a - b)
    .map(([time, state]) => ({
      time,
      close: state.closes.get(time + 4 * MINUTE_MS)!,
    }));
}

async function fetchBars(latestBarTime: number): Promise<Z60Bar[]> {
  const start = latestBarTime - (HISTORY_BARS - 1) * BAR_MS;
  const end = latestBarTime + 4 * MINUTE_MS;
  const url = new URL('https://mainnet.zklighter.elliot.ai/api/v1/candles');
  url.searchParams.set('market_id', String(MARKET_ID));
  url.searchParams.set('resolution', '1m');
  url.searchParams.set('start_timestamp', String(start));
  url.searchParams.set('end_timestamp', String(end));
  url.searchParams.set('count_back', '0');
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

function emit(
  action: 'entry' | 'exit',
  side: 'long' | 'short',
  barTime: number,
  price: number,
): void {
  queueLighterLuxalgoSignal({
    kind: 'strategy',
    strategy_id: STRATEGY_ID,
    action,
    side,
    strategy_event: action === 'entry' ? side : `exit_${side}`,
    symbol: SYMBOL,
    timeframe: '5',
    price,
    bar_time: barTime,
  });
}

async function poll(): Promise<void> {
  if (running) return;
  const target = targetCompletedBar(Date.now());
  if (target <= lastEvaluatedBar) return;
  running = true;
  try {
    const bars = await fetchBars(target);
    const snapshot = evaluateZ60Reclaim(bars);
    if (!snapshot) throw new Error('z60_history_incomplete');

    const open = openPosition.get(STRATEGY_ID);
    if (open) {
      const meanExit = open.side === 'long'
        ? snapshot.close >= snapshot.mean
        : snapshot.close <= snapshot.mean;
      const timeExit = target + BAR_MS - open.opened_at >= TIME_EXIT_BARS * BAR_MS;
      if (meanExit || timeExit) {
        emit('exit', open.side, target, snapshot.close);
        logger.info({
          strategyId: STRATEGY_ID,
          side: open.side,
          barTime: target,
          close: snapshot.close,
          mean: snapshot.mean,
          reason: meanExit ? 'sma60_cross' : 'time_240_bars',
        }, 'lighter-z60: native exit signal');
      }
      lastEvaluatedBar = target;
      return;
    }

    // A protective stop that filled during this same completed candle must not
    // be followed by an immediate same-bar re-entry.
    const closed = lastClosed.get(STRATEGY_ID);
    if (closed && Math.floor(closed.closed_at / BAR_MS) * BAR_MS === target) {
      lastEvaluatedBar = target;
      return;
    }

    if (snapshot.signal) {
      emit('entry', snapshot.signal, target, snapshot.close);
      logger.info({
        strategyId: STRATEGY_ID,
        side: snapshot.signal,
        barTime: target,
        close: snapshot.close,
        previousZ: snapshot.previousZ,
        currentZ: snapshot.currentZ,
      }, 'lighter-z60: native entry signal');
    }
    lastEvaluatedBar = target;
  } catch (error) {
    logger.warn({ error: (error as Error).message, target }, 'lighter-z60: poll failed');
  } finally {
    running = false;
  }
}

export function startLighterZ60Runner(): void {
  if (started) return;
  started = true;
  const initial = setTimeout(() => void poll(), 5_000);
  initial.unref();
  timer = setInterval(() => void poll(), RETRY_MS);
  timer.unref();
}
