/**
 * Maximum Adverse Excursion (MAE) backfill.
 *
 * Problem with the realized-loss method: it only sees the close price.
 * A trade that drew down −15% mid-life and bounced to exit at −2% looks
 * like a «small loser» — but a 5% safety SL would have force-closed it
 * during the −15% excursion, turning a small loss into a 5% loss.
 *
 * This script fetches 5-minute klines from Bybit between each trade's
 * entry_at and exit_at, finds the worst price against the position
 * (low for long, high for short), and saves the MAE back into the
 * strategy's tradesLog JSON. Subsequent SL-distribution audits then
 * use MAE instead of realized loss → cut rates reflect what a safety
 * SL would TRULY have done.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-mae.ts                    # all strategies
 *   pnpm tsx scripts/backfill-mae.ts <strategy-id>      # one
 *   pnpm tsx scripts/backfill-mae.ts --force            # re-fetch even if already cached
 *
 * Idempotent — trades already containing `maePct` are skipped unless
 * --force is passed.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { request } from 'undici';

const BASE = 'https://api.bybit.com';
const FETCH_INTERVAL = '5'; // 5-minute candles — good MAE granularity for all our timeframes
const FETCH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_LIMIT = 1000; // Bybit V5 kline max page size
const RATE_LIMIT_DELAY_MS = 90; // ~10 req/s, conservative vs the 600/5s limit

type Kline = { start: number; open: number; high: number; low: number; close: number };

type Trade = {
  num: number;
  side: 'long' | 'short';
  entryAt: number;
  entryPrice: number;
  exitAt: number;
  exitPrice: number;
  netPnlUsdt?: number;
  cumulativePnlUsdt?: number;
  // populated by this script:
  maePct?: number;   // % drawdown from entry (positive magnitude)
  maePrice?: number; // worst price during trade life
  maeAt?: number;    // when the worst price occurred
  // realized loss (signed), cached for convenience
  realizedPct?: number;
};

type StrategyFile = {
  url?: string;
  scrapedAt?: number;
  tradesLog: Trade[];
  // …other top-level fields preserved as-is
  [k: string]: unknown;
};

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch klines covering [start, end] for symbol. Paginates if the range
 * exceeds MAX_LIMIT bars. Returns oldest-first.
 */
async function fetchKlinesRange(symbol: string, start: number, end: number): Promise<Kline[]> {
  const out: Kline[] = [];
  let cursor = start;
  while (cursor <= end) {
    const pageEnd = Math.min(end, cursor + (MAX_LIMIT - 1) * FETCH_INTERVAL_MS);
    const url =
      `${BASE}/v5/market/kline?category=linear&symbol=${symbol}` +
      `&interval=${FETCH_INTERVAL}&start=${cursor}&end=${pageEnd}&limit=${MAX_LIMIT}`;
    const res = await request(url, { method: 'GET', headersTimeout: 8_000, bodyTimeout: 8_000 });
    const body = (await res.body.json()) as { retCode: number; result?: { list?: string[][] } };
    if (body.retCode !== 0 || !body.result?.list) {
      throw new Error(`bybit retCode=${body.retCode} for ${symbol} ${cursor}-${pageEnd}`);
    }
    const page = body.result.list
      .map((k) => ({
        start: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
      }))
      .filter((k) => Number.isFinite(k.close))
      .sort((a, b) => a.start - b.start);
    if (page.length === 0) break;
    out.push(...page);
    const last = page[page.length - 1]!.start;
    if (last >= end || page.length < MAX_LIMIT) break;
    cursor = last + FETCH_INTERVAL_MS;
    await sleep(RATE_LIMIT_DELAY_MS);
  }
  return out;
}

/**
 * Compute MAE for a single trade.
 *
 *   long  → MAE = (entry − minLow)  / entry  × 100
 *   short → MAE = (maxHigh − entry) / entry × 100
 *
 * Always positive. 0 means the trade never went underwater.
 */
