/**
 * One-glance operator dashboard (read-only). Run on the VPS:
 *   pnpm tsx scripts/status.ts
 *
 * Consolidates what used to be 4 separate scripts: aggregate PnL (net of
 * commission), circuit-breaker/cooldown/probation state, per-strategy live
 * stats + Kelly weight, and open positions. Start here for any audit.
 */

import { db } from '../src/db/client.js';
import { STRATEGY_CONFIGS, TRACK_C_COMMISSION_RT_PCT } from '../src/strategies/track-c-config.js';
import { getStrategyLiveStats } from '../src/strategies/live-stats.js';
import { TIER_CONFIGS } from '../src/strategies/tier-config.js';
import { computeWeights } from '../src/strategies/kelly-allocator.js';
import {
  getRecentShadowSlHits, decideBreaker,
  getLastSlHitForStrategy, decideCooldown,
  getLastClosedTrades, decideProbation,
} from '../src/strategies/risk-control.js';

const C = TRACK_C_COMMISSION_RT_PCT;
const now = Date.now();
const fmtT = (ms: number | null) => (ms === null ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));

// ---- aggregate (shadow closed, commission-net) ----
const closed = db.prepare<[], { pnl_pct: number; side: string | null; closed_at: number }>(`
  SELECT pnl_pct, side, closed_at FROM decisions
   WHERE user_id IS NULL AND track='strategy' AND status='closed' AND pnl_pct IS NOT NULL
   ORDER BY closed_at`).all();
let cum = 0, peak = 0, maxDd = 0, wins = 0, longNet = 0, shortNet = 0;
for (const r of closed) {
  const net = r.pnl_pct - C;
  cum += net; if (cum > peak) peak = cum; if (peak - cum > maxDd) maxDd = peak - cum;
  if (net > 0) wins++;
  if (r.side === 'short') shortNet += net; else longNet += net;
}
const n = closed.length;
console.log(`\n━━ Robot Claude · status @ ${fmtT(now)} UTC ━━\n`);
console.log(`PORTFOLIO (shadow, net of ${C}% commission)`);
console.log(`  closed ${n}  ·  net ${cum >= 0 ? '+' : ''}${cum.toFixed(1)}%  ·  WR ${n ? ((wins / n) * 100).toFixed(0) : 0}%  ·  maxDD −${maxDd.toFixed(1)}%`);
console.log(`  long ${longNet >= 0 ? '+' : ''}${longNet.toFixed(1)}%   short ${shortNet >= 0 ? '+' : ''}${shortNet.toFixed(1)}%`);

// ---- circuit breaker ----
const breaker = decideBreaker(getRecentShadowSlHits(now), now);
console.log(`\nRISK`);
console.log(`  circuit breaker: ${breaker.blocked ? `⛔ ACTIVE until ${fmtT(breaker.until)}` : '✅ clear'}`);

// ---- per-strategy ----
const enabled = Object.values(STRATEGY_CONFIGS).filter((c) => c.enabled);
const weights = computeWeights(TIER_CONFIGS['plus'].strategyIds);
const eq = 1 / TIER_CONFIGS['plus'].strategyIds.length;
console.log(`\nSTRATEGIES (enabled)`);
console.log(`  code sym       tf   fanOut  net$    WR   N   open  weight  risk`);
for (const cfg of enabled.sort((a, b) => a.code.localeCompare(b.code))) {
  const live = getStrategyLiveStats(cfg.id);
  const cd = decideCooldown(getLastSlHitForStrategy(cfg.id), cfg.timeframe, now);
  const pr = decideProbation(getLastClosedTrades(cfg.id), now);
  const risk = cd.blocked ? '🧊cooldown' : pr.blocked ? '🚧probation' : 'ok';
  const w = weights.get(cfg.id);
  const wStr = w !== undefined ? `${(w * 100).toFixed(0)}%${w > eq * 1.05 ? '↑' : w < eq * 0.95 ? '↓' : ''}` : '—';
  console.log(
    `  ${cfg.code}  ${String(cfg.symbol).padEnd(9)} ${cfg.timeframe.padEnd(4)} ${(cfg.fanOut ? 'live' : 'shdw').padEnd(6)} ` +
    `${(live.netPnlUsd >= 0 ? '+' : '') + live.netPnlUsd.toFixed(0)}`.padEnd(7) +
    ` ${live.winRate !== null ? (live.winRate * 100).toFixed(0) + '%' : '—'}`.padEnd(5) +
    ` ${String(live.closed).padStart(3)}  ${String(live.open).padStart(4)}  ${wStr.padStart(6)}  ${risk}`,
  );
}

// ---- open positions ----
const open = db.prepare<[], { strategy_id: string; symbol: string; side: string | null; entry: number | null; created_at: number }>(`
  SELECT strategy_id, symbol, side, entry, created_at FROM decisions
   WHERE user_id IS NULL AND track='strategy' AND status IN ('active','pending') ORDER BY created_at DESC`).all();
console.log(`\nOPEN (${open.length})`);
for (const o of open) {
  console.log(`  ${String(o.symbol).padEnd(9)} ${(o.side === 'short' ? 'short' : 'long').padEnd(5)} @ ${o.entry ?? '—'}  ${fmtT(o.created_at)}  ${o.strategy_id}`);
}
console.log('');
