import { db } from '../client.js';

/**
 * Runtime-tunable parameters. Stored in SQLite so changes persist across
 * restarts and are auditable. Read-through pattern: callers ask for a key,
 * we return the parsed value or null — caller falls back to its compiled
 * default if null. Deleting a row reverts to compile-time behaviour.
 *
 * Only the self-review job (src/jobs/self-review.ts) writes here in
 * production. Manual edits are also fine for debugging — just don't
 * forget to log a reason.
 */

const getStmt = db.prepare<[string], { value: string; updated_at: number; reason: string | null }>(
  'SELECT value, updated_at, reason FROM runtime_config WHERE key = ?',
);

const upsertStmt = db.prepare<[string, string, number, string | null], unknown>(`
  INSERT INTO runtime_config (key, value, updated_at, reason)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at,
    reason = excluded.reason
`);

export type RuntimeConfigRow = {
  value: string;
  updated_at: number;
  reason: string | null;
};

export function getRuntimeConfig(key: string): RuntimeConfigRow | null {
  return getStmt.get(key) ?? null;
}

/** Returns the value parsed as a number, or null if missing / unparseable. */
export function getRuntimeNumber(key: string): number | null {
  const row = getStmt.get(key);
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

export function setRuntimeConfig(key: string, value: string, reason: string): void {
  upsertStmt.run(key, value, Date.now(), reason);
}

export const RUNTIME_KEYS = {
  scalpConfidenceFloor: 'scalp.confidence_floor',
} as const;
