import { createHash } from 'node:crypto';
import {
  type MicroFeatureBar,
  type MicroTrade,
  existingImmutableFrozenMicrostructureReport,
  PREREGISTERED_MICRO_CHALLENGERS,
  PREREGISTERED_MICRO_RULES,
  simulateMicrostructureRule,
} from './lighter-microstructure-research.js';
import type { LighterFundingSeries } from './lighter-funding-history.js';
import {
  evaluateNativeForwardGate,
  type NativeForwardGateEvaluation,
} from './lighter-luxalgo-math.js';

export const MICROSTRUCTURE_SHADOW_MANIFEST_VERSION =
  'lighter-microstructure-shadow-manifest-v2';

export type MicrostructureSuite = 'core' | 'challenger';

export type MicrostructureFrozenSource = {
  suite: MicrostructureSuite;
  version: string;
  report: unknown;
};

export type MicrostructureShadowCandidate = {
  id: string;
  suite: MicrostructureSuite;
  timeframeMinutes: 1 | 5;
  ruleId: string;
};

export function microstructureCandidateKey(candidate: MicrostructureShadowCandidate): string {
  return `${candidate.suite}:${candidate.id}`;
}

export type MicrostructureEntryPauses = {
  portfolioPausedAtMs?: number | null;
  candidatePausedAtMs?: ReadonlyMap<string, number>;
};

export type MicrostructureShadowFrozenSource = {
  suite: MicrostructureSuite;
  version: string;
  sha256: string;
  selectionEpochAt: string;
};

export type MicrostructureShadowManifest = {
  version: typeof MICROSTRUCTURE_SHADOW_MANIFEST_VERSION;
  status: 'active' | 'no_candidates';
  frozenReportSha256: string;
  frozenSources: MicrostructureShadowFrozenSource[];
  selectionEpochAt: string;
  activatedAt: string;
  notionalUsd: 100;
  maximumConcurrentPositions: 10;
  candidates: MicrostructureShadowCandidate[];
  autoPromotion: false;
  realEnabled: false;
};

export type MicrostructureShadowPreparation =
  | { status: 'not_ready'; manifest: null }
  | { status: 'created' | 'existing'; manifest: MicrostructureShadowManifest };

