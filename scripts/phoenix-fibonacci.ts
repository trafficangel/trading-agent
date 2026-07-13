/**
 * Phoenix Fibonacci moonshot backtest.
 *
 * This is intentionally modeled as a high-risk lottery module, not as a
 * durable low-risk strategy. It tests whether impulse -> Fibonacci pullback
 * entries can support a Fibonacci stake progression with +300% margin targets.
 *
 * Run on the VPS where Bybit is reachable:
 *   pnpm tsx scripts/phoenix-fibonacci.ts [days]
 */
import { getKlines, intervalStepMs } from '../src/backtest/klines.js';
import type { Candle } from '../src/backtest/indicators.js';

const DAYS = Number(process.argv[2] ?? 180);
const NOW = Date.now();
const SYMBOLS = [
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'LTCUSDT',
  'ADAUSDT',
  'UNIUSDT',
  'JUPUSDT',
  '1000PEPEUSDT',
  'WIFUSDT',
  'ENAUSDT',
  'NEARUSDT',
  'ARBUSDT',
  'OPUSDT',
  'SUIUSDT',
  'APTUSDT',
  'TIAUSDT',
  'SEIUSDT',
  'ORDIUSDT',
];

const STAKES = [10, 10, 20, 30, 50, 80];
const MAX_CYCLE_LOSS = STAKES.reduce((sum, stake) => sum + stake, 0);
const TAKER_RT_BPS = 11; // Bybit taker in/out rough all-in round-trip.
const SLIP_BPS = 8; // extra adverse fill/exit cushion.

type Profile = {
  name: string;
  interval: '1' | '3';
  leverage: number;
  impulseBps: number;
  volumeMultiple: number;
  pullbackBars: number;
  maxHoldBars: number;
  btcAlignBps: number;
};

type Variant = {
  name: string;
  targetMargin: number;
  entryMode: 'pullback' | 'reclaim' | 'breakout';
  partialStop: boolean;
};

type Trade = {
  symbol: string;
  at: number;
  side: 1 | -1;
  step: number;
  stake: number;
  outcome: 'win' | 'loss' | 'liquidation' | 'timeout';
  pnl: number;
  retOnMargin: number;
};

const PROFILES: Profile[] = [
  { name: '1m-L20', interval: '1', leverage: 20, impulseBps: 90, volumeMultiple: 3, pullbackBars: 8, maxHoldBars: 90, btcAlignBps: 8 },
  { name: '1m-L30', interval: '1', leverage: 30, impulseBps: 90, volumeMultiple: 3, pullbackBars: 8, maxHoldBars: 90, btcAlignBps: 8 },
  { name: '1m-L50', interval: '1', leverage: 50, impulseBps: 90, volumeMultiple: 3, pullbackBars: 8, maxHoldBars: 90, btcAlignBps: 8 },
  { name: '3m-L20', interval: '3', leverage: 20, impulseBps: 130, volumeMultiple: 3, pullbackBars: 6, maxHoldBars: 60, btcAlignBps: 12 },
  { name: '3m-L30', interval: '3', leverage: 30, impulseBps: 130, volumeMultiple: 3, pullbackBars: 6, maxHoldBars: 60, btcAlignBps: 12 },
  { name: '3m-L50', interval: '3', leverage: 50, impulseBps: 130, volumeMultiple: 3, pullbackBars: 6, maxHoldBars: 60, btcAlignBps: 12 },
];

const VARIANTS: Variant[] = [
  { name: 'fib300-fullstop', targetMargin: 3, entryMode: 'pullback', partialStop: false },
  { name: 'fib300-partial', targetMargin: 3, entryMode: 'pullback', partialStop: true },
  { name: 'fib200-partial', targetMargin: 2, entryMode: 'pullback', partialStop: true },
  { name: 'reclaim200', targetMargin: 2, entryMode: 'reclaim', partialStop: true },
  { name: 'reclaim150', targetMargin: 1.5, entryMode: 'reclaim', partialStop: true },
  { name: 'breakout150', targetMargin: 1.5, entryMode: 'breakout', partialStop: true },
];

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function volumeAverage(candles: Candle[], index: number, lookback: number): number {
  if (index < lookback) return 0;
  let sum = 0;
  for (let i = index - lookback; i < index; i++) sum += candles[i]!.v;
  return sum / lookback;
}

