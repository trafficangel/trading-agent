/**
 * Read-only prospective promotion audit for immutable L2 Shadow candidates.
 * It cannot enable Real or send orders.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  NATIVE_FORWARD_GATE,
} from '../src/lib/lighter-luxalgo-math.js';
import {
  evaluateMicrostructureForwardTrades,
  microstructureCandidateKey,
  type MicrostructureShadowCandidate,
  type MicrostructureShadowReport,
} from '../src/lib/lighter-microstructure-shadow.js';
import type { MicroTrade } from '../src/lib/lighter-microstructure-research.js';

const MAX_AUDIT_AGE_MS = 2 * 3_600_000;

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, path);
}

function decision(
  evaluation: ReturnType<typeof evaluateMicrostructureForwardTrades>,
  dataHealthy: boolean,
) {
  if (!evaluation.entryAllowed) return {
    shadowAction: 'pause_new_entries',
    realAction: 'disabled',
    manualReviewRequired: true,
  };
  if (evaluation.status === 'passed' && dataHealthy) return {
    shadowAction: 'continue',
    realAction: 'manual_canary_implementation_review',
    manualReviewRequired: true,
  };
  return {
    shadowAction: 'continue',
    realAction: 'disabled',
    manualReviewRequired: false,
  };
}

const shadowPath = resolve(
  flagValue('--shadow') ?? 'data/lighter-native-microstructure-shadow-report.json',
);
const auditPath = resolve(
  flagValue('--data-audit') ?? 'data/lighter-native-microstructure-audit.json',
);
const outputPath = resolve(
  flagValue('--output') ?? 'data/lighter-native-microstructure-promotion-audit.json',
);
const generatedAt = new Date().toISOString();
let existingAudit: Record<string, unknown> | null = null;
if (existsSync(outputPath)) {
  const value = readJson(outputPath);
  if (value && typeof value === 'object') existingAudit = value as Record<string, unknown>;
}

function existingCandidatePause(candidateKey: string): string | null {
  const candidates = Array.isArray(existingAudit?.candidates) ? existingAudit.candidates : [];
  for (const value of candidates) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (row.candidateKey !== candidateKey) continue;
    const pausedAt = String(row.pausedAt ?? '');
    if (Number.isFinite(Date.parse(pausedAt))) return pausedAt;
  }
  return null;
}

function existingPortfolioPause(): string | null {
  const portfolio = existingAudit?.portfolio;
  if (!portfolio || typeof portfolio !== 'object') return null;
  const pausedAt = String((portfolio as Record<string, unknown>).pausedAt ?? '');
  return Number.isFinite(Date.parse(pausedAt)) ? pausedAt : null;
}

if (!existsSync(shadowPath)) {
  const report = {
    version: 'lighter-microstructure-promotion-audit-v1',
    generatedAt,
    status: 'not_ready',
    failures: ['prospective Shadow report missing'],
    eligibleCandidateIds: [],
    autoPromotion: false,
    realEnabled: false,
  };
  writeAtomic(outputPath, report);
  console.log(JSON.stringify(report));
  process.exit(0);
}

const shadow = readJson(shadowPath) as Partial<MicrostructureShadowReport>;
if (
  shadow.version !== 'lighter-microstructure-shadow-report-v2'
  || shadow.prospectiveOnly !== true
  || shadow.exactFunding !== true
  || shadow.autoPromotion !== false
  || shadow.realEnabled !== false
  || !Array.isArray(shadow.candidates)
  || !Array.isArray(shadow.closedTrades)
) throw new Error('invalid prospective microstructure Shadow report');

let dataHealthy = false;
let dataAuditGeneratedAt: string | null = null;
const dataFailures: string[] = [];
if (!existsSync(auditPath)) {
  dataFailures.push('microstructure data audit missing');
} else {
  const audit = readJson(auditPath) as {
    generatedAt?: string;
    gates?: { collectionHealthy?: { passed?: boolean; failures?: string[] } };
  };
  dataAuditGeneratedAt = audit.generatedAt ?? null;
  const ageMs = Date.now() - Date.parse(audit.generatedAt ?? '');
  if (!Number.isFinite(ageMs) || ageMs > MAX_AUDIT_AGE_MS) {
    dataFailures.push('microstructure data audit stale');
  }
  if (audit.gates?.collectionHealthy?.passed !== true) {
    dataFailures.push(...(audit.gates?.collectionHealthy?.failures ?? ['collection unhealthy']));
  }
  dataHealthy = dataFailures.length === 0;
}

const trades = shadow.closedTrades as MicroTrade[];
const candidates = shadow.candidates as MicrostructureShadowCandidate[];
const evaluations = candidates.map((candidate) => {
  const candidateTrades = trades.filter((trade) =>
    trade.ruleId === candidate.ruleId && trade.barMinutes === candidate.timeframeMinutes);
  const evaluation = evaluateMicrostructureForwardTrades(candidateTrades, 1);
  const candidateKey = microstructureCandidateKey(candidate);
  const pausedAt = existingCandidatePause(candidateKey)
    ?? (!evaluation.entryAllowed ? generatedAt : null);
  return {
    candidateKey,
    candidate,
    evaluation,
    pausedAt,
    decision: pausedAt == null
      ? decision(evaluation, dataHealthy)
      : {
        shadowAction: 'pause_new_entries',
        realAction: 'disabled',
        manualReviewRequired: true,
      },
  };
});
const portfolioEvaluation = evaluateMicrostructureForwardTrades(trades, 10);
const portfolioPausedAt = existingPortfolioPause()
  ?? (!portfolioEvaluation.entryAllowed ? generatedAt : null);
const eligibleCandidateIds = dataHealthy
  ? evaluations
    .filter((row) => row.evaluation.status === 'passed' && row.pausedAt == null)
    .map((row) => row.candidateKey)
  : [];
const report = {
  version: 'lighter-microstructure-promotion-audit-v1',
  generatedAt,
  status: candidates.length ? 'evaluated' : 'waiting_for_candidates',
  shadowReportGeneratedAt: shadow.generatedAt,
  shadowNotionalUsd: 100,
  gate: NATIVE_FORWARD_GATE,
  dataHealth: {
    passed: dataHealthy,
    auditGeneratedAt: dataAuditGeneratedAt,
    failures: dataFailures,
  },
  eligibleCandidateIds,
  candidates: evaluations,
  portfolio: {
    evaluation: portfolioEvaluation,
    pausedAt: portfolioPausedAt,
    decision: portfolioPausedAt == null
      ? decision(portfolioEvaluation, dataHealthy)
      : {
        shadowAction: 'pause_new_entries',
        realAction: 'disabled',
        manualReviewRequired: true,
      },
  },
  permanentPauses: true,
  exactFunding: true,
  measuredExecutionCosts: true,
  autoPromotion: false,
  realEnabled: false,
};
writeAtomic(outputPath, report);
console.log(JSON.stringify(report));
