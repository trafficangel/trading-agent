/**
 * Independent validation for the Quant-built "Lighter ATR Donchian Dual".
 *
 * The Quant script is deliberately simple and symmetric:
 *   - 5m candles; EMA(6) / EMA(48) trend regime.
 *   - Close breaks the prior Donchian channel (current bar excluded).
 *   - Signal is decided on a completed candle; entry is next-bar open.
 *   - ATR(6) stop, R-multiple target, time exit, no pyramiding/reversal.
 *
 * This runner keeps parameter selection and validation separate:
 *   - choose one shared parameter set on the first 70% of BTC/ETH/SOL;
 *   - time-OOS = last 30% of the same three symbols;
 *   - transfer-OOS = XRP/DOGE/SUI, never used for selection;
 *   - report 5 bps and stressed 10 bps round-trip execution costs.
 *
 * Run on the VPS (Bybit klines are geo-blocked locally):
 *   pnpm tsx scripts/test-quant-atr-donchian.ts [days]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atr, donchian, ema, type Candle } from '../src/backtest/indicators.js';
import { getKlines } from '../src/backtest/klines.js';

const DAYS = Number(process.argv[2] ?? 365);
const TF = '5';
const TRAIN_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;
const TRANSFER_SYMBOLS = ['XRPUSDT', 'DOGEUSDT', 'SUIUSDT'] as const;
const BASE_COST_PCT = 0.05;   // 5 bps round trip: spread + slippage, fee remains zero.
const STRESS_COST_PCT = 0.10; // 10 bps round trip execution stress.

type Params = {
  channel: number;
  trendAtr: number;
  stopAtr: number;
  rewardR: number;
  timeBars: number;
};

type Prepared = {
  candles: Candle[];
  atr6: number[];
  fast: number[];
  slow: number[];
  channels: Map<number, ReturnType<typeof donchian>>;
};

type Trade = {
  side: 'long' | 'short';
  entryAt: number;
  exitAt: number;
  grossPct: number;
  reason: 'stop' | 'target' | 'time' | 'end';
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
  return {
    candles,
    atr6: atr(candles, 6),
    fast: ema(closes, 6),
    slow: ema(closes, 48),
    channels: new Map([6, 12, 18].map((n) => [n, donchian(candles, n)])),
  };
}

function simulate(data: Prepared, p: Params, start: number, end: number): Trade[] {
  const { candles, atr6, fast, slow } = data;
  const channel = data.channels.get(p.channel);
  if (!channel) throw new Error(`channel ${p.channel} was not prepared`);

  const trades: Trade[] = [];
  const first = Math.max(start, 60);
  const last = Math.min(end, candles.length - 1);
  let pos: {
    side: 'long' | 'short';
    entryAt: number;
    entryIdx: number;
    entryPrice: number;
    stop: number;
    target: number;
  } | null = null;

  const close = (exitPrice: number, exitAt: number, reason: Trade['reason']): void => {
    if (!pos) return;
    const sign = pos.side === 'long' ? 1 : -1;
    trades.push({
      side: pos.side,
      entryAt: pos.entryAt,
      exitAt,
      grossPct: sign * (exitPrice - pos.entryPrice) / pos.entryPrice * 100,
      reason,
    });
    pos = null;
  };

  for (let i = first; i <= last; i++) {
    const c = candles[i]!;
    if (pos) {
      const stopHit = pos.side === 'long' ? c.l <= pos.stop : c.h >= pos.stop;
      const targetHit = pos.side === 'long' ? c.h >= pos.target : c.l <= pos.target;
      // Conservative OHLC ambiguity rule: if both levels trade in one bar,
      // the stop is assumed to have filled first.
      if (stopHit) {
        close(pos.stop, c.t, 'stop');
        continue;
      }
      if (targetHit) {
        close(pos.target, c.t, 'target');
        continue;
      }
      if (i - pos.entryIdx >= p.timeBars) {
        const next = candles[i + 1];
        if (next && i + 1 <= last) close(next.o, next.t, 'time');
        else close(c.c, c.t, 'end');
        continue;
      }
      continue;
    }

    // Decision uses only completed bar i. The fill is next bar's open.
    const next = candles[i + 1];
    if (!next || i + 1 > last) continue;
    const a = atr6[i]!;
    if (!(a > 0)) continue;
    const sep = p.trendAtr * a;
    const longSignal = fast[i]! - slow[i]! >= sep && c.c > channel.upper[i]!;
    const shortSignal = slow[i]! - fast[i]! >= sep && c.c < channel.lower[i]!;
    if (!longSignal && !shortSignal) continue;

    const side = longSignal ? 'long' : 'short';
    const risk = p.stopAtr * a;
    const anchor = c.c;
    pos = {
      side,
      entryAt: next.t,
      entryIdx: i + 1,
      entryPrice: next.o,
      stop: side === 'long' ? anchor - risk : anchor + risk,
      target: side === 'long' ? anchor + p.rewardR * risk : anchor - p.rewardR * risk,
    };
  }

  if (pos && last >= first) close(candles[last]!.c, candles[last]!.t, 'end');
  return trades;
}

function profitFactor(values: number[]): number {
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
  const sideStats = (side: Trade['side']): { n: number; net: number; pf: number } => {
    const sideValues = trades.filter((t) => t.side === side).map((t) => t.grossPct - costPct);
    return {
      n: sideValues.length,
      net: sideValues.reduce((a, b) => a + b, 0),
      pf: profitFactor(sideValues),
    };
  };
  const longs = sideStats('long');
  const shorts = sideStats('short');
  return {
    n: trades.length,
    netPct: round(values.reduce((a, b) => a + b, 0)),
    pf: round(profitFactor(values)),
    wrPct: round(values.length ? values.filter((v) => v > 0).length / values.length * 100 : 0, 1),
    maxDdPct: round(maxDd),
    longN: longs.n,
    longNetPct: round(longs.net),
    longPf: round(longs.pf),
    shortN: shorts.n,
    shortNetPct: round(shorts.net),
    shortPf: round(shorts.pf),
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
for (const channel of [6, 12, 18]) {
  for (const trendAtr of [0, 0.1, 0.2]) {
    for (const risk of [
      { stopAtr: 1.5, rewardR: 1.5, timeBars: 48 },
      { stopAtr: 2, rewardR: 2, timeBars: 96 },
      { stopAtr: 2.5, rewardR: 2.5, timeBars: 144 },
    ]) {
      PARAMS.push({ channel, trendAtr, ...risk });
    }
  }
}

const now = Date.now();
const from = now - DAYS * 86_400_000;
const symbols = [...TRAIN_SYMBOLS, ...TRANSFER_SYMBOLS];
const data = new Map<string, Prepared>();

for (const symbol of symbols) {
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
  const bothSides = perSymbol.every((s) => s.longN >= 15 && s.shortN >= 15);
  // Hard constraints first; then prefer the worst asset over the best curve.
  const eligible = minN >= 40 && bothSides && minNet > 0;
  const score = (eligible ? 1_000 : 0) + minPf * 10 + medianPf;
  return { params, perSymbol, minN, minPf, medianPf, minNet, bothSides, eligible, score };
}).sort((a, b) => b.score - a.score);

const chosen = ranked[0]!;
console.log(`\nQuant ATR Donchian Dual · ${DAYS}d · 5m · next-bar entry · fee 0`);
console.log(`Selection costs: ${BASE_COST_PCT.toFixed(2)}% RT; stress: ${STRESS_COST_PCT.toFixed(2)}% RT`);
console.log(`Chosen: channel=${chosen.params.channel}, trend=${chosen.params.trendAtr} ATR, stop=${chosen.params.stopAtr} ATR, target=${chosen.params.rewardR}R, time=${chosen.params.timeBars} bars`);
console.log(`Train gate: ${chosen.eligible ? 'PASS' : 'FAIL'} · worst PF ${fmt(chosen.minPf)} · worst net ${fmt(chosen.minNet)}% · min N ${chosen.minN} · both sides ${chosen.bothSides ? 'yes' : 'no'}\n`);

console.log('Top parameter neighborhoods (training only):');
for (const row of ranked.slice(0, 5)) {
  console.log(
    `  ch${row.params.channel} tr${row.params.trendAtr} s${row.params.stopAtr} r${row.params.rewardR} t${row.params.timeBars}` +
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
  const trainTrades = simulate(d, chosen.params, 0, cut - 1);
  const oosTrades = simulate(d, chosen.params, cut, d.candles.length - 1);
  report.push({ scope: 'train', symbol, base: stats(trainTrades, BASE_COST_PCT), stress: stats(trainTrades, STRESS_COST_PCT) });
  report.push({ scope: 'time-oos', symbol, base: stats(oosTrades, BASE_COST_PCT), stress: stats(oosTrades, STRESS_COST_PCT) });
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
    r.base.n >= 25 &&
    r.base.netPct > 0 &&
    r.base.pf >= 1.15 &&
    r.base.longN >= 8 &&
    r.base.shortN >= 8 &&
    r.stress.netPct > 0,
  );

console.log(`\nFINAL SHADOW GATE: ${pass ? 'PASS' : 'FAIL'}`);
if (!pass) console.log('Do not create an alert or add this strategy to Shadow; revise the hypothesis first.');

mkdirSync(resolve('data'), { recursive: true });
writeFileSync(
  resolve('data', 'quant-atr-donchian-results.json'),
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
