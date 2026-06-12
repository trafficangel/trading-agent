/**
 * Phase T — operator CLI: current risk-control state of the whole book.
 *
 * Usage:
 *   pnpm tsx scripts/risk-status.ts              # state as of now
 *   pnpm tsx scripts/risk-status.ts --at 2026-06-02T12:00
 *                                                # replay: state at a past moment
 *
 * Prints, per enabled strategy: cool-down / probation status, plus the
 * portfolio circuit-breaker state. The --at flag exists so we can verify
 * the rules against history ("would June 2 have tripped the breaker?").
 */

import { STRATEGY_CONFIGS } from '../src/strategies/track-c-config.js';
import {
  decideBreaker,
  decideCooldown,
  decideProbation,
  getRecentShadowSlHits,
  getLastSlHitForStrategy,
  getLastClosedTrades,
  PROBATION_WINDOW,
} from '../src/strategies/risk-control.js';

function fmt(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

const atArg = process.argv.indexOf('--at');
const now = atArg >= 0 ? Date.parse(process.argv[atArg + 1] ?? '') : Date.now();
if (!Number.isFinite(now)) {
  console.error('bad --at value (use e.g. 2026-06-02T12:00)');
  process.exit(2);
}

console.log(`Risk-control status @ ${fmt(now)} UTC\n`);

// Portfolio breaker — note: when replaying with --at we still read hits up
// to the present, but decideBreaker only considers pairs whose block window
// covers `now`, so the verdict is correct for the chosen moment.
const hits = getRecentShadowSlHits(now);
const breaker = decideBreaker(hits, now);
console.log(
  breaker.blocked
    ? `⛔️ CIRCUIT BREAKER ACTIVE — все входы заблокированы до ${fmt(breaker.until)}`
    : `✅ Circuit breaker: неактивен (SL-хитов в окне: ${hits.filter((h) => now - h.closedAt < 72 * 3600_000 && h.closedAt <= now).length})`,
);
console.log('');

const enabled = Object.values(STRATEGY_CONFIGS).filter((s) => s.enabled);
for (const cfg of enabled) {
  const cooldown = decideCooldown(getLastSlHitForStrategy(cfg.id), cfg.timeframe, now);
  const probation = decideProbation(
    getLastClosedTrades(cfg.id).filter((t) => t.closedAt <= now),
    now,
  );
  const parts: string[] = [];
  if (cooldown.blocked) parts.push(`🧊 cool-down до ${fmt(cooldown.until)}`);
  if (probation.blocked) {
    parts.push(`🚧 probation (${probation.netPct!.toFixed(1)}% за ${PROBATION_WINDOW} сделок, probe ${fmt(probation.probeAt)})`);
  }
  if (!cooldown.blocked && probation.netPct !== null && !probation.blocked) {
    parts.push(`ok · окно ${PROBATION_WINDOW}: ${probation.netPct.toFixed(1)}% нетто`);
  }
  if (parts.length === 0) parts.push('ok');
  const fan = cfg.fanOut ? '' : ' · 🔒 shadow-only (fanOut=false)';
  console.log(`STRAT-${cfg.code} ${String(cfg.symbol).padEnd(9)} ${cfg.timeframe.padEnd(3)}m  ${parts.join(' · ')}${fan}`);
}
