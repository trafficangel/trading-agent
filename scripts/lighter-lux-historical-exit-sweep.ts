/**
 * Historical exit-overlay research for the LuxAlgo -> Lighter portfolio.
 *
 * Reads the complete LuxAlgo Trades Log artifacts, replays every trade over
 * 1-minute Bybit candles (liquid path proxy), and compares the native reverse
 * signal exit with hard stops, fixed take-profits, and profit trailing.
 *
 * The script is read-only with respect to trading state. It only reads tracked
 * strategy data and the reproducible kline cache.
 *
 * Run on the VPS, where Bybit public klines are reachable:
 *   EXIT_SWEEP_COST_PCT=0.05 pnpm tsx scripts/lighter-lux-historical-exit-sweep.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Candle } from '../src/backtest/indicators.js';
import { getKlines } from '../src/backtest/klines.js';

type Side = 'long' | 'short';

type SourceTrade = {
  num: number;
  side: Side;
  entryAt: number;
  entryPrice: number;
  exitAt: number;
  exitPrice: number;
};

type HistoricalTrade = SourceTrade & {
  key: string;
  strategyId: string;
  symbol: string;
  stopPct: number;
};

type Variant =
  | { kind: 'native'; name: string }
  | { kind: 'stop'; name: string; stopPct: number }
  | { kind: 'take-profit'; name: string; takeProfitPct: number }
  | { kind: 'trailing'; name: string; armPct: number; trailPct: number };

type Outcome = {
  key: string;
  strategyId: string;
  exitedAt: number;
  pnlPct: number;
  reason: 'native' | 'stop' | 'take-profit' | 'trailing';
};

type Metrics = {
  n: number;
  netPct: number;
  avgPct: number;
  winRatePct: number;
  maxDrawdownPct: number;
  worstPct: number;
  changed: number;
};

type StrategySpec = {
  id: string;
  symbol: string;
  stopPct: number;
  dataId?: string;
};

const MINUTE_MS = 60_000;
const EXECUTION_COST_PCT = Number(process.env.EXIT_SWEEP_COST_PCT ?? '0.05');

const STRATEGIES: readonly StrategySpec[] = [
  { id: 'sol-lg-mf50', symbol: 'SOLUSDT', stopPct: 5 },
  { id: 'eth-cntr-st', symbol: 'ETHUSDT', stopPct: 4 },
  { id: 'btc-choch-cfm-tc', symbol: 'BTCUSDT', stopPct: 3.5 },
  { id: 'ltc-tcs-smart-trail', symbol: 'LTCUSDT', stopPct: 5 },
  { id: 'uni-cfm-smart-weak', symbol: 'UNIUSDT', stopPct: 5 },
  { id: 'dot-cntr-tc-hw', symbol: 'DOTUSDT', stopPct: 5 },
  { id: 'hbar-cfm-smart-weak', symbol: 'HBARUSDT', stopPct: 5 },
  { id: 'aave-cntr-strong', symbol: 'AAVEUSDT', stopPct: 5 },
  { id: 'xrp-choch-mf50', symbol: 'XRPUSDT', stopPct: 5 },
  { id: 'bnb-fvgm-tc-hw', symbol: 'BNBUSDT', stopPct: 5 },
  {
    id: 'bnb-cntr-hw-weak',
    dataId: 'bnb-cntrn-hw-wc',
    symbol: 'BNBUSDT',
    stopPct: 5,
  },
  {
    id: 'doge-fvgm-smart-tc',
    dataId: 'doge-fvgm-st-tc',
    symbol: 'DOGEUSDT',
    stopPct: 5,
  },
  { id: 'ada-cntr-mf-hw', symbol: 'ADAUSDT', stopPct: 5 },
  { id: 'ada-cfm-cntr-hw', symbol: 'ADAUSDT', stopPct: 5 },
  { id: 'pol-fvgm-neo-tsr', symbol: 'POLUSDT', stopPct: 5 },
];

const VARIANTS: readonly Variant[] = [
  { kind: 'native', name: 'native Lux exit' },
  { kind: 'stop', name: 'SL 2%', stopPct: 2 },
  { kind: 'stop', name: 'SL 3%', stopPct: 3 },
  { kind: 'stop', name: 'configured SL', stopPct: 0 },
  { kind: 'take-profit', name: 'TP 1%', takeProfitPct: 1 },
  { kind: 'take-profit', name: 'TP 2%', takeProfitPct: 2 },
  { kind: 'take-profit', name: 'TP 3%', takeProfitPct: 3 },
  { kind: 'take-profit', name: 'TP 4%', takeProfitPct: 4 },
  { kind: 'take-profit', name: 'TP 5%', takeProfitPct: 5 },
  { kind: 'trailing', name: 'trail 1% / 0.5%', armPct: 1, trailPct: 0.5 },
  { kind: 'trailing', name: 'trail 2% / 0.5%', armPct: 2, trailPct: 0.5 },
  { kind: 'trailing', name: 'trail 2% / 1%', armPct: 2, trailPct: 1 },
  { kind: 'trailing', name: 'trail 3% / 0.5%', armPct: 3, trailPct: 0.5 },
  { kind: 'trailing', name: 'trail 3% / 1%', armPct: 3, trailPct: 1 },
  { kind: 'trailing', name: 'trail 3% / 1.5%', armPct: 3, trailPct: 1.5 },
  { kind: 'trailing', name: 'trail 4% / 1%', armPct: 4, trailPct: 1 },
  { kind: 'trailing', name: 'trail 4% / 1.5%', armPct: 4, trailPct: 1.5 },
  { kind: 'trailing', name: 'trail 4% / 2%', armPct: 4, trailPct: 2 },
];

function loadTrades(spec: StrategySpec): HistoricalTrade[] {
  const dataId = spec.dataId ?? spec.id;
  const path = resolve('src', 'strategies', 'data', `${dataId}.json`);
  if (!existsSync(path)) throw new Error(`missing data file: ${path}`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { tradesLog?: SourceTrade[] };
  if (!raw.tradesLog?.length) throw new Error(`empty tradesLog: ${path}`);
  return raw.tradesLog.map((trade) => ({
    ...trade,
    key: `${spec.id}:${trade.num}`,
    strategyId: spec.id,
    symbol: spec.symbol,
    stopPct: spec.stopPct,
  }));
}

function pricePnlPct(side: Side, entry: number, exit: number): number {
  return (side === 'long' ? 1 : -1) * (exit - entry) / entry * 100;
}

function stopPrice(side: Side, entry: number, stopPct: number): number {
  return side === 'long'
    ? entry * (1 - stopPct / 100)
    : entry * (1 + stopPct / 100);
}

function targetPrice(side: Side, entry: number, targetPct: number): number {
  return side === 'long'
    ? entry * (1 + targetPct / 100)
    : entry * (1 - targetPct / 100);
}

function trailPrice(side: Side, best: number, trailPct: number): number {
  return side === 'long'
    ? best * (1 - trailPct / 100)
    : best * (1 + trailPct / 100);
}

function stopTouched(side: Side, candle: Candle, price: number): boolean {
  return side === 'long' ? candle.l <= price : candle.h >= price;
}

function targetTouched(side: Side, candle: Candle, price: number): boolean {
  return side === 'long' ? candle.h >= price : candle.l <= price;
}

function favourableExtreme(side: Side, candle: Candle): number {
  return side === 'long' ? candle.h : candle.l;
}

function isBetter(side: Side, candidate: number, current: number): boolean {
  return side === 'long' ? candidate > current : candidate < current;
}

function outcome(
  trade: HistoricalTrade,
  candles: readonly Candle[],
  variant: Variant,
): Outcome {
  const native = (): Outcome => ({
    key: trade.key,
    strategyId: trade.strategyId,
    exitedAt: trade.exitAt,
    pnlPct: pricePnlPct(trade.side, trade.entryPrice, trade.exitPrice) - EXECUTION_COST_PCT,
    reason: 'native',
  });
  if (variant.kind === 'native') return native();

  const resolvedStop = variant.kind === 'stop' && variant.stopPct > 0
    ? variant.stopPct
    : trade.stopPct;
  const hardStop = stopPrice(trade.side, trade.entryPrice, resolvedStop);
  const fixedTarget = variant.kind === 'take-profit'
    ? targetPrice(trade.side, trade.entryPrice, variant.takeProfitPct)
    : null;
  let best = trade.entryPrice;
  let armed = false;

  for (const candle of candles) {
    // Conservative same-minute ordering. We never let a new intrabar extreme
    // arm or tighten the trail and then assume a later move in the same candle.
    if (stopTouched(trade.side, candle, hardStop)) {
      return {
        key: trade.key,
        strategyId: trade.strategyId,
        exitedAt: candle.t,
        pnlPct: -resolvedStop - EXECUTION_COST_PCT,
        reason: 'stop',
      };
    }
    if (variant.kind === 'trailing' && armed) {
      const trailingStop = trailPrice(trade.side, best, variant.trailPct);
      if (stopTouched(trade.side, candle, trailingStop)) {
        return {
          key: trade.key,
          strategyId: trade.strategyId,
          exitedAt: candle.t,
          pnlPct: pricePnlPct(trade.side, trade.entryPrice, trailingStop)
            - EXECUTION_COST_PCT,
          reason: 'trailing',
        };
      }
    }
    if (fixedTarget != null && targetTouched(trade.side, candle, fixedTarget)) {
      return {
        key: trade.key,
        strategyId: trade.strategyId,
        exitedAt: candle.t,
        pnlPct: variant.kind === 'take-profit'
          ? variant.takeProfitPct - EXECUTION_COST_PCT
          : 0,
        reason: 'take-profit',
      };
    }
    const extreme = favourableExtreme(trade.side, candle);
    if (isBetter(trade.side, extreme, best)) best = extreme;
    if (
      variant.kind === 'trailing'
      && !armed
      && pricePnlPct(trade.side, trade.entryPrice, best) >= variant.armPct
    ) {
      armed = true;
    }
  }
  return native();
}

function metrics(rows: readonly Outcome[]): Metrics {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let wins = 0;
  let worst = Infinity;
  let changed = 0;
  for (const row of rows) {
    equity += row.pnlPct;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (row.pnlPct > 0) wins += 1;
    worst = Math.min(worst, row.pnlPct);
    if (row.reason !== 'native') changed += 1;
  }
  return {
    n: rows.length,
    netPct: equity,
    avgPct: rows.length ? equity / rows.length : 0,
    winRatePct: rows.length ? wins / rows.length * 100 : 0,
    maxDrawdownPct: maxDrawdown,
    worstPct: Number.isFinite(worst) ? worst : 0,
    changed,
  };
}

function fmt(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function sliceThird<T>(rows: readonly T[], third: number): readonly T[] {
  const a = Math.floor(rows.length * third / 3);
  const b = Math.floor(rows.length * (third + 1) / 3);
  return rows.slice(a, b);
}

async function main(): Promise<void> {
  const trades = STRATEGIES.flatMap(loadTrades).sort(
    (a, b) => a.exitAt - b.exitAt || a.key.localeCompare(b.key),
  );
  const bySymbol = new Map<string, HistoricalTrade[]>();
  for (const trade of trades) {
    const rows = bySymbol.get(trade.symbol) ?? [];
    rows.push(trade);
    bySymbol.set(trade.symbol, rows);
  }

  const paths = new Map<string, Candle[]>();
  for (const [symbol, symbolTrades] of bySymbol) {
    const from = Math.min(...symbolTrades.map((trade) => trade.entryAt)) - MINUTE_MS;
    const to = Math.max(...symbolTrades.map((trade) => trade.exitAt)) + MINUTE_MS;
    process.stderr.write(`Fetching ${symbol} 1m path…\n`);
    const candles = await getKlines(symbol, '1', from, to);
    for (const trade of symbolTrades) {
      paths.set(
        trade.key,
        candles.filter((candle) => candle.t >= trade.entryAt && candle.t <= trade.exitAt),
      );
    }
  }

  const usable = trades.filter((trade) => (paths.get(trade.key)?.length ?? 0) > 0);
  const missingByStrategy = STRATEGIES.map((spec) => {
    const total = trades.filter((trade) => trade.strategyId === spec.id).length;
    const present = usable.filter((trade) => trade.strategyId === spec.id).length;
    return { id: spec.id, total, present };
  }).filter((row) => row.total !== row.present);
  const allOutcomes = new Map<string, Outcome[]>();
  for (const variant of VARIANTS) {
    allOutcomes.set(
      variant.name,
      usable.map((trade) => outcome(trade, paths.get(trade.key) ?? [], variant)),
    );
  }
  const native = metrics(allOutcomes.get('native Lux exit') ?? []);
  const ranked = VARIANTS.map((variant) => {
    const rows = allOutcomes.get(variant.name) ?? [];
    return { name: variant.name, ...metrics(rows) };
  }).sort((a, b) => b.netPct - a.netPct);

  console.log(
    `\nHistorical LuxAlgo exit sweep · 1m Bybit path proxy · ` +
    `N=${usable.length}/${trades.length} · strategies=${STRATEGIES.length}`,
  );
  console.log(
    `Execution friction stress: ${EXECUTION_COST_PCT.toFixed(3)}% round-trip; ` +
    `Lighter trading fee 0%. Same-minute ordering is conservative.\n`,
  );
  if (missingByStrategy.length) {
    console.log(
      `Missing candle paths: ${missingByStrategy.map((row) =>
        `${row.id} ${row.present}/${row.total}`).join(' · ')}\n`,
    );
  }
  console.log(
    `${'variant'.padEnd(25)} ${'net'.padStart(10)} ${'Δnative'.padStart(10)} ` +
    `${'avg'.padStart(9)} ${'WR'.padStart(8)} ${'maxDD'.padStart(10)} ` +
    `${'worst'.padStart(9)} ${'changed'.padStart(8)}`,
  );
  console.log('-'.repeat(94));
  for (const row of ranked) {
    console.log(
      `${row.name.padEnd(25)} ${fmt(row.netPct).padStart(10)} ` +
      `${fmt(row.netPct - native.netPct).padStart(10)} ${fmt(row.avgPct).padStart(9)} ` +
      `${(row.winRatePct.toFixed(1) + '%').padStart(8)} ` +
      `${fmt(-row.maxDrawdownPct).padStart(10)} ${fmt(row.worstPct).padStart(9)} ` +
      `${String(row.changed).padStart(8)}`,
    );
  }

  console.log('\nAnti-overfit: delta versus native by chronological portfolio third');
  for (const row of ranked.slice(0, 10)) {
    const variantRows = allOutcomes.get(row.name) ?? [];
    const nativeRows = allOutcomes.get('native Lux exit') ?? [];
    const thirds = [0, 1, 2].map((third) =>
      metrics(sliceThird(variantRows, third)).netPct
      - metrics(sliceThird(nativeRows, third)).netPct,
    );
    console.log(
      `  ${row.name.padEnd(25)} ${thirds.map((value) => fmt(value).padStart(9)).join('  ')}`,
    );
  }

  console.log('\nPer-strategy validation for the five best portfolio variants');
  for (const candidate of ranked.slice(0, 5)) {
    console.log(`\n${candidate.name}:`);
    const candidateRows = allOutcomes.get(candidate.name) ?? [];
    const nativeRows = allOutcomes.get('native Lux exit') ?? [];
    for (const spec of STRATEGIES) {
      const selected = candidateRows.filter((row) => row.strategyId === spec.id);
      const baseline = nativeRows.filter((row) => row.strategyId === spec.id);
      const split = Math.floor(selected.length / 2);
      const firstDelta = metrics(selected.slice(0, split)).netPct
        - metrics(baseline.slice(0, split)).netPct;
      const secondDelta = metrics(selected.slice(split)).netPct
        - metrics(baseline.slice(split)).netPct;
      const totalDelta = metrics(selected).netPct - metrics(baseline).netPct;
      console.log(
        `  ${spec.id.padEnd(24)} N=${String(selected.length).padStart(3)} ` +
        `Δ ${fmt(totalDelta).padStart(9)} · halves ` +
        `${fmt(firstDelta).padStart(9)} / ${fmt(secondDelta).padStart(9)} · ` +
        `exits ${metrics(selected).changed}`,
      );
    }
  }

  console.log(
    '\nStrategy-specific candidates passing: total Δ>0, both halves Δ>0, ' +
    'all thirds Δ>0, and at least 5 altered exits',
  );
  for (const spec of STRATEGIES) {
    const nativeRows = (allOutcomes.get('native Lux exit') ?? [])
      .filter((row) => row.strategyId === spec.id);
    const passing = VARIANTS.filter((variant) => variant.kind !== 'native')
      .map((variant) => {
        const rows = (allOutcomes.get(variant.name) ?? [])
          .filter((row) => row.strategyId === spec.id);
        const split = Math.floor(rows.length / 2);
        const totalDelta = metrics(rows).netPct - metrics(nativeRows).netPct;
        const halves = [
          metrics(rows.slice(0, split)).netPct - metrics(nativeRows.slice(0, split)).netPct,
          metrics(rows.slice(split)).netPct - metrics(nativeRows.slice(split)).netPct,
        ];
        const thirds = [0, 1, 2].map((third) =>
          metrics(sliceThird(rows, third)).netPct
          - metrics(sliceThird(nativeRows, third)).netPct,
        );
        return {
          name: variant.name,
          totalDelta,
          halves,
          thirds,
          changed: metrics(rows).changed,
          maxDrawdownDelta: metrics(rows).maxDrawdownPct - metrics(nativeRows).maxDrawdownPct,
        };
      })
      .filter((row) =>
        row.totalDelta > 0
        && row.halves.every((value) => value > 0)
        && row.thirds.every((value) => value > 0)
        && row.changed >= 5,
      )
      .sort((a, b) => b.totalDelta - a.totalDelta);
    if (!passing.length) {
      console.log(`  ${spec.id.padEnd(24)} — none`);
      continue;
    }
    for (const row of passing.slice(0, 3)) {
      console.log(
        `  ${spec.id.padEnd(24)} ${row.name.padEnd(22)} ` +
        `Δ ${fmt(row.totalDelta).padStart(9)} · halves ` +
        `${row.halves.map((value) => fmt(value)).join(' / ')} · thirds ` +
        `${row.thirds.map((value) => fmt(value)).join(' / ')} · ` +
        `DDΔ ${fmt(-row.maxDrawdownDelta)} · exits ${row.changed}`,
      );
    }
  }
}

await main();
