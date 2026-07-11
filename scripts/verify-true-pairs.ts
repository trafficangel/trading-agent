/**
 * Faithful two-leg cryptocurrency pairs verifier.
 *
 * Every weekly/daily trading block uses only its preceding formation window.
 * Signals are computed at a 5m close and both legs fill at the next bar open.
 * PnL includes the beta-weighted hedge leg and is normalized by total gross
 * exposure. The final six months are frozen OOS; candidates are selected only
 * on the earlier discovery sample.
 *
 * Run on the VPS: pnpm tsx scripts/verify-true-pairs.ts
 */

import { existsSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { getKlines } from '../src/backtest/klines.js';
import type { Candle } from '../src/backtest/indicators.js';
import { fitLogPair, pairResidualZ, pairTradeGrossPct, type PairFit } from '../src/lib/true-pairs.js';

const PROFILE = process.argv[2] === 'hourly' ? 'hourly' : '5m';
const TF = PROFILE === 'hourly' ? '60' : '5';
const DAYS = PROFILE === 'hourly' ? 720 : 552;
const MIN_ALIGNED_BARS = PROFILE === 'hourly' ? 10_000 : 100_000;
const OUTPUT_PATH = PROFILE === 'hourly' ? 'data/true-pairs-hourly-results.json' : 'data/true-pairs-results.json';
const OOS_START_MS = Date.parse('2026-01-12T00:00:00Z');
const HL_TAKER_RT_PCT = 0.09;
const BYBIT_TAKER_RT_PCT = 0.11;
const STRESS_RT_PCT = 0.18;
const MIN_CORRELATION = 0.6;
const MIN_BETA = 0.2;
const MAX_BETA = 2.5;
const UNIVERSE = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'LTC', 'LINK', 'DOGE', 'AVAX', 'UNI', 'AAVE', 'CRV', 'JUP', 'SUI'];

type Model = {
  id: string;
  formationBars: number;
  tradeBars: number;
  entryZ: number;
  exitZ: number;
  stopZ: number;
  maxHoldBars: number;
};

// 5m was frozen before its first run. Hourly was frozen after that family
// failed and before the first hourly run; hourly results are exploratory and
// require forward shadow from Jul 12 rather than reusing the seen OOS as proof.
const MODELS: Model[] = PROFILE === 'hourly'
  ? [
      { id: 'H_F60_R14_E2', formationBars: 60 * 24, tradeBars: 14 * 24, entryZ: 2, exitZ: 0.25, stopZ: 4, maxHoldBars: 7 * 24 },
      { id: 'H_F90_R30_E2.5', formationBars: 90 * 24, tradeBars: 30 * 24, entryZ: 2.5, exitZ: 0.5, stopZ: 4, maxHoldBars: 14 * 24 },
    ]
  : [
      { id: 'F30_R7_E2', formationBars: 30 * 288, tradeBars: 7 * 288, entryZ: 2, exitZ: 0.25, stopZ: 4, maxHoldBars: 3 * 288 },
      { id: 'F14_R3_E2.5', formationBars: 14 * 288, tradeBars: 3 * 288, entryZ: 2.5, exitZ: 0.5, stopZ: 4, maxHoldBars: 288 },
    ];

type AlignedBar = { t: number; aO: number; aC: number; bO: number; bC: number };
type ExitReason = 'mean' | 'z-stop' | 'time' | 'rebalance';
type PairTrade = {
  pair: string;
  model: string;
  direction: 1 | -1;
  beta: number;
  entryAt: number;
  exitAt: number;
  holdBars: number;
  grossPct: number;
  netPct: number;
  bybitNetPct: number;
  stressPct: number;
  fundingPct: number;
  fundingHours: number;
  expectedFundingHours: number;
  exitReason: ExitReason;
};
type Stats = {
  n: number;
  net: number;
  stressNet: number;
  profitFactor: number;
  stressProfitFactor: number;
  winRate: number;
  maxDrawdown: number;
  positivePeriods: number;
  periods: number;
  stressWithoutBest: number;
  fundingNet: number;
  fundingCoverage: number;
};

type FundingByCoin = Map<string, Map<number, number>>;

