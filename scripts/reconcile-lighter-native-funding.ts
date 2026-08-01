#!/usr/bin/env tsx

/**
 * Replace provisional Native Shadow funding with exact public Lighter hourly
 * settlements. It never sends an order and never changes price PnL.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  buildLighterFundingSeries,
  fundingSeriesCoverage,
  lighterFundingPnlPct,
  type LighterFundingPoint,
} from '../src/lib/lighter-funding-history.js';

const BASE_URL = process.env.LIGHTER_API_BASE ?? 'https://mainnet.zklighter.elliot.ai';
const HOUR_SECONDS = 3_600;
const CHUNK_SECONDS = 28 * 86_400;
const NATIVE_IDS = [
  'sol-z60-reclaim', 'sol-z60-touch', 'bnb-z60-touch', 'ltc-z60-touch',
  'btc-vwz60-touch', 'hype-vwz60-touch',
  'xrp-vwz60-touch',
  'xlm-vwz60-touch-er25',
  'data-vwz60-touch',
  'apt-rsi14-pullback-ema400', 'dot-rsi14-pullback-ema400',
  'hype-rsi14-willr14-ema400', 'xlm-vwz60-mfi14-ema400',
  'zec-rsi14-willr14-ema400',
  'z60stack25-btc', 'z60stack25-eth', 'z60stack25-sol',
  'z60stack25-bnb', 'z60stack25-ltc', 'z60stack25-hype',
  'z60stack25-zec', 'z60stack25-doge', 'z60stack25-near',
  'z60stack25-jup', 'z60stack25-lit', 'z60stack25-gram',
  'z60stack25-xmr', 'z60stack25-ena', 'z60stack25-tao',
] as const;

type PendingTrade = {
  id: number;
  symbol: string;
  side: 'long' | 'short';
  opened_at: number;
  closed_at: number;
  gross_pnl_pct: number;
};

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function sqlMarks(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

async function getJson(url: URL | string): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'robotclaude-native-funding-reconciler/1.0',
        },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok || Number(body.code) !== 200) {
        throw new Error(`http_${response.status}:${String(body.message ?? body.code)}`);
      }
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 500 * 2 ** attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('funding_api_retry_exhausted');
}

async function activeMarketIds(): Promise<Map<string, number>> {
  const body = await getJson(`${BASE_URL}/api/v1/orderBooks`);
  const rows = Array.isArray(body.order_books) ? body.order_books : [];
  const result = new Map<string, number>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    if (row.market_type !== 'perp' || row.status !== 'active') continue;
    const symbol = String(row.symbol ?? '').toUpperCase();
    const marketId = Number(row.market_id);
    if (symbol && Number.isInteger(marketId)) result.set(symbol, marketId);
  }
  return result;
}

async function fundingPoints(
  marketId: number,
  requiredStartMs: number,
  requiredEndMs: number,
): Promise<LighterFundingPoint[]> {
  const startSeconds = Math.floor(requiredStartMs / 1_000) - HOUR_SECONDS;
  const endSeconds = Math.ceil(requiredEndMs / 1_000) + HOUR_SECONDS;
  const byTimestamp = new Map<number, LighterFundingPoint>();
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
    const rows = Array.isArray(body.fundings) ? body.fundings : [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const timestampMs = Number(row.timestamp) * 1_000;
      const ratePctH = Math.abs(Number(row.rate));
      const direction = String(row.direction ?? '').toLowerCase();
      if (
        timestampMs > 0
        && Number.isFinite(ratePctH)
        && (direction === 'long' || direction === 'short')
      ) {
        byTimestamp.set(timestampMs, {
          timestampMs,
          ratePctH,
          direction,
        });
      }
    }
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestampMs - right.timestampMs);
}

const databasePath = resolve(flagValue('--db') ?? 'data/trading.sqlite');
if (!existsSync(databasePath)) throw new Error(`trading database missing: ${databasePath}`);
const db = new Database(databasePath, { fileMustExist: true });
db.pragma('busy_timeout = 5000');
const columns = new Set(
  (db.pragma('table_info(lighter_lux_trades)') as Array<{ name: string }>).map((row) => row.name),
);
if (!columns.has('funding_source') || !columns.has('funding_reconciled_at')) {
  db.close();
  throw new Error('migration 062_lighter_native_exact_funding.sql is not applied');
}

const pending = db.prepare<string[], PendingTrade>(`
  SELECT id, symbol, side, opened_at, closed_at, gross_pnl_pct
  FROM lighter_lux_trades
  WHERE strategy_id IN (${sqlMarks(NATIVE_IDS.length)})
    AND closed_at IS NOT NULL
    AND gross_pnl_pct IS NOT NULL
    AND funding_source != 'lighter_api_settlements'
  ORDER BY closed_at, id
`).all(...NATIVE_IDS);

if (!pending.length) {
  db.close();
  console.log(JSON.stringify({ status: 'up_to_date', reconciled: 0 }));
  process.exit(0);
}

const marketIds = await activeMarketIds();
const bySymbol = new Map<string, PendingTrade[]>();
for (const trade of pending) {
  const symbol = trade.symbol.toUpperCase().replace(/USDT$/, '');
  const rows = bySymbol.get(symbol) ?? [];
  rows.push(trade);
  bySymbol.set(symbol, rows);
}

const updates: Array<{ id: number; fundingPct: number; netPct: number }> = [];
const failures: string[] = [];
for (const [symbol, trades] of bySymbol) {
  try {
    const marketId = marketIds.get(symbol);
    if (marketId == null) throw new Error('active perp market not found');
    const requiredStartMs = Math.min(...trades.map((trade) => trade.opened_at));
    const requiredEndMs = Math.max(...trades.map((trade) => trade.closed_at));
    const series = buildLighterFundingSeries(
      await fundingPoints(marketId, requiredStartMs, requiredEndMs),
    );
    const coverage = fundingSeriesCoverage(series, requiredStartMs, requiredEndMs);
    if (!coverage.covered) {
      throw new Error(
        `settlement coverage ${(coverage.internalCoverage * 100).toFixed(2)}% does not span trades`,
      );
    }
    for (const trade of trades) {
      const fundingPct = lighterFundingPnlPct(
        series,
        trade.side,
        trade.opened_at,
        trade.closed_at,
      );
      updates.push({
        id: trade.id,
        fundingPct,
        netPct: trade.gross_pnl_pct + fundingPct,
      });
    }
  } catch (error) {
    failures.push(`${symbol}: ${(error as Error).message}`);
  }
}

const update = db.prepare(`
  UPDATE lighter_lux_trades
  SET funding_pnl_pct = ?, net_pnl_pct = ?,
      funding_source = 'lighter_api_settlements', funding_reconciled_at = ?
  WHERE id = ? AND funding_source != 'lighter_api_settlements'
`);
const reconciledAt = Date.now();
const apply = db.transaction(() => {
  let changed = 0;
  for (const row of updates) {
    changed += update.run(row.fundingPct, row.netPct, reconciledAt, row.id).changes;
  }
  return changed;
});
const reconciled = apply();
db.close();

console.log(JSON.stringify({
  status: failures.length ? 'partial' : 'ok',
  pending: pending.length,
  reconciled,
  failures,
}, null, 2));
if (failures.length) process.exitCode = 1;
