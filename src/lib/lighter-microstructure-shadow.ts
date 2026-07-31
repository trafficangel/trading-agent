import { createHash } from 'node:crypto';
import {
  existingImmutableFrozenMicrostructureReport,
  PREREGISTERED_MICRO_RULES,
} from './lighter-microstructure-research.js';

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

function validateManifest(
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
    return { status: 'existing', manifest: validateManifest(existingManifest, hash) };
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
