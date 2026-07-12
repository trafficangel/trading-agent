/** Safe operator control for the live Wick-Fade recovery canary. */

import { db } from '../src/db/client.js';
import {
  wickFadeDriftBlockReason,
  WICK_FADE_DRIFT_STATE_KEY,
  type WickFadeDriftRuntimeState,
} from '../src/lib/wick-fade-drift-guard.js';
import {
  WICK_FADE_RECOVERY_ENABLED_KEY,
  WICK_FADE_RECOVERY_RESUME_APPROVED_KEY,
  WICK_FADE_RECOVERY_STATE_KEY,
  type WickFadeRecoveryRuntimeState,
} from '../src/lib/wick-fade-recovery-canary.js';

const action = process.argv[2] ?? 'status';
const getKv = db.prepare<[string], { value: string }>('SELECT value FROM runtime_config WHERE key = ?');
const setKv = db.prepare<[string, string, number, string], void>(`
  INSERT INTO runtime_config (key, value, updated_at, reason)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, reason=excluded.reason
`);
const openPositions = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM wick_fade_pos');

function parsed<T>(key: string): T | null {
  const raw = getKv.get(key)?.value;
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function printStatus(): void {
  const enabled = getKv.get(WICK_FADE_RECOVERY_ENABLED_KEY)?.value === '1';
  const approved = getKv.get(WICK_FADE_RECOVERY_RESUME_APPROVED_KEY)?.value === '1';
  const state = parsed<WickFadeRecoveryRuntimeState>(WICK_FADE_RECOVERY_STATE_KEY);
  console.log(JSON.stringify({ enabled, fullResumeApproved: approved, openPositions: openPositions.get()?.n ?? 0, state }, null, 2));
}

if (action === 'enable') {
  const nowMs = Date.now();
  const driftRaw = getKv.get(WICK_FADE_DRIFT_STATE_KEY)?.value;
  const driftReason = wickFadeDriftBlockReason(driftRaw, nowMs);
  const drift = parsed<WickFadeDriftRuntimeState>(WICK_FADE_DRIFT_STATE_KEY);
  const recovery = parsed<WickFadeRecoveryRuntimeState>(WICK_FADE_RECOVERY_STATE_KEY);
  if (!drift || !drift.blocked || !driftReason || drift.slow.n < 40) {
    throw new Error('refusing enable: drift guard is not a fresh, fully sampled pause');
  }
  if ((openPositions.get()?.n ?? 0) > 0) throw new Error('refusing enable: Wick-Fade position is already open');
  if (recovery && recovery.status !== 'active') {
    throw new Error(`refusing enable: recovery verdict is already ${recovery.status}`);
  }
  const tx = db.transaction(() => {
    setKv.run(WICK_FADE_RECOVERY_ENABLED_KEY, '1', nowMs, 'operator approved recovery canary');
    setKv.run(WICK_FADE_RECOVERY_RESUME_APPROVED_KEY, '0', nowMs, 'full-book resume remains manual');
  });
  tx();
  printStatus();
} else if (action === 'disable') {
  const nowMs = Date.now();
  const tx = db.transaction(() => {
    setKv.run(WICK_FADE_RECOVERY_ENABLED_KEY, '0', nowMs, 'operator disabled recovery canary');
    setKv.run(WICK_FADE_RECOVERY_RESUME_APPROVED_KEY, '0', nowMs, 'full-book resume remains manual');
  });
  tx();
  printStatus();
} else if (action === 'status') {
  printStatus();
} else {
  throw new Error('usage: pnpm tsx scripts/wick-fade-recovery.ts status|enable|disable');
}

