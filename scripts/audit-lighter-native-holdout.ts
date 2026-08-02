import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  reservedHoldoutLeaks,
  type JsonReport,
} from '../src/lib/lighter-native-holdout.js';

type Candle = { t?: number };
type Ledger = {
  version: string;
  reservedSymbols: string[];
  performanceOpened: boolean;
  files: {
    candleDirectory: string;
    executionCosts: string;
    fundingHistory: string;
  };
  requirements: {
    minimumCoverageDays: number;
    minimumCandleCoverageRatio: number;
    minimumCostSamples: number;
    minimumFundingCoverageRatio: number;
  };
};

const ledgerPath = resolve(process.argv[2] ?? 'data/lighter-native-holdout-ledger.json');
const outputPath = process.argv[3] ? resolve(process.argv[3]) : null;
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger;
if (ledger.version !== 'lighter-native-holdout-ledger-v1') {
  throw new Error(`Unexpected holdout ledger version: ${ledger.version}`);
}

const dataDirectory = resolve('data');
const reports: JsonReport[] = [];
for (const file of readdirSync(dataDirectory)) {
  if (!file.endsWith('.json') || resolve(dataDirectory, file) === ledgerPath) continue;
  try {
    reports.push({
      file: `data/${file}`,
      content: JSON.parse(readFileSync(resolve(dataDirectory, file), 'utf8')) as unknown,
    });
  } catch {
    // Partially written/unrelated research JSON is not promotion evidence.
  }
}
const leaks = reservedHoldoutLeaks(reports, ledger.reservedSymbols);
const failures: string[] = [];
if (!ledger.performanceOpened && Object.keys(leaks).length) {
  failures.push(`sealed holdout leaked into performance reports: ${JSON.stringify(leaks)}`);
}

const execution = JSON.parse(readFileSync(resolve(ledger.files.executionCosts), 'utf8')) as {
  summaries?: Record<string, { n?: number; p95Pct?: number }>;
};
const funding = JSON.parse(readFileSync(resolve(ledger.files.fundingHistory), 'utf8')) as {
  symbols?: Record<string, { internalCoverage?: number }>;
};
const readiness: Record<string, unknown> = {};
for (const symbol of ledger.reservedSymbols) {
  const candleReadiness: Record<string, unknown> = {};
  for (const timeframe of [1, 5]) {
    const path = resolve(ledger.files.candleDirectory, `${symbol}-${timeframe}m.json`);
    if (!existsSync(path)) {
      failures.push(`${symbol} ${timeframe}m candles missing`);
      continue;
    }
    const candles = JSON.parse(readFileSync(path, 'utf8')) as Candle[];
    const timestamps = candles
      .map((candle) => Number(candle.t))
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0)
      .sort((left, right) => left - right);
    const first = timestamps[0] ?? 0;
    const last = timestamps.at(-1) ?? 0;
    const stepMs = timeframe * 60_000;
    const expected = first && last > first ? Math.floor((last - first) / stepMs) + 1 : 0;
    const coverageRatio = expected ? new Set(timestamps).size / expected : 0;
    const durationDays = first && last > first ? (last - first) / 86_400_000 : 0;
    candleReadiness[`${timeframe}m`] = {
      candles: timestamps.length,
      durationDays,
      coverageRatio,
      first: first ? new Date(first).toISOString() : null,
      last: last ? new Date(last).toISOString() : null,
    };
    if (durationDays < ledger.requirements.minimumCoverageDays) {
      failures.push(`${symbol} ${timeframe}m coverage ${durationDays.toFixed(3)}d too short`);
    }
    if (coverageRatio < ledger.requirements.minimumCandleCoverageRatio) {
      failures.push(`${symbol} ${timeframe}m candle ratio ${coverageRatio.toFixed(6)} too low`);
    }
  }
  const cost = execution.summaries?.[symbol];
  const fundingCoverage = funding.symbols?.[symbol]?.internalCoverage ?? 0;
  if ((cost?.n ?? 0) < ledger.requirements.minimumCostSamples) {
    failures.push(`${symbol} execution samples ${cost?.n ?? 0} too few`);
  }
  if (!Number.isFinite(cost?.p95Pct)) failures.push(`${symbol} execution p95 missing`);
  if (fundingCoverage < ledger.requirements.minimumFundingCoverageRatio) {
    failures.push(`${symbol} funding coverage ${fundingCoverage.toFixed(6)} too low`);
  }
  readiness[symbol] = {
    candles: candleReadiness,
    executionCostSamples: cost?.n ?? 0,
    executionCostP95Pct: cost?.p95Pct ?? null,
    fundingCoverage,
  };
}

const output = {
  version: 'lighter-native-holdout-audit-v1',
  generatedAt: new Date().toISOString(),
  ledgerPath: relative(process.cwd(), ledgerPath),
  status: failures.length ? 'failed' : 'sealed_ready',
  performanceOpened: ledger.performanceOpened,
  reservedSymbols: ledger.reservedSymbols,
  leaks,
  readiness,
  failures,
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (outputPath) {
  const temporary = `${outputPath}.tmp`;
  writeFileSync(temporary, serialized);
  renameSync(temporary, outputPath);
}
console.log(serialized.trimEnd());
if (failures.length) process.exitCode = 1;
