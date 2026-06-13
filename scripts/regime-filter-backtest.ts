/**
 * Regime/trend-filter validation (read-only analysis).
 *
 * Hypothesis (from live data, Jun 2026): our contrarian strategies bleed
 * on COUNTER-TREND entries — buying dips in a downtrend / fading rips in
 * an uptrend. A higher-timeframe trend filter that skips counter-trend
 * entries should improve net results WITHOUT being a curve-fit "shorts
 * only" bet (it adapts: allows longs in uptrends, shorts in downtrends).
 *
 * For each historical trade we fetch the coin's 4h trend at entry time
 * (EMA20 vs EMA50 on 4h klines) and tag the trade trend-aligned vs
 * counter-trend, then compare baseline net vs trend-filtered net.
 *
 * Returns are SL-capped via MAE + 0.11% round-trip commission, matching
 * how the strategy actually trades (same engine as kelly-analysis).
 *
 * Usage: pnpm tsx scripts/regime-filter-backtest.ts [fast] [slow]
 *   fast/slow = EMA periods on 4h (default 20 / 50).
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { request } from 'undici';
import { STRATEGY_CONFIGS, TRACK_C_COMMISSION_RT_PCT } from '../src/strategies/track-c-config.js';

const COMM = TRACK_C_COMMISSION_RT_PCT / 100;
const BASE = 'https://api.bybit.com';
const TF_MIN = 240; // 4h
const TF_MS = TF_MIN * 60_000;
const FAST = Number(process.argv[2] ?? 20);
const SLOW = Number(process.argv[3] ?? 50);

type Trade = { symbol: string; side: 'long' | 'short'; entryAt: number; r: number };
type Candle = { t: number; close: number };

function strategyIdForFile(f: string): string {
  return f.replace(/\.json$/, '');
}

function loadTrades(id: string, slPct: number): Trade[] {
  const path = resolve('src/strategies/data', `${id}.json`);
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    tradesLog?: Array<{ side: string; entryAt: number; entryPrice: number; exitPrice: number; maePct?: number }>;
  };
  const out: Trade[] = [];
  for (const t of raw.tradesLog ?? []) {
    const entry = Number(t.entryPrice);
    const exit = Number(t.exitPrice);
    if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) continue;
    const side = t.side === 'long' ? 'long' : 'short';
    const sign = side === 'long' ? 1 : -1;
    let r = (sign * (exit - entry)) / entry;
    const mae = typeof t.maePct === 'number' ? t.maePct / 100 : null;
    if (mae !== null && mae >= slPct) r = -slPct;
    out.push({ symbol: '', side, entryAt: t.entryAt, r: r - COMM });
  }
  return out;
}

async function fetchKlines(symbol: string, start: number, end: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = start;
  while (cursor < end) {
    const url =
      `${BASE}/v5/market/kline?category=linear&symbol=${symbol}` +
      `&interval=${TF_MIN}&start=${cursor}&end=${end}&limit=1000`;
    const res = await request(url);
    const body = (await res.body.json()) as { result?: { list?: string[][] } };
    const list = body.result?.list ?? [];
    if (list.length === 0) break;
    for (const k of list) all.push({ t: Number(k[0]), close: Number(k[4]) });
    const oldest = Math.min(...list.map((k) => Number(k[0])));
    const newest = Math.max(...list.map((k) => Number(k[0])));
    cursor = newest + TF_MS;
    if (newest <= oldest) break;
    await new Promise((r) => setTimeout(r, 90));
  }
  all.sort((a, b) => a.t - b.t);
  return all;
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0]!;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0]! : values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** regime at time `ts`: +1 up (emaFast>emaSlow), -1 down, 0 unknown. */
function regimeSeries(candles: Candle[]): { t: number; up: boolean }[] {
  if (candles.length < SLOW) return [];
  const closes = candles.map((c) => c.close);
  const ef = ema(closes, FAST);
  const es = ema(closes, SLOW);
  return candles.map((c, i) => ({ t: c.t, up: ef[i]! > es[i]! }));
}

