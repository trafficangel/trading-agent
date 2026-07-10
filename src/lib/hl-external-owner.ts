import { readFileSync } from 'node:fs';

export type HlExternalOwner = {
  coin: string;
  side: 'long' | 'short';
  intentId: string;
  phase: 'entering' | 'open' | 'closing' | 'unwinding';
  updatedAt: number;
  leaseExpiresAt: number;
};

const ACTIVE_PHASES = new Set<HlExternalOwner['phase']>([
  'entering',
  'open',
  'closing',
  'unwinding',
]);

/** Accept only a fresh, bounded lease. Stale/malformed files must never mask an orphan position. */
export function parseHlExternalOwner(
  raw: string,
  nowMs = Date.now(),
  maxHeartbeatAgeMs = 30_000,
): HlExternalOwner | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const coin = typeof row.coin === 'string' ? row.coin.trim() : '';
  const side = row.hlSide;
  const phase = row.phase;
  const intentId = typeof row.intentId === 'string' ? row.intentId.trim() : '';
  const updatedAt = Number(row.updatedAt);
  const leaseExpiresAt = Number(row.leaseExpiresAt);
  if (!coin || !intentId || (side !== 'long' && side !== 'short')) return null;
  if (typeof phase !== 'string' || !ACTIVE_PHASES.has(phase as HlExternalOwner['phase'])) return null;
  if (!Number.isFinite(updatedAt) || !Number.isFinite(leaseExpiresAt)) return null;
  if (updatedAt > nowMs + 5_000 || nowMs - updatedAt > maxHeartbeatAgeMs) return null;
  if (leaseExpiresAt < nowMs || leaseExpiresAt > nowMs + 5 * 60_000) return null;
  return {
    coin,
    side,
    intentId,
    phase: phase as HlExternalOwner['phase'],
    updatedAt,
    leaseExpiresAt,
  };
}

export function readHlExternalOwner(path: string, nowMs = Date.now()): HlExternalOwner | null {
  try { return parseHlExternalOwner(readFileSync(path, 'utf8'), nowMs); }
  catch { return null; }
}
