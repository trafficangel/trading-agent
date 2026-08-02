#!/usr/bin/env node

/**
 * Standalone, resumable Lighter candle downloader.
 *
 * It intentionally depends only on Node's built-in fetch so historical
 * research can run on an isolated host without sharing API/WAF capacity with
 * the production signal runner.
 *
 * Usage:
 *   node scripts/download-lighter-candles.mjs 180 1 BTC,ETH,SOL
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const BASE_URL = 'https://mainnet.zklighter.elliot.ai';
const days = Number(process.argv[2] ?? 180);
const resolutionMinutes = Number(process.argv[3] ?? 1);
const symbols = String(process.argv[4] ?? 'BTC,ETH,SOL')
  .split(',')
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
const delayMs = Number(process.env.LIGHTER_FETCH_DELAY_MS ?? 500);
const outputDir = resolve(process.env.LIGHTER_CACHE_DIR ?? 'data/lighter-klines');
const stepMs = resolutionMinutes * 60_000;
const now = Date.now();
const fromMs = Math.floor((now - days * 86_400_000) / stepMs) * stepMs;
const toExclusiveMs = Math.floor(now / stepMs) * stepMs;

if (!(days > 0) || !(resolutionMinutes > 0) || !symbols.length) {
  throw new Error('Expected positive days/resolution and at least one symbol');
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

function atomicWrite(path, value) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

async function getJson(url) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'robotclaude-native-quant-research/1.0',
        },
      });
      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();
      if (!response.ok || !contentType.includes('application/json')) {
        throw new Error(`http_${response.status}:${contentType || 'unknown_content_type'}`);
      }
      const body = JSON.parse(text);
      if (Number(body.code) === 200 || Array.isArray(body.order_books)) return body;
      if (Number(body.code) !== 23000) {
        throw new Error(`code_${String(body.code)}:${String(body.message ?? 'unknown')}`);
      }
    } catch (error) {
      if (attempt === 7) throw error;
    }
    await wait(Math.min(60_000, 1_000 * 2 ** attempt));
  }
  throw new Error('retry_exhausted');
}

function missingWindows(existingTimes) {
  const existing = new Set(existingTimes);
  const windows = [];
  let start = null;
  let count = 0;
  const flush = () => {
    if (start == null || count === 0) return;
    let cursor = start;
    let remaining = count;
    while (remaining > 0) {
      const pageCount = Math.min(500, remaining);
      windows.push([cursor, cursor + pageCount * stepMs]);
      cursor += pageCount * stepMs;
      remaining -= pageCount;
    }
    start = null;
    count = 0;
  };
  for (let timestamp = fromMs; timestamp < toExclusiveMs; timestamp += stepMs) {
    if (existing.has(timestamp)) {
      flush();
    } else {
      if (start == null) start = timestamp;
      count += 1;
    }
  }
  flush();
  return windows;
}

const books = await getJson(`${BASE_URL}/api/v1/orderBooks`);
const markets = new Map(
  books.order_books
    .filter((book) => book.market_type === 'perp')
    .map((book) => [String(book.symbol).toUpperCase(), Number(book.market_id)]),
);

mkdirSync(outputDir, { recursive: true });
for (const symbol of symbols) {
  const marketId = markets.get(symbol);
  if (marketId == null) {
    console.error(`${symbol}: market_not_found`);
    continue;
  }
  const cacheFile = resolve(outputDir, `${symbol}-${resolutionMinutes}m.json`);
  const cached = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : [];
  const byTime = new Map(cached.map((candle) => [Number(candle.t), candle]));
  const windows = missingWindows(byTime.keys());
  console.log(`${symbol}: cached=${byTime.size} pages=${windows.length}`);

  for (let index = 0; index < windows.length; index += 1) {
    const [start, endExclusive] = windows[index];
    const url = new URL(`${BASE_URL}/api/v1/candles`);
    url.searchParams.set('market_id', String(marketId));
    url.searchParams.set('resolution', `${resolutionMinutes}m`);
    url.searchParams.set('start_timestamp', String(start));
    url.searchParams.set('end_timestamp', String(endExclusive));
    url.searchParams.set('count_back', '500');
    url.searchParams.set('set_timestamp_to_end', 'false');
    const body = await getJson(url);
    for (const candle of body.c ?? []) {
      const timestamp = Number(candle.t);
      if (timestamp >= fromMs && timestamp < toExclusiveMs) byTime.set(timestamp, candle);
    }
    atomicWrite(cacheFile, [...byTime.values()].sort((a, b) => a.t - b.t));
    if ((index + 1) % 50 === 0 || index + 1 === windows.length) {
      console.log(`${symbol}: ${index + 1}/${windows.length} pages · ${byTime.size} candles`);
    }
    if (index + 1 < windows.length) await wait(delayMs);
  }
}
