import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  reservedHoldoutLeaks,
  type JsonReport,
  undeclaredHoldoutLeaks,
} from '../src/lib/lighter-native-holdout.js';

type Candle = { t?: number };
type EvidenceRef = { file: string; sha256: string };
type Ledger = {
  version: string;
  generation?: number;
  reservedSymbols: string[];
  performanceOpened: boolean;
  openedAt?: string;
  preregistration?: EvidenceRef;
  performanceArtifacts?: EvidenceRef[];
  files: {
    candleDirectory: string;
    executionCosts: string;
    fundingHistory: string;
  };
  selection?: {
    audit?: string;
    auditSha256?: string;
  };
  sealedReadinessEvidence?: {
    audit?: string;
    auditSha256?: string;
    executionCostsSha256?: string;
    fundingHistorySha256?: string;
    candleHashes?: Record<string, string>;
    candleArchives?: Record<string, EvidenceRef>;
  };
  requirements: {
    minimumCoverageDays: number;
    minimumCandleCoverageRatio: number;
    minimumCostSamples: number;
    minimumFundingCoverageRatio: number;
  };
};

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyEvidenceRef(
  evidence: EvidenceRef | undefined,
  label: string,
  failures: string[],
): void {
  if (!evidence || typeof evidence.file !== 'string' || typeof evidence.sha256 !== 'string') {
    failures.push(`${label} evidence missing`);
    return;
  }
  const path = resolve(evidence.file);
  if (!existsSync(path)) {
    failures.push(`${label} file missing: ${evidence.file}`);
    return;
  }
  const actual = fileSha256(path);
  if (actual !== evidence.sha256) {
    failures.push(`${label} hash mismatch: ${evidence.file}`);
  }
}

function verifyExpectedHash(
  file: string,
  expected: string | undefined,
  label: string,
  failures: string[],
): void {
  if (typeof expected !== 'string' || !expected) {
    failures.push(`${label} sealed hash missing`);
    return;
  }
  const path = resolve(file);
  if (!existsSync(path)) {
    failures.push(`${label} file missing: ${file}`);
    return;
  }
  if (fileSha256(path) !== expected) failures.push(`${label} sealed hash mismatch: ${file}`);
}

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
const sealed = ledger.sealedReadinessEvidence;
if (!sealed) {
  failures.push('sealed readiness evidence missing');
} else {
  verifyExpectedHash(
    ledger.files.executionCosts,
    sealed.executionCostsSha256,
    'execution costs',
    failures,
  );
  verifyExpectedHash(
    ledger.files.fundingHistory,
    sealed.fundingHistorySha256,
    'funding history',
    failures,
  );
  for (const symbol of ledger.reservedSymbols) {
    for (const timeframe of [1, 5]) {
      const key = `${symbol}-${timeframe}m`;
      const expectedCandleHash = sealed.candleHashes?.[key];
      const candlePath = resolve(ledger.files.candleDirectory, `${key}.json`);
      const archive = sealed.candleArchives?.[key];
      if (existsSync(candlePath)) {
        verifyExpectedHash(candlePath, expectedCandleHash, `${key} candles`, failures);
      } else if (!archive) {
        failures.push(`${key} candles and sealed archive missing`);
      }
      if (archive) {
        verifyExpectedHash(archive.file, archive.sha256, `${key} archive`, failures);
        if (existsSync(resolve(archive.file)) && expectedCandleHash) {
          try {
            const uncompressedHash = createHash('sha256')
              .update(gunzipSync(readFileSync(resolve(archive.file))))
              .digest('hex');
            if (uncompressedHash !== expectedCandleHash) {
              failures.push(`${key} archive content hash mismatch: ${archive.file}`);
            }
          } catch {
            failures.push(`${key} archive cannot be decompressed: ${archive.file}`);
          }
        }
      } else if ((ledger.generation ?? 1) >= 2) {
        failures.push(`${key} sealed archive missing`);
      }
    }
  }
  if (sealed.audit || sealed.auditSha256) {
    verifyExpectedHash(
      sealed.audit ?? '',
      sealed.auditSha256,
      'sealed readiness audit',
      failures,
    );
  }
}
if (ledger.selection?.audit || ledger.selection?.auditSha256) {
  verifyExpectedHash(
    ledger.selection.audit ?? '',
    ledger.selection.auditSha256,
    'holdout selection audit',
    failures,
  );
}
if (!ledger.performanceOpened && Object.keys(leaks).length) {
  failures.push(`sealed holdout leaked into performance reports: ${JSON.stringify(leaks)}`);
}
if (ledger.performanceOpened) {
  const openedAt = Date.parse(ledger.openedAt ?? '');
  if (!Number.isFinite(openedAt)) failures.push('opened holdout timestamp missing or invalid');
  verifyEvidenceRef(ledger.preregistration, 'preregistration', failures);
  if (!Array.isArray(ledger.performanceArtifacts) || !ledger.performanceArtifacts.length) {
    failures.push('opened holdout performance artifacts missing');
  } else {
    for (const [index, artifact] of ledger.performanceArtifacts.entries()) {
      verifyEvidenceRef(artifact, `performance artifact ${index + 1}`, failures);
    }
    const undeclared = undeclaredHoldoutLeaks(
      leaks,
      ledger.performanceArtifacts.map((artifact) => artifact.file),
    );
    if (Object.keys(undeclared).length) {
      failures.push(`opened holdout has undeclared performance reports: ${JSON.stringify(undeclared)}`);
    }
  }
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
    const archive = ledger.sealedReadinessEvidence?.candleArchives?.[`${symbol}-${timeframe}m`];
    let candleJson: string | null = null;
    try {
      candleJson = existsSync(path)
        ? readFileSync(path, 'utf8')
        : archive && existsSync(resolve(archive.file))
          ? gunzipSync(readFileSync(resolve(archive.file))).toString('utf8')
          : null;
    } catch {
      failures.push(`${symbol} ${timeframe}m candles unreadable`);
    }
    if (candleJson == null) {
      failures.push(`${symbol} ${timeframe}m candles missing`);
      continue;
    }
    const candles = JSON.parse(candleJson) as Candle[];
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
  status: failures.length
    ? 'failed'
    : ledger.performanceOpened
      ? 'spent_verified'
      : 'sealed_ready',
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
