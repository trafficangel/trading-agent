/**
 * Phase U — historical kline loader with on-disk cache.
 *
 * Fetches Bybit USDT-perp klines and caches them to data/klines/ so a
 * backtest is reproducible and doesn't refetch. The cache is append-merged
 * and deduped by open-time. Must run where Bybit is reachable (VPS).
 *
 * Cache file: data/klines/<SYMBOL>-<interval>.json  → Candle[] (ascending).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { request } from 'undici';
import type { Candle } from './indicators.js';

const BASE = 'https://api.bybit.com';
const CACHE_DIR = resolve('data', 'klines');

function cachePath(symbol: string, interval: string): string {
  return resolve(CACHE_DIR, `${symbol}-${interval}.json`);
}

export function loadCache(symbol: string, interval: string): Candle[] {
  const p = cachePath(symbol, interval);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Candle[];
  } catch {
    return [];
  }
}

function saveCache(symbol: string, interval: string, candles: Candle[]): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(symbol, interval), JSON.stringify(candles));
}

async function fetchPage(symbol: string, interval: string, start: number, end: number): Promise<Candle[]> {
  const url =
    `${BASE}/v5/market/kline?category=linear&symbol=${symbol}` +
    `&interval=${interval}&start=${start}&end=${end}&limit=1000`;
  const res = await request(url, { headersTimeout: 8000, bodyTimeout: 8000 });
  const body = (await res.body.json()) as { retCode: number; result?: { list?: string[][] } };
  if (body.retCode !== 0 || !body.result?.list) {
    throw new Error(`bybit retCode=${body.retCode} for ${symbol} ${interval}`);
  }
  return body.result.list.map((k) => ({
    t: Number(k[0]),
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[5]),
  }));
}

/**
 * Return candles covering [fromMs, toMs], using cache where possible and
 * fetching only the missing tail/head. Always returns ascending, deduped.
 */
/** Bybit non-numeric kline intervals → minutes. Numeric intervals
 *  ('5','15','60','240'…) pass through. Enables daily/weekly backtests. */
const INTERVAL_MIN: Record<string, number> = { D: 1440, W: 10080, M: 43200 };
export function intervalStepMs(interval: string): number {
  return (INTERVAL_MIN[interval] ?? Number(interval)) * 60_000;
}

export async function getKlines(
  symbol: string,
  interval: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  const stepMs = intervalStepMs(interval);
  const cache = loadCache(symbol, interval);
  const have = new Map<number, Candle>();
  for (const c of cache) have.set(c.t, c);

  const cachedMin = cache.length ? cache[0]!.t : Infinity;
  const cachedMax = cache.length ? cache[cache.length - 1]!.t : -Infinity;

  // Decide the ranges to fetch: anything before cachedMin and after cachedMax
  // that overlaps [fromMs,toMs], plus internal holes. The old head/tail-only
  // logic silently preserved a missing middle section forever when an earlier
  // request had been interrupted.
  const ranges: Array<[number, number]> = [];
  if (fromMs < cachedMin) ranges.push([fromMs, Math.min(toMs, cachedMin - stepMs)]);
  if (toMs > cachedMax) ranges.push([Math.max(fromMs, cachedMax + stepMs), toMs]);
  if (cache.length === 0) ranges.length = 0, ranges.push([fromMs, toMs]);
  if (cache.length > 0) {
    const requestedCache = cache.filter((c) => c.t >= fromMs && c.t <= toMs);
    if (requestedCache.length === 0) {
      ranges.push([fromMs, toMs]);
    } else {
      const firstRequested = requestedCache[0]!;
      const lastRequested = requestedCache[requestedCache.length - 1]!;
      if (firstRequested.t - fromMs > stepMs) {
        ranges.push([fromMs, firstRequested.t - stepMs]);
      }
      if (toMs - lastRequested.t > stepMs) {
        ranges.push([lastRequested.t + stepMs, toMs]);
      }
    }
    for (let index = 1; index < requestedCache.length; index += 1) {
      const previous = requestedCache[index - 1]!;
      const current = requestedCache[index]!;
      if (current.t - previous.t > stepMs) {
        ranges.push([previous.t + stepMs, current.t - stepMs]);
      }
    }
  }

  // Merge overlapping ranges so a boundary request and an internal-gap
  // request cannot fetch the same candles twice.
  ranges.sort((a, b) => a[0] - b[0]);
  const mergedRanges: Array<[number, number]> = [];
  for (const range of ranges) {
    const previous = mergedRanges.at(-1);
    if (previous && range[0] <= previous[1] + stepMs) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      mergedRanges.push([...range]);
    }
  }

  for (const [rs, re] of mergedRanges) {
    let cursor = rs;
    while (cursor <= re) {
      const pageEnd = Math.min(re, cursor + 999 * stepMs);
      let page: Candle[] = [];
      try {
        page = await fetchPage(symbol, interval, cursor, pageEnd);
      } catch (err) {
        process.stderr.write(`  klines fetch error ${symbol} ${interval}: ${(err as Error).message}\n`);
        break;
      }
      if (page.length === 0) break;
      for (const c of page) have.set(c.t, c);
      const newest = Math.max(...page.map((c) => c.t));
      if (newest + stepMs <= cursor) break;
      cursor = newest + stepMs;
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  const merged = [...have.values()].sort((a, b) => a.t - b.t);
  saveCache(symbol, interval, merged);
  return merged.filter((c) => c.t >= fromMs && c.t <= toMs);
}