function computeMae(trade: Trade, klines: Kline[]): { mae: number; price: number; at: number } {
  if (klines.length === 0) return { mae: 0, price: trade.entryPrice, at: trade.entryAt };
  let worstPrice = trade.entryPrice;
  let worstAt = trade.entryAt;
  if (trade.side === 'long') {
    for (const k of klines) {
      if (k.low < worstPrice) {
        worstPrice = k.low;
        worstAt = k.start;
      }
    }
    return {
      mae: ((trade.entryPrice - worstPrice) / trade.entryPrice) * 100,
      price: worstPrice,
      at: worstAt,
    };
  } else {
    for (const k of klines) {
      if (k.high > worstPrice) {
        worstPrice = k.high;
        worstAt = k.start;
      }
    }
    return {
      mae: ((worstPrice - trade.entryPrice) / trade.entryPrice) * 100,
      price: worstPrice,
      at: worstAt,
    };
  }
}

async function backfillStrategy(strategyId: string, symbol: string, force: boolean): Promise<void> {
  const path = resolve('src/strategies/data', `${strategyId}.json`);
  if (!existsSync(path)) {
    console.error(`  ⚠ ${strategyId}: no data file at ${path}`);
    return;
  }
  const data = JSON.parse(readFileSync(path, 'utf8')) as StrategyFile;
  const trades = data.tradesLog;
  if (!Array.isArray(trades) || trades.length === 0) {
    console.error(`  ⚠ ${strategyId}: empty tradesLog`);
    return;
  }

  const todo = trades.filter((t) => force || typeof t.maePct !== 'number');
  console.log(`  ${strategyId} (${symbol}): ${todo.length}/${trades.length} trades to backfill`);
  if (todo.length === 0) return;

  let done = 0;
  for (const t of trades) {
    if (!force && typeof t.maePct === 'number') continue;
    try {
      // Pad the range by one interval on each side so we don't miss the
      // exact entry/exit bar.
      const start = t.entryAt - FETCH_INTERVAL_MS;
      const end = t.exitAt + FETCH_INTERVAL_MS;
      const klines = await fetchKlinesRange(symbol, start, end);
      const { mae, price, at } = computeMae(t, klines);
      t.maePct = Math.round(mae * 100) / 100;
      t.maePrice = price;
      t.maeAt = at;
      // Cache realized loss for convenience
      const sign = t.side === 'long' ? 1 : -1;
      t.realizedPct = Math.round(sign * ((t.exitPrice - t.entryPrice) / t.entryPrice) * 10000) / 100;
      done++;
      if (done % 10 === 0) console.log(`    …${done}/${todo.length} done (latest: trade #${t.num}, MAE=${t.maePct.toFixed(2)}%)`);
      await sleep(RATE_LIMIT_DELAY_MS);
    } catch (err) {
      console.error(`    ✗ trade #${t.num}:`, (err as Error).message);
    }
  }

  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`  ✅ ${strategyId}: wrote ${done} MAE values to ${path}`);
}

const SYMBOL_OVERRIDES: Record<string, string> = {
  // strategy-id → bybit symbol. Falls back to id-derived guess if absent.
};

function symbolForStrategy(strategyId: string): string | null {
  if (SYMBOL_OVERRIDES[strategyId]) return SYMBOL_OVERRIDES[strategyId];
  // crude: pull leading token from slug. bnb-cntr-tt-mf50 → BNB → BNBUSDT.
  const m = strategyId.match(/^([a-z]+)-/i);
  if (!m) return null;
  return m[1]!.toUpperCase() + 'USDT';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const idArg = args.find((a) => !a.startsWith('-')) ?? null;

  const allFiles = readdirSync('src/strategies/data').filter((f) => f.endsWith('.json'));
  const targets = idArg ? [idArg] : allFiles.map((f) => f.replace(/\.json$/, ''));

  console.log(`MAE backfill — interval ${FETCH_INTERVAL}m, force=${force}\n`);

  for (const id of targets) {
    const sym = symbolForStrategy(id);
    if (!sym) {
      console.error(`  ✗ ${id}: cannot infer Bybit symbol; add to SYMBOL_OVERRIDES`);
      continue;
    }
    try {
      await backfillStrategy(id, sym, force);
    } catch (err) {
      console.error(`  ✗ ${id}:`, (err as Error).message);
    }
  }
  console.log(`\nDone. Run pnpm tsx scripts/audit-sl-distribution.ts to re-audit with MAE.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
