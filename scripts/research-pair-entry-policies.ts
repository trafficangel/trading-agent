/** Compare bounded entry and stop policies for one pair on frozen hourly blocks. */

import { existsSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { getKlines } from '../src/backtest/klines.js';
import type { Candle } from '../src/backtest/indicators.js';
import {
  fitLogPair,
  pairFundingCarryPct,
  pairResidualZ,
  pairTradeGrossPct,
  TRUE_PAIRS_HOURLY_EPOCH_MS,
  type PairFit,
} from '../src/lib/true-pairs.js';

const HOUR_MS = 3_600_000;
const OOS_START_MS = Date.parse('2026-01-12T00:00:00Z');
const FORMATION_BARS = 60 * 24;
const TRADE_BARS = 14 * 24;
const EXIT_Z = 0.25;
const HL_COST_PCT = 0.09;
const STRESS_COST_PCT = 0.18;
const COIN_A = (process.argv[2] ?? 'DOGE').toUpperCase();
const COIN_B = (process.argv[3] ?? 'XRP').toUpperCase();

if (!/^[A-Z0-9]+$/.test(COIN_A) || !/^[A-Z0-9]+$/.test(COIN_B) || COIN_A === COIN_B) {
  throw new Error('usage: research-pair-entry-policies.ts [COIN_A] [COIN_B]');
}

type Policy = {
  id: string;
  entry: 'immediate' | 'fresh-cross' | 'reversal';
  entryZ: number;
  armZ?: number;
  reversalZ?: number;
  stopZ: number | null;
  maxHoldBars: number;
  staged?: { firstWeight: number; addZ: number };
};

const POLICIES: Policy[] = [
  {
    id: 'baseline_immediate_E2_S4_H7',
    entry: 'immediate',
    entryZ: 2,
    stopZ: 4,
    maxHoldBars: 7 * 24,
  },
  { id: 'fresh_cross_E2_S4_H7', entry: 'fresh-cross', entryZ: 2, stopZ: 4, maxHoldBars: 7 * 24 },
  {
    id: 'fresh_cross_E2.5_S4.5_H7',
    entry: 'fresh-cross',
    entryZ: 2.5,
    stopZ: 4.5,
    maxHoldBars: 7 * 24,
  },
  {
    id: 'reversal_A3.5_E3_S4.5_H7',
    entry: 'reversal',
    entryZ: 2,
    armZ: 3.5,
    reversalZ: 3,
    stopZ: 4.5,
    maxHoldBars: 7 * 24,
  },
  {
    id: 'staged_50_E2_ADD3_S4.5_H7',
    entry: 'fresh-cross',
    entryZ: 2,
    stopZ: 4.5,
    maxHoldBars: 7 * 24,
    staged: { firstWeight: 0.5, addZ: 3 },
  },
  {
    id: 'fresh_cross_E2_NO_Z_STOP_H14',
    entry: 'fresh-cross',
    entryZ: 2,
    stopZ: null,
    maxHoldBars: 14 * 24,
  },
  { id: 'fresh_cross_E2_S6_H14', entry: 'fresh-cross', entryZ: 2, stopZ: 6, maxHoldBars: 14 * 24 },
];

type Aligned = { t: number; aO: number; aC: number; bO: number; bC: number };
type Tranche = { entryIdx: number; aEntry: number; bEntry: number; weight: number };
type Trade = {
  entryAt: number;
  exitAt: number;
  netPct: number;
  stressPct: number;
  holdBars: number;
  exitReason: 'mean' | 'z-stop' | 'time' | 'rebalance';
  entryZ: number;
  worstAbsZ: number;
  deployedWeight: number;
};
type Funding = Map<string, Map<number, number>>;

function loadFunding(aCoin: string, bCoin: string): Funding {
  const result: Funding = new Map();
  if (!existsSync('data/trading.sqlite')) return result;
  const db = new Database('data/trading.sqlite', { readonly: true, fileMustExist: true });
  const rows = db
    .prepare(
      `SELECT coin, hour, funding FROM (
         SELECT coin, (ts / 3600000) * 3600000 AS hour, funding,
                ROW_NUMBER() OVER (PARTITION BY coin, ts / 3600000 ORDER BY ts DESC) AS rank
           FROM hl_micro
          WHERE funding IS NOT NULL AND coin IN (?, ?)
       ) WHERE rank = 1`,
    )
    .all(aCoin, bCoin) as Array<{ coin: string; hour: number; funding: number }>;
  db.close();
  for (const row of rows) {
    const rates = result.get(row.coin) ?? new Map<number, number>();
    rates.set(row.hour, row.funding);
    result.set(row.coin, rates);
  }
  return result;
}

function fundingCarry(
  aCoin: string,
  bCoin: string,
  direction: 1 | -1,
  beta: number,
  entryAt: number,
  exitAt: number,
  funding: Funding,
): number {
  const aRates: number[] = [];
  const bRates: number[] = [];
  const first = Math.floor(entryAt / HOUR_MS) * HOUR_MS + HOUR_MS;
  for (let hour = first; hour <= exitAt; hour += HOUR_MS) {
    const a = funding.get(aCoin)?.get(hour);
    const b = funding.get(bCoin)?.get(hour);
    if (a == null || b == null) continue;
    aRates.push(a);
    bRates.push(b);
  }
  return pairFundingCarryPct({ direction, beta, aRates, bRates });
}

function align(a: Candle[], b: Candle[]): Aligned[] {
  const byTime = new Map(b.map((bar) => [bar.t, bar]));
  return a.flatMap((bar) => {
    const bb = byTime.get(bar.t);
    return bb ? [{ t: bar.t, aO: bar.o, aC: bar.c, bO: bb.o, bC: bb.c }] : [];
  });
}

function usableFit(fit: PairFit | null): fit is PairFit {
  return (
    fit !== null &&
    fit.beta >= 0.2 &&
    fit.beta <= 2.5 &&
    fit.returnCorrelation >= 0.6 &&
    fit.halfLifeBars >= 6 &&
    fit.halfLifeBars <= 84
  );
}

function simulate(
  rows: Aligned[],
  policy: Policy,
  funding: Funding,
  aCoin: string,
  bCoin: string,
): Trade[] {
  const trades: Trade[] = [];
  for (
    let formationStart = 0;
    formationStart + FORMATION_BARS + 2 < rows.length;
    formationStart += TRADE_BARS
  ) {
    const formationEnd = formationStart + FORMATION_BARS;
    const tradeEnd = Math.min(rows.length, formationEnd + TRADE_BARS);
    const formation = rows.slice(formationStart, formationEnd);
    const fit = fitLogPair(
      formation.map((bar) => bar.aC),
      formation.map((bar) => bar.bC),
    );
    if (!usableFit(fit)) continue;

    let position: {
      direction: 1 | -1;
      tranches: Tranche[];
      entryZ: number;
      worstAbsZ: number;
    } | null = null;
    let prevZ: number | null = null;
    let armed: 1 | -1 | null = null;

    const close = (exitIdx: number, reason: Trade['exitReason']): void => {
      if (!position) return;
      const exit = rows[exitIdx]!;
      let netPct = 0;
      let stressPct = 0;
      let deployedWeight = 0;
      for (const tranche of position.tranches) {
        const gross = pairTradeGrossPct({
          direction: position.direction,
          beta: fit.beta,
          aEntry: tranche.aEntry,
          aExit: exit.aO,
          bEntry: tranche.bEntry,
          bExit: exit.bO,
        });
        const carry = fundingCarry(
          aCoin,
          bCoin,
          position.direction,
          fit.beta,
          rows[tranche.entryIdx]!.t,
          exit.t,
          funding,
        );
        netPct += tranche.weight * (gross - HL_COST_PCT + carry);
        stressPct += tranche.weight * (gross - STRESS_COST_PCT + carry);
        deployedWeight += tranche.weight;
      }
      const firstEntry = position.tranches[0]!.entryIdx;
      trades.push({
        entryAt: rows[firstEntry]!.t,
        exitAt: exit.t,
        netPct,
        stressPct,
        holdBars: exitIdx - firstEntry,
        exitReason: reason,
        entryZ: position.entryZ,
        worstAbsZ: position.worstAbsZ,
        deployedWeight,
      });
      position = null;
    };

    for (let signalIdx = formationEnd; signalIdx < tradeEnd - 1; signalIdx++) {
      const signal = rows[signalIdx]!;
      const fillIdx = signalIdx + 1;
      const z = pairResidualZ(signal.aC, signal.bC, fit);
      if (!Number.isFinite(z)) continue;

      if (position) {
        position.worstAbsZ = Math.max(position.worstAbsZ, Math.abs(z));
        const adverseStop =
          policy.stopZ != null &&
          (position.direction === 1 ? z <= -policy.stopZ : z >= policy.stopZ);
        const reverted = position.direction === 1 ? z >= -EXIT_Z : z <= EXIT_Z;
        const timedOut = fillIdx - position.tranches[0]!.entryIdx >= policy.maxHoldBars;
        if (adverseStop) close(fillIdx, 'z-stop');
        else if (reverted) close(fillIdx, 'mean');
        else if (timedOut) close(fillIdx, 'time');
        else if (
          policy.staged &&
          position.tranches.length === 1 &&
          Math.abs(z) >= policy.staged.addZ &&
          Math.sign(z) === -position.direction
        ) {
          const fill = rows[fillIdx]!;
          position.tranches.push({
            entryIdx: fillIdx,
            aEntry: fill.aO,
            bEntry: fill.bO,
            weight: 1 - policy.staged.firstWeight,
          });
        }
        prevZ = z;
        continue;
      }

      const absZ = Math.abs(z);
      const sign: 1 | -1 = z < 0 ? -1 : 1;
      if (policy.entry === 'reversal') {
        if (absZ >= policy.armZ!) armed = sign;
        const reversed =
          armed === sign &&
          absZ >= policy.entryZ &&
          absZ <= policy.reversalZ! &&
          prevZ != null &&
          absZ < Math.abs(prevZ);
        if (!reversed) {
          prevZ = z;
          continue;
        }
      } else {
        const eligible = absZ >= policy.entryZ && (policy.stopZ == null || absZ < policy.stopZ);
        const crossed = prevZ != null && Math.abs(prevZ) < policy.entryZ;
        if (!eligible || (policy.entry === 'fresh-cross' && !crossed)) {
          prevZ = z;
          continue;
        }
      }

      const fill = rows[fillIdx]!;
      const direction: 1 | -1 = z < 0 ? 1 : -1;
      position = {
        direction,
        tranches: [
          {
            entryIdx: fillIdx,
            aEntry: fill.aO,
            bEntry: fill.bO,
            weight: policy.staged?.firstWeight ?? 1,
          },
        ],
        entryZ: z,
        worstAbsZ: absZ,
      };
      armed = null;
      prevZ = z;
    }
    if (position) close(tradeEnd - 1, 'rebalance');
  }
  return trades;
}

function stats(trades: Trade[]): Record<string, number> {
  const ordered = [...trades].sort((a, b) => a.exitAt - b.exitAt);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let gains = 0;
  let losses = 0;
  for (const trade of ordered) {
    equity += trade.stressPct;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (trade.stressPct > 0) gains += trade.stressPct;
    else losses -= trade.stressPct;
  }
  const stressNet = ordered.reduce((sum, trade) => sum + trade.stressPct, 0);
  const best = ordered.reduce((value, trade) => Math.max(value, trade.stressPct), 0);
  return {
    n: ordered.length,
    net: ordered.reduce((sum, trade) => sum + trade.netPct, 0),
    stressNet,
    stressWithoutBest: stressNet - best,
    stressPf: losses ? gains / losses : gains ? 99 : 0,
    winRate: ordered.length
      ? ordered.filter((trade) => trade.netPct > 0).length / ordered.length
      : 0,
    maxDrawdown,
    worstTrade: ordered.reduce((value, trade) => Math.min(value, trade.stressPct), 0),
    avgHoldHours: ordered.length
      ? ordered.reduce((sum, trade) => sum + trade.holdBars, 0) / ordered.length
      : 0,
    meanExitRate: ordered.length
      ? ordered.filter((trade) => trade.exitReason === 'mean').length / ordered.length
      : 0,
    stopRate: ordered.length
      ? ordered.filter((trade) => trade.exitReason === 'z-stop').length / ordered.length
      : 0,
    avgWorstAbsZ: ordered.length
      ? ordered.reduce((sum, trade) => sum + trade.worstAbsZ, 0) / ordered.length
      : 0,
    avgDeployedWeight: ordered.length
      ? ordered.reduce((sum, trade) => sum + trade.deployedWeight, 0) / ordered.length
      : 0,
  };
}

function rounded<T extends Record<string, number>>(row: T): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Math.round(value * 10_000) / 10_000]),
  ) as T;
}

