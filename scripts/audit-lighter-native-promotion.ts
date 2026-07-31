/**
 * Read-only, canonical Shadow -> Real promotion audit for Native Quant.
 * It writes evidence only; it never toggles a strategy or sends an order.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  evaluateNativeForwardRows,
  NATIVE_FORWARD_GATE,
  NATIVE_SHADOW_NOTIONAL_USD,
  type NativeForwardGateEvaluation,
  type NativeForwardPnlRow,
  type NativeForwardSignalRow,
} from '../src/lib/lighter-luxalgo-math.js';

const REAL_NATIVE_IDS = [
  'sol-z60-reclaim',
  'bnb-z60-touch',
  'ltc-z60-touch',
] as const;
const SHADOW_NATIVE_IDS = [
  ...REAL_NATIVE_IDS,
  'sol-z60-touch',
  'btc-vwz60-touch',
  'hype-vwz60-touch',
] as const;
const P2_IDS = [
  'z60stack25-btc', 'z60stack25-eth', 'z60stack25-sol',
  'z60stack25-bnb', 'z60stack25-ltc', 'z60stack25-hype',
  'z60stack25-zec', 'z60stack25-doge', 'z60stack25-near',
  'z60stack25-jup', 'z60stack25-lit', 'z60stack25-gram',
  'z60stack25-xmr', 'z60stack25-ena', 'z60stack25-tao',
] as const;

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function sqlMarks(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

const databasePath = resolve(flagValue('--db') ?? 'data/trading.sqlite');
if (!existsSync(databasePath)) throw new Error(`trading database missing: ${databasePath}`);
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const pnlStatement = db.prepare<[string], NativeForwardPnlRow>(`
  SELECT net_pnl_pct, side, symbol, opened_at, closed_at FROM lighter_lux_trades
  WHERE strategy_id = ? AND notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}
    AND closed_at IS NOT NULL AND net_pnl_pct IS NOT NULL
    AND funding_source = 'lighter_api_settlements'
  ORDER BY closed_at, id`);
const signalStatement = db.prepare<[string], NativeForwardSignalRow>(`
  SELECT capture_status, book_age_ms, bid, ask,
         buy_slippage_pct, sell_slippage_pct
  FROM lighter_lux_signals WHERE strategy_id = ?
    AND execution_notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}
  ORDER BY received_at, id`);
const portfolioPnls = db.prepare<string[], NativeForwardPnlRow>(`
  SELECT net_pnl_pct, side, symbol, opened_at, closed_at FROM lighter_lux_trades
  WHERE strategy_id IN (${sqlMarks(P2_IDS.length)})
    AND notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}
    AND closed_at IS NOT NULL AND net_pnl_pct IS NOT NULL
    AND funding_source = 'lighter_api_settlements'
  ORDER BY closed_at, id`);
const portfolioSignals = db.prepare<string[], NativeForwardSignalRow>(`
  SELECT capture_status, book_age_ms, bid, ask,
         buy_slippage_pct, sell_slippage_pct
  FROM lighter_lux_signals
  WHERE strategy_id IN (${sqlMarks(P2_IDS.length)})
    AND execution_notional_usd = ${NATIVE_SHADOW_NOTIONAL_USD}
  ORDER BY received_at, id`);

const strategies = SHADOW_NATIVE_IDS.map((strategyId) => ({
  strategyId,
  realExecutorRegistered: REAL_NATIVE_IDS.includes(
    strategyId as (typeof REAL_NATIVE_IDS)[number],
  ),
  evaluation: evaluateNativeForwardRows(
    pnlStatement.all(strategyId),
    signalStatement.all(strategyId),
  ),
}));
const portfolio = evaluateNativeForwardRows(
  portfolioPnls.all(...P2_IDS),
  portfolioSignals.all(...P2_IDS),
  10,
  4,
);
db.close();

function decision(
  evaluation: NativeForwardGateEvaluation,
  realExecutorRegistered: boolean,
) {
  const operationalPause = evaluation.reasons.every((reason) =>
    reason.startsWith('recent ') && (
      reason.includes('capture errors')
      || reason.includes('book-age samples')
      || reason.includes('book age p95')
    ));
  if (!evaluation.entryAllowed) return {
    shadowAction: 'pause_new_entries',
    realAction: 'disabled',
    recoverableFromNewSignals: operationalPause,
    manualReviewRequired: !operationalPause,
  };
  if (evaluation.status === 'passed' && realExecutorRegistered) return {
    shadowAction: 'continue',
    realAction: 'manual_canary_review',
    recoverableFromNewSignals: false,
    manualReviewRequired: true,
  };
  return {
    shadowAction: 'continue',
    realAction: 'disabled',
    recoverableFromNewSignals: false,
    manualReviewRequired: false,
  };
}

const evaluatedStrategies = strategies.map((row) => ({
  ...row,
  decision: decision(row.evaluation, row.realExecutorRegistered),
}));
const eligibleStrategyIds = evaluatedStrategies
  .filter((row) => row.realExecutorRegistered && row.evaluation.status === 'passed')
  .map((row) => row.strategyId);
const generatedAt = new Date().toISOString();
const report = {
  version: 'lighter-native-promotion-audit-v2',
  generatedAt,
  databasePath,
  gate: NATIVE_FORWARD_GATE,
  shadowNotionalUsd: NATIVE_SHADOW_NOTIONAL_USD,
  eligibleStrategyIds,
  p2: {
    portfolioId: 'z60stack25-portfolio',
    realExecutorRegistered: false,
    evaluation: portfolio,
    decision: decision(portfolio, false),
  },
  strategies: evaluatedStrategies,
  autoPromotion: false,
};
const serialized = JSON.stringify(report, null, 2);
const outputPath = flagValue('--output');
if (outputPath) {
  const absolute = resolve(outputPath);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp`;
  writeFileSync(temporary, serialized);
  renameSync(temporary, absolute);
}
console.log(serialized);
