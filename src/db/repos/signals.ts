import { db } from '../client.js';

/**
 * Legacy `signals` table — populated by Tracks A/B's event-alert webhook
 * pipeline (removed May 2026). Kept as read-only history: historical rows
 * remain queryable for the /status endpoint and for any future analysis.
 *
 * No new rows are written by the current Track C-only system.
 */

export type SignalRow = {
  id: number;
  received_at: number;
  symbol: string;
  timeframe: string;
  source: string;
  event: string;
  direction: string | null;
  price: number | null;
  bar_time: number | null;
  raw_payload: string;
  dedup_key: string;
};

const countSinceStmt = db.prepare<[number], { c: number }>(
  'SELECT COUNT(*) AS c FROM signals WHERE received_at >= ?',
);

export function countSignalsSince(sinceMs: number): number {
  return countSinceStmt.get(sinceMs)?.c ?? 0;
}
