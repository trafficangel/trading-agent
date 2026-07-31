#!/usr/bin/env node

/** Fetch gap-checked public Lighter hourly funding for native backtests. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const BASE_URL = 'https://mainnet.zklighter.elliot.ai';
const HOUR_SECONDS = 3_600;
const CHUNK_SECONDS = 28 * 86_400;
const symbols = String(process.argv[2] ?? 'BTC,ETH,SOL')
  .split(',')
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
const klinesDir = resolve(process.env.LIGHTER_KLINES_DIR ?? 'data/lighter-klines');
const outputPath = resolve(
  process.env.LIGHTER_FUNDING_OUTPUT ?? 'data/lighter-funding-history-native.json',
);

async function getJson(url) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'robotclaude-native-funding-fetcher/1.0',
        },
      });
      const body = await response.json();
      if (!response.ok || Number(body.code) !== 200) {
        throw new Error(`http_${response.status}:${String(body.message ?? body.code)}`);
      }
      return body;
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 500 * 2 ** attempt));
    }
  }
  throw new Error('retry_exhausted');
}

function candleRange(symbol) {
  const ranges = ['1m', '5m']
    .map((timeframe) => resolve(klinesDir, `${symbol}-${timeframe}.json`))
    .filter((path) => existsSync(path))
    .map((path) => {
      const candles = JSON.parse(readFileSync(path, 'utf8'));
      return {
        startMs: Number(candles[0]?.t),
        endMs: Number(candles.at(-1)?.t),
      };
    })
    .filter((range) => range.startMs > 0 && range.endMs > range.startMs);
  const startMs = Math.min(...ranges.map((range) => range.startMs));
  const endMs = Math.max(...ranges.map((range) => range.endMs));
  if (!(startMs > 0) || !(endMs > startMs)) {
    throw new Error(`${symbol}: invalid candle range`);
  }
  return { startMs, endMs };
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

const books = await getJson(`${BASE_URL}/api/v1/orderBooks`);
const marketIds = new Map(
  books.order_books
    .filter((book) => book.market_type === 'perp' && book.status === 'active')
    .map((book) => [String(book.symbol).toUpperCase(), Number(book.market_id)]),
);

const result = {
  version: 'lighter-funding-history-v1',
  generatedAt: new Date().toISOString(),
  resolution: '1h',
  source: `${BASE_URL}/api/v1/fundings`,
  symbols: {},
};

for (const symbol of symbols) {
  const marketId = marketIds.get(symbol);
  if (marketId == null) throw new Error(`${symbol}: active perp market not found`);
  const range = candleRange(symbol);
  const startSeconds = Math.floor(range.startMs / 1_000) - HOUR_SECONDS;
  const endSeconds = Math.ceil(range.endMs / 1_000) + HOUR_SECONDS;
  const byTimestamp = new Map();
  for (let chunkStart = startSeconds; chunkStart <= endSeconds; chunkStart += CHUNK_SECONDS) {
    const chunkEnd = Math.min(endSeconds, chunkStart + CHUNK_SECONDS - 1);
    const url = new URL(`${BASE_URL}/api/v1/fundings`);
    for (const [key, value] of Object.entries({
      market_id: marketId,
      resolution: '1h',
      start_timestamp: chunkStart,
      end_timestamp: chunkEnd,
      count_back: 0,
    })) url.searchParams.set(key, String(value));
    const body = await getJson(url);
    for (const row of body.fundings ?? []) {
      const timestampMs = Number(row.timestamp) * 1_000;
      const ratePctH = Math.abs(Number(row.rate));
      const direction = String(row.direction).toLowerCase();
      if (
        timestampMs > 0
        && Number.isFinite(ratePctH)
        && (direction === 'long' || direction === 'short')
      ) byTimestamp.set(timestampMs, { timestampMs, ratePctH, direction });
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  const fundings = [...byTimestamp.values()]
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const firstTimestampMs = fundings[0]?.timestampMs ?? null;
  const lastTimestampMs = fundings.at(-1)?.timestampMs ?? null;
  const expected = firstTimestampMs == null || lastTimestampMs == null
    ? 0
    : Math.floor((lastTimestampMs - firstTimestampMs) / 3_600_000) + 1;
  const internalCoverage = expected ? fundings.length / expected : 0;
  result.symbols[symbol] = {
    marketId,
    requiredStartMs: range.startMs,
    requiredEndMs: range.endMs,
    firstTimestampMs,
    lastTimestampMs,
    internalCoverage,
    fundings,
  };
  atomicWrite(outputPath, result);
  console.log(
    `${symbol}: ${fundings.length} hourly settlements · coverage ${(internalCoverage * 100).toFixed(2)}%`,
  );
}

atomicWrite(outputPath, result);
console.log(`Funding history → ${outputPath}`);