function loadFunding(): FundingByCoin {
  const path = 'data/trading.sqlite';
  const result: FundingByCoin = new Map();
  if (!existsSync(path)) return result;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const rows = db.prepare(`
    SELECT coin, hour, funding FROM (
      SELECT coin, (ts / 3600000) * 3600000 AS hour, funding,
             ROW_NUMBER() OVER (PARTITION BY coin, ts / 3600000 ORDER BY ts DESC) AS rank
      FROM hl_micro
      WHERE funding IS NOT NULL
    ) WHERE rank = 1
  `).all() as Array<{ coin: string; hour: number; funding: number }>;
  db.close();
  for (const row of rows) {
    let coin = result.get(row.coin);
    if (!coin) {
      coin = new Map();
      result.set(row.coin, coin);
    }
    coin.set(row.hour, row.funding);
  }
  return result;
}

function fundingCarry(args: {
  a: string;
  b: string;
  direction: 1 | -1;
  beta: number;
  entryAt: number;
  exitAt: number;
  funding: FundingByCoin;
}): { pct: number; matched: number; expected: number } {
  const aRates = args.funding.get(args.a);
  const bRates = args.funding.get(args.b);
  let pct = 0;
  let matched = 0;
  let expected = 0;
  const firstHour = Math.floor(args.entryAt / 3_600_000) * 3_600_000 + 3_600_000;
  for (let hour = firstHour; hour <= args.exitAt; hour += 3_600_000) {
    expected++;
    const aRate = aRates?.get(hour);
    const bRate = bRates?.get(hour);
    if (aRate == null || bRate == null) continue;
    // A side is direction; B side is the opposite beta-weighted hedge.
    pct += args.direction * (-aRate + args.beta * bRate) / (1 + args.beta) * 100;
    matched++;
  }
  return { pct, matched, expected };
}

function align(a: Candle[], b: Candle[]): AlignedBar[] {
  const rows: AlignedBar[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const aa = a[i]!;
    const bb = b[j]!;
    if (aa.t === bb.t) {
      rows.push({ t: aa.t, aO: aa.o, aC: aa.c, bO: bb.o, bC: bb.c });
      i++;
      j++;
    } else if (aa.t < bb.t) i++;
    else j++;
  }
  return rows;
}

function usableFit(fit: PairFit | null, model: Model): fit is PairFit {
  return fit !== null
    && fit.beta >= MIN_BETA
    && fit.beta <= MAX_BETA
    && fit.returnCorrelation >= MIN_CORRELATION
    && fit.halfLifeBars >= 6
    && fit.halfLifeBars <= model.maxHoldBars / 2;
}

