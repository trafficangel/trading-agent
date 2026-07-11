/**
 * Faithful 5m passive-fill verification for the low-TF mean-reversion book.
 *
 * Unlike runBacktest(), this simulator does not assume a fill at the signal
 * close. A quote calculated after bar i can fill only on bar i+1, marketable
 * post-only quotes are rejected, catastrophe/time exits pay taker fees, and
 * same-bar entry+stop ambiguity is resolved against us. It also applies a
 * portfolio capacity cap so overlapping alt signals cannot manufacture PnL.
 *
 * Run on the VPS: pnpm tsx scripts/verify-passive-lowtf.ts [days]
 */

import { getKlines } from '../src/backtest/klines.js';
import type { Candle } from '../src/backtest/indicators.js';
import type { CustomStrategy, MakerQuote } from '../src/backtest/strategy.js';
import { keltnerMr, zscoreMr } from '../src/backtest/strategies/families-lowtf.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const DAYS = Number(process.argv[2] ?? 180);
const NOW = Date.now();
const TF = '5';
const MAKER_SIDE_PCT = 0.02;
const TAKER_SIDE_PCT = 0.045;
const EXTRA_STRESS_PCT = MAKER_SIDE_PCT + TAKER_SIDE_PCT;
const MAX_HOLD_BARS = 48;

type Spec = { label: string; build: (symbol: string) => CustomStrategy };
const SPECS: Spec[] = [];
for (const mult of [1.5, 2, 2.5, 3]) {
  SPECS.push({ label: `Keltner20/10/${mult}+EMA200`, build: (s) => keltnerMr(s, TF, 20, 10, mult, 200, 0.05) });
}
for (const period of [50, 100]) for (const z of [1.5, 2, 2.5, 3]) {
  SPECS.push({ label: `Z${period}/${z}+EMA200`, build: (s) => zscoreMr(s, TF, period, z, 200, 0.05) });
}

type ExitKind = 'maker' | 'taker-mean' | 'time' | 'sl' | 'end';
type Trade = {
  symbol: string;
  side: 'long' | 'short';
  entryAt: number;
  exitAt: number;
  grossPct: number;
  netPct: number;
  stressPct: number;
  exitKind: ExitKind;
};
type SimResult = { trades: Trade[]; quoteBars: number; fills: number };
type Position = { side: 'long' | 'short'; entry: number; entryAt: number; entryIdx: number; sl: number };

function validEntry(q: MakerQuote, close: number): q is Extract<MakerQuote, { kind: 'entry' }> {
  return q?.kind === 'entry' && (q.side === 'long' ? q.limit < close : q.limit > close);
}

function validExit(q: MakerQuote, side: Position['side'], close: number): boolean {
  return q?.kind === 'exit' && (side === 'long' ? q.limit > close : q.limit < close);
}