async function main(): Promise<void> {
  const now = Date.now();
  const [a, b] = await Promise.all([
    getKlines(`${COIN_A}USDT`, '60', TRUE_PAIRS_HOURLY_EPOCH_MS, now),
    getKlines(`${COIN_B}USDT`, '60', TRUE_PAIRS_HOURLY_EPOCH_MS, now),
  ]);
  const rows = align(a, b);
  const funding = loadFunding(COIN_A, COIN_B);
  const results = POLICIES.map((policy) => {
    const trades = simulate(rows, policy, funding, COIN_A, COIN_B);
    return {
      policy,
      discovery: rounded(stats(trades.filter((trade) => trade.exitAt < OOS_START_MS))),
      oos: rounded(stats(trades.filter((trade) => trade.entryAt >= OOS_START_MS))),
      all: rounded(stats(trades)),
    };
  });
  const output = {
    generatedAt: new Date().toISOString(),
    pair: `${COIN_A}/${COIN_B}`,
    rows: rows.length,
    results,
  };
  const outputPath = `data/pair-entry-policy-results-${COIN_A.toLowerCase()}-${COIN_B.toLowerCase()}.json`;
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`${output.pair} · ${rows.length} aligned hourly bars · ${outputPath}`);
  console.table(
    results.map((row) => ({
      policy: row.policy.id,
      Dn: row.discovery.n,
      Dstress: row.discovery.stressNet,
      Dpf: row.discovery.stressPf,
      On: row.oos.n,
      Ostress: row.oos.stressNet,
      Opf: row.oos.stressPf,
      OmaxDD: row.oos.maxDrawdown,
      Omean: row.oos.meanExitRate,
      Ostop: row.oos.stopRate,
    })),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
