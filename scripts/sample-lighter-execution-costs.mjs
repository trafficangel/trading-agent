#!/usr/bin/env node

/**
 * Sample executable Lighter round-trip costs for a fixed quote notional.
 *
 * This is research input, not a trading process. It measures both sides of the
 * public L2 book at the same instant:
 *   long entry VWAP vs mid + short entry VWAP vs mid
 * which is the immediately executable buy→sell round-trip cost. Prospective
 * signal-time Shadow fills remain the authoritative validation evidence.
 *
 * Usage:
 *   node scripts/sample-lighter-execution-costs.mjs BTC,SOL 120 15000 1000
 *   # symbols, samples per symbol, interval ms, quote notional USD
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const BASE_URL = 'https://mainnet.zklighter.elliot.ai';
const symbols = String(process.argv[2] ?? 'BTC,ETH,SOL')
  .split(',')
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
const targetSamples = Number(process.argv[3] ?? 120);
const intervalMs = Number(process.argv[4] ?? 15_000);
const notionalUsd = Number(process.argv[5] ?? 1_000);
const outputFile = resolve(
  process.env.LIGHTER_COST_OUTPUT ?? 'data/lighter-execution-costs.json',
);

if (
  !symbols.length
  || !(targetSamples > 0)
  || !(intervalMs >= 1_000)
  || !(notionalUsd > 0)
) {
  throw new Error('Expected symbols, positive samples/notional and interval >= 1000ms');
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function getJson(url) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'robotclaude-native-cost-sampler/1.0',
        },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`http_${response.status}`);
      const body = JSON.parse(text);
      if (Number(body.code) === 200 || Array.isArray(body.order_books)) return body;
      throw new Error(`code_${String(body.code)}:${String(body.message ?? 'unknown')}`);
    } catch (error) {
      if (attempt === 5) throw error;
      await wait(Math.min(30_000, 1_000 * 2 ** attempt));
    }
  }
  throw new Error('retry_exhausted');
}

function vwap(levels, quoteNotional) {
  let remaining = quoteNotional;
  let base = 0;
  let quote = 0;
  for (const level of levels) {
    const price = Number(level.price);
    const size = Number(level.remaining_base_amount);
    if (!(price > 0) || !(size > 0)) continue;
    const take = Math.min(size, remaining / price);
    base += take;
    quote += take * price;
    remaining -= take * price;
    if (remaining <= 1e-8) return quote / base;
  }
  return null;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

function summary(samples) {
  const values = samples.map((sample) => sample.roundTripCostPct);
  return {
    n: values.length,
    medianPct: percentile(values, 0.5),
    p90Pct: percentile(values, 0.9),
    p95Pct: percentile(values, 0.95),
    maxPct: values.length ? Math.max(...values) : null,
  };
}

const books = await getJson(`${BASE_URL}/api/v1/orderBooks`);
const marketIds = new Map(
  books.order_books
    .filter((book) => book.market_type === 'perp' && book.status === 'active')
    .map((book) => [String(book.symbol).toUpperCase(), Number(book.market_id)]),
);
const samples = Object.fromEntries(symbols.map((symbol) => [symbol, []]));
const missing = symbols.filter((symbol) => !marketIds.has(symbol));
if (missing.length) throw new Error(`Markets not found: ${missing.join(', ')}`);

mkdirSync(dirname(outputFile), { recursive: true });
for (let cycle = 0; cycle < targetSamples; cycle += 1) {
  const startedAt = Date.now();
  for (const symbol of symbols) {
    const marketId = marketIds.get(symbol);
    try {
      const url = new URL(`${BASE_URL}/api/v1/orderBookOrders`);
      url.searchParams.set('market_id', String(marketId));
      url.searchParams.set('limit', '100');
      const body = await getJson(url);
      const asks = [...(body.asks ?? [])].sort((a, b) => Number(a.price) - Number(b.price));
      const bids = [...(body.bids ?? [])].sort((a, b) => Number(b.price) - Number(a.price));
      const bestAsk = Number(asks[0]?.price);
      const bestBid = Number(bids[0]?.price);
      const buyVwap = vwap(asks, notionalUsd);
      const sellVwap = vwap(bids, notionalUsd);
      if (
        !(bestBid > 0)
        || !(bestAsk > bestBid)
        || buyVwap == null
        || sellVwap == null
      ) throw new Error('insufficient_or_invalid_book');
      const mid = (bestBid + bestAsk) / 2;
      samples[symbol].push({
        at: Date.now(),
        marketId,
        notionalUsd,
        bestBid,
        bestAsk,
        buyVwap,
        sellVwap,
        roundTripCostPct: ((buyVwap - sellVwap) / mid) * 100,
      });
    } catch (error) {
      console.error(`${symbol}: ${error.message}`);
    }
    await wait(250);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    targetSamples,
    intervalMs,
    notionalUsd,
    summaries: Object.fromEntries(
      symbols.map((symbol) => [symbol, summary(samples[symbol])]),
    ),
    samples,
  };
  writeFileSync(outputFile, JSON.stringify(result));
  const compact = symbols.map((symbol) => {
    const item = result.summaries[symbol];
    return `${symbol} n${item.n} med ${item.medianPct?.toFixed(4) ?? '—'}% p95 ${item.p95Pct?.toFixed(4) ?? '—'}%`;
  }).join(' · ');
  console.log(`${cycle + 1}/${targetSamples} ${compact}`);

  const remaining = intervalMs - (Date.now() - startedAt);
  if (cycle + 1 < targetSamples && remaining > 0) await wait(remaining);
}