function simulate(strategy: CustomStrategy, c: Candle[]): SimResult {
  if (!strategy.quote) return { trades: [], quoteBars: 0, fills: 0 };
  const trades: Trade[] = [];
  let pos: Position | null = null;
  let entryQuote: Extract<MakerQuote, { kind: 'entry' }> | null = null;
  let exitQuote: Extract<MakerQuote, { kind: 'exit' }> | null = null;
  let quoteBars = 0;
  let fills = 0;

  const close = (bar: Candle, price: number, exitKind: ExitKind): void => {
    if (!pos) return;
    const sign = pos.side === 'long' ? 1 : -1;
    const grossPct = sign * (price - pos.entry) / pos.entry * 100;
    const exitFee = exitKind === 'maker' ? MAKER_SIDE_PCT : TAKER_SIDE_PCT;
    const netPct = grossPct - MAKER_SIDE_PCT - exitFee;
    trades.push({
      symbol: strategy.symbol,
      side: pos.side,
      entryAt: pos.entryAt,
      exitAt: bar.t,
      grossPct,
      netPct,
      stressPct: netPct - EXTRA_STRESS_PCT,
      exitKind,
    });
    pos = null;
    exitQuote = null;
  };

  for (let i = strategy.warmup + 1; i < c.length; i++) {
    const bar = c[i]!;

    if (pos) {
      // A stop touched on the same bar as a maker target is treated as first.
      const stopped = pos.side === 'long' ? bar.l <= pos.sl : bar.h >= pos.sl;
      if (stopped) {
        close(bar, pos.sl, 'sl');
      } else if (exitQuote && (pos.side === 'long' ? bar.h >= exitQuote.limit : bar.l <= exitQuote.limit)) {
        close(bar, exitQuote.limit, 'maker');
      } else if (i - pos.entryIdx >= MAX_HOLD_BARS) {
        close(bar, bar.c, 'time');
      }

      if (pos) {
        const q = strategy.quote(c, i, pos.side);
        if (q?.kind === 'exit' && validExit(q, pos.side, bar.c)) {
          exitQuote = q;
        } else if (q?.kind === 'exit') {
          // The mean crossed by the close. A post-only order at that stale
          // level would be rejected, so a usable implementation exits taker.
          close(bar, bar.c, 'taker-mean');
        } else {
          exitQuote = null;
        }
      }
      continue;
    }

    if (entryQuote) {
      quoteBars++;
      const touched = entryQuote.side === 'long' ? bar.l <= entryQuote.limit : bar.h >= entryQuote.limit;
      if (touched) {
        fills++;
        const side = entryQuote.side;
        const entry = entryQuote.limit;
        pos = {
          side,
          entry,
          entryAt: bar.t,
          entryIdx: i,
          sl: side === 'long' ? entry * (1 - strategy.slPct) : entry * (1 + strategy.slPct),
        };
        entryQuote = null;

        // If the fill bar also breaches the catastrophe stop, the fill must
        // have happened on the way there; count the stop rather than assuming
        // a favorable unknown OHLC path.
        const stopped = side === 'long' ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (stopped) {
          close(bar, pos.sl, 'sl');
          continue;
        }

        const q = strategy.quote(c, i, side);
        if (q?.kind === 'exit' && validExit(q, side, bar.c)) exitQuote = q;
        else if (q?.kind === 'exit') close(bar, bar.c, 'taker-mean');
        continue;
      }
    }

    const q = strategy.quote(c, i, null);
    entryQuote = validEntry(q, bar.c) ? q : null;
  }

  if (pos && c.length) close(c[c.length - 1]!, c[c.length - 1]!.c, 'end');
  return { trades, quoteBars, fills };
}

function sum(trades: Trade[], field: 'netPct' | 'stressPct'): number {
  return trades.reduce((acc, t) => acc + t[field], 0);
}

function pf(trades: Trade[], field: 'netPct' | 'stressPct' = 'netPct'): number {
  let gains = 0; let losses = 0;
  for (const t of trades) { const x = t[field]; if (x >= 0) gains += x; else losses -= x; }
  return losses === 0 ? (gains > 0 ? 99 : 0) : gains / losses;
}

function drawdown(trades: Trade[], field: 'netPct' | 'stressPct' = 'netPct'): number {
  let equity = 0; let peak = 0; let dd = 0;
  for (const t of [...trades].sort((a, b) => a.exitAt - b.exitAt)) {
    equity += t[field]; peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity);
  }
  return dd;
}

function positiveFolds(trades: Trade[], field: 'netPct' | 'stressPct' = 'netPct'): number {
  if (trades.length < 16) return -1;
  const sorted = [...trades].sort((a, b) => a.exitAt - b.exitAt);
  const size = Math.floor(sorted.length / 4);
  let positive = 0;
  for (let f = 0; f < 4; f++) {
    const slice = sorted.slice(f * size, f === 3 ? undefined : (f + 1) * size);
    if (sum(slice, field) > 0) positive++;
  }
  return positive;
}