function sameBarBtcReturnBps(btcByTime: Map<number, Candle>, bar: Candle): number {
  const btc = btcByTime.get(bar.t);
  return btc ? (btc.c / btc.o - 1) * 10_000 : 0;
}

function feeAndSlipMargin(leverage: number): number {
  return ((TAKER_RT_BPS + SLIP_BPS) / 10_000) * leverage;
}

function simulateSymbol(
  symbol: string,
  candles: Candle[],
  btcByTime: Map<number, Candle>,
  profile: Profile,
  variant: Variant,
): Trade[] {
  const trades: Trade[] = [];
  let step = 0;
  let nextAllowed = 30;
  const targetMove = variant.targetMargin / profile.leverage;
  const liquidationMove = 0.92 / profile.leverage;
  for (let i = 30; i < candles.length - profile.maxHoldBars - profile.pullbackBars - 2; i++) {
    if (i < nextAllowed) continue;
    const bar = candles[i]!;
    const retBps = (bar.c / bar.o - 1) * 10_000;
    if (Math.abs(retBps) < profile.impulseBps) continue;
    const avgVol = volumeAverage(candles, i, 30);
    if (!(avgVol > 0) || bar.v < avgVol * profile.volumeMultiple) continue;
    const side: 1 | -1 = retBps > 0 ? 1 : -1;
    const btcRet = sameBarBtcReturnBps(btcByTime, bar);
    if (side * btcRet < -profile.btcAlignBps) continue;

    const impulseHigh = bar.h;
    const impulseLow = bar.l;
    const span = impulseHigh - impulseLow;
    if (!(span > 0)) continue;
    const entry = side === 1 ? impulseHigh - span * 0.5 : impulseLow + span * 0.5;
    const invalid = side === 1 ? impulseHigh - span * 0.786 : impulseLow + span * 0.786;
    const reclaim = side === 1 ? impulseHigh - span * 0.236 : impulseLow + span * 0.236;
    const breakout = side === 1 ? impulseHigh : impulseLow;

    let entryIndex = -1;
    let entryPrice = entry;
    for (let j = i + 1; j <= i + profile.pullbackBars; j++) {
      const pull = candles[j]!;
      if (pull.l <= entry && pull.h >= entry) {
        entryIndex = j;
        break;
      }
    }
    if (entryIndex < 0) continue;
    if (variant.entryMode !== 'pullback') {
      const pullbackIndex = entryIndex;
      entryIndex = -1;
      for (let j = pullbackIndex; j <= pullbackIndex + profile.pullbackBars; j++) {
        const b = candles[j]!;
        const invalidHit = side === 1 ? b.l <= invalid : b.h >= invalid;
        if (invalidHit) break;
        const trigger = variant.entryMode === 'reclaim' ? reclaim : breakout;
        const triggered = side === 1 ? b.h >= trigger : b.l <= trigger;
        if (triggered) {
          entryIndex = j;
          entryPrice = trigger;
          break;
        }
      }
      if (entryIndex < 0) continue;
    }
    const actualStopMove = Math.min(Math.abs(entryPrice / invalid - 1), liquidationMove);
    const actualStop = side === 1 ? entryPrice * (1 - actualStopMove) : entryPrice * (1 + actualStopMove);
    const actualTarget = side === 1 ? entryPrice * (1 + targetMove) : entryPrice * (1 - targetMove);

    let exitIndex = entryIndex + profile.maxHoldBars;
    let outcome: Trade['outcome'] = 'timeout';
    let exit = candles[exitIndex]!.c;
    for (let j = entryIndex; j <= entryIndex + profile.maxHoldBars; j++) {
      const b = candles[j]!;
      const stopHit = side === 1 ? b.l <= actualStop : b.h >= actualStop;
      const targetHit = side === 1 ? b.h >= actualTarget : b.l <= actualTarget;
      if (stopHit) {
        exitIndex = j;
        exit = actualStop;
        outcome = actualStopMove === liquidationMove ? 'liquidation' : 'loss';
        break;
      }
      if (targetHit) {
        exitIndex = j;
        exit = actualTarget;
        outcome = 'win';
        break;
      }
    }

    const grossMargin = side * (exit / entryPrice - 1) * profile.leverage;
    const retOnMargin = grossMargin - feeAndSlipMargin(profile.leverage);
    const stake = STAKES[step]!;
    const pnl = outcome === 'win'
      ? stake * retOnMargin
      : outcome === 'timeout'
        ? stake * Math.max(-1, retOnMargin)
        : variant.partialStop && outcome !== 'liquidation'
          ? stake * Math.max(-1, retOnMargin)
          : -stake;
    trades.push({ symbol, at: candles[entryIndex]!.t, side, step, stake, outcome, pnl, retOnMargin });
    if (pnl > 0) step = 0;
    else step++;
    if (step >= STAKES.length) step = 0;
    nextAllowed = exitIndex + 1;
  }
  return trades;
}

