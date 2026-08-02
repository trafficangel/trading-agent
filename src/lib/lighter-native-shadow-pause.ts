export const NATIVE_PROMOTION_AUDIT_VERSION = 'lighter-native-promotion-audit-v5';
export const NATIVE_PROMOTION_AUDIT_MAX_AGE_MS = 60 * 60_000;

export type NativeShadowPauseAudit = {
  generatedAt: number;
  pausedStrategyIds: ReadonlySet<string>;
};

/**
 * Parse the atomic promotion-audit snapshot used to stop new Shadow entries.
 * A missing, malformed, future-dated or stale report is ignored: Shadow has no
 * capital exposure and must keep collecting evidence when the audit job itself
 * is unavailable. Real has a separate fail-closed liveness/promotion gate.
 */
export function parseNativeShadowPauseAudit(
  raw: string,
  now = Date.now(),
  maxAgeMs = NATIVE_PROMOTION_AUDIT_MAX_AGE_MS,
): NativeShadowPauseAudit | null {
  try {
    const value = JSON.parse(raw) as {
      version?: unknown;
      generatedAt?: unknown;
      pausedShadowStrategyIds?: unknown;
    };
    if (
      value.version !== NATIVE_PROMOTION_AUDIT_VERSION
      || typeof value.generatedAt !== 'string'
      || !Array.isArray(value.pausedShadowStrategyIds)
      || !(maxAgeMs > 0)
    ) return null;
    const generatedAt = Date.parse(value.generatedAt);
    const ageMs = now - generatedAt;
    if (!Number.isFinite(generatedAt) || ageMs < -5 * 60_000 || ageMs > maxAgeMs) return null;
    const pausedStrategyIds = new Set<string>();
    for (const id of value.pausedShadowStrategyIds) {
      if (typeof id !== 'string' || !id.trim()) return null;
      pausedStrategyIds.add(id);
    }
    return { generatedAt, pausedStrategyIds };
  } catch {
    return null;
  }
}
