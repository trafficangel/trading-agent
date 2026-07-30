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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { request } from 'undici';
import { missingCandleWindows } from '../src/lib/lighter-candle-windows.js';

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const SYMBOLS = (process.env.SYMBOLS?.split(',').map((symbol) => symbol.trim()).filter(Boolean) ?? DEFAULT_SYMBOLS);
const DAYS = Number(process.argv[2] ?? 180);
const NOW = Date.now();
const TF = process.env.TF ?? '5';
const MAKER_SIDE_PCT = Number(process.env.MAKER_SIDE_PCT ?? 0.02);
const TAKER_SIDE_PCT = Number(process.env.TAKER_SIDE_PCT ?? 0.045);
const EXTRA_STRESS_PCT = Number(process.env.STRESS_RT_PCT ?? (MAKER_SIDE_PCT + TAKER_SIDE_PCT));
const MAX_HOLD_BARS = Number(process.env.MAX_HOLD_BARS ?? (TF === '1' ? 240 : 48));
const FILL_BUFFER_PCT = Number(process.env.FILL_BUFFER_PCT ?? 0);
const SL_PCT = Number(process.env.SL_PCT ?? 0.05);
const TREND_EMA = Number(process.env.TREND_EMA ?? 200);
const DATA_SOURCE = process.env.DATA_SOURCE ?? 'bybit';
const Z_PERIODS = (process.env.Z_PERIODS?.split(',').map(Number).filter(Number.isFinite) ?? [50, 100]);
const Z_THRESHOLDS = (process.env.Z_THRESHOLDS?.split(',').map(Number).filter(Number.isFinite) ?? [1.5, 2, 2.5, 3]);

type Spec = { label: string; build: (symbol: string) => CustomStrategy };
const SPECS: Spec[] = [];
for (const mult of [1.5, 2, 2.5, 3]) {
  SPECS.push({ label: `Keltner20/10/${mult}+EMA${TREND_EMA}`, build: (s) => keltnerMr(s, TF, 20, 10, mult, TREND_EMA, SL_PCT) });
}
for (const period of Z_PERIODS) for (const z of Z_THRESHOLDS) {
  SPECS.push({ label: `Z${period}/${z}+EMA${TREND_EMA}`, build: (s) => zscoreMr(s, TF, period, z, TREND_EMA, SL_PCT) });
}
const SELECTED_SPECS = process.env.SPEC_FILTER
  ? SPECS.filter((spec) => spec.label.includes(process.env.SPEC_FILTER!))
  : SPECS;

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
      } else if (exitQuote && (pos.side === 'long'
        ? bar.h >= exitQuote.limit * (1 + FILL_BUFFER_PCT / 100)
        : bar.l <= exitQuote.limit * (1 - FILL_BUFFER_PCT / 100))) {
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
      const touched = entryQuote.side === 'long'
        ? bar.l <= entryQuote.limit * (1 - FILL_BUFFER_PCT / 100)
        : bar.h >= entryQuote.limit * (1 + FILL_BUFFER_PCT / 100);
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

type LighterOrderBook = { symbol: string; market_id: number; market_type: string };
type LighterCandleResponse = { code: number; message?: string; c?: Candle[] };

const wait = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

let lighterMarketsPromise: Promise<Map<string, LighterOrderBook>> | null = null;

function lighterMarkets(): Promise<Map<string, LighterOrderBook>> {
  lighterMarketsPromise ??= (async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await request('https://mainnet.zklighter.elliot.ai/api/v1/orderBooks');
      const body = await response.body.json() as {
        code?: number;
        message?: string;
        order_books?: LighterOrderBook[];
      };
      if (body.order_books) {
        return new Map(
          body.order_books
            .filter((book) => book.market_type === 'perp')
            .map((book) => [book.symbol, book]),
        );
      }
      if (body.code !== 23000 || attempt === 5) {
        throw new Error(`Lighter orderBooks code=${body.code ?? 'unknown'}${body.message ? `: ${body.message}` : ''}`);
      }
      await wait(Math.min(4_000, 250 * 2 ** attempt));
    }
    throw new Error('Lighter orderBooks retry exhausted');
  })();
  return lighterMarketsPromise;
}

async function lighterCandlePage(url: URL): Promise<Candle[]> {
  for (let attempt = 0; attempt < 7; attempt++) {
    const response = await request(url);
    const body = await response.body.json() as LighterCandleResponse;
    if (body.code === 200) return body.c ?? [];
    if (body.code !== 23000 || attempt === 6) {
      throw new Error(`Lighter candles code=${body.code}${body.message ? `: ${body.message}` : ''}`);
    }
    await wait(Math.min(4_000, 250 * 2 ** attempt));
  }
  throw new Error('Lighter candles retry exhausted');
}

