/**
 * Frozen portfolio audit for independently selected Native Quant strategies.
 *
 * The input is a detailed JSON report produced by sweep-lighter-native-1m.ts.
 * Selection is explicit and preregistered through SELECTED_STRATEGIES rather
 * than choosing the best rows after the portfolio result is known.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const INPUT_JSON = resolve(process.env.INPUT_JSON ?? 'data/lighter-selected-sweep.json');
const OUTPUT_JSON = resolve(
  process.env.OUTPUT_JSON ?? 'data/lighter-selected-portfolio-audit.json',
);
const POSITION_NOTIONAL_USD = Number(process.env.POSITION_NOTIONAL_USD ?? 100);
const MAX_DRAWDOWN_PCT = Number(process.env.MAX_DRAWDOWN_PCT ?? 10);
const RECENT_WINDOWS_DAYS = [30, 60, 90];
const selections = (process.env.SELECTED_STRATEGIES
  ?? 'zec-rsi14-willr14-ema400=ZEC:CONF-RSI14-WILLR14-30/70+EMA400,data-vwz60-mfi14-ema400=DATA:CONF-VWZ60-2.5+MFI14-35/65+EMA400')
  .split(',')
  .map((entry) => {
    const [strategyId, selector] = entry.split('=');
    const separator = selector?.indexOf(':') ?? -1;
    if (!strategyId || separator <= 0) throw new Error(`Invalid selection: ${entry}`);
    return {
      strategyId,
      symbol: selector!.slice(0, separator),
      rule: selector!.slice(separator + 1),
    };
  });

type Side = 'long' | 'short';
type TrendRegime = 'bull' | 'bear' | 'mixed';
type VolatilityRegime = 'highVol' | 'lowVol';
type TradeDetail = {
  side: Side;
  entryAt: number;
  exitAt: number;
  pct: number;
  fundingPct?: number;
  trendRegime: TrendRegime;
  volatilityRegime: VolatilityRegime;
};
type SweepRow = {
  symbol: string;
  rule: string;
  costPct: number;
  adverseCostPct: number;
  tradeDetails?: TradeDetail[];
};
type SweepReport = {
  generatedAt: string;
  input?: { qualificationInputsMeasured?: boolean };
  rows: SweepRow[];
};
type PortfolioTrade = TradeDetail & {
  strategyId: string;
  symbol: string;
  costPct: number;
  adverseCostPct: number;
};

const report = JSON.parse(readFileSync(INPUT_JSON, 'utf8')) as SweepReport;
if (!report.input?.qualificationInputsMeasured) {
  throw new Error('Sweep used fallback cost or funding inputs; portfolio cannot qualify');
}

const sourceRows = selections.map((selection) => {
  const row = report.rows.find((candidate) =>
    candidate.symbol === selection.symbol && candidate.rule === selection.rule);
  if (!row?.tradeDetails?.length) {
    throw new Error(`${selection.strategyId}: detailed sweep row is missing`);
  }
  return { ...selection, row };
});
const allTrades = sourceRows.flatMap(({ strategyId, symbol, row }) =>
  row.tradeDetails!.map((trade) => ({
    ...trade,
    strategyId,
    symbol,
    costPct: row.costPct,
    adverseCostPct: row.adverseCostPct,
  })));

function net(trade: PortfolioTrade, adverse = false): number {
  return trade.pct - (adverse ? trade.adverseCostPct : trade.costPct)
    + (trade.fundingPct ?? 0);
}

function cap(
  source: PortfolioTrade[],
  maxOpen: number,
  priority: readonly string[],
): { trades: PortfolioTrade[]; dropped: number; maxConcurrent: number } {
  const rank = new Map(priority.map((strategyId, index) => [strategyId, index]));
  const ordered = [...source].sort((a, b) =>
    a.entryAt - b.entryAt
    || (rank.get(a.strategyId) ?? 999) - (rank.get(b.strategyId) ?? 999)
    || a.symbol.localeCompare(b.symbol));
  const accepted: PortfolioTrade[] = [];
  let open: number[] = [];
  let dropped = 0;
  let maxConcurrent = 0;
  for (const trade of ordered) {
    open = open.filter((exitAt) => exitAt > trade.entryAt);
    if (open.length >= maxOpen) {
      dropped += 1;
      continue;
    }
    accepted.push(trade);
    open.push(trade.exitAt);
    maxConcurrent = Math.max(maxConcurrent, open.length);
  }
  return { trades: accepted, dropped, maxConcurrent };
}

function summarize(source: PortfolioTrade[], capacity: number) {
  const ordered = [...source].sort((a, b) => a.exitAt - b.exitAt);
  const values = ordered.map((trade) => net(trade));
  const adverseValues = ordered.map((trade) => net(trade, true));
  const sum = values.reduce((total, value) => total + value, 0);
  const adverseSum = adverseValues.reduce((total, value) => total + value, 0);
  const gains = values.filter((value) => value >= 0).reduce((a, b) => a + b, 0);
  const losses = -values.filter((value) => value < 0).reduce((a, b) => a + b, 0);
  const adverseGains = adverseValues.filter((value) => value >= 0).reduce((a, b) => a + b, 0);
  const adverseLosses = -adverseValues.filter((value) => value < 0).reduce((a, b) => a + b, 0);
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, equity - peak);
  }
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  const variance = values.length > 1
    ? values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  const cut = Math.floor(values.length * 0.7);
  const foldSize = Math.floor(values.length / 4);
  const foldNets = Array.from({ length: 4 }, (_, index) =>
    values.slice(index * foldSize, index === 3 ? undefined : (index + 1) * foldSize)
      .reduce((a, b) => a + b, 0));
  const latest = Math.max(0, ...ordered.map((trade) => trade.exitAt));
  const recent = RECENT_WINDOWS_DAYS.map((days) => {
    const trades = ordered.filter((trade) => trade.entryAt >= latest - days * 86_400_000);
    const pnl = trades.map((trade) => net(trade));
    const recentGains = pnl.filter((value) => value >= 0).reduce((a, b) => a + b, 0);
    const recentLosses = -pnl.filter((value) => value < 0).reduce((a, b) => a + b, 0);
    return {
      days,
      trades: trades.length,
      netPctUnits: pnl.reduce((a, b) => a + b, 0),
      profitFactor: recentLosses ? recentGains / recentLosses : recentGains > 0 ? 99 : 0,
      longPctUnits: trades.filter((trade) => trade.side === 'long').reduce((a, b) => a + net(b), 0),
      shortPctUnits: trades.filter((trade) => trade.side === 'short').reduce((a, b) => a + net(b), 0),
    };
  });
  return {
    trades: ordered.length,
    netPctUnits: sum,
    netUsd: sum * POSITION_NOTIONAL_USD / 100,
    profitFactor: losses ? gains / losses : gains > 0 ? 99 : 0,
    adverseNetPctUnits: adverseSum,
    adverseProfitFactor: adverseLosses ? adverseGains / adverseLosses : adverseGains > 0 ? 99 : 0,
    winRatePct: values.filter((value) => value > 0).length / Math.max(1, values.length) * 100,
    maxDrawdownPctUnits: drawdown,
    maxDrawdownUsd: drawdown * POSITION_NOTIONAL_USD / 100,
    maxDrawdownCapitalPct: drawdown / Math.max(1, capacity),
    meanL95Pct: mean - 1.645 * Math.sqrt(variance / Math.max(1, values.length)),
    positiveFolds: foldNets.filter((value) => value > 0).length,
    foldNets,
    inSamplePctUnits: values.slice(0, cut).reduce((a, b) => a + b, 0),
    outOfSamplePctUnits: values.slice(cut).reduce((a, b) => a + b, 0),
    longPctUnits: ordered.filter((trade) => trade.side === 'long').reduce((a, b) => a + net(b), 0),
    shortPctUnits: ordered.filter((trade) => trade.side === 'short').reduce((a, b) => a + net(b), 0),
    recent,
  };
}

const priority = selections.map((selection) => selection.strategyId);
const capTwo = cap(allTrades, 2, priority);
const capOne = cap(allTrades, 1, priority);
const capOneReverse = cap(allTrades, 1, [...priority].reverse());
const combined = summarize(capTwo.trades, 2);
const contributions = sourceRows.map(({ strategyId, symbol }) => ({
  strategyId,
  symbol,
  ...summarize(capTwo.trades.filter((trade) => trade.strategyId === strategyId), 1),
}));
const contributionSum = contributions.reduce((total, value) => total + Math.max(0, value.netPctUnits), 0);
const dominance = Math.max(...contributions.map((value) => Math.max(0, value.netPctUnits)))
  / Math.max(Number.EPSILON, contributionSum);
const regime = (key: 'trendRegime' | 'volatilityRegime', value: string) =>
  summarize(capTwo.trades.filter((trade) => trade[key] === value), 2);
const passed = combined.trades >= 120
  && combined.netPctUnits > 0
  && combined.profitFactor >= 1.2
  && combined.adverseNetPctUnits > 0
  && combined.adverseProfitFactor >= 1.1
  && combined.meanL95Pct > 0
  && combined.positiveFolds >= 3
  && combined.inSamplePctUnits > 0
  && combined.outOfSamplePctUnits > 0
  && combined.longPctUnits > 0
  && combined.shortPctUnits > 0
  && combined.maxDrawdownCapitalPct >= -MAX_DRAWDOWN_PCT
  && contributions.every((value) => value.netPctUnits > 0)
  && dominance <= 0.7
  && combined.recent.every((value) =>
    value.trades >= 20
    && value.netPctUnits > 0
    && value.profitFactor >= 1.1
    && value.longPctUnits > 0
    && value.shortPctUnits > 0);

const output = {
  version: 'lighter-selected-portfolio-audit-v1',
  generatedAt: new Date().toISOString(),
  source: { file: INPUT_JSON, generatedAt: report.generatedAt },
  frozenSelection: selections,
  assumptions: {
    positionNotionalUsd: POSITION_NOTIONAL_USD,
    capacity: 2,
    commissionPct: 0,
    executionCost: 'market-specific executable $100 full-round-trip p95',
    funding: 'exact hourly settlements in (entry, exit]',
    maxDrawdownCapitalPct: MAX_DRAWDOWN_PCT,
    realPromotion: 'not authorized; prospective Shadow gate remains independent',
  },
  passedHistoricalPortfolioGate: passed,
  capacityTwo: {
    accepted: capTwo.trades.length,
    dropped: capTwo.dropped,
    maxConcurrent: capTwo.maxConcurrent,
    ...combined,
  },
  capacityOneSensitivity: {
    frozenPriority: {
      priority,
      accepted: capOne.trades.length,
      dropped: capOne.dropped,
      ...summarize(capOne.trades, 1),
    },
    reversePriority: {
      priority: [...priority].reverse(),
      accepted: capOneReverse.trades.length,
      dropped: capOneReverse.dropped,
      ...summarize(capOneReverse.trades, 1),
    },
  },
  contributionDominance: dominance,
  contributions,
  regimes: {
    bull: regime('trendRegime', 'bull'),
    bear: regime('trendRegime', 'bear'),
    mixed: regime('trendRegime', 'mixed'),
    highVol: regime('volatilityRegime', 'highVol'),
    lowVol: regime('volatilityRegime', 'lowVol'),
  },
};

mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
const temporary = `${OUTPUT_JSON}.tmp`;
writeFileSync(temporary, `${JSON.stringify(output, null, 2)}\n`);
renameSync(temporary, OUTPUT_JSON);
console.warn(JSON.stringify({
  output: OUTPUT_JSON,
  passed,
  trades: combined.trades,
  netUsd: combined.netUsd,
  profitFactor: combined.profitFactor,
  maxDrawdownUsd: combined.maxDrawdownUsd,
  maxDrawdownCapitalPct: combined.maxDrawdownCapitalPct,
  droppedAtCapacityTwo: capTwo.dropped,
  droppedAtCapacityOne: capOne.dropped,
}, null, 2));
