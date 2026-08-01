/**
 * Read-only, canonical Shadow -> Real promotion audit for Native Quant.
 * It writes evidence only; it never toggles a strategy or sends an order.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  evaluateNativeForwardRows,
  nativePromotionDecision,
  NATIVE_FORWARD_GATE,
  NATIVE_SHADOW_NOTIONAL_USD,
  type NativeForwardPnlRow,
  type NativeForwardSignalRow,
} from '../src/lib/lighter-luxalgo-math.js';
import { evaluateNativeHistoricalEvidence } from '../src/lib/lighter-native-historical.js';

const REAL_NATIVE_IDS: readonly string[] = [];
const SHADOW_NATIVE_IDS = [
  'btc-vwz60-touch',
  'hype-vwz60-touch',
  'xrp-vwz60-touch',
  'xlm-vwz60-touch-er25',
  'data-vwz60-touch',
  'apt-rsi14-pullback-ema400',
  'dot-rsi14-pullback-ema400',
  'hype-rsi14-willr14-ema400',
  'xlm-vwz60-mfi14-ema400',
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
const historicalPath = resolve(
  flagValue('--historical') ?? 'data/lighter-native-current-z60-validation.json',
);
if (!existsSync(historicalPath)) throw new Error(`historical evidence missing: ${historicalPath}`);
const supplementalHistoricalPath = resolve(
  flagValue('--historical-supplement') ?? 'data/lighter-vwz60-holdout-validation.json',
);
if (!existsSync(supplementalHistoricalPath)) {
  throw new Error(`supplemental historical evidence missing: ${supplementalHistoricalPath}`);
}
const xlmSupplementalHistoricalPath = resolve(
  flagValue('--historical-xlm-supplement') ?? 'data/lighter-vwz60-transfer2-validation.json',
);
if (!existsSync(xlmSupplementalHistoricalPath)) {
  throw new Error(`XLM supplemental historical evidence missing: ${xlmSupplementalHistoricalPath}`);
}
const dataSupplementalHistoricalPath = resolve(
  flagValue('--historical-data-supplement')
    ?? 'data/lighter-data-vwz60-1m-rebuild-validation.json',
);
if (!existsSync(dataSupplementalHistoricalPath)) {
  throw new Error(`DATA supplemental historical evidence missing: ${dataSupplementalHistoricalPath}`);
}
const rsiSupplementalHistoricalPath = resolve(
  flagValue('--historical-rsi-supplement')
    ?? 'data/lighter-rsi14-trend-transfer-validation.json',
);
if (!existsSync(rsiSupplementalHistoricalPath)) {
  throw new Error(`RSI supplemental historical evidence missing: ${rsiSupplementalHistoricalPath}`);
}
const hypeConfluenceHistoricalPath = resolve(
  flagValue('--historical-hype-confluence')
    ?? 'data/lighter-hype-confluence-direct5m-validation.json',
);
if (!existsSync(hypeConfluenceHistoricalPath)) {
  throw new Error(`HYPE confluence historical evidence missing: ${hypeConfluenceHistoricalPath}`);
}
const xlmConfluenceHistoricalPath = resolve(
  flagValue('--historical-xlm-confluence')
    ?? 'data/lighter-oscillator-confluence-transfer2-5m-20260801.json',
);
if (!existsSync(xlmConfluenceHistoricalPath)) {
  throw new Error(`XLM confluence historical evidence missing: ${xlmConfluenceHistoricalPath}`);
}
const historicalEvidence = evaluateNativeHistoricalEvidence(
  JSON.parse(readFileSync(historicalPath, 'utf8')) as unknown,
  JSON.parse(readFileSync(supplementalHistoricalPath, 'utf8')) as unknown,
  JSON.parse(readFileSync(xlmSupplementalHistoricalPath, 'utf8')) as unknown,
  JSON.parse(readFileSync(dataSupplementalHistoricalPath, 'utf8')) as unknown,
  JSON.parse(readFileSync(rsiSupplementalHistoricalPath, 'utf8')) as unknown,
  JSON.parse(readFileSync(hypeConfluenceHistoricalPath, 'utf8')) as unknown,
  JSON.parse(readFileSync(xlmConfluenceHistoricalPath, 'utf8')) as unknown,
);
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

const strategies = SHADOW_NATIVE_IDS.map((strategyId) => {
  const historical = historicalEvidence.candidates.find((row) =>
    row.strategyId === strategyId);
  if (!historical) throw new Error(`historical strategy evidence missing: ${strategyId}`);
  return {
    strategyId,
    realExecutorRegistered: REAL_NATIVE_IDS.includes(strategyId),
    historicalEvidence: historical,
    evaluation: evaluateNativeForwardRows(
      pnlStatement.all(strategyId),
      signalStatement.all(strategyId),
    ),
  };
});
const portfolio = evaluateNativeForwardRows(
  portfolioPnls.all(...P2_IDS),
  portfolioSignals.all(...P2_IDS),
  10,
  4,
);

const evaluatedStrategies = strategies.map((row) => ({
  ...row,
  decision: nativePromotionDecision(
    row.evaluation,
    row.realExecutorRegistered,
    row.historicalEvidence.passed,
  ),
}));
const p2Members = P2_IDS.map((strategyId) => {
  const evaluation = evaluateNativeForwardRows(
    pnlStatement.all(strategyId),
    signalStatement.all(strategyId),
  );
  return {
    strategyId,
    realExecutorRegistered: false,
    evaluation,
    decision: nativePromotionDecision(
      evaluation,
      false,
      historicalEvidence.portfolio.passed,
    ),
  };
});
db.close();
const pausedShadowStrategyIds = [...evaluatedStrategies, ...p2Members]
  .filter((row) => row.decision.shadowAction === 'pause_new_entries')
  .map((row) => row.strategyId);
const eligibleStrategyIds = evaluatedStrategies
  .filter((row) =>
    row.realExecutorRegistered
    && row.historicalEvidence.passed
    && row.evaluation.status === 'passed')
  .map((row) => row.strategyId);
const generatedAt = new Date().toISOString();
const report = {
  version: 'lighter-native-promotion-audit-v3',
  generatedAt,
  databasePath,
  gate: NATIVE_FORWARD_GATE,
  shadowNotionalUsd: NATIVE_SHADOW_NOTIONAL_USD,
  eligibleStrategyIds,
  historicalEvidence: {
    version: historicalEvidence.version,
    sourceGeneratedAt: historicalEvidence.sourceGeneratedAt,
    sourceSha256: historicalEvidence.sourceSha256,
    supplementalSourceSha256: historicalEvidence.supplementalSourceSha256,
    xlmSupplementalSourceSha256: historicalEvidence.xlmSupplementalSourceSha256,
    dataSupplementalSourceSha256: historicalEvidence.dataSupplementalSourceSha256,
    rsiSupplementalSourceSha256: historicalEvidence.rsiSupplementalSourceSha256,
    portfolio: historicalEvidence.portfolio,
  },
  p2: {
    portfolioId: 'z60stack25-portfolio',
    realExecutorRegistered: false,
    evaluation: portfolio,
    decision: nativePromotionDecision(
      portfolio,
      false,
      historicalEvidence.portfolio.passed,
    ),
    members: p2Members,
  },
  strategies: evaluatedStrategies,
  pausedShadowStrategyIds,
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
