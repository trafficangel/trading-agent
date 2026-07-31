import { createHash } from 'node:crypto';
import {
  type MicroFeatureBar,
  type MicroTrade,
  existingImmutableFrozenMicrostructureReport,
  PREREGISTERED_MICRO_RULES,
  simulateMicrostructureRule,
} from './lighter-microstructure-research.js';
import type { LighterFundingSeries } from './lighter-funding-history.js';

export const MICROSTRUCTURE_SHADOW_MANIFEST_VERSION =
  'lighter-microstructure-shadow-manifest-v1';

export type MicrostructureShadowCandidate = {
  id: string;
  timeframeMinutes: 1 | 5;
  ruleId: string;
};

export type MicrostructureShadowManifest = {
  version: typeof MICROSTRUCTURE_SHADOW_MANIFEST_VERSION;
  status: 'active' | 'no_candidates';
  frozenReportSha256: string;
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

function parseCandidate(value: string): MicrostructureShadowCandidate {
  const match = value.match(/^(1|5)m:(.+)$/);
  if (!match?.[1] || !match[2]) throw new Error(`invalid frozen candidate id: ${value}`);
  const timeframeMinutes = Number(match[1]) as 1 | 5;
  const ruleId = match[2];
  if (!PREREGISTERED_MICRO_RULES.some((rule) => rule.id === ruleId)) {
    throw new Error(`unknown frozen candidate rule: ${ruleId}`);
  }
  return { id: value, timeframeMinutes, ruleId };
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
  const candidates = manifest.candidates.map((candidate) => parseCandidate(candidate.id));
  if (
    candidates.some((candidate, index) =>
      candidate.timeframeMinutes !== manifest.candidates![index]!.timeframeMinutes
      || candidate.ruleId !== manifest.candidates![index]!.ruleId)
    || new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length
    || (manifest.status === 'active') !== (candidates.length > 0)
  ) {
    throw new Error('existing microstructure Shadow manifest candidates mismatch');
  }
  return manifest as MicrostructureShadowManifest;
}

export function prepareMicrostructureShadowManifest(
  frozenReport: unknown,
  existingManifest: unknown | null,
  nowMs: number,
): MicrostructureShadowPreparation {
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error('invalid activation time');
  const locked = existingImmutableFrozenMicrostructureReport(frozenReport);
  if (!locked) {
    if (existingManifest != null) {
      throw new Error('microstructure Shadow manifest exists without immutable frozen evidence');
    }
    return { status: 'not_ready', manifest: null };
  }
  const hash = frozenMicrostructureReportSha256(locked);
  if (existingManifest != null) {
    return { status: 'existing', manifest: validateMicrostructureShadowManifest(existingManifest, hash) };
  }

  const eligible = locked.shadowEligibleRules as unknown[];
  if (eligible.some((value) => typeof value !== 'string')) {
    throw new Error('frozen candidate list contains a non-string value');
  }
  const candidates = (eligible as string[]).map(parseCandidate);
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new Error('frozen candidate list contains duplicates');
  }
  const evaluations = locked.evaluations as unknown[];
  for (const candidate of candidates) {
    const matches = evaluations.filter((value) => {
      if (!value || typeof value !== 'object') return false;
      const row = value as Record<string, unknown>;
      return row.timeframeMinutes === candidate.timeframeMinutes
        && row.ruleId === candidate.ruleId
        && row.qualified === true;
    });
    if (matches.length !== 1) {
      throw new Error(`frozen candidate evidence missing or duplicated: ${candidate.id}`);
    }
  }
  const generatedAt = String(locked.generatedAt ?? '');
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs) || generatedAtMs > nowMs + 5 * 60_000) {
    throw new Error('frozen selection timestamp invalid');
  }
  const manifest: MicrostructureShadowManifest = {
    version: MICROSTRUCTURE_SHADOW_MANIFEST_VERSION,
    status: candidates.length ? 'active' : 'no_candidates',
    frozenReportSha256: hash,
    selectionEpochAt: generatedAt,
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
  version: 'lighter-microstructure-shadow-report-v1';
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
): MicroTrade[] {
  if (!Number.isFinite(nowMs)) throw new Error('invalid Shadow report time');
  if (manifest.status !== 'active') return [];
  const activatedAtMs = Date.parse(manifest.activatedAt);
  const proposed: MicroTrade[] = [];
  for (const candidate of manifest.candidates) {
    const rule = PREREGISTERED_MICRO_RULES.find((item) => item.id === candidate.ruleId);
    if (!rule) throw new Error(`unknown Shadow candidate rule: ${candidate.ruleId}`);
    const features = featuresByTimeframe.get(candidate.timeframeMinutes) ?? [];
    proposed.push(...simulateMicrostructureRule(
      features,
      rule,
      fundingByMarket,
      Number.MAX_SAFE_INTEGER,
    ).filter((trade) => trade.entryTimeMs >= activatedAtMs && trade.exitTimeMs <= nowMs));
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
    version: 'lighter-microstructure-shadow-report-v1',
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