/** Shared adapter for per-candidate and portfolio prospective promotion evidence. */
export function evaluateMicrostructureForwardTrades(
  trades: readonly MicroTrade[],
  capacityUnits: number,
): NativeForwardGateEvaluation {
  return evaluateNativeForwardGate({
    netPcts: trades.map((trade) => trade.netPct),
    executionCostPcts: trades.map((trade) => trade.executionCostPct),
    bookAgesMs: trades.map((trade) => trade.bookAgeMs),
    signalCount: trades.length,
    captureErrors: 0,
    sides: trades.map((trade) => trade.side),
    symbols: trades.map((trade) => trade.symbol),
    openedAtMs: trades.map((trade) => trade.entryTimeMs),
    closedAtMs: trades.map((trade) => trade.exitTimeMs),
    drawdownCapacityUnits: capacityUnits,
    minUniqueSymbols: 4,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function frozenMicrostructureReportSha256(report: unknown): string {
  return createHash('sha256').update(canonicalJson(report)).digest('hex');
}

const EXPECTED_FROZEN_SOURCES: Readonly<Record<MicrostructureSuite, string>> = {
  core: 'lighter-microstructure-sweep-v3',
  challenger: 'lighter-microstructure-challenger-sweep-v1',
};

export function immutableMicrostructureSelectionBundle(
  sources: readonly MicrostructureFrozenSource[],
): {
  hash: string;
  locked: Array<MicrostructureFrozenSource & { report: Record<string, unknown> }>;
} | null {
  if (sources.length !== 2) throw new Error('both frozen microstructure suites are required');
  const locked: Array<MicrostructureFrozenSource & { report: Record<string, unknown> }> = [];
  for (const suite of ['core', 'challenger'] as const) {
    const matches = sources.filter((source) => source.suite === suite);
    if (matches.length !== 1 || matches[0]!.version !== EXPECTED_FROZEN_SOURCES[suite]) {
      throw new Error(`invalid frozen microstructure source: ${suite}`);
    }
    const source = matches[0]!;
    const report = existingImmutableFrozenMicrostructureReport(source.report, source.version);
    if (!report) return null;
    if (report.suite !== suite) throw new Error(`frozen report suite mismatch: ${suite}`);
    locked.push({ ...source, report });
  }
  const ordered = locked.sort((left, right) => left.suite.localeCompare(right.suite));
  return {
    hash: frozenMicrostructureReportSha256({
      version: 'lighter-microstructure-selection-bundle-v1',
      sources: ordered.map((source) => ({
        suite: source.suite,
        version: source.version,
        report: source.report,
      })),
    }),
    locked: ordered,
  };
}

function rulesForSuite(suite: MicrostructureSuite) {
  return suite === 'challenger'
    ? PREREGISTERED_MICRO_CHALLENGERS
    : PREREGISTERED_MICRO_RULES;
}

function parseCandidate(value: string, suite: MicrostructureSuite): MicrostructureShadowCandidate {
  const match = value.match(/^(1|5)m:(.+)$/);
  if (!match?.[1] || !match[2]) throw new Error(`invalid frozen candidate id: ${value}`);
  const timeframeMinutes = Number(match[1]) as 1 | 5;
  const ruleId = match[2];
  if (!rulesForSuite(suite).some((rule) => rule.id === ruleId)) {
    throw new Error(`unknown frozen candidate rule: ${ruleId}`);
  }
  return { id: value, suite, timeframeMinutes, ruleId };
}

export function validateMicrostructureShadowManifest(
  value: unknown,
  expectedHash: string,
): MicrostructureShadowManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('existing microstructure Shadow manifest is invalid');
  }
  const manifest = value as Partial<MicrostructureShadowManifest>;
  if (
    manifest.version !== MICROSTRUCTURE_SHADOW_MANIFEST_VERSION
    || (manifest.status !== 'active' && manifest.status !== 'no_candidates')
    || manifest.frozenReportSha256 !== expectedHash
    || !Array.isArray(manifest.frozenSources)
    || manifest.frozenSources.length !== 2
    || typeof manifest.selectionEpochAt !== 'string'
    || !Number.isFinite(Date.parse(manifest.selectionEpochAt))
    || typeof manifest.activatedAt !== 'string'
    || !Number.isFinite(Date.parse(manifest.activatedAt))
    || manifest.notionalUsd !== 100
    || manifest.maximumConcurrentPositions !== 10
    || manifest.autoPromotion !== false
    || manifest.realEnabled !== false
    || !Array.isArray(manifest.candidates)
  ) {
    throw new Error('existing microstructure Shadow manifest contract mismatch');
  }
  const sourceSuites = new Set(manifest.frozenSources.map((source) => source.suite));
  if (
    sourceSuites.size !== 2
    || !sourceSuites.has('core')
    || !sourceSuites.has('challenger')
    || manifest.frozenSources.some((source) =>
      source.version !== EXPECTED_FROZEN_SOURCES[source.suite]
      || !/^[a-f0-9]{64}$/.test(source.sha256)
      || !Number.isFinite(Date.parse(source.selectionEpochAt)))
  ) {
    throw new Error('existing microstructure Shadow manifest sources mismatch');
  }
  const candidates = manifest.candidates.map((candidate) =>
    parseCandidate(candidate.id, candidate.suite));
  if (
    candidates.some((candidate, index) =>
      candidate.suite !== manifest.candidates![index]!.suite
      || candidate.timeframeMinutes !== manifest.candidates![index]!.timeframeMinutes
      || candidate.ruleId !== manifest.candidates![index]!.ruleId)
    || new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length
    || (manifest.status === 'active') !== (candidates.length > 0)
  ) {
    throw new Error('existing microstructure Shadow manifest candidates mismatch');
  }
  return manifest as MicrostructureShadowManifest;
}

export function prepareMicrostructureShadowManifest(
  frozenSources: readonly MicrostructureFrozenSource[],
  existingManifest: unknown | null,
  nowMs: number,
): MicrostructureShadowPreparation {
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error('invalid activation time');
  const bundle = immutableMicrostructureSelectionBundle(frozenSources);
  if (!bundle) {
    if (existingManifest != null) {
      throw new Error('microstructure Shadow manifest exists without both immutable frozen suites');
    }
    return { status: 'not_ready', manifest: null };
  }
  if (existingManifest != null) {
    return {
      status: 'existing',
      manifest: validateMicrostructureShadowManifest(existingManifest, bundle.hash),
    };
  }

  const candidates: MicrostructureShadowCandidate[] = [];
  const frozenSourceDetails: MicrostructureShadowFrozenSource[] = [];
  const generatedAtValues: number[] = [];
  for (const source of bundle.locked) {
    const eligible = source.report.shadowEligibleRules as unknown[];
    if (eligible.some((value) => typeof value !== 'string')) {
      throw new Error(`frozen candidate list contains a non-string value: ${source.suite}`);
    }
    const sourceCandidates = (eligible as string[]).map((value) =>
      parseCandidate(value, source.suite));
    const evaluations = source.report.evaluations as unknown[];
    for (const candidate of sourceCandidates) {
      const matches = evaluations.filter((value) => {
        if (!value || typeof value !== 'object') return false;
        const row = value as Record<string, unknown>;
        return row.timeframeMinutes === candidate.timeframeMinutes
          && row.ruleId === candidate.ruleId
          && row.qualified === true;
      });
      if (matches.length !== 1) {
        throw new Error(`frozen candidate evidence missing or duplicated: ${source.suite}:${candidate.id}`);
      }
    }
    const generatedAt = String(source.report.generatedAt ?? '');
    const generatedAtMs = Date.parse(generatedAt);
    if (!Number.isFinite(generatedAtMs) || generatedAtMs > nowMs + 5 * 60_000) {
      throw new Error(`frozen selection timestamp invalid: ${source.suite}`);
    }
    generatedAtValues.push(generatedAtMs);
    candidates.push(...sourceCandidates);
    frozenSourceDetails.push({
      suite: source.suite,
      version: source.version,
      sha256: frozenMicrostructureReportSha256(source.report),
      selectionEpochAt: generatedAt,
    });
  }
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new Error('frozen candidate list contains duplicates');
  }
  const generatedAtMs = Math.max(...generatedAtValues);
  const manifest: MicrostructureShadowManifest = {
    version: MICROSTRUCTURE_SHADOW_MANIFEST_VERSION,
    status: candidates.length ? 'active' : 'no_candidates',
    frozenReportSha256: bundle.hash,
    frozenSources: frozenSourceDetails,
    selectionEpochAt: new Date(generatedAtMs).toISOString(),
    activatedAt: new Date(Math.max(nowMs, generatedAtMs)).toISOString(),
    notionalUsd: 100,
    maximumConcurrentPositions: 10,
    candidates,
    autoPromotion: false,
    realEnabled: false,
  };
  return { status: 'created', manifest };
}

