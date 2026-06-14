/**
 * TP/SL sweep (read-only) — settles "should strategies have a take-profit
 * at 1:N risk:reward?" with data, not intuition.
 *
 * For each ENABLED strategy, per trade we know (from the MAE/MFE backfill):
 *   maePct  = worst adverse excursion %   (+ maeAt timestamp)
 *   mfePct  = best favourable excursion %  (+ mfeAt timestamp)
 *   realizedPct = native exit % (no SL/TP)
 *
 * For a grid of SL% and TP (as an R-multiple of SL) we simulate each trade:
 *   slHit = maePct >= SL ;  tpHit = mfePct >= TP   (TP% = SL × R)
 *   - both hit  → whichever happened FIRST (maeAt vs mfeAt) decides
 *   - SL first  → −SL ;  TP first → +TP ;  neither → realized native
 *   net of 0.11% round-trip commission.
 *
 * Reports, per strategy at SL=5%, the net for TP off / 2R / 3R / 4R, so we
 * see directly whether a take-profit (esp. the requested 1:3) helps or hurts.
 *
 * Run on the VPS after: pnpm tsx scripts/backfill-mae.ts --force  (for MFE).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { STRATEGY_CONFIGS, TRACK_C_COMMISSION_RT_PCT } from '../src/strategies/track-c-config.js';

const COMM = TRACK_C_COMMISSION_RT_PCT;

type T = { side: string; maePct?: number; maeAt?: number; mfePct?: number; mfeAt?: number; realizedPct?: number; entryPrice: number; exitPrice: number };

function load(id: string): T[] | null {
  const p = resolve('src/strategies/data', `${id}.json`);
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, 'utf8')) as { tradesLog?: T[] };
  return raw.tradesLog ?? null;
}

function realized(t: T): number {
  if (typeof t.realizedPct === 'number') return t.realizedPct;
  const sign = t.side === 'long' ? 1 : -1;
  return (sign * (t.exitPrice - t.entryPrice)) / t.entryPrice * 100;
}

/** Net % over trades for a given SL and TP-R-multiple (0 = no TP). */
function simulate(trades: T[], slPct: number, tpR: number): number {
  const SL = slPct * 100;
  const TP = tpR > 0 ? SL * tpR : Infinity;
  let net = 0;
  for (const t of trades) {
    const mae = t.maePct ?? 0;
    const mfe = t.mfePct ?? 0;
    const slHit = mae >= SL;
    const tpHit = mfe >= TP;
    let outcome: number;
    if (slHit && tpHit) {
      // order by timestamp; if unknown, assume SL first (conservative)
      const slFirst = (t.maeAt ?? 0) <= (t.mfeAt ?? Number.MAX_SAFE_INTEGER);
      outcome = slFirst ? -SL : TP;
    } else if (slHit) outcome = -SL;
    else if (tpHit) outcome = TP;
    else outcome = realized(t);
    net += outcome - COMM;
  }
  return net;
}

const configs = Object.values(STRATEGY_CONFIGS).filter((c) => c.enabled);
console.log(`TP/SL sweep · net % of $1000 notional, commission-in · SL fixed at 5%\n`);
console.log('strat  ' + 'symbol'.padEnd(9) + '  N    native   noTP@5%   TP2R(1:2)  TP3R(1:3)  TP4R(1:4)  best');
console.log('-'.repeat(92));

let haveMfe = true;
for (const cfg of configs) {
  const trades = load(cfg.id);
  if (!trades || !trades.length) { console.log(`${cfg.code}  ${String(cfg.symbol).padEnd(9)} — no data`); continue; }
  if (trades.some((t) => typeof t.mfePct !== 'number')) { haveMfe = false; }
  const nat = trades.reduce((a, t) => a + realized(t) - COMM, 0);
  const noTp = simulate(trades, 0.05, 0);
  const r2 = simulate(trades, 0.05, 2);
  const r3 = simulate(trades, 0.05, 3);
  const r4 = simulate(trades, 0.05, 4);
  const best = Math.max(noTp, r2, r3, r4);
  const tag = best === noTp ? 'noTP' : best === r2 ? '1:2' : best === r3 ? '1:3' : '1:4';
  console.log(
    `${cfg.code}  ${String(cfg.symbol).padEnd(9)} ${String(trades.length).padStart(3)}  ` +
      `${nat.toFixed(1).padStart(7)}  ${noTp.toFixed(1).padStart(7)}  ${r2.toFixed(1).padStart(8)}  ${r3.toFixed(1).padStart(8)}  ${r4.toFixed(1).padStart(8)}  ${tag}`,
  );
}
if (!haveMfe) console.log('\n⚠ Some strategies lack mfePct — run: pnpm tsx scripts/backfill-mae.ts --force');
console.log('\nREAD: if "best" is noTP for (almost) every strategy → a take-profit HURTS our contrarian book.');
