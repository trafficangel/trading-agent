/** Causal high-frequency cross-sectional crypto stat-arb research. */

import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import type { Candle } from '../src/backtest/indicators.js';

const FIVE_MIN_MS = 300_000;
const DAY_MS = 86_400_000;
const START_MS = Date.parse('2025-01-01T00:00:00Z');
const OOS_START_MS = Date.parse('2026-01-12T00:00:00Z');
const COST_PCT = 0.09;
const STRESS_COST_PCT = 0.18;
const FACTOR = 'BTC';
const ASSETS = ['ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'LTC', 'LINK', 'DOGE', 'AVAX', 'UNI'];

type Profile = {
  id: string;
  mode: 'revert' | 'momentum';
  decisionBars: number;
  betaBars: number;
  signalBars: number;
  holdBars: number;
  minGapPct: number;
};

// Frozen before the first run. All bars are 5m; 12 bars = 1 hour.
const PROFILES: Profile[] = [
  {
    id: 'XS_REV_D15M_L1H_H1H_G0.8',
    mode: 'revert',
    decisionBars: 3,
    betaBars: 7 * 288,
    signalBars: 12,
    holdBars: 12,
    minGapPct: 0.8,
  },
  {
    id: 'XS_REV_D30M_L2H_H2H_G1.2',
    mode: 'revert',
    decisionBars: 6,
    betaBars: 7 * 288,
    signalBars: 24,
    holdBars: 24,
    minGapPct: 1.2,
  },
  {
    id: 'XS_REV_D1H_L4H_H4H_G1.8',
    mode: 'revert',
    decisionBars: 12,
    betaBars: 14 * 288,
    signalBars: 48,
    holdBars: 48,
    minGapPct: 1.8,
  },
  {
    id: 'XS_MOM_D15M_L1H_H1H_G0.8',
    mode: 'momentum',
    decisionBars: 3,
    betaBars: 7 * 288,
    signalBars: 12,
    holdBars: 12,
    minGapPct: 0.8,
  },
  {
    id: 'XS_MOM_D30M_L2H_H2H_G1.2',
    mode: 'momentum',
    decisionBars: 6,
    betaBars: 7 * 288,
    signalBars: 24,
    holdBars: 24,
    minGapPct: 1.2,
  },
  {
    id: 'XS_MOM_D1H_L4H_H4H_G1.8',
    mode: 'momentum',
    decisionBars: 12,
    betaBars: 14 * 288,
    signalBars: 48,
    holdBars: 48,
    minGapPct: 1.8,
  },
];

type Row = { t: number; opens: Record<string, number>; closes: Record<string, number> };
type FactorStats = { beta: number[]; correlation: number[] };
type Trade = {
  entryAt: number;
  exitAt: number;
  long: string;
  short: string;
  gapPct: number;
  grossPct: number;
  netPct: number;
  stressPct: number;
};

function align(candles: Map<string, Candle[]>): Row[] {
  const maps = new Map(
    [...candles.entries()].map(([coin, rows]) => [coin, new Map(rows.map((bar) => [bar.t, bar]))]),
  );
  const factorRows = candles.get(FACTOR) ?? [];
  return factorRows.flatMap((factorBar) => {
    const opens: Record<string, number> = {};
    const closes: Record<string, number> = {};
    for (const coin of [FACTOR, ...ASSETS]) {
      const bar = maps.get(coin)?.get(factorBar.t);
      if (!bar) return [];
      opens[coin] = bar.o;
      closes[coin] = bar.c;
    }
    return [{ t: factorBar.t, opens, closes }];
  });
}

function logReturns(rows: Row[], coin: string): number[] {
  return rows.map((row, index) =>
    index ? Math.log(row.closes[coin]! / rows[index - 1]!.closes[coin]!) : 0,
  );
}

function rollingFactorStats(x: number[], y: number[], window: number): FactorStats {
  const beta = Array(x.length).fill(Number.NaN) as number[];
  const correlation = Array(x.length).fill(Number.NaN) as number[];
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 1; i < x.length; i++) {
    sx += x[i]!;
    sy += y[i]!;
    sxx += x[i]! * x[i]!;
    syy += y[i]! * y[i]!;
    sxy += x[i]! * y[i]!;
    if (i > window) {
      const old = i - window;
      sx -= x[old]!;
      sy -= y[old]!;
      sxx -= x[old]! * x[old]!;
      syy -= y[old]! * y[old]!;
      sxy -= x[old]! * y[old]!;
    }
    if (i < window) continue;
    const n = window;
    const covariance = sxy - (sx * sy) / n;
    const varianceX = sxx - (sx * sx) / n;
    const varianceY = syy - (sy * sy) / n;
    if (!(varianceX > 0) || !(varianceY > 0)) continue;
    beta[i] = covariance / varianceX;
    correlation[i] = covariance / Math.sqrt(varianceX * varianceY);
  }
  return { beta, correlation };
}

