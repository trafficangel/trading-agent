/**
 * Frozen portfolio-level executable-entry audit for the 15-leg Native P2.
 *
 * The input is produced by audit-lighter-native-entry-delay.ts with trade
 * details enabled. Every trade already includes the market-specific $100 p95
 * round-trip execution reserve and exact Lighter funding. This script applies
 * the production ten-position cap and compares next-5m-open fills with the
 * conservative native +1m fill scenario.
 *
 * The positive-execution subset is diagnostic only: it applies one declared
 * rule (delayed net > 0, PF >= 1.10 and >=50% baseline retention) and requires
 * a fresh prospective Shadow sample before it can replace P2.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const INPUT_JSON = resolve(
  process.env.INPUT_JSON ?? 'data/lighter-p2-entry-delay-members-20260802.json',
);
const OUTPUT_JSON = resolve(
  process.env.OUTPUT_JSON ?? 'data/lighter-p2-entry-delay-portfolio-20260802.json',
);
const POSITION_NOTIONAL_USD = 100;
const MAX_OPEN = 10;
const MAX_DRAWDOWN_CAPITAL_PCT = 5;
const MEMBER_IDS = [
  'z60stack25-btc', 'z60stack25-eth', 'z60stack25-sol',
  'z60stack25-bnb', 'z60stack25-ltc', 'z60stack25-hype',
  'z60stack25-zec', 'z60stack25-doge', 'z60stack25-near',
  'z60stack25-jup', 'z60stack25-lit', 'z60stack25-gram',
  'z60stack25-xmr', 'z60stack25-ena', 'z60stack25-tao',
] as const;
const RECENT_WINDOWS_DAYS = [30, 60, 90] as const;

type Side = 'long' | 'short';
type Trade = {
  side: Side;
  entryAt: number;
  exitAt: number;
  netPct: number;
};
type Metrics = {
  trades: number;
  netPctUnits: number;
  profitFactor: number;
  meanL95Pct: number;
  positiveFolds: number;
  inSamplePctUnits: number;
  outOfSamplePctUnits: number;
  longPctUnits: number;
  shortPctUnits: number;
};
type AuditRow = {
  strategyId: string;
  symbol: string;
  passed: boolean;
  baselineNextOpen: Metrics;
  delayedOneMinute: Metrics;
  delayedNetRetention: number | null;
  baselineTradeDetails?: Trade[];
  delayedTradeDetails?: Trade[];
};
type AuditReport = {
  version: string;
  strategies: AuditRow[];
};
type PortfolioTrade = Trade & { strategyId: string; symbol: string };

function finite(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} invalid`);
  return parsed;
}

function cap(source: readonly PortfolioTrade[]) {
  const priority = new Map(MEMBER_IDS.map((id, index) => [id, index]));
  const ordered = [...source].sort((left, right) =>
    left.entryAt - right.entryAt
    || (priority.get(left.strategyId as typeof MEMBER_IDS[number]) ?? 999)
      - (priority.get(right.strategyId as typeof MEMBER_IDS[number]) ?? 999));
  const accepted: PortfolioTrade[] = [];
  let open: number[] = [];
  let dropped = 0;
  let maxConcurrent = 0;
  for (const trade of ordered) {
    open = open.filter((exitAt) => exitAt > trade.entryAt);
    if (open.length >= MAX_OPEN) {
      dropped += 1;
      continue;
    }
    accepted.push(trade);
    open.push(trade.exitAt);
    maxConcurrent = Math.max(maxConcurrent, open.length);
  }
  return { accepted, dropped, maxConcurrent };
}

function profitFactor(values: readonly number[]): number {
  const gains = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = -values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  return losses ? gains / losses : gains > 0 ? 99 : 0;
}

function summarize(source: readonly PortfolioTrade[]) {
  const capped = cap(source);
  const trades = [...capped.accepted].sort((left, right) =>
    left.exitAt - right.exitAt || left.entryAt - right.entryAt);
  const values = trades.map((trade) => trade.netPct);
  const net = values.reduce((sum, value) => sum + value, 0);
  const mean = net / Math.max(1, values.length);
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, equity - peak);
  }
  const foldSize = Math.floor(values.length / 4);
  const foldNets = Array.from({ length: 4 }, (_, index) =>
    values.slice(index * foldSize, index === 3 ? undefined : (index + 1) * foldSize)
      .reduce((sum, value) => sum + value, 0));
  const cut = Math.floor(values.length * 0.7);
  const latest = Math.max(0, ...trades.map((trade) => trade.exitAt));
  const recent = RECENT_WINDOWS_DAYS.map((days) => {
    const selected = trades.filter((trade) =>
      trade.entryAt >= latest - days * 86_400_000);
    const pnl = selected.map((trade) => trade.netPct);
    return {
      days,
      trades: selected.length,
      netPctUnits: pnl.reduce((sum, value) => sum + value, 0),
      profitFactor: profitFactor(pnl),
      longPctUnits: selected.filter((trade) => trade.side === 'long')
        .reduce((sum, trade) => sum + trade.netPct, 0),
      shortPctUnits: selected.filter((trade) => trade.side === 'short')
        .reduce((sum, trade) => sum + trade.netPct, 0),
    };
  });
  const byMember = MEMBER_IDS.map((strategyId) => {
    const selected = trades.filter((trade) => trade.strategyId === strategyId);
    const pnl = selected.map((trade) => trade.netPct);
    return {
      strategyId,
      symbol: selected[0]?.symbol ?? strategyId.split('-').at(-1)!.toUpperCase(),
      trades: selected.length,
      netPctUnits: pnl.reduce((sum, value) => sum + value, 0),
      profitFactor: profitFactor(pnl),
    };
  }).filter((row) => row.trades > 0);
  const active = byMember.filter((row) => row.trades >= 10);
  const positiveTotal = active.reduce(
    (sum, row) => sum + Math.max(0, row.netPctUnits), 0,
  );
  const monthly = new Map<string, number>();
  for (const trade of trades) {
    const date = new Date(trade.exitAt);
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    monthly.set(key, (monthly.get(key) ?? 0) + trade.netPct);
  }
  const maxConcurrent = Math.max(1, capped.maxConcurrent);
  const result = {
    trades: trades.length,
    dropped: capped.dropped,
    maxConcurrent: capped.maxConcurrent,
    netPctUnits: net,
    netUsd: net * POSITION_NOTIONAL_USD / 100,
    profitFactor: profitFactor(values),
    winRatePct: values.filter((value) => value > 0).length / Math.max(1, values.length) * 100,
    maxDrawdownPctUnits: drawdown,
    maxDrawdownUsd: drawdown * POSITION_NOTIONAL_USD / 100,
    maxDrawdownCapitalPct: drawdown / maxConcurrent,
    meanL95Pct: mean - 1.645 * Math.sqrt(variance / Math.max(1, values.length)),
    positiveFolds: foldNets.filter((value) => value > 0).length,
    foldNets,
    inSamplePctUnits: values.slice(0, cut).reduce((sum, value) => sum + value, 0),
    outOfSamplePctUnits: values.slice(cut).reduce((sum, value) => sum + value, 0),
    longPctUnits: trades.filter((trade) => trade.side === 'long')
      .reduce((sum, trade) => sum + trade.netPct, 0),
    shortPctUnits: trades.filter((trade) => trade.side === 'short')
      .reduce((sum, trade) => sum + trade.netPct, 0),
    recent,
    activeSymbols: active.length,
    positiveSymbols: active.filter((row) => row.netPctUnits > 0).length,
    dominance: positiveTotal > 0
      ? Math.max(0, ...active.map((row) => row.netPctUnits)) / positiveTotal : 1,
    leaveOneOutMinNet: active.length
      ? Math.min(...active.map((row) => net - row.netPctUnits)) : Number.NEGATIVE_INFINITY,
    positiveMonths: [...monthly.values()].filter((value) => value > 0).length,
    totalMonths: monthly.size,
    members: byMember,
  };
  const passed = result.trades >= 120
    && result.netPctUnits > 0
    && result.profitFactor >= 1.2
    && result.meanL95Pct > 0
    && result.positiveFolds >= 3
    && result.inSamplePctUnits > 0
    && result.outOfSamplePctUnits > 0
    && result.longPctUnits > 0
    && result.shortPctUnits > 0
    && result.maxDrawdownCapitalPct >= -MAX_DRAWDOWN_CAPITAL_PCT
    && result.activeSymbols >= 4
    && result.positiveSymbols >= Math.max(3, Math.ceil(result.activeSymbols / 2))
    && result.dominance <= 0.6
    && result.leaveOneOutMinNet > 0
    && result.positiveMonths >= Math.max(1, result.totalMonths - 2)
    && result.dropped / Math.max(1, result.trades + result.dropped) <= 0.1
    && result.recent.every((window) =>
      window.trades >= 20
      && window.netPctUnits > 0
      && window.profitFactor >= 1.1
      && window.longPctUnits > 0
      && window.shortPctUnits > 0);
  return { passed, ...result };
}

const raw = readFileSync(INPUT_JSON);
const sourceSha256 = createHash('sha256').update(raw).digest('hex');
const report = JSON.parse(raw.toString('utf8')) as AuditReport;
if (report.version !== 'lighter-native-entry-delay-audit-v1') {
  throw new Error('P2 member audit version mismatch');
}
const rows = new Map(report.strategies.map((row) => [row.strategyId, row]));
if (rows.size !== MEMBER_IDS.length || MEMBER_IDS.some((id) => !rows.has(id))) {
  throw new Error('P2 member audit is incomplete or duplicated');
}
for (const id of MEMBER_IDS) {
  const row = rows.get(id)!;
  if (!Array.isArray(row.baselineTradeDetails) || !Array.isArray(row.delayedTradeDetails)) {
    throw new Error(`${id}: P2 member trade details missing`);
  }
  finite(row.baselineNextOpen.netPctUnits, `${id}.baseline.net`);
  finite(row.delayedOneMinute.netPctUnits, `${id}.delayed.net`);
}

function tradesFor(
  key: 'baselineTradeDetails' | 'delayedTradeDetails',
  memberIds: readonly string[] = MEMBER_IDS,
): PortfolioTrade[] {
  return memberIds.flatMap((strategyId) => {
    const row = rows.get(strategyId)!;
    return row[key]!.map((trade) => ({
      ...trade,
      strategyId,
      symbol: row.symbol,
    }));
  });
}

const positiveExecutionMembers = MEMBER_IDS.filter((strategyId) => {
  const row = rows.get(strategyId)!;
  return row.delayedOneMinute.netPctUnits > 0
    && row.delayedOneMinute.profitFactor >= 1.1
    && row.delayedNetRetention != null
    && row.delayedNetRetention >= 0.5;
});
const excludedMembers = MEMBER_IDS.filter((id) => !positiveExecutionMembers.includes(id));
const allBaseline = summarize(tradesFor('baselineTradeDetails'));
const allDelayed = summarize(tradesFor('delayedTradeDetails'));
const subsetBaseline = summarize(tradesFor('baselineTradeDetails', positiveExecutionMembers));
const subsetDelayed = summarize(tradesFor('delayedTradeDetails', positiveExecutionMembers));
const allRetention = allBaseline.netPctUnits > 0
  ? allDelayed.netPctUnits / allBaseline.netPctUnits : Number.NEGATIVE_INFINITY;
const subsetRetention = subsetBaseline.netPctUnits > 0
  ? subsetDelayed.netPctUnits / subsetBaseline.netPctUnits : Number.NEGATIVE_INFINITY;

const output = {
  version: 'lighter-p2-entry-delay-portfolio-audit-v1',
  generatedAt: new Date().toISOString(),
  source: { file: INPUT_JSON, sha256: sourceSha256 },
  assumptions: {
    positionNotionalUsd: POSITION_NOTIONAL_USD,
    maxOpen: MAX_OPEN,
    commissionPct: 0,
    executionCost: 'market-specific executable $100 full-round-trip p95 already in each trade',
    funding: 'exact Lighter hourly settlements already in each trade',
    delayedFill: 'native 1m open one minute after the next 5m open',
    historicalRegimes: 'validated by frozen P2 historical evidence; latency changes fills, not signals',
  },
  allMembers: {
    memberIds: MEMBER_IDS,
    baseline: allBaseline,
    delayed: allDelayed,
    delayedNetRetention: allRetention,
    passed: allDelayed.passed && allRetention >= 0.5,
  },
  positiveExecutionSubset: {
    status: 'diagnostic_only_requires_fresh_prospective_shadow',
    selectionRule: 'delayed net > 0, delayed PF >= 1.10 and >=50% baseline net retention',
    memberIds: positiveExecutionMembers,
    excludedMemberIds: excludedMembers,
    baseline: subsetBaseline,
    delayed: subsetDelayed,
    delayedNetRetention: subsetRetention,
    passedHistoricalLatencyGate: subsetDelayed.passed && subsetRetention >= 0.5,
  },
  memberAudits: MEMBER_IDS.map((strategyId) => {
    const row = rows.get(strategyId)!;
    return {
      strategyId,
      symbol: row.symbol,
      individualStrictGatePassed: row.passed,
      baselineNetPctUnits: row.baselineNextOpen.netPctUnits,
      delayedNetPctUnits: row.delayedOneMinute.netPctUnits,
      delayedProfitFactor: row.delayedOneMinute.profitFactor,
      delayedMeanL95Pct: row.delayedOneMinute.meanL95Pct,
      delayedLongPctUnits: row.delayedOneMinute.longPctUnits,
      delayedShortPctUnits: row.delayedOneMinute.shortPctUnits,
      delayedNetRetention: row.delayedNetRetention,
    };
  }),
  realPromotion: false,
};

mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
const temporary = `${OUTPUT_JSON}.tmp`;
writeFileSync(temporary, `${JSON.stringify(output, null, 2)}\n`);
renameSync(temporary, OUTPUT_JSON);
console.warn(JSON.stringify({
  output: OUTPUT_JSON,
  allMembersPassed: output.allMembers.passed,
  allDelayedNetUsd: output.allMembers.delayed.netUsd,
  allDelayedProfitFactor: output.allMembers.delayed.profitFactor,
  subsetMembers: positiveExecutionMembers.length,
  subsetPassed: output.positiveExecutionSubset.passedHistoricalLatencyGate,
  subsetDelayedNetUsd: output.positiveExecutionSubset.delayed.netUsd,
  excludedMembers,
}, null, 2));
