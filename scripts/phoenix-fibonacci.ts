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
): Trade[] {
  const trades: Trade[] = [];
  let step = 0;
  let nextAllowed = 30;
  const targetMargin = 3;
  const targetMove = targetMargin / profile.leverage;
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
    const invalidMove = Math.abs(entry / invalid - 1);
    const stopMove = Math.min(invalidMove, liquidationMove);
    const stop = side === 1 ? entry * (1 - stopMove) : entry * (1 + stopMove);
    const target = side === 1 ? entry * (1 + targetMove) : entry * (1 - targetMove);

    let entryIndex = -1;
    for (let j = i + 1; j <= i + profile.pullbackBars; j++) {
      const pull = candles[j]!;
      if (pull.l <= entry && pull.h >= entry) {
        entryIndex = j;
        break;
      }
    }
    if (entryIndex < 0) continue;

    let exitIndex = entryIndex + profile.maxHoldBars;
    let outcome: Trade['outcome'] = 'timeout';
    let exit = candles[exitIndex]!.c;
    for (let j = entryIndex; j <= entryIndex + profile.maxHoldBars; j++) {
      const b = candles[j]!;
      const stopHit = side === 1 ? b.l <= stop : b.h >= stop;
      const targetHit = side === 1 ? b.h >= target : b.l <= target;
      if (stopHit) {
        exitIndex = j;
        exit = stop;
        outcome = stopMove === liquidationMove ? 'liquidation' : 'loss';
        break;
      }
      if (targetHit) {
        exitIndex = j;
        exit = target;
        outcome = 'win';
        break;
      }
    }

    const grossMargin = side * (exit / entry - 1) * profile.leverage;
    const retOnMargin = grossMargin - feeAndSlipMargin(profile.leverage);
    const stake = STAKES[step]!;
    const pnl = outcome === 'win'
      ? stake * retOnMargin
      : outcome === 'timeout'
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
  console.warn(`PHOENIX FIBONACCI · ${DAYS}d · stakes ${STAKES.join(',')} maxCycle=$${MAX_CYCLE_LOSS} · target +300% margin · fees+slip ${(TAKER_RT_BPS + SLIP_BPS)}bps RT\n`);
  for (const profile of PROFILES) {
    const from = NOW - DAYS * 86_400_000;
    const to = NOW - intervalStepMs(profile.interval);
    const btc = await getKlines('BTCUSDT', profile.interval, from, to);
    const btcByTime = new Map(btc.map((bar) => [bar.t, bar]));
    const trades: Trade[] = [];
    for (const symbol of SYMBOLS) {
      try {
        const candles = await getKlines(symbol, profile.interval, from, to);
        if (candles.length < 1_000) continue;
        trades.push(...simulateSymbol(symbol, candles, btcByTime, profile));
        process.stderr.write(`  ${profile.name} ${symbol}: ${candles.length} candles\n`);
      } catch (error) {
        process.stderr.write(`  ${profile.name} ${symbol}: ${(error as Error).message}\n`);
      }
    }
    summarize(profile.name, trades);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
