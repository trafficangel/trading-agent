/**
 * Tiny key/value accessor over the `runtime_config` table (migration 007).
 * Used for small operational state that should survive restarts but isn't worth
 * a dedicated table — e.g. the webhook-watchdog "last entry webhook seen"
 * heartbeat, which lets the watchdog tell "source went dark" from "our own
 * risk-control is suppressing entries".
 */
import { db } from '../client.js';

const setStmt = db.prepare<[string, string, number, string | null]>(
  `INSERT INTO runtime_config (key, value, updated_at, reason) VALUES (?, ?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, reason = excluded.reason`,
);
const getStmt = db.prepare<[string], { value: string }>(
  'SELECT value FROM runtime_config WHERE key = ?',
);

export function setRuntimeConfig(key: string, value: string, reason: string | null = null): void {
  setStmt.run(key, value, Date.now(), reason);
}

export function getRuntimeConfig(key: string): string | null {
  return getStmt.get(key)?.value ?? null;
}