async function lighterCandles(symbol: string, fromMs: number, toMs: number): Promise<Candle[]> {
  const lighterSymbol = symbol.replace(/USDT$/, '');
  const cacheDir = resolve('data', 'lighter-klines');
  const cacheFile = resolve(cacheDir, `${lighterSymbol}-${TF}m.json`);
  const cached = existsSync(cacheFile)
    ? JSON.parse(readFileSync(cacheFile, 'utf8')) as Candle[]
    : [];
  const byTime = new Map(cached.map((candle) => [candle.t, candle]));
  const stepMs = Number(TF) * 60_000;
  const fetchConcurrency = Number(process.env.LIGHTER_FETCH_CONCURRENCY ?? 3);
  const fetchDelayMs = Number(process.env.LIGHTER_FETCH_DELAY_MS ?? 200);

  const market = (await lighterMarkets()).get(lighterSymbol);
  if (!market) throw new Error(`Lighter market not found: ${lighterSymbol}`);

  const windows = missingCandleWindows(byTime.keys(), fromMs, toMs, stepMs);

  for (let offset = 0; offset < windows.length; offset += fetchConcurrency) {
    const batch = windows.slice(offset, offset + fetchConcurrency);
    const pages = await Promise.all(batch.map(async ([start, endExclusive]) => {
      const url = new URL('https://mainnet.zklighter.elliot.ai/api/v1/candles');
      url.searchParams.set('market_id', String(market.market_id));
      url.searchParams.set('resolution', `${TF}m`);
      url.searchParams.set('start_timestamp', String(start));
      url.searchParams.set('end_timestamp', String(endExclusive));
      url.searchParams.set('count_back', '0');
      url.searchParams.set('set_timestamp_to_end', 'false');
      return lighterCandlePage(url);
    }));
    for (const page of pages) for (const candle of page) byTime.set(candle.t, candle);
    if (offset + batch.length < windows.length) await wait(fetchDelayMs);
  }

  const merged = [...byTime.values()].sort((a, b) => a.t - b.t);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(merged));
  return merged.filter((candle) => candle.t >= fromMs && candle.t <= toMs);
}

(async () => {
  console.log(`Faithful passive ${TF}m verification · ${DATA_SOURCE} candles · ${DAYS}d · maker ${MAKER_SIDE_PCT}%/side · taker ${TAKER_SIDE_PCT}%/side`);
  console.log(`next-bar fills · post-only rejection · penetration ${FILL_BUFFER_PCT}% · SL-first ambiguity · ${MAX_HOLD_BARS}-bar timeout · SL ${SL_PCT * 100}% · stress +${EXTRA_STRESS_PCT}%/trade\n`);

  const candles = new Map<string, Candle[]>();
  for (const symbol of SYMBOLS) {
    try {
      const fromMs = NOW - DAYS * 86_400_000;
      candles.set(symbol, DATA_SOURCE === 'lighter'
        ? await lighterCandles(symbol, fromMs, NOW)
        : await getKlines(symbol, TF, fromMs, NOW));
    }
    catch (error) { process.stderr.write(`${symbol}: ${(error as Error).message}\n`); }
  }

  for (const spec of SELECTED_SPECS) {
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
      const longs = t.filter((trade) => trade.side === 'long');
      const shorts = t.filter((trade) => trade.side === 'short');
      const ok = t.length >= 30 && net > 0 && pf(t) >= 1.2 && folds >= 3;
      const stressOk = ok && stress > 0;
      if (ok) green++;
      if (stressOk) stressGreen++;
      lines.push(`  ${stressOk ? '*' : ok ? '+' : ' '} ${symbol.replace('USDT', '').padEnd(5)} N${String(t.length).padStart(4)} ${(t.length / DAYS).toFixed(2).padStart(5)}/d net ${fmt(net).padStart(7)} stress ${fmt(stress).padStart(7)} PF ${pf(t).toFixed(2).padStart(4)} DD ${drawdown(t).toFixed(1).padStart(5)} f${folds}/4 L${longs.length}/${fmt(sum(longs, 'netPct'))} S${shorts.length}/${fmt(sum(shorts, 'netPct'))} fill ${result.quoteBars ? (result.fills / result.quoteBars * 100).toFixed(2) : '0'}%`);
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