function regimeAt(series: { t: number; up: boolean }[], ts: number): boolean | null {
  let lo = 0;
  let hi = series.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (series[m]!.t <= ts) { idx = m; lo = m + 1; } else hi = m - 1;
  }
  if (idx < SLOW) return null; // not enough warmup
  return series[idx]!.up;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

(async () => {
  const files = readdirSync('src/strategies/data').filter((f) => f.endsWith('.json'));
  // collect trades per strategy + per symbol
  const perStrat: { id: string; symbol: string; trades: Trade[] }[] = [];
  const symbolSpan = new Map<string, { min: number; max: number }>();

  for (const f of files) {
    const id = strategyIdForFile(f);
    const cfg = STRATEGY_CONFIGS[id];
    if (!cfg) continue;
    const symbol = cfg.symbol ?? '';
    if (!symbol) continue;
    const trades = loadTrades(id, cfg.slPct).map((t) => ({ ...t, symbol }));
    if (!trades.length) continue;
    perStrat.push({ id, symbol, trades });
    const span = symbolSpan.get(symbol) ?? { min: Infinity, max: -Infinity };
    for (const t of trades) { span.min = Math.min(span.min, t.entryAt); span.max = Math.max(span.max, t.entryAt); }
    symbolSpan.set(symbol, span);
  }

  // fetch klines + regime per symbol
  const regimeBySymbol = new Map<string, { t: number; up: boolean }[]>();
  for (const [symbol, span] of symbolSpan) {
    const start = span.min - SLOW * 2 * TF_MS; // warmup
    const candles = await fetchKlines(symbol, start, span.max + TF_MS);
    regimeBySymbol.set(symbol, regimeSeries(candles));
    process.stderr.write(`  fetched ${symbol}: ${candles.length} 4h candles\n`);
  }

  console.log(`\nRegime filter = keep trades aligned with 4h EMA${FAST}/${SLOW} trend (long&up | short&down).`);
  console.log('net% = sum of per-trade net returns on $1000 notional (SL-capped, commission-in).\n');
  console.log('strat  ' + 'symbol'.padEnd(9) + '  N   base_net  aligned(N,net)   counter(N,net)   filtered_net  Δ');
  console.log('-'.repeat(96));

  let totBase = 0, totFilt = 0, totCounterNet = 0, totCounterN = 0;
  for (const { id, symbol, trades } of perStrat) {
    const series = regimeBySymbol.get(symbol) ?? [];
    const aligned: number[] = [];
    const counter: number[] = [];
    for (const t of trades) {
      const up = regimeAt(series, t.entryAt);
      if (up === null) { aligned.push(t.r); continue; } // unknown → keep (conservative)
      const isAligned = (t.side === 'long' && up) || (t.side === 'short' && !up);
      (isAligned ? aligned : counter).push(t.r);
    }
    const base = sum([...aligned, ...counter]) * 100;
    const filt = sum(aligned) * 100;
    const cNet = sum(counter) * 100;
    totBase += base; totFilt += filt; totCounterNet += cNet; totCounterN += counter.length;
    const code = STRATEGY_CONFIGS[id]?.code ?? '??';
    console.log(
      `${code.padEnd(6)} ${symbol.padEnd(9)} ${String(trades.length).padStart(3)}  ` +
        `${base.toFixed(1).padStart(7)}  ${(`${aligned.length},${(sum(aligned)*100).toFixed(1)}`).padStart(14)}  ` +
        `${(`${counter.length},${cNet.toFixed(1)}`).padStart(14)}  ${filt.toFixed(1).padStart(11)}  ${(filt-base>=0?'+':'')}${(filt-base).toFixed(1)}`,
    );
  }
  console.log('-'.repeat(96));
  console.log(
    `TOTAL              base ${totBase.toFixed(0)}%   filtered ${totFilt.toFixed(0)}%   ` +
      `Δ ${(totFilt-totBase>=0?'+':'')}${(totFilt-totBase).toFixed(0)}%   ` +
      `(removed ${totCounterN} counter-trend trades worth ${totCounterNet.toFixed(0)}%)`,
  );
})().catch((e) => { console.error(e); process.exit(1); });