function simulate(rows: Row[], profile: Profile): Trade[] {
  const factorReturns = logReturns(rows, FACTOR);
  const stats = new Map<string, FactorStats>();
  for (const coin of ASSETS) {
    stats.set(coin, rollingFactorStats(factorReturns, logReturns(rows, coin), profile.betaBars));
  }
  const trades: Trade[] = [];
  let nextAvailable = profile.betaBars;
  for (
    let signalIdx = profile.betaBars;
    signalIdx + 1 + profile.holdBars < rows.length;
    signalIdx += profile.decisionBars
  ) {
    if (signalIdx < nextAvailable) continue;
    const factorMove = Math.log(
      rows[signalIdx]!.closes[FACTOR]! / rows[signalIdx - profile.signalBars]!.closes[FACTOR]!,
    );
    const ranked = ASSETS.flatMap((coin) => {
      const beta = stats.get(coin)!.beta[signalIdx]!;
      const correlation = stats.get(coin)!.correlation[signalIdx]!;
      if (!(beta >= 0.2 && beta <= 2.5 && correlation >= 0.5)) return [];
      const move = Math.log(
        rows[signalIdx]!.closes[coin]! / rows[signalIdx - profile.signalBars]!.closes[coin]!,
      );
      return [{ coin, beta, residualPct: (move - beta * factorMove) * 100 }];
    }).sort((a, b) => a.residualPct - b.residualPct);
    const low = ranked[0];
    const high = ranked.at(-1);
    if (!low || !high || low.coin === high.coin) continue;
    const gapPct = high.residualPct - low.residualPct;
    if (gapPct < profile.minGapPct) continue;
    const long = profile.mode === 'revert' ? low : high;
    const short = profile.mode === 'revert' ? high : low;
    const entryIdx = signalIdx + 1;
    const exitIdx = entryIdx + profile.holdBars;
    const hedge = long.beta / short.beta;
    const longReturn = rows[exitIdx]!.opens[long.coin]! / rows[entryIdx]!.opens[long.coin]! - 1;
    const shortReturn = rows[exitIdx]!.opens[short.coin]! / rows[entryIdx]!.opens[short.coin]! - 1;
    const grossPct = ((longReturn - hedge * shortReturn) / (1 + hedge)) * 100;
    trades.push({
      entryAt: rows[entryIdx]!.t,
      exitAt: rows[exitIdx]!.t,
      long: long.coin,
      short: short.coin,
      gapPct,
      grossPct,
      netPct: grossPct - COST_PCT,
      stressPct: grossPct - STRESS_COST_PCT,
    });
    nextAvailable = exitIdx;
  }
  return trades;
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function stats(trades: Trade[], from: number, through: number) {
  const ordered = [...trades].sort((a, b) => a.exitAt - b.exitAt);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let gains = 0;
  let losses = 0;
  const months = new Map<string, number>();
  for (const trade of ordered) {
    equity += trade.stressPct;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (trade.stressPct > 0) gains += trade.stressPct;
    else losses -= trade.stressPct;
    const month = new Date(trade.exitAt).toISOString().slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + trade.stressPct);
  }
  const stressNet = ordered.reduce((sum, trade) => sum + trade.stressPct, 0);
  const best = ordered.reduce((value, trade) => Math.max(value, trade.stressPct), 0);
  const days = Math.max(1, (through - from) / DAY_MS);
  return {
    n: ordered.length,
    tradesPerDay: rounded(ordered.length / days),
    net: rounded(ordered.reduce((sum, trade) => sum + trade.netPct, 0)),
    stressNet: rounded(stressNet),
    stressWithoutBest: rounded(stressNet - best),
    stressPf: rounded(losses ? gains / losses : gains ? 99 : 0),
    winRate: rounded(
      ordered.length ? ordered.filter((trade) => trade.netPct > 0).length / ordered.length : 0,
    ),
    maxDrawdown: rounded(maxDrawdown),
    positiveMonths: [...months.values()].filter((value) => value > 0).length,
    months: months.size,
    avgGapPct: rounded(
      ordered.length ? ordered.reduce((sum, trade) => sum + trade.gapPct, 0) / ordered.length : 0,
    ),
  };
}

async function main(): Promise<void> {
  const now = Date.now();
  const candles = new Map<string, Candle[]>();
  for (const coin of [FACTOR, ...ASSETS]) {
    const rows = await getKlines(`${coin}USDT`, '5', START_MS, now);
    candles.set(coin, rows);
    process.stderr.write(`  ${coin}: ${rows.length} bars\n`);
  }
  const rows = align(candles);
  const results = PROFILES.map((profile) => {
    const trades = simulate(rows, profile);
    const discovery = stats(
      trades.filter((trade) => trade.exitAt < OOS_START_MS),
      START_MS + profile.betaBars * FIVE_MIN_MS,
      OOS_START_MS,
    );
    const oos = stats(
      trades.filter((trade) => trade.entryAt >= OOS_START_MS),
      OOS_START_MS,
      now,
    );
    const pass =
      discovery.n >= 100 &&
      discovery.stressNet > 0 &&
      discovery.stressWithoutBest > 0 &&
      discovery.stressPf >= 1.1 &&
      discovery.positiveMonths / Math.max(1, discovery.months) >= 0.6 &&
      oos.n >= 50 &&
      oos.stressNet > 0 &&
      oos.stressWithoutBest > 0 &&
      oos.stressPf >= 1.1 &&
      oos.positiveMonths / Math.max(1, oos.months) >= 0.6;
    return { profile, discovery, oos, pass };
  });
  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    status: 'frozen-before-first-run',
    factor: FACTOR,
    assets: ASSETS,
    costsPct: { normal: COST_PCT, stress: STRESS_COST_PCT },
    rows: rows.length,
    results,
  };
  writeFileSync('data/cross-sectional-stat-arb-results.json', JSON.stringify(output, null, 2));
  console.table(
    results.map((row) => ({
      profile: row.profile.id,
      Dn: row.discovery.n,
      DperDay: row.discovery.tradesPerDay,
      Dstress: row.discovery.stressNet,
      Dpf: row.discovery.stressPf,
      On: row.oos.n,
      OperDay: row.oos.tradesPerDay,
      Ostress: row.oos.stressNet,
      Opf: row.oos.stressPf,
      Omonths: `${row.oos.positiveMonths}/${row.oos.months}`,
      pass: row.pass,
    })),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
