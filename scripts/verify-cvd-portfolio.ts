/**
 * Portfolio verification for the preselected mature CVD N20 / 30m candidate.
 * Enforces chronological position capacity and rotates same-bar symbol priority
 * so a result cannot depend on alphabetical tie-breaking.
 *
 * Run on the VPS: pnpm tsx scripts/verify-cvd-portfolio.ts
 */
import { getKlines } from '../src/backtest/klines.js';
import { runBacktest } from '../src/backtest/engine.js';
import { loadMicroAligned } from '../src/backtest/micro.js';
import { cvdDivergence } from '../src/backtest/strategies/families-flow.js';

type CandidateTrade = {
  coin: string;
  entryAt: number;
  exitAt: number;
  grossPct: number;
};

type Stats = {
  n: number;
  net: number;
  stressNet: number;
  profitFactor: number;
  winRate: number;
  maxDrawdown: number;
  positiveFolds: number;
};

const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'LTC', 'LINK', 'DOGE', 'AVAX'];
const DAYS = 340;
const TF = '30';
const LOOKBACK = 20;
const COST_PCT = 0.09;
const NOW = Date.now();

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function net(trades: CandidateTrade[], costPct: number): number {
  return rounded(trades.reduce((sum, trade) => sum + trade.grossPct - costPct, 0));
}

function profitFactor(trades: CandidateTrade[], costPct: number): number {
  let gains = 0;
  let losses = 0;
  for (const trade of trades) {
    const pnl = trade.grossPct - costPct;
    if (pnl > 0) gains += pnl;
    else if (pnl < 0) losses += Math.abs(pnl);
  }
  return losses > 0 ? rounded(gains / losses) : gains > 0 ? 99 : 0;
}

function maxDrawdown(trades: CandidateTrade[], costPct: number): number {
  let cumulative = 0;
  let peak = 0;
  let drawdown = 0;
  for (const trade of trades) {
    cumulative += trade.grossPct - costPct;
    peak = Math.max(peak, cumulative);
    drawdown = Math.max(drawdown, peak - cumulative);
  }
  return rounded(drawdown);
}

function positiveFolds(trades: CandidateTrade[], costPct: number): number {
  const foldSize = Math.floor(trades.length / 4);
  if (foldSize < 5) return -1;
  let positive = 0;
  for (let fold = 0; fold < 4; fold++) {
    const end = fold === 3 ? trades.length : (fold + 1) * foldSize;
    if (net(trades.slice(fold * foldSize, end), costPct) > 0) positive++;
  }
  return positive;
}

function stats(trades: CandidateTrade[]): Stats {
  return {
    n: trades.length,
    net: net(trades, COST_PCT),
    stressNet: net(trades, COST_PCT * 2),
    profitFactor: profitFactor(trades, COST_PCT),
    winRate: trades.length ? rounded(trades.filter((trade) => trade.grossPct > COST_PCT).length / trades.length) : 0,
    maxDrawdown: maxDrawdown(trades, COST_PCT),
    positiveFolds: positiveFolds(trades, COST_PCT),
  };
}

function applyCapacity(allTrades: CandidateTrade[], capacity: number, priority: string[]): CandidateTrade[] {
  const rank = new Map(priority.map((coin, index) => [coin, index]));
  const sorted = [...allTrades].sort((a, b) => (a.entryAt - b.entryAt) || ((rank.get(a.coin) ?? 99) - (rank.get(b.coin) ?? 99)));
  const accepted: CandidateTrade[] = [];
  const activeExitTimes: number[] = [];
  for (const trade of sorted) {
    for (let index = activeExitTimes.length - 1; index >= 0; index--) {
      if (activeExitTimes[index]! <= trade.entryAt) activeExitTimes.splice(index, 1);
    }
    if (activeExitTimes.length >= capacity) continue;
    accepted.push(trade);
    activeExitTimes.push(trade.exitAt);
  }
  return accepted;
}

function rotations(values: string[]): string[][] {
  return values.map((_, offset) => [...values.slice(offset), ...values.slice(0, offset)]);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint]! : (sorted[midpoint - 1]! + sorted[midpoint]!) / 2;
}

function summary(label: string, runs: Stats[]): void {
  const field = (pick: (run: Stats) => number): string => {
    const values = runs.map(pick);
    return `${Math.min(...values).toFixed(2)} / ${median(values).toFixed(2)} / ${Math.max(...values).toFixed(2)}`;
  };
  console.log(`${label}: ${runs.length} symbol-priority rotations`);
  console.log(`  N min/med/max          ${field((run) => run.n)}`);
  console.log(`  net@0.09 min/med/max   ${field((run) => run.net)}`);
  console.log(`  net@0.18 min/med/max   ${field((run) => run.stressNet)}`);
  console.log(`  PF min/med/max         ${field((run) => run.profitFactor)}`);
  console.log(`  WR min/med/max         ${field((run) => run.winRate * 100)}%`);
  console.log(`  maxDD min/med/max      ${field((run) => run.maxDrawdown)}`);
  console.log(`  folds min/med/max      ${field((run) => run.positiveFolds)}`);
}

async function main(): Promise<void> {
  console.log(`Verify CVD N${LOOKBACK} ${TF}m portfolio · ${DAYS}d · cost ${COST_PCT}% / stress ${COST_PCT * 2}%\n`);
  const trades: CandidateTrade[] = [];
  for (const coin of COINS) {
    const candles = await getKlines(`${coin}USDT`, TF, NOW - DAYS * 86_400_000, NOW);
    const micro = loadMicroAligned(coin, TF, candles);
    const result = runBacktest(cvdDivergence(`${coin}USDT`, TF, micro, LOOKBACK), candles);
    const coinTrades = result.tradesLog.map((trade) => ({
      coin,
      entryAt: trade.entryAt,
      exitAt: trade.exitAt,
      grossPct: trade.realizedPct,
    }));
    trades.push(...coinTrades);
    process.stderr.write(`  ${coin}: ${coinTrades.length} trades\n`);
  }

  trades.sort((a, b) => a.entryAt - b.entryAt);
  console.log(`\nUnlimited raw pool: ${JSON.stringify(stats(trades))}\n`);
  const priorities = rotations(COINS);
  const capOneRuns = priorities.map((priority) => stats(applyCapacity(trades, 1, priority)));
  const capTwoRuns = priorities.map((priority) => stats(applyCapacity(trades, 2, priority)));
  summary('CAPACITY 1', capOneRuns);
  console.log('');
  summary('CAPACITY 2', capTwoRuns);

  const capOnePass = capOneRuns.every((run) => run.n >= 100 && run.stressNet > 0 && run.profitFactor >= 1.2 && run.positiveFolds >= 3);
  const capTwoPass = capTwoRuns.every((run) => run.n >= 150 && run.stressNet > 0 && run.profitFactor >= 1.2 && run.positiveFolds >= 3);
  console.log(`\nVerdict: capacity1=${capOnePass ? 'PASS' : 'FAIL'} capacity2=${capTwoPass ? 'PASS' : 'FAIL'}.`);
  console.log('A pass is still research-only because this signature was selected on the same historical panel; forward shadow remains mandatory.');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