function summarize(label: string, trades: Trade[]): void {
  const ordered = [...trades].sort((a, b) => a.at - b.at);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let cycleLoss = 0;
  let deadCycles = 0;
  const cyclePnls: number[] = [];
  let currentCycle = 0;
  for (const trade of ordered) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    currentCycle += trade.pnl;
    if (trade.pnl > 0) {
      cyclePnls.push(currentCycle);
      currentCycle = 0;
      cycleLoss = 0;
    } else {
      cycleLoss += trade.stake;
      if (trade.step === STAKES.length - 1 || cycleLoss >= MAX_CYCLE_LOSS) {
        deadCycles++;
        cyclePnls.push(currentCycle);
        currentCycle = 0;
        cycleLoss = 0;
      }
    }
  }
  const wins = ordered.filter((trade) => trade.pnl > 0).length;
  const liquidations = ordered.filter((trade) => trade.outcome === 'liquidation').length;
  const net = ordered.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossWin = ordered.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = -ordered.filter((trade) => trade.pnl <= 0).reduce((sum, trade) => sum + trade.pnl, 0);
  const bySymbol = new Map<string, number>();
  for (const trade of ordered) bySymbol.set(trade.symbol, (bySymbol.get(trade.symbol) ?? 0) + trade.pnl);
  const positiveSymbols = [...bySymbol.values()].filter((value) => value > 0).length;
  console.warn(
    `${label.padEnd(8)} trades=${String(ordered.length).padStart(5)} win=${(wins / Math.max(1, ordered.length) * 100).toFixed(1).padStart(5)}% ` +
    `net=$${net.toFixed(2).padStart(9)} PF=${(grossLoss > 0 ? grossWin / grossLoss : 99).toFixed(2).padStart(5)} ` +
    `DD=$${maxDrawdown.toFixed(2).padStart(8)} liq=${String(liquidations).padStart(4)} deadCycles=${String(deadCycles).padStart(4)} ` +
    `cycleMean=$${mean(cyclePnls).toFixed(2).padStart(7)} posSyms=${positiveSymbols}/${bySymbol.size}`,
  );
  if (ordered.length && (net > 0 || deadCycles > 0)) {
    const worst = [...bySymbol.entries()].sort((a, b) => a[1] - b[1]).slice(0, 4);
    const best = [...bySymbol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    console.warn(`  best ${best.map(([s, v]) => `${s}:${v.toFixed(0)}`).join(' ')} | worst ${worst.map(([s, v]) => `${s}:${v.toFixed(0)}`).join(' ')}`);
  }
}

async function main(): Promise<void> {
  console.warn(`PHOENIX FIBONACCI · ${DAYS}d · stakes ${STAKES.join(',')} maxCycle=$${MAX_CYCLE_LOSS} · fees+slip ${(TAKER_RT_BPS + SLIP_BPS)}bps RT\n`);
  for (const profile of PROFILES) {
    const from = NOW - DAYS * 86_400_000;
    const to = NOW - intervalStepMs(profile.interval);
    const btc = await getKlines('BTCUSDT', profile.interval, from, to);
    const btcByTime = new Map(btc.map((bar) => [bar.t, bar]));
    const bySymbol = new Map<string, Candle[]>();
    for (const symbol of SYMBOLS) {
      try {
        const candles = await getKlines(symbol, profile.interval, from, to);
        if (candles.length < 1_000) continue;
        bySymbol.set(symbol, candles);
        process.stderr.write(`  ${profile.name} ${symbol}: ${candles.length} candles\n`);
      } catch (error) {
        process.stderr.write(`  ${profile.name} ${symbol}: ${(error as Error).message}\n`);
      }
    }
    for (const variant of VARIANTS) {
      const trades: Trade[] = [];
      for (const [symbol, candles] of bySymbol) trades.push(...simulateSymbol(symbol, candles, btcByTime, profile, variant));
      summarize(`${profile.name}-${variant.name}`, trades);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
