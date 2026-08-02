import { describe, expect, it } from 'vitest';
import {
  NATIVE_PROMOTION_AUDIT_MAX_AGE_MS,
  nativePausedShadowStrategyIds,
  parseNativeShadowPauseAudit,
} from '../../src/lib/lighter-native-shadow-pause.js';

describe('nativePausedShadowStrategyIds', () => {
  const row = (strategyId: string, paused = false) => ({
    strategyId,
    decision: {
      shadowAction: paused ? 'pause_new_entries' as const : 'continue' as const,
    },
  });

  it('includes individually failed standalone and cohort members once', () => {
    expect(nativePausedShadowStrategyIds(
      [row('main-ok'), row('main-bad', true)],
      [{
        members: [row('member-ok'), row('member-bad', true), row('main-bad', true)],
        portfolioDecision: { shadowAction: 'continue' },
      }],
    )).toEqual(['main-bad', 'member-bad']);
  });

  it('propagates a failed portfolio decision to every cohort member', () => {
    expect(nativePausedShadowStrategyIds([], [{
      members: [row('p2-a'), row('p2-b')],
      portfolioDecision: { shadowAction: 'pause_new_entries' },
    }])).toEqual(['p2-a', 'p2-b']);
  });

  it('does not pause a healthy cohort merely because it is still collecting', () => {
    expect(nativePausedShadowStrategyIds([], [{
      members: [row('p3-a'), row('p3-b')],
      portfolioDecision: { shadowAction: 'continue' },
    }])).toEqual([]);
  });
});

describe('parseNativeShadowPauseAudit', () => {
  const now = Date.parse('2026-08-02T05:30:00.000Z');

  it('returns the exact fresh pause set and deduplicates ids', () => {
    const parsed = parseNativeShadowPauseAudit(JSON.stringify({
      version: 'lighter-native-promotion-audit-v5',
      generatedAt: '2026-08-02T05:20:00.000Z',
      pausedShadowStrategyIds: ['weak-a', 'weak-a', 'weak-b'],
    }), now);
    expect([...parsed!.pausedStrategyIds]).toEqual(['weak-a', 'weak-b']);
  });

  it('ignores malformed, future-dated and stale evidence', () => {
    expect(parseNativeShadowPauseAudit('{', now)).toBeNull();
    expect(parseNativeShadowPauseAudit(JSON.stringify({
      version: 'lighter-native-promotion-audit-v4',
      generatedAt: '2026-08-02T05:20:00.000Z',
      pausedShadowStrategyIds: ['stale-contract'],
    }), now)).toBeNull();
    expect(parseNativeShadowPauseAudit(JSON.stringify({
      version: 'wrong',
      generatedAt: '2026-08-02T05:20:00.000Z',
      pausedShadowStrategyIds: [],
    }), now)).toBeNull();
    expect(parseNativeShadowPauseAudit(JSON.stringify({
      version: 'lighter-native-promotion-audit-v5',
      generatedAt: new Date(now - NATIVE_PROMOTION_AUDIT_MAX_AGE_MS - 1).toISOString(),
      pausedShadowStrategyIds: [],
    }), now)).toBeNull();
    expect(parseNativeShadowPauseAudit(JSON.stringify({
      version: 'lighter-native-promotion-audit-v5',
      generatedAt: new Date(now + 5 * 60_000 + 1).toISOString(),
      pausedShadowStrategyIds: [],
    }), now)).toBeNull();
  });

  it('fails the whole snapshot on a malformed strategy id', () => {
    expect(parseNativeShadowPauseAudit(JSON.stringify({
      version: 'lighter-native-promotion-audit-v5',
      generatedAt: '2026-08-02T05:20:00.000Z',
      pausedShadowStrategyIds: ['ok', 7],
    }), now)).toBeNull();
  });
});
