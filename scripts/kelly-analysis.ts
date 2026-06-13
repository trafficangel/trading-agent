/**
 * Kelly-criterion ANALYSIS (read-only, no trading impact).
 *
 * Computes the empirical Kelly fraction per strategy by maximising
 * log-growth over its ACTUAL per-trade net returns (SL-capped via MAE +
 * 0.11% round-trip commission), then compares to the current
 * maxSafeLeverage. Pure diagnostic — tells us whether Kelly sizing would
 * even help before we wire it into anything.
 *
 * Key honesty points baked in:
 *   - Returns are net of commission AND capped at the strategy's slPct
 *     (matches how it trades live), so f* is the growth-optimal
 *     notional/equity ratio = "full-Kelly leverage" for that strategy
 *     in ISOLATION.
 *   - Negative-mean strategies get f*=0 (Kelly says: don't bet) — a
 *     real expectancy red-flag.
 *   - Standalone only: concurrent strategies + tail-correlation (June 2)
 *     mean you CANNOT sum these leverages. ¼-Kelly + the risk layer is
 *     the safe deployment, not full Kelly.
 *
 * Usage:
 *   pnpm tsx scripts/kelly-analysis.ts            # all strategies w/ data
 *   pnpm tsx scripts/kelly-analysis.ts <id>       # one
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { STRATEGY_CONFIGS, TRACK_C_COMMISSION_RT_PCT } from '../src/strategies/track-c-config.js';

const COMM = TRACK_C_COMMISSION_RT_PCT / 100; // 0.0011 round-trip

function loadReturns(id: string, slPct: number): number[] | null {
  const path = resolve('src/strategies/data', `${id}.json`);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    tradesLog?: Array<{ side: string; entryPrice: number; exitPrice: number; maePct?: number }>;
  };
  const trades = raw.tradesLog;
  if (!Array.isArray(trades) || trades.length === 0) return null;
  const rs: number[] = [];
  for (const t of trades) {
    const entry = Number(t.entryPrice);
    const exit = Number(t.exitPrice);
    if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) continue;
    const sign = t.side === 'long' ? 1 : -1;
    let r = (sign * (exit - entry)) / entry;
    const mae = typeof t.maePct === 'number' ? t.maePct / 100 : null;
    if (mae !== null && mae >= slPct) r = -slPct; // safety SL would have fired
    rs.push(r - COMM);
  }
  return rs.length ? rs : null;
}

function logGrowth(rs: number[], f: number): number {
  let s = 0;
  for (const r of rs) {
    const x = 1 + f * r;
    if (x <= 1e-9) return -Infinity;
    s += Math.log(x);
  }
  return s / rs.length;
}

/** Empirical Kelly: argmax_f E[ln(1+f·r)], f≥0. Concave → ternary search. */
function empiricalKelly(rs: number[]): number {
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  if (mean <= 0) return 0;
  const worst = Math.min(...rs); // negative
  const fMax = worst < 0 ? 0.999 / -worst : 50;
  let lo = 0;
  let hi = fMax;
  for (let i = 0; i < 200; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (logGrowth(rs, m1) < logGrowth(rs, m2)) lo = m1;
    else hi = m2;
  }
  return (lo + hi) / 2;
}

function stats(rs: number[]) {
  const n = rs.length;
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const variance = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const wins = rs.filter((r) => r > 0).length;
  return { n, mean, std: Math.sqrt(variance), wr: wins / n };
}

const only = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? null;
const configs = Object.values(STRATEGY_CONFIGS).filter((c) => (only ? c.id === only : true));

console.log('Kelly analysis · net of 0.11% commission · SL-capped via MAE · BACKTEST trades logs\n');
console.log(
  'strat  ' + 'symbol'.padEnd(9) + ' N    WR%   mean%  std%   fullK_lev  ¼K_lev  cfg_lev  verdict',
);
console.log('-'.repeat(92));

for (const cfg of configs) {
  const rs = loadReturns(cfg.id, cfg.slPct);
  if (!rs) {
    console.log(`${cfg.code.padEnd(6)} ${String(cfg.symbol).padEnd(9)} — no data`);
    continue;
  }
  const s = stats(rs);
  const fK = empiricalKelly(rs);
  const qK = fK / 4;
  const cfgLev = cfg.maxSafeLeverage ?? 0;
  const verdict =
    s.mean <= 0
      ? '🔴 negative edge (Kelly=0)'
      : qK < 1
        ? '🟡 marginal (¼K<1×)'
        : qK >= cfgLev
          ? '🟢 strong (¼K ≥ cfg lev)'
          : '🟢 ok';
  console.log(
    `${cfg.code.padEnd(6)} ${String(cfg.symbol).padEnd(9)} ` +
      `${String(s.n).padEnd(4)} ${(s.wr * 100).toFixed(0).padStart(4)}  ` +
      `${(s.mean * 100).toFixed(2).padStart(6)} ${(s.std * 100).toFixed(2).padStart(5)}  ` +
      `${fK.toFixed(1).padStart(7)}×   ${qK.toFixed(1).padStart(5)}×  ${String(cfgLev).padStart(5)}×  ${verdict}`,
  );
}

console.log(
  '\nfullK_lev = growth-optimal notional/equity in ISOLATION (full Kelly).\n' +
    '¼K_lev   = quarter-Kelly (estimation-risk-safe) — the deployable figure.\n' +
    'cfg_lev  = current maxSafeLeverage (liquidation-safety cap, NOT growth).\n' +
    '⚠ Standalone numbers: concurrent strategies are tail-correlated (June 2) —\n' +
    '  do NOT sum these. Portfolio Kelly + the risk layer cap the total.',
);