function simulate(pair: string, a: string, b: string, rows: AlignedBar[], model: Model, funding: FundingByCoin): PairTrade[] {
  const trades: PairTrade[] = [];
  for (let formationStart = 0; formationStart + model.formationBars + 2 < rows.length; formationStart += model.tradeBars) {
    const formationEnd = formationStart + model.formationBars;
    const tradeEnd = Math.min(rows.length, formationEnd + model.tradeBars);
    const formation = rows.slice(formationStart, formationEnd);
    const fit = fitLogPair(formation.map((bar) => bar.aC), formation.map((bar) => bar.bC));
    if (!usableFit(fit, model)) continue;

    let position: { direction: 1 | -1; entryIdx: number; aEntry: number; bEntry: number } | null = null;
    const close = (exitIdx: number, reason: ExitReason): void => {
      if (!position) return;
      const exit = rows[exitIdx]!;
      const grossPct = pairTradeGrossPct({
        direction: position.direction,
        beta: fit.beta,
        aEntry: position.aEntry,
        aExit: exit.aO,
        bEntry: position.bEntry,
        bExit: exit.bO,
      });
      const carry = fundingCarry({
        a,
        b,
        direction: position.direction,
        beta: fit.beta,
        entryAt: rows[position.entryIdx]!.t,
        exitAt: exit.t,
        funding,
      });
      trades.push({
        pair,
        model: model.id,
        direction: position.direction,
        beta: fit.beta,
        entryAt: rows[position.entryIdx]!.t,
        exitAt: exit.t,
        holdBars: exitIdx - position.entryIdx,
        grossPct,
        netPct: grossPct - HL_TAKER_RT_PCT + carry.pct,
        bybitNetPct: grossPct - BYBIT_TAKER_RT_PCT + carry.pct,
        stressPct: grossPct - STRESS_RT_PCT + carry.pct,
        fundingPct: carry.pct,
        fundingHours: carry.matched,
        expectedFundingHours: carry.expected,
        exitReason: reason,
      });
      position = null;
    };

    for (let signalIdx = formationEnd; signalIdx < tradeEnd - 1; signalIdx++) {
      const signal = rows[signalIdx]!;
      const fillIdx = signalIdx + 1;
      const z = pairResidualZ(signal.aC, signal.bC, fit);
      if (!Number.isFinite(z)) continue;
      if (position) {
        const adverseStop = position.direction === 1 ? z <= -model.stopZ : z >= model.stopZ;
        const reverted = position.direction === 1 ? z >= -model.exitZ : z <= model.exitZ;
        const timedOut = fillIdx - position.entryIdx >= model.maxHoldBars;
        if (adverseStop) close(fillIdx, 'z-stop');
        else if (reverted) close(fillIdx, 'mean');
        else if (timedOut) close(fillIdx, 'time');
        continue;
      }
      if (Math.abs(z) < model.entryZ || Math.abs(z) >= model.stopZ) continue;
      const fill = rows[fillIdx]!;
      position = {
        direction: z < 0 ? 1 : -1,
        entryIdx: fillIdx,
        aEntry: fill.aO,
        bEntry: fill.bO,
      };
    }
    if (position) close(tradeEnd - 1, 'rebalance');
  }
  return trades;
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function stats(trades: PairTrade[], period: 'month' | 'quarter'): Stats {
  let gains = 0;
  let losses = 0;
  let stressGains = 0;
  let stressLosses = 0;
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let fundingNet = 0;
  let fundingHours = 0;
  let expectedFundingHours = 0;
  const buckets = new Map<string, number>();
  for (const trade of [...trades].sort((a, b) => a.exitAt - b.exitAt)) {
    if (trade.netPct > 0) gains += trade.netPct;
    else losses -= trade.netPct;
    if (trade.stressPct > 0) stressGains += trade.stressPct;
    else stressLosses -= trade.stressPct;
    cumulative += trade.stressPct;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    fundingNet += trade.fundingPct;
    fundingHours += trade.fundingHours;
    expectedFundingHours += trade.expectedFundingHours;
    const date = new Date(trade.exitAt);
    const key = period === 'month'
      ? date.toISOString().slice(0, 7)
      : `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
    buckets.set(key, (buckets.get(key) ?? 0) + trade.stressPct);
  }
  const stressNet = trades.reduce((sum, trade) => sum + trade.stressPct, 0);
  const best = trades.reduce((value, trade) => Math.max(value, trade.stressPct), 0);
  return {
    n: trades.length,
    net: rounded(trades.reduce((sum, trade) => sum + trade.netPct, 0)),
    stressNet: rounded(stressNet),
    profitFactor: rounded(losses > 0 ? gains / losses : gains > 0 ? 99 : 0),
    stressProfitFactor: rounded(stressLosses > 0 ? stressGains / stressLosses : stressGains > 0 ? 99 : 0),
    winRate: rounded(trades.length ? trades.filter((trade) => trade.netPct > 0).length / trades.length : 0),
    maxDrawdown: rounded(maxDrawdown),
    positivePeriods: [...buckets.values()].filter((value) => value > 0).length,
    periods: buckets.size,
    stressWithoutBest: rounded(stressNet - best),
    fundingNet: rounded(fundingNet),
    fundingCoverage: rounded(expectedFundingHours > 0 ? fundingHours / expectedFundingHours : 1),
  };
}

function allPairs(): Array<{ a: string; b: string }> {
  const pairs: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < UNIVERSE.length; i++) {
    for (let j = i + 1; j < UNIVERSE.length; j++) pairs.push({ a: UNIVERSE[j]!, b: UNIVERSE[i]! });
  }
  return pairs;
}

async function main(): Promise<void> {
  const now = Date.now();
  const from = now - DAYS * 86_400_000;
  console.log(`True pairs ${PROFILE} · ${TF}m · ${UNIVERSE.length} coins · ${allPairs().length} pairs · OOS ${new Date(OOS_START_MS).toISOString()}`);
  console.log(`next-open both legs · HL taker ${HL_TAKER_RT_PCT}% · Bybit taker ${BYBIT_TAKER_RT_PCT}% · stress ${STRESS_RT_PCT}% gross RT\n`);
  const candles = new Map<string, Candle[]>();
  const funding = loadFunding();
  console.log(`funding history: ${funding.size} coins loaded`);
  for (const coin of UNIVERSE) {
    const rows = await getKlines(`${coin}USDT`, TF, from, now);
    candles.set(coin, rows);
    process.stderr.write(`  ${coin}: ${rows.length} bars\n`);
  }

  const results: Array<{
    pair: string;
    model: string;
    anchored: boolean;
    discovery: Stats;
    oos: Stats;
    discoveryPass: boolean;
    pass: boolean;
  }> = [];
  for (const { a, b } of allPairs()) {
    const pair = `${a}/${b}`;
    const aligned = align(candles.get(a) ?? [], candles.get(b) ?? []);
    if (aligned.length < MIN_ALIGNED_BARS) continue;
    for (const model of MODELS) {
      const trades = simulate(pair, a, b, aligned, model, funding);
      const discovery = stats(trades.filter((trade) => trade.exitAt < OOS_START_MS), 'quarter');
      const oos = stats(trades.filter((trade) => trade.entryAt >= OOS_START_MS), 'month');
      const discoveryPass = discovery.n >= 30
        && discovery.stressNet > 0
        && discovery.stressProfitFactor >= 1.15
        && discovery.positivePeriods >= 3
        && discovery.stressWithoutBest > 0
        && discovery.fundingCoverage >= 0.95;
      const pass = discoveryPass
        && oos.n >= 12
        && oos.stressNet > 0
        && oos.stressProfitFactor >= 1.1
        && oos.positivePeriods >= 3
        && oos.stressWithoutBest > 0
        && oos.fundingCoverage >= 0.95;
      results.push({ pair, model: model.id, anchored: b === 'BTC', discovery, oos, discoveryPass, pass });
    }
    process.stderr.write(`  ${pair} done\n`);
  }

  const passing = results.filter((row) => row.pass).sort((a, b) => b.oos.stressNet - a.oos.stressNet);
  const discoveryCandidates = results.filter((row) => row.discoveryPass).sort((a, b) => b.discovery.stressNet - a.discovery.stressNet);
  const output = {
    version: 1,
    profile: PROFILE,
    validationStatus: PROFILE === 'hourly' ? 'exploratory-requires-forward-shadow-from-2026-07-12' : 'frozen-historical-oos',
    generatedAt: new Date().toISOString(),
    oosStartAt: OOS_START_MS,
    universe: UNIVERSE,
    models: MODELS,
    costsPct: { hlTakerRoundTrip: HL_TAKER_RT_PCT, bybitTakerRoundTrip: BYBIT_TAKER_RT_PCT, stressRoundTrip: STRESS_RT_PCT },
    gates: {
      minCorrelation: MIN_CORRELATION,
      beta: [MIN_BETA, MAX_BETA],
      discovery: { minTrades: 30, minStressPf: 1.15, minPositiveQuarters: 3, positiveWithoutBest: true },
      oos: { minTrades: 12, minStressPf: 1.1, minPositiveMonths: 3, positiveWithoutBest: true },
      minFundingCoverage: 0.95,
    },
    discoveryCandidates,
    passing,
    results,
  };
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  const line = (row: typeof results[number]): string =>
    `${row.pass ? 'PASS' : '    '} ${row.pair.padEnd(11)} ${row.model.padEnd(12)} `
    + `D[N${String(row.discovery.n).padStart(3)} stress ${String(row.discovery.stressNet).padStart(7)} PF ${row.discovery.stressProfitFactor.toFixed(2)} q${row.discovery.positivePeriods}/${row.discovery.periods}] `
    + `OOS[N${String(row.oos.n).padStart(3)} stress ${String(row.oos.stressNet).padStart(7)} PF ${row.oos.stressProfitFactor.toFixed(2)} m${row.oos.positivePeriods}/${row.oos.periods}] `
    + `fundCov ${Math.round(row.oos.fundingCoverage * 100)}%`;
  console.log(`\nDiscovery candidates: ${discoveryCandidates.length}/${results.length}`);
  console.log(discoveryCandidates.slice(0, 20).map(line).join('\n') || '  none');
  console.log(`\nStrict OOS passes: ${passing.length}`);
  console.log(passing.map(line).join('\n') || '  none');
  console.log(`\nFull audit: ${OUTPUT_PATH}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
