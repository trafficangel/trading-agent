/**
 * user_tier_history repo — audit log of every tier transition.
 *
 * Written by assignTier / applyDowngrade / qtyStep-skip in
 * src/user/tier-assignment.ts. Read by admin /admin/tiers stats page
 * and support diagnostics.
 */

import { db } from '../client.js';

export type TierHistoryRow = {
  id: number;
  user_id: number;
  from_tier: string | null;
  to_tier: string;
  reason: string;
  balance_at_change_usdt: number | null;
  metadata_json: string | null;
  created_at: number;
};

const insertStmt = db.prepare(`
  INSERT INTO user_tier_history
    (user_id, from_tier, to_tier, reason, balance_at_change_usdt, metadata_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const recentStmt = db.prepare<[number], TierHistoryRow>(`
  SELECT * FROM user_tier_history
   ORDER BY created_at DESC
   LIMIT ?
`);

const byUserStmt = db.prepare<[number], TierHistoryRow>(`
  SELECT * FROM user_tier_history
   WHERE user_id = ?
   ORDER BY created_at DESC
`);

export function recordTierTransition(input: {
  userId: number;
  fromTier: string | null;
  toTier: string;
  reason: string;
  balanceUsdt: number | null;
  metadata?: Record<string, unknown>;
}): void {
  insertStmt.run(
    input.userId,
    input.fromTier,
    input.toTier,
    input.reason,
    input.balanceUsdt,
    input.metadata ? JSON.stringify(input.metadata) : null,
    Date.now(),
  );
}

export function listRecentTransitions(limit = 50): TierHistoryRow[] {
  return recentStmt.all(limit);
}

export function listUserTransitions(userId: number): TierHistoryRow[] {
  return byUserStmt.all(userId);
}
