import { db } from '../client.js';
import { makeDedupKey } from '../../signals/dedup.js';
import type { LuxAlgoPayload } from '../../webhooks/luxalgo.schema.js';

export { makeDedupKey };

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

const insertStmt = db.prepare<
  [number, string, string, string, string, string | null, number | null, number | null, string, string]
>(`
  INSERT OR IGNORE INTO signals
    (received_at, symbol, timeframe, source, event, direction, price, bar_time, raw_payload, dedup_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const recentStmt = db.prepare<[number], SignalRow>(
  'SELECT * FROM signals WHERE received_at >= ? ORDER BY received_at DESC',
);

const countSinceStmt = db.prepare<[number], { c: number }>(
  'SELECT COUNT(*) AS c FROM signals WHERE received_at >= ?',
);

const countFreshBySymbolStmt = db.prepare<[string, number], { c: number }>(
  // Note: timeframe filter — only subject TFs that the decide step actually
  // cares about. 1D signals fire too rarely to be a "fresh activity" signal,
  // and 5m signals can be too noisy. We keep it tight to 15m / 1H / 4H, which
  // is what scalp + swing setups actually live on.
  `SELECT COUNT(*) AS c FROM signals
   WHERE symbol = ? AND received_at >= ?
     AND timeframe IN ('15', '60', '240')`,
);

const groupedSinceStmt = db.prepare<
  [number],
  { symbol: string; event: string; direction: string | null; n: number }
>(`
  SELECT symbol, event, direction, COUNT(*) AS n
  FROM signals WHERE received_at >= ?
  GROUP BY symbol, event, direction
  ORDER BY symbol, n DESC
`);

export function insertSignal(p: LuxAlgoPayload, raw: unknown): { inserted: boolean; id?: number } {
  const dedup = makeDedupKey(p);
  const result = insertStmt.run(
    Date.now(),
    p.symbol,
    p.timeframe,
    p.source,
    p.event,
    p.direction ?? null,
    p.price ?? null,
    p.bar_time,
    JSON.stringify(raw),
    dedup,
  );
  return result.changes > 0
    ? { inserted: true, id: Number(result.lastInsertRowid) }
    : { inserted: false };
}

export function recentSignals(sinceMs: number): SignalRow[] {
  return recentStmt.all(sinceMs);
}

export function countSignalsSince(sinceMs: number): number {
  return countSinceStmt.get(sinceMs)?.c ?? 0;
}

/** Count signals received in the last N ms for given symbol on subject TFs.
 *  Used by the decide-step "no fresh activity → skip LLM" pre-filter. */
export function countFreshSignals(symbol: string, sinceMs: number): number {
  return countFreshBySymbolStmt.get(symbol, sinceMs)?.c ?? 0;
}

export function groupedSignalsSince(sinceMs: number) {
  return groupedSinceStmt.all(sinceMs);
}