export type MicrostructureShadowReport = {
  version: 'lighter-microstructure-shadow-report-v2';
  generatedAt: string;
  status: 'active' | 'no_candidates';
  activatedAt: string;
  frozenReportSha256: string;
  notionalUsd: 100;
  maximumConcurrentPositions: 10;
  candidates: MicrostructureShadowCandidate[];
  closedTrades: MicroTrade[];
  summary: {
    closed: number;
    long: number;
    short: number;
    netPct: number;
    netUsd: number;
    wins: number;
    losses: number;
    profitFactor: number | null;
  };
  prospectiveOnly: true;
  exactFunding: true;
  autoPromotion: false;
  realEnabled: false;
};

/**
 * Reconstruct only trades whose entries happened after the immutable Shadow
 * activation. Pre-activation bars may warm causal indicators, but can never
 * become reported trades. Capacity is enforced once across the whole cohort.
 */
export function prospectiveMicrostructureShadowTrades(
  manifest: MicrostructureShadowManifest,
  featuresByTimeframe: ReadonlyMap<1 | 5, readonly MicroFeatureBar[]>,
  fundingByMarket: ReadonlyMap<number, LighterFundingSeries>,
  nowMs: number,
  pauses: MicrostructureEntryPauses = {},
): MicroTrade[] {
  if (!Number.isFinite(nowMs)) throw new Error('invalid Shadow report time');
  if (manifest.status !== 'active') return [];
  const activatedAtMs = Date.parse(manifest.activatedAt);
  const proposed: MicroTrade[] = [];
  for (const candidate of manifest.candidates) {
    const rule = rulesForSuite(candidate.suite)
      .find((item) => item.id === candidate.ruleId);
    if (!rule) throw new Error(`unknown Shadow candidate rule: ${candidate.ruleId}`);
    const features = featuresByTimeframe.get(candidate.timeframeMinutes) ?? [];
    const candidatePause = pauses.candidatePausedAtMs?.get(
      microstructureCandidateKey(candidate),
    );
    const pauseTimes = [pauses.portfolioPausedAtMs, candidatePause]
      .filter((value): value is number => value != null && Number.isFinite(value));
    const pausedAtMs = pauseTimes.length ? Math.min(...pauseTimes) : null;
    proposed.push(...simulateMicrostructureRule(
      features,
      rule,
      fundingByMarket,
      Number.MAX_SAFE_INTEGER,
    ).filter((trade) =>
      trade.entryTimeMs >= activatedAtMs
      && trade.exitTimeMs <= nowMs
      && (pausedAtMs == null || trade.entryTimeMs < pausedAtMs)));
  }

  proposed.sort((left, right) =>
    left.entryTimeMs - right.entryTimeMs
    || left.marketId - right.marketId
    || left.ruleId.localeCompare(right.ruleId));
  const accepted: MicroTrade[] = [];
  const activeExitTimes: number[] = [];
  for (const trade of proposed) {
    for (let index = activeExitTimes.length - 1; index >= 0; index--) {
      if (activeExitTimes[index]! <= trade.entryTimeMs) activeExitTimes.splice(index, 1);
    }
    if (activeExitTimes.length >= manifest.maximumConcurrentPositions) continue;
    accepted.push(trade);
    activeExitTimes.push(trade.exitTimeMs);
  }
  return accepted;
}

