/**
 * Independent validation for Quant's "Lighter Volatility Reversion Dual".
 *
 * Exact causal rules:
 *   Long:  prev close < prev EMA - stretch*prev ATR,
 *          current close > prev close and remains below current EMA.
 *   Short: mirrored.
 *   Decide on completed candle, enter next-bar open, exit at next-bar open
 *   after a close crosses the EMA. Intrabar ATR safety stop + time stop.
 *
 * Parameter selection uses only the first 70% of BTC/ETH/SOL. The last 30%
 * and XRP/DOGE/SUI are untouched validation sets.
 *
 * Run on the VPS:
 *   pnpm tsx scripts/test-quant-volatility-reversion.ts [days]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atr, ema, sma, type Candle } from '../src/backtest/indicators.js';
import { getKlines } from '../src/backtest/klines.js';

const DAYS = Number(process.argv[2] ?? 365);
const TF = '5';
const TRAIN_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;
const TRANSFER_SYMBOLS = ['XRPUSDT', 'DOGEUSDT', 'SUIUSDT'] as const;
const BASE_COST_PCT = 0.05;
const STRESS_COST_PCT = 0.10;
const USE_VOLUME = process.env.VOLUME_FILTER === '1';

type Params = {
  meanPeriod: number;
  atrPeriod: number;
  stretchAtr: number;
  stopAtr: number;
  timeBars: number;
  volumeWindow: number;
  volumeMult: number;
};
type Prepared = {
  candles: Candle[];
  means: Map<number, number[]>;
  atrs: Map<number, number[]>;
  volumeMeans: Map<number, number[]>;
};
type Trade = {
  side: 'long' | 'short';
  entryAt: number;
  exitAt: number;
  grossPct: number;
  reason: 'mean' | 'stop' | 'time' | 'end';
};
type Stats = {
  n: number;
  netPct: number;
  pf: number;
  wrPct: number;
  maxDdPct: number;
  longN: number;
  longNetPct: number;
  longPf: number;
  shortN: number;
  shortNetPct: number;
  shortPf: number;
};

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function prepare(candles: Candle[]): Prepared {
  const closes = candles.map((c) => c.c);
  const volumes = candles.map((c) => c.v);
  return {
    candles,
    means: new Map([36, 48, 72].map((n) => [n, ema(closes, n)])),
    atrs: new Map([14, 24, 36].map((n) => [n, atr(candles, n)])),
    volumeMeans: new Map([12, 20, 36].map((n) => [n, sma(volumes, n)])),
  };
}

function simulate(data: Prepared, p: Params, start: number, end: number): Trade[] {
  const mean = data.means.get(p.meanPeriod);
  const atrArr = data.atrs.get(p.atrPeriod);
  const volumeMean = data.volumeMeans.get(p.volumeWindow);
  if (!mean || !atrArr || !volumeMean) throw new Error('indicator set was not prepared');
  const { candles } = data;
  const first = Math.max(start, Math.max(p.meanPeriod, p.atrPeriod) + 2);
  const last = Math.min(end, candles.length - 1);
  const trades: Trade[] = [];
  let pos: {
    side: Trade['side'];
    entryAt: number;
    entryIdx: number;
    entryPrice: number;
    stop: number;
  } | null = null;

  const close = (price: number, at: number, reason: Trade['reason']): void => {
    if (!pos) return;
    const sign = pos.side === 'long' ? 1 : -1;
    trades.push({
      side: pos.side,
      entryAt: pos.entryAt,
      exitAt: at,
      grossPct: sign * (price - pos.entryPrice) / pos.entryPrice * 100,
      reason,
    });
    pos = null;
  };

  for (let i = first; i <= last; i++) {
    const c = candles[i]!;
    const next = candles[i + 1];
    if (pos) {
      const stopHit = pos.side === 'long' ? c.l <= pos.stop : c.h >= pos.stop;
      if (stopHit) {
        close(pos.stop, c.t, 'stop');
        continue;
      }
      const meanReached = pos.side === 'long' ? c.c >= mean[i]! : c.c <= mean[i]!;
      if (meanReached) {
        if (next && i + 1 <= last) close(next.o, next.t, 'mean');
        else close(c.c, c.t, 'end');
        continue;
      }
      if (i - pos.entryIdx >= p.timeBars) {
        if (next && i + 1 <= last) close(next.o, next.t, 'time');
        else close(c.c, c.t, 'end');
        continue;
      }
      continue;
    }

    if (!next || i + 1 > last) continue;
    const prev = candles[i - 1]!;
    const prevAtr = atrArr[i - 1]!;
    const signalAtr = atrArr[i]!;
    if (!(prevAtr > 0) || !(signalAtr > 0)) continue;
    // Event candle = i-1. Its volume baseline ends at i-2, so the event
    // cannot inflate its own threshold.
    const volumeBaseline = volumeMean[i - 2]!;
    const volumeOk = p.volumeMult <= 0 || (volumeBaseline > 0 && prev.v >= p.volumeMult * volumeBaseline);
    const longSignal =
      volumeOk &&
      prev.c < mean[i - 1]! - p.stretchAtr * prevAtr &&
      c.c > prev.c &&
      c.c < mean[i]!;
    const shortSignal =
      volumeOk &&
      prev.c > mean[i - 1]! + p.stretchAtr * prevAtr &&
      c.c < prev.c &&
      c.c > mean[i]!;
    if (!longSignal && !shortSignal) continue;

    const side: Trade['side'] = longSignal ? 'long' : 'short';
    const risk = p.stopAtr * signalAtr;
    pos = {
      side,
      entryAt: next.t,
      entryIdx: i + 1,
      entryPrice: next.o,
      stop: side === 'long' ? c.c - risk : c.c + risk,
    };
  }

  if (pos && last >= first) close(candles[last]!.c, candles[last]!.t, 'end');
  return trades;
}

function pf(values: number[]): number {
  let gp = 0;
  let gl = 0;
  for (const value of values) {
    if (value >= 0) gp += value;
    else gl -= value;
  }
  return gl === 0 ? (gp > 0 ? Number.POSITIVE_INFINITY : 0) : gp / gl;
}

function stats(trades: Trade[], costPct: number): Stats {
  const values = trades.map((t) => t.grossPct - costPct);
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const side = (wanted: Trade['side']): { n: number; net: number; factor: number } => {
    const xs = trades.filter((t) => t.side === wanted).map((t) => t.grossPct - costPct);
    return { n: xs.length, net: xs.reduce((a, b) => a + b, 0), factor: pf(xs) };
  };
  const long = side('long');
  const short = side('short');
  return {
    n: trades.length,
    netPct: round(values.reduce((a, b) => a + b, 0)),
    pf: round(pf(values)),
    wrPct: round(values.length ? values.filter((v) => v > 0).length / values.length * 100 : 0, 1),
    maxDdPct: round(maxDd),
    longN: long.n,
    longNetPct: round(long.net),
    longPf: round(long.factor),
    shortN: short.n,
    shortNetPct: round(short.net),
    shortPf: round(short.factor),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '∞';
}

const PARAMS: Params[] = [];
if (USE_VOLUME) {
  // Preserve the Quant strategy exactly; only test a small neighborhood
  // around the independently motivated volume-exhaustion filter.
  for (const volumeWindow of [12, 20, 36]) {
    for (const volumeMult of [1.25, 1.5, 2]) {
      PARAMS.push({
        meanPeriod: 48,
        atrPeriod: 24,
        stretchAtr: 1,
        stopAtr: 2.5,
        timeBars: 96,
        volumeWindow,
        volumeMult,
      });
    }
  }
} else {
  for (const meanPeriod of [36, 48, 72]) {
    for (const stretchAtr of [0.75, 1, 1.25]) {
      for (const risk of [
        { atrPeriod: 14, stopAtr: 2, timeBars: 48 },
        { atrPeriod: 24, stopAtr: 2.5, timeBars: 96 },
        { atrPeriod: 36, stopAtr: 3, timeBars: 144 },
      ]) {
        PARAMS.push({ meanPeriod, stretchAtr, volumeWindow: 20, volumeMult: 0, ...risk });
      }
    }
  }
}

const now = Date.now();
const from = now - DAYS * 86_400_000;
const data = new Map<string, Prepared>();
for (const symbol of [...TRAIN_SYMBOLS, ...TRANSFER_SYMBOLS]) {
  process.stderr.write(`loading ${symbol} ${TF}m... `);
  const candles = await getKlines(symbol, TF, from, now);
  process.stderr.write(`${candles.length} bars\n`);
  if (candles.length < 5_000) throw new Error(`${symbol}: insufficient candles (${candles.length})`);
  data.set(symbol, prepare(candles));
}

const ranked = PARAMS.map((params) => {
  const perSymbol = TRAIN_SYMBOLS.map((symbol) => {
    const d = data.get(symbol)!;
    const cut = Math.floor(d.candles.length * 0.7);
    return stats(simulate(d, params, 0, cut - 1), BASE_COST_PCT);
  });
  const minN = Math.min(...perSymbol.map((s) => s.n));
  const minPf = Math.min(...perSymbol.map((s) => s.pf));
  const medianPf = median(perSymbol.map((s) => s.pf));
  const minNet = Math.min(...perSymbol.map((s) => s.netPct));
  const bothSides = perSymbol.every((s) => s.longN >= 20 && s.shortN >= 20);
  const eligible = minN >= 70 && bothSides && minNet > 0 && minPf >= 1.05;
  const score = (eligible ? 1_000 : 0) + minPf * 10 + medianPf;
  return { params, perSymbol, minN, minPf, medianPf, minNet, bothSides, eligible, score };
}).sort((a, b) => b.score - a.score);

const chosen = ranked[0]!;
console.log(`\nQuant ${USE_VOLUME ? 'Volume Exhaustion ' : 'Volatility '}Reversion Dual · ${DAYS}d · 5m · next-bar entry/mean exit · fee 0`);
console.log(`Selection costs: ${BASE_COST_PCT.toFixed(2)}% RT; stress: ${STRESS_COST_PCT.toFixed(2)}% RT`);
console.log(
  `Chosen: EMA=${chosen.params.meanPeriod}, ATR=${chosen.params.atrPeriod}, stretch=${chosen.params.stretchAtr} ATR, ` +
  `stop=${chosen.params.stopAtr} ATR, time=${chosen.params.timeBars} bars, volume=${chosen.params.volumeMult}×/${chosen.params.volumeWindow}`,
);
console.log(`Train gate: ${chosen.eligible ? 'PASS' : 'FAIL'} · worst PF ${fmt(chosen.minPf)} · worst net ${fmt(chosen.minNet)}% · min N ${chosen.minN} · both sides ${chosen.bothSides ? 'yes' : 'no'}\n`);

console.log('Top parameter neighborhoods (training only):');
for (const row of ranked.slice(0, 5)) {
  console.log(
    `  ema${row.params.meanPeriod} atr${row.params.atrPeriod} x${row.params.stretchAtr} s${row.params.stopAtr} t${row.params.timeBars}` +
    ` v${row.params.volumeMult}/${row.params.volumeWindow}` +
    ` · ${row.eligible ? 'PASS' : 'fail'} · minPF ${fmt(row.minPf)} · medPF ${fmt(row.medianPf)} · minNet ${fmt(row.minNet)}% · minN ${row.minN}`,
  );
}

type ReportRow = {
  scope: 'train' | 'time-oos' | 'transfer-oos';
  symbol: string;
  base: Stats;
  stress: Stats;
};
const report: ReportRow[] = [];
for (const symbol of TRAIN_SYMBOLS) {
  const d = data.get(symbol)!;
  const cut = Math.floor(d.candles.length * 0.7);
  const train = simulate(d, chosen.params, 0, cut - 1);
  const oos = simulate(d, chosen.params, cut, d.candles.length - 1);
  report.push({ scope: 'train', symbol, base: stats(train, BASE_COST_PCT), stress: stats(train, STRESS_COST_PCT) });
  report.push({ scope: 'time-oos', symbol, base: stats(oos, BASE_COST_PCT), stress: stats(oos, STRESS_COST_PCT) });
}
for (const symbol of TRANSFER_SYMBOLS) {
  const d = data.get(symbol)!;
  const trades = simulate(d, chosen.params, 0, d.candles.length - 1);
  report.push({ scope: 'transfer-oos', symbol, base: stats(trades, BASE_COST_PCT), stress: stats(trades, STRESS_COST_PCT) });
}

console.log('\nscope         symbol     N   net@5b   PF@5b   net@10b  PF@10b  L(N/net/PF)             S(N/net/PF)             DD@5b');
console.log('-'.repeat(132));
for (const row of report) {
  const b = row.base;
  const s = row.stress;
  console.log(
    `${row.scope.padEnd(13)} ${row.symbol.padEnd(9)} ${String(b.n).padStart(4)} ` +
    `${fmt(b.netPct).padStart(8)} ${fmt(b.pf).padStart(7)} ${fmt(s.netPct).padStart(9)} ${fmt(s.pf).padStart(7)}  ` +
    `${`${b.longN}/${fmt(b.longNetPct)}/${fmt(b.longPf)}`.padEnd(23)} ` +
    `${`${b.shortN}/${fmt(b.shortNetPct)}/${fmt(b.shortPf)}`.padEnd(23)} ${fmt(b.maxDdPct).padStart(7)}`,
  );
}

const validationRows = report.filter((r) => r.scope !== 'train');
const pass =
  chosen.eligible &&
  validationRows.every((r) =>
    r.base.n >= 30 &&
    r.base.netPct > 0 &&
    r.base.pf >= 1.15 &&
    r.base.longN >= 10 &&
    r.base.shortN >= 10 &&
    r.stress.netPct > 0,
  );
console.log(`\nFINAL SHADOW GATE: ${pass ? 'PASS' : 'FAIL'}`);
if (!pass) console.log('Do not create an alert or add this strategy to Shadow.');

mkdirSync(resolve('data'), { recursive: true });
writeFileSync(
  resolve('data', USE_VOLUME ? 'quant-volume-exhaustion-results.json' : 'quant-volatility-reversion-results.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    days: DAYS,
    timeframe: TF,
    baseCostPct: BASE_COST_PCT,
    stressCostPct: STRESS_COST_PCT,
    chosen: chosen.params,
    trainGate: {
      eligible: chosen.eligible,
      minN: chosen.minN,
      minPf: chosen.minPf,
      medianPf: chosen.medianPf,
      minNet: chosen.minNet,
      bothSides: chosen.bothSides,
    },
    report,
    shadowGate: pass,
  }, null, 2),
);
