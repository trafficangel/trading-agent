/**
 * Preregistered Lighter-native cross-sectional residual pair research.
 *
 * This is one economic hypothesis expressed at 1m and 5m, not a parameter
 * optimizer. At fixed 15-minute decisions it beta-neutralizes every alt to
 * BTC over the prior seven days, ranks the causal one-hour residual move, and
 * pairs the two residual extremes when dispersion is at least 0.80%.
 * `reversion` buys the laggard and sells the leader. Its independently
 * preregistered `momentum` sibling does the exact reverse without changing
 * any lookback, threshold, holding period, cost, or qualification gate.
 * Entry is the next bar open and exit is exactly one hour later.
 *
 * Qualification is intentionally fail-closed and uses the same $100 market-
 * specific executable L2 p95 costs as Native Quant, adverse funding, 1.5x
 * cost stress, untouched final-30% OOS, chronological folds, regimes,
 * breadth, leave-one-asset-out and a 5% drawdown ceiling. The script only
 * writes a research report; it cannot register a strategy or trade.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Candle } from '../src/backtest/indicators.js';

const ASSETS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'LTC', 'HYPE', 'ZEC', 'DOGE',
  'NEAR', 'JUP', 'LIT', 'GRAM', 'XMR', 'ENA', 'TAO',
] as const;
const FACTOR = 'BTC';
const BAR_MS = 60_000;
const DAY_MS = 86_400_000;
const BETA_DAYS = 7;
const SIGNAL_MINUTES = 60;
const HOLD_MINUTES = 60;
const DECISION_MINUTES = 15;
const MIN_DISPERSION_PCT = 0.8;
const FUNDING_PER_HOUR_PCT = 0.00125;
const MAX_DRAWDOWN_PCT = 5;
const POSITION_NOTIONAL_USD = 100;
type Family = 'reversion' | 'momentum';
const familyInput = process.env.XS_RESIDUAL_FAMILY ?? 'reversion';
if (familyInput !== 'reversion' && familyInput !== 'momentum') {
  throw new Error(`XS_RESIDUAL_FAMILY must be reversion or momentum, got ${familyInput}`);
}
const FAMILY: Family = familyInput;
const RESULT_PATH = resolve(FAMILY === 'reversion'
  ? 'data/lighter-xs-residual-results.json'
  : 'data/lighter-xs-momentum-results.json');
const COST_PATH = resolve('data/lighter-execution-costs-native-portfolio-100-20260731.json');

type Asset = typeof ASSETS[number];
type Series = { t: number[]; o: number[]; c: number[] };
type Regime = 'bull' | 'bear';
type VolRegime = 'high' | 'low';
type Trade = {
  entryAt: number;
  exitAt: number;
  long: Asset;
  short: Asset;
  longWeight: number;
  shortWeight: number;
  dispersionPct: number;
  grossPct: number;
  costPct: number;
  fundingPct: number;
  netPct: number;
  stressPct: number;
  regime: Regime;
  volatility: VolRegime;
};

type Stats = {
  n: number;
  netPct: number;
  stressPct: number;
  profitFactor: number;
  stressProfitFactor: number;
  meanL95Pct: number;
  maxDrawdownPct: number;
  winRatePct: number;
};

type Profile = {
  timeframeMinutes: 1 | 5;
  betaBars: number;
  signalBars: number;
  holdBars: number;
  decisionBars: number;
};

type CostFile = {
  notionalUsd?: number;
  summaries?: Record<string, { p95Pct?: number | null }>;
};

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function lowerBound(candles: Candle[], timestamp: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (candles[mid]!.t < timestamp) low = mid + 1;
    else high = mid;
  }
  return low;
}

function candleMeta(asset: Asset): { first: number; last: number } {
  const path = resolve(`data/lighter-klines/${asset}-1m.json`);
  if (!existsSync(path)) throw new Error(`Missing native Lighter candles: ${path}`);
  const candles = JSON.parse(readFileSync(path, 'utf8')) as Candle[];
  if (!candles.length) throw new Error(`Empty native Lighter candles: ${path}`);
  return { first: candles[0]!.t, last: candles.at(-1)!.t };
}

function loadStrictSeries(asset: Asset, from: number, through: number): Series {
  const path = resolve(`data/lighter-klines/${asset}-1m.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Candle[];
  const start = lowerBound(raw, from);
  const deduped: Candle[] = [];
  for (let i = start; i < raw.length && raw[i]!.t <= through; i++) {
    const candle = raw[i]!;
    const prior = deduped.at(-1);
    if (prior?.t === candle.t) {
      if (prior.o !== candle.o || prior.c !== candle.c) {
        throw new Error(`${asset} has conflicting duplicate candle at ${candle.t}`);
      }
      continue;
    }
    deduped.push(candle);
  }
  if (!deduped.length || deduped[0]!.t !== from || deduped.at(-1)!.t !== through) {
    throw new Error(`${asset} does not cover the frozen common window`);
  }
  for (let i = 1; i < deduped.length; i++) {
    if (deduped[i]!.t - deduped[i - 1]!.t !== BAR_MS) {
      throw new Error(`${asset} has a 1m gap at ${deduped[i - 1]!.t}`);
    }
  }
  return {
    t: deduped.map((bar) => bar.t),
    o: deduped.map((bar) => bar.o),
    c: deduped.map((bar) => bar.c),
  };
}

function aggregateStrict(series: Series, minutes: number): Series {
  if (minutes === 1) return series;
  const t: number[] = [];
  const o: number[] = [];
  const c: number[] = [];
  for (let i = 0; i + minutes <= series.t.length; i += minutes) {
    const bucket = Math.floor(series.t[i]! / (minutes * BAR_MS)) * minutes * BAR_MS;
    if (series.t[i] !== bucket) continue;
    let complete = true;
    for (let j = 1; j < minutes; j++) {
      if (series.t[i + j] !== series.t[i]! + j * BAR_MS) complete = false;
    }
    if (!complete) throw new Error(`Unexpected aggregation gap at ${series.t[i]}`);
    t.push(series.t[i]!);
    o.push(series.o[i]!);
    c.push(series.c[i + minutes - 1]!);
  }
  return { t, o, c };
}

function rollingFactorStats(
  factor: number[],
  asset: number[],
  window: number,
): { beta: number[]; correlation: number[] } {
  const beta = Array(factor.length).fill(Number.NaN) as number[];
  const correlation = Array(factor.length).fill(Number.NaN) as number[];
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 1; i < factor.length; i++) {
    const x = Math.log(factor[i]! / factor[i - 1]!);
    const y = Math.log(asset[i]! / asset[i - 1]!);
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    if (i > window) {
      const oldX = Math.log(factor[i - window]! / factor[i - window - 1]!);
      const oldY = Math.log(asset[i - window]! / asset[i - window - 1]!);
      sx -= oldX;
      sy -= oldY;
      sxx -= oldX * oldX;
      syy -= oldY * oldY;
      sxy -= oldX * oldY;
    }
    if (i < window) continue;
    const covariance = sxy - sx * sy / window;
    const varianceX = sxx - sx * sx / window;
    const varianceY = syy - sy * sy / window;
    if (!(varianceX > 0) || !(varianceY > 0)) continue;
    beta[i] = covariance / varianceX;
    correlation[i] = covariance / Math.sqrt(varianceX * varianceY);
  }
  return { beta, correlation };
}

function rollingVariance(values: number[], window: number): number[] {
  const output = Array(values.length).fill(Number.NaN) as number[];
  let sum = 0;
  let sumSq = 0;
  for (let i = 1; i < values.length; i++) {
    const value = Math.log(values[i]! / values[i - 1]!);
    sum += value;
    sumSq += value * value;
    if (i > window) {
      const old = Math.log(values[i - window]! / values[i - window - 1]!);
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= window) output[i] = Math.max(0, sumSq / window - (sum / window) ** 2);
  }
  return output;
}

function measuredCosts(): Map<Asset, number> {
  const parsed = JSON.parse(readFileSync(COST_PATH, 'utf8')) as CostFile;
  if (parsed.notionalUsd !== POSITION_NOTIONAL_USD) {
    throw new Error(`Execution-cost notional must be $${POSITION_NOTIONAL_USD}`);
  }
  const output = new Map<Asset, number>();
  for (const asset of ASSETS) {
    const value = parsed.summaries?.[asset]?.p95Pct;
    if (value == null || !Number.isFinite(value) || value < 0) {
      throw new Error(`Missing measured $${POSITION_NOTIONAL_USD} p95 cost for ${asset}`);
    }
    output.set(asset, value);
  }
  return output;
}

function simulate(
  profile: Profile,
  data: Map<Asset, Series>,
  costs: Map<Asset, number>,
): Trade[] {
  const factor = data.get(FACTOR)!;
  const stats = new Map<Asset, ReturnType<typeof rollingFactorStats>>();
  for (const asset of ASSETS) {
    if (asset !== FACTOR) {
      stats.set(asset, rollingFactorStats(factor.c, data.get(asset)!.c, profile.betaBars));
    }
  }
  const shortVol = rollingVariance(factor.c, profile.signalBars);
  const longVol = rollingVariance(factor.c, 24 * 60 / profile.timeframeMinutes);
  const trades: Trade[] = [];
  let nextAvailable = profile.betaBars;
  for (
    let signalIndex = profile.betaBars;
    signalIndex + 1 + profile.holdBars < factor.t.length;
    signalIndex += profile.decisionBars
  ) {
    if (signalIndex < nextAvailable) continue;
    const factorMove = Math.log(
      factor.c[signalIndex]! / factor.c[signalIndex - profile.signalBars]!,
    );
    const ranked = ASSETS.flatMap((asset) => {
      if (asset === FACTOR) return [];
      const beta = stats.get(asset)!.beta[signalIndex]!;
      const correlation = stats.get(asset)!.correlation[signalIndex]!;
      if (!(beta >= 0.2 && beta <= 2.5 && correlation >= 0.4)) return [];
      const prices = data.get(asset)!;
      const move = Math.log(prices.c[signalIndex]! / prices.c[signalIndex - profile.signalBars]!);
      return [{ asset, beta, residualPct: (move - beta * factorMove) * 100 }];
    }).sort((a, b) => a.residualPct - b.residualPct);
    const laggard = ranked[0];
    const leader = ranked.at(-1);
    if (!laggard || !leader || laggard.asset === leader.asset) continue;
    const dispersionPct = leader.residualPct - laggard.residualPct;
    if (dispersionPct < MIN_DISPERSION_PCT) continue;
    const longCandidate = FAMILY === 'reversion' ? laggard : leader;
    const shortCandidate = FAMILY === 'reversion' ? leader : laggard;
    const hedge = longCandidate.beta / shortCandidate.beta;
    const longWeight = 1 / (1 + hedge);
    const shortWeight = hedge / (1 + hedge);
    const entryIndex = signalIndex + 1;
    const exitIndex = entryIndex + profile.holdBars;
    const longSeries = data.get(longCandidate.asset)!;
    const shortSeries = data.get(shortCandidate.asset)!;
    const longReturn = longSeries.o[exitIndex]! / longSeries.o[entryIndex]! - 1;
    const shortReturn = shortSeries.o[exitIndex]! / shortSeries.o[entryIndex]! - 1;
    const grossPct = (longWeight * longReturn - shortWeight * shortReturn) * 100;
    const costPct = longWeight * costs.get(longCandidate.asset)!
      + shortWeight * costs.get(shortCandidate.asset)!;
    const fundingPct = FUNDING_PER_HOUR_PCT * HOLD_MINUTES / 60;
    const regime: Regime = factor.c[signalIndex]! >= factor.c[signalIndex - 24 * 60 / profile.timeframeMinutes]!
      ? 'bull'
      : 'bear';
    const volatility: VolRegime = shortVol[signalIndex]! >= longVol[signalIndex]!
      ? 'high'
      : 'low';
    trades.push({
      entryAt: factor.t[entryIndex]!,
      exitAt: factor.t[exitIndex]!,
      long: longCandidate.asset,
      short: shortCandidate.asset,
      longWeight,
      shortWeight,
      dispersionPct,
      grossPct,
      costPct,
      fundingPct,
      netPct: grossPct - costPct - fundingPct,
      stressPct: grossPct - costPct * 1.5 - fundingPct,
      regime,
      volatility,
    });
    nextAvailable = exitIndex;
  }
  return trades;
}

function statistics(trades: Trade[]): Stats {
  let equity = 0;
  let peak = 0;
  let maxDrawdownPct = 0;
  let gains = 0;
  let losses = 0;
  let stressGains = 0;
  let stressLosses = 0;
  for (const trade of trades) {
    equity += trade.netPct;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, equity - peak);
    if (trade.netPct >= 0) gains += trade.netPct;
    else losses -= trade.netPct;
    if (trade.stressPct >= 0) stressGains += trade.stressPct;
    else stressLosses -= trade.stressPct;
  }
  const netPct = trades.reduce((sum, trade) => sum + trade.netPct, 0);
  const stressPct = trades.reduce((sum, trade) => sum + trade.stressPct, 0);
  const mean = trades.length ? netPct / trades.length : 0;
  const variance = trades.length > 1
    ? trades.reduce((sum, trade) => sum + (trade.netPct - mean) ** 2, 0) / (trades.length - 1)
    : 0;
  return {
    n: trades.length,
    netPct: round(netPct),
    stressPct: round(stressPct),
    profitFactor: round(losses ? gains / losses : gains ? 99 : 0),
    stressProfitFactor: round(stressLosses ? stressGains / stressLosses : stressGains ? 99 : 0),
    meanL95Pct: round(mean - 1.645 * Math.sqrt(variance / Math.max(1, trades.length))),
    maxDrawdownPct: round(maxDrawdownPct),
    winRatePct: round(trades.length ? trades.filter((trade) => trade.netPct > 0).length / trades.length * 100 : 0),
  };
}

function positiveFolds(trades: Trade[]): number {
  if (trades.length < 40) return 0;
  const size = Math.floor(trades.length / 4);
  let positive = 0;
  for (let fold = 0; fold < 4; fold++) {
    const slice = trades.slice(fold * size, fold === 3 ? undefined : (fold + 1) * size);
    if (statistics(slice).netPct > 0) positive++;
  }
  return positive;
}

function profileReport(profile: Profile, trades: Trade[]) {
  const cut = Math.floor(trades.length * 0.7);
  const discovery = trades.slice(0, cut);
  const oos = trades.slice(cut);
  const months = new Map<string, number>();
  for (const trade of trades) {
    const month = new Date(trade.exitAt).toISOString().slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + trade.netPct);
  }
  const byAsset = new Map<Asset, { n: number; contribution: number; long: number; short: number }>();
  for (const asset of ASSETS) byAsset.set(asset, { n: 0, contribution: 0, long: 0, short: 0 });
  for (const trade of trades) {
    const long = byAsset.get(trade.long)!;
    long.n++;
    long.long++;
    long.contribution += trade.netPct / 2;
    const short = byAsset.get(trade.short)!;
    short.n++;
    short.short++;
    short.contribution += trade.netPct / 2;
  }
  const activeAssets = [...byAsset.entries()].filter(([, row]) => row.n >= 10);
  const positiveContribution = activeAssets.reduce(
    (sum, [, row]) => sum + Math.max(0, row.contribution),
    0,
  );
  const full = statistics(trades);
  const discoveryStats = statistics(discovery);
  const oosStats = statistics(oos);
  const bull = statistics(trades.filter((trade) => trade.regime === 'bull'));
  const bear = statistics(trades.filter((trade) => trade.regime === 'bear'));
  const highVol = statistics(trades.filter((trade) => trade.volatility === 'high'));
  const lowVol = statistics(trades.filter((trade) => trade.volatility === 'low'));
  const leaveOneOutMinPct = activeAssets.length
    ? Math.min(...activeAssets.map(([asset]) => statistics(
      trades.filter((trade) => trade.long !== asset && trade.short !== asset),
    ).netPct))
    : Number.NEGATIVE_INFINITY;
  const dominance = positiveContribution > 0
    ? Math.max(...activeAssets.map(([, row]) => Math.max(0, row.contribution))) / positiveContribution
    : 1;
  const positiveMonths = [...months.values()].filter((value) => value > 0).length;
  const pass = full.n >= 120
    && full.netPct > 0
    && full.profitFactor >= 1.2
    && full.stressPct > 0
    && full.stressProfitFactor >= 1.1
    && full.meanL95Pct > 0
    && full.maxDrawdownPct >= -MAX_DRAWDOWN_PCT
    && positiveFolds(trades) >= 3
    && discoveryStats.netPct > 0
    && discoveryStats.profitFactor >= 1.1
    && oosStats.n >= 30
    && oosStats.netPct > 0
    && oosStats.profitFactor >= 1.1
    && bull.n >= 20 && bull.netPct > 0 && bull.profitFactor >= 1.1
    && bear.n >= 20 && bear.netPct > 0 && bear.profitFactor >= 1.1
    && highVol.n >= 20 && highVol.netPct > 0 && highVol.profitFactor >= 1.1
    && lowVol.n >= 20 && lowVol.netPct > 0 && lowVol.profitFactor >= 1.1
    && activeAssets.length >= 6
    && activeAssets.filter(([, row]) => row.long > 0 && row.short > 0).length >= 4
    && dominance <= 0.6
    && leaveOneOutMinPct > 0
    && positiveMonths >= Math.max(1, months.size - 2);
  return {
    profile,
    full,
    discovery: discoveryStats,
    oos: oosStats,
    foldsPositive: positiveFolds(trades),
    regimes: { bull, bear, highVol, lowVol },
    breadth: {
      activeAssets: activeAssets.length,
      bothSidesAssets: activeAssets.filter(([, row]) => row.long > 0 && row.short > 0).length,
      dominance: round(dominance),
      leaveOneOutMinPct: round(leaveOneOutMinPct),
      byAsset: Object.fromEntries(activeAssets.map(([asset, row]) => [asset, {
        ...row,
        contribution: round(row.contribution),
      }])),
    },
    months: { positive: positiveMonths, total: months.size },
    pass,
  };
}

function main(): void {
  const metas = ASSETS.map((asset) => candleMeta(asset));
  const commonFrom = Math.max(...metas.map((meta) => meta.first));
  const commonThrough = Math.min(...metas.map((meta) => meta.last));
  const alignedFrom = Math.ceil(commonFrom / (5 * BAR_MS)) * 5 * BAR_MS;
  const alignedThrough = Math.floor(commonThrough / (5 * BAR_MS)) * 5 * BAR_MS - BAR_MS;
  if ((alignedThrough - alignedFrom) / DAY_MS < 171) {
    throw new Error('Strict common native window is shorter than 171 days');
  }
  const oneMinute = new Map<Asset, Series>();
  for (const asset of ASSETS) {
    const series = loadStrictSeries(asset, alignedFrom, alignedThrough);
    if (oneMinute.size && series.t.length !== oneMinute.values().next().value!.t.length) {
      throw new Error(`${asset} does not align to the common 1m row count`);
    }
    oneMinute.set(asset, series);
  }
  const costs = measuredCosts();
  const profiles: Profile[] = ([1, 5] as const).map((timeframeMinutes) => ({
    timeframeMinutes,
    betaBars: BETA_DAYS * 24 * 60 / timeframeMinutes,
    signalBars: SIGNAL_MINUTES / timeframeMinutes,
    holdBars: HOLD_MINUTES / timeframeMinutes,
    decisionBars: DECISION_MINUTES / timeframeMinutes,
  }));
  const results = profiles.map((profile) => {
    const data = profile.timeframeMinutes === 1
      ? oneMinute
      : new Map([...oneMinute.entries()].map(([asset, series]) => [asset, aggregateStrict(series, 5)]));
    const trades = simulate(profile, data, costs);
    return profileReport(profile, trades);
  });
  const report = {
    version: FAMILY === 'reversion'
      ? 'lighter-xs-residual-v1'
      : 'lighter-xs-momentum-v1',
    generatedAt: new Date().toISOString(),
    preregistered: true,
    canTrade: false,
    hypothesis: {
      factor: FACTOR,
      assets: ASSETS,
      betaDays: BETA_DAYS,
      signalMinutes: SIGNAL_MINUTES,
      holdMinutes: HOLD_MINUTES,
      decisionMinutes: DECISION_MINUTES,
      minDispersionPct: MIN_DISPERSION_PCT,
      family: FAMILY,
      direction: FAMILY === 'reversion'
        ? 'long residual laggard / short residual leader'
        : 'long residual leader / short residual laggard',
      nextBarOpen: true,
      noOverlap: true,
    },
    execution: {
      positionNotionalUsd: POSITION_NOTIONAL_USD,
      costs: 'market-specific immediately executable L2 p95, weighted by pair leg',
      costStressMultiplier: 1.5,
      adverseFundingPerHourPct: FUNDING_PER_HOUR_PCT,
    },
    data: {
      source: 'Lighter native 1m candles; 5m strictly aggregated from five consecutive 1m bars',
      from: new Date(alignedFrom).toISOString(),
      through: new Date(alignedThrough).toISOString(),
      days: round((alignedThrough - alignedFrom + BAR_MS) / DAY_MS, 3),
      gapsFilled: 0,
    },
    gate: {
      minimumTrades: 120,
      profitFactor: 1.2,
      stressProfitFactor: 1.1,
      meanL95Positive: true,
      oosFraction: 0.3,
      maximumDrawdownPct: MAX_DRAWDOWN_PCT,
      bothRegimesAndVolatilityHalves: true,
      breadthAndLeaveOneOut: true,
    },
    results,
    qualifiedTimeframes: results.filter((result) => result.pass).map((result) => result.profile.timeframeMinutes),
  };
  writeFileSync(RESULT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Cross-sectional residual ${FAMILY} · frozen parameters · report ${RESULT_PATH}`);
  console.table(results.map((result) => ({
    tf: `${result.profile.timeframeMinutes}m`,
    n: result.full.n,
    net: result.full.netPct,
    pf: result.full.profitFactor,
    stress: result.full.stressPct,
    stressPf: result.full.stressProfitFactor,
    l95: result.full.meanL95Pct,
    dd: result.full.maxDrawdownPct,
    folds: result.foldsPositive,
    discovery: result.discovery.netPct,
    oos: result.oos.netPct,
    bull: result.regimes.bull.netPct,
    bear: result.regimes.bear.netPct,
    highVol: result.regimes.highVol.netPct,
    lowVol: result.regimes.lowVol.netPct,
    pass: result.pass,
  })));
}

main();