function capacityFilter(trades: Trade[], capacity: number, rotation: number): Trade[] {
  const ordered = [...trades].sort((a, b) => {
    if (a.entryAt !== b.entryAt) return a.entryAt - b.entryAt;
    const ah = (SYMBOLS.indexOf(a.symbol) + rotation) % SYMBOLS.length;
    const bh = (SYMBOLS.indexOf(b.symbol) + rotation) % SYMBOLS.length;
    return ah - bh;
  });
  const accepted: Trade[] = [];
  let active: Trade[] = [];
  for (const trade of ordered) {
    active = active.filter((x) => x.exitAt > trade.entryAt);
    if (active.length >= capacity) continue;
    accepted.push(trade);
    active.push(trade);
  }
  return accepted;
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const sorted = [...a].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function fmt(x: number, digits = 1): string { return `${x >= 0 ? '+' : ''}${x.toFixed(digits)}`; }

(async () => {
  console.log(`Faithful passive 5m verification · ${DAYS}d · maker ${MAKER_SIDE_PCT}%/side · taker ${TAKER_SIDE_PCT}%/side`);
  console.log(`next-bar fills · post-only rejection · SL-first ambiguity · ${MAX_HOLD_BARS}-bar timeout · stress +${EXTRA_STRESS_PCT}%/trade\n`);

  const candles = new Map<string, Candle[]>();
  for (const symbol of SYMBOLS) {
    try { candles.set(symbol, await getKlines(symbol, TF, NOW - DAYS * 86_400_000, NOW)); }
    catch (error) { process.stderr.write(`${symbol}: ${(error as Error).message}\n`); }
  }

  for (const spec of SPECS) {
    const all: Trade[] = [];
    let green = 0;
    let stressGreen = 0;
    const lines: string[] = [];
    for (const symbol of SYMBOLS) {
      const c = candles.get(symbol) ?? [];
      const strategy = spec.build(symbol);
      if (c.length <= strategy.warmup + 50) continue;
      const result = simulate(strategy, c);
      const t = result.trades;
      all.push(...t);
      const net = sum(t, 'netPct');
      const stress = sum(t, 'stressPct');
      const folds = positiveFolds(t);
      const ok = t.length >= 30 && net > 0 && pf(t) >= 1.2 && folds >= 3;
      const stressOk = ok && stress > 0;
      if (ok) green++;
      if (stressOk) stressGreen++;
      lines.push(`  ${stressOk ? '*' : ok ? '+' : ' '} ${symbol.replace('USDT', '').padEnd(5)} N${String(t.length).padStart(4)} ${(t.length / DAYS).toFixed(2).padStart(5)}/d net ${fmt(net).padStart(7)} stress ${fmt(stress).padStart(7)} PF ${pf(t).toFixed(2).padStart(4)} DD ${drawdown(t).toFixed(1).padStart(5)} f${folds}/4 fill ${result.quoteBars ? (result.fills / result.quoteBars * 100).toFixed(0) : '0'}%`);
    }

    const capSummary: string[] = [];
    for (const cap of [1, 2, 3, 5]) {
      const rotations = Array.from({ length: 10 }, (_, r) => capacityFilter(all, cap, r));
      capSummary.push(`cap${cap} N${Math.round(median(rotations.map((x) => x.length)))} ${(median(rotations.map((x) => x.length)) / DAYS).toFixed(2)}/d net ${fmt(median(rotations.map((x) => sum(x, 'netPct'))))} stress ${fmt(median(rotations.map((x) => sum(x, 'stressPct'))))} PF ${median(rotations.map((x) => pf(x))).toFixed(2)} f${median(rotations.map((x) => positiveFolds(x)))}/4`);
    }

    console.log(`\n■ ${spec.label} · symbol-green ${green}/10 · stress-green ${stressGreen}/10 · raw ${all.length} (${(all.length / DAYS).toFixed(1)}/d)`);
    console.log(`  portfolio: ${capSummary.join(' | ')}`);
    if (green > 0 || stressGreen > 0) console.log(lines.join('\n'));
  }

  console.log('\n* = symbol survives baseline plus adverse-cost stress; + = baseline only. Promotion still requires forward paper trades.');
})().catch((error) => { console.error(error); process.exit(1); });