export function buildMicrostructureShadowReport(
  manifest: MicrostructureShadowManifest,
  closedTrades: readonly MicroTrade[],
  generatedAtMs: number,
): MicrostructureShadowReport {
  if (!Number.isFinite(generatedAtMs)) throw new Error('invalid Shadow report time');
  const wins = closedTrades.filter((trade) => trade.netPct > 0);
  const losses = closedTrades.filter((trade) => trade.netPct < 0);
  const grossWins = wins.reduce((sum, trade) => sum + trade.netPct, 0);
  const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + trade.netPct, 0));
  const netPct = closedTrades.reduce((sum, trade) => sum + trade.netPct, 0);
  return {
    version: 'lighter-microstructure-shadow-report-v2',
    generatedAt: new Date(generatedAtMs).toISOString(),
    status: manifest.status,
    activatedAt: manifest.activatedAt,
    frozenReportSha256: manifest.frozenReportSha256,
    notionalUsd: manifest.notionalUsd,
    maximumConcurrentPositions: manifest.maximumConcurrentPositions,
    candidates: manifest.candidates,
    closedTrades: [...closedTrades],
    summary: {
      closed: closedTrades.length,
      long: closedTrades.filter((trade) => trade.side === 'long').length,
      short: closedTrades.filter((trade) => trade.side === 'short').length,
      netPct,
      netUsd: netPct * manifest.notionalUsd / 100,
      wins: wins.length,
      losses: losses.length,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : closedTrades.length ? Infinity : null,
    },
    prospectiveOnly: true,
    exactFunding: true,
    autoPromotion: false,
    realEnabled: false,
  };
}

function shadowTradeKey(trade: MicroTrade): string {
  return `${trade.barMinutes}:${trade.ruleId}:${trade.marketId}:${trade.entryTimeMs}`;
}

/** Preserve trades that have aged out of the recorder retention window. */
export function mergeMicrostructureShadowTrades(
  existing: readonly MicroTrade[],
  reconstructed: readonly MicroTrade[],
): MicroTrade[] {
  const merged = new Map<string, MicroTrade>();
  for (const trade of existing) merged.set(shadowTradeKey(trade), trade);
  for (const trade of reconstructed) {
    const key = shadowTradeKey(trade);
    const previous = merged.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(trade)) {
      throw new Error(`closed microstructure Shadow trade changed: ${key}`);
    }
    merged.set(key, trade);
  }
  return [...merged.values()].sort((left, right) =>
    left.entryTimeMs - right.entryTimeMs
    || left.marketId - right.marketId
    || left.ruleId.localeCompare(right.ruleId));
}
