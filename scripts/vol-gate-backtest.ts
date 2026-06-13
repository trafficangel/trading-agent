/**
 * Volatility-extremity gate validation (read-only).
 *
 * Refines the rejected blanket trend filter into a SURGICAL one:
 *   - Trend-aligned entries: ALWAYS kept (preserve the contrarian edge,
 *     proven +228% in regime-filter-backtest).
 *   - Counter-trend entries: kept in normal vol, SKIPPED only when a
 *     volatility-extremity signal is high at entry (i.e. a violent /
 *     crash regime — the June-W22 killer).
 *
 * Tested on TWO datasets at once:
 *   - BACKTEST logs (Mar-May): gate must NOT meaningfully hurt (it should
 *     rarely fire in calm periods; if it cuts profitable counter-trend
 *     trades, Δ goes negative → reject).
 *   - LIVE decisions (VPS DB), with the June 1-8 crash window isolated:
 *     gate should cut the long bleed there.
 *
 * Signals (computed from PAST candles only — no look-ahead):
 *   - atrRel: ATR(14,1h)/price relative to its trailing-180-bar median.
 *   - ext:    |close − EMA50(4h)| / ATR(14,4h)  (stretch from mean in vol units).
 *
 * Returns: backtest = SL-capped via MAE + commission; live = pnl_pct net
 * of commission. Run ON THE VPS (Bybit reachable there).
 *
 * Usage: pnpm tsx scripts/vol-gate-backtest.ts
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { request } from 'undici';
import { db } from '../src/db/client.js';
import { STRATEGY_CONFIGS, TRACK_C_COMMISSION_RT_PCT } from '../src/strategies/track-c-config.js';

const COMM = TRACK_C_COMMISSION_RT_PCT / 100;
const BASE = 'https://api.bybit.com';
const CRASH_START = Date.parse('2026-06-01T00:00:00Z');
const CRASH_END = Date.parse('2026-06-08T00:00:00Z');

type Trade = { source: 'bt' | 'live'; symbol: string; side: 'long' | 'short'; entryAt: number; closedAt: number; r: number };
type K = { t: number; o: number; h: number; l: number; c: number };

// ---------- trades ----------
function backtestTrades(): Trade[] {
  const out: Trade[] = [];
  for (const f of readdirSync('src/strategies/data').filter((x) => x.endsWith('.json'))) {
    const id = f.replace(/\.json$/, '');
    const cfg = STRATEGY_CONFIGS[id];
    if (!cfg?.symbol) continue;
    const raw = JSON.parse(readFileSync(resolve('src/strategies/data', f), 'utf8')) as {
      tradesLog?: Array<{ side: string; entryAt: number; exitAt: number; entryPrice: number; exitPrice: number; maePct?: number }>;
    };
    for (const t of raw.tradesLog ?? []) {
      const e = Number(t.entryPrice), x = Number(t.exitPrice);
      if (!Number.isFinite(e) || !Number.isFinite(x) || e <= 0) continue;
      const side = t.side === 'long' ? 'long' : 'short';
      let r = ((side === 'long' ? 1 : -1) * (x - e)) / e;
      const mae = typeof t.maePct === 'number' ? t.maePct / 100 : null;
      if (mae !== null && mae >= cfg.slPct) r = -cfg.slPct;
      out.push({ source: 'bt', symbol: cfg.symbol, side, entryAt: t.entryAt, closedAt: t.exitAt, r: r - COMM });
    }
  }
  return out;
}

function liveTrades(): Trade[] {
  const rows = db.prepare<[], { symbol: string; side: string; pnl_pct: number; created_at: number; closed_at: number }>(`
    SELECT symbol, side, pnl_pct, created_at, closed_at FROM decisions
     WHERE user_id IS NULL AND track='strategy' AND status='closed' AND pnl_pct IS NOT NULL AND side IS NOT NULL
  `).all();
  return rows.map((r) => ({
    source: 'live' as const, symbol: r.symbol, side: r.side === 'long' ? 'long' : 'short',
    entryAt: r.created_at, closedAt: r.closed_at, r: r.pnl_pct / 100 - COMM,
  }));
}

// ---------- klines ----------
async function fetchK(symbol: string, interval: number, start: number, end: number): Promise<K[]> {
  const step = interval * 60_000;
  const all: K[] = [];
  let cursor = start;
  while (cursor < end) {
    const url = `${BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&start=${cursor}&end=${end}&limit=1000`;
    const res = await request(url, { headersTimeout: 8000, bodyTimeout: 8000 });
    const body = (await res.body.json()) as { retCode: number; result?: { list?: string[][] } };
    if (body.retCode !== 0 || !body.result?.list?.length) break;
    for (const k of body.result.list) all.push({ t: +k[0]!, o: +k[1]!, h: +k[2]!, l: +k[3]!, c: +k[4]! });
    const newest = Math.max(...body.result.list.map((k) => +k[0]!));
    if (newest + step <= cursor) break;
    cursor = newest + step;
    await new Promise((r) => setTimeout(r, 80));
  }
  all.sort((a, b) => a.t - b.t);
  return all;
}

function ema(v: number[], p: number): number[] {
  const k = 2 / (p + 1); const o: number[] = []; let prev = v[0] ?? 0;
  for (let i = 0; i < v.length; i++) { prev = i === 0 ? v[0]! : v[i]! * k + prev * (1 - k); o.push(prev); } return o;
}
function atr(ks: K[], p = 14): number[] {
  const tr: number[] = []; for (let i = 0; i < ks.length; i++) {
    const pc = i ? ks[i - 1]!.c : ks[i]!.o;
    tr.push(Math.max(ks[i]!.h - ks[i]!.l, Math.abs(ks[i]!.h - pc), Math.abs(ks[i]!.l - pc)));
  }
  const o: number[] = []; let s = 0;
  for (let i = 0; i < tr.length; i++) { s += tr[i]!; if (i >= p) s -= tr[i - p]!; o.push(s / Math.min(i + 1, p)); } return o;
}
function trailingMedian(v: number[], win: number): number[] {
  const o: number[] = [];
  for (let i = 0; i < v.length; i++) {
    const w = v.slice(Math.max(0, i - win), i); // PAST only
    if (!w.length) { o.push(v[i]!); continue; }
    const s = [...w].sort((a, b) => a - b); o.push(s[s.length >> 1]!);
  } return o;
}
function idxAt(ts: number, times: number[]): number {
  let lo = 0, hi = times.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m]! <= ts) { idx = m; lo = m + 1; } else hi = m - 1; }
  return idx;
}

type Feat = { up: boolean; atrRel: number; ext: number } | null;

(async () => {
  const trades = [...backtestTrades(), ...liveTrades()];
  const symbols = [...new Set(trades.map((t) => t.symbol))];
  const feat = new Map<string, { t1: number[]; up4: boolean[]; t4: number[]; atrRel1: number[]; ext4: number[] }>();

  for (const sym of symbols) {
    const span = trades.filter((t) => t.symbol === sym);
    const min = Math.min(...span.map((t) => t.entryAt)) - 60 * 4 * 3600_000; // warmup
    const max = Math.max(...span.map((t) => t.entryAt)) + 4 * 3600_000;
    const h1 = await fetchK(sym, 60, min, max);
    const h4 = await fetchK(sym, 240, min, max);
    if (h1.length < 50 || h4.length < 50) { process.stderr.write(`  ${sym}: insufficient klines (${h1.length}/${h4.length})\n`); continue; }
    const atr1 = atr(h1, 14); const med1 = trailingMedian(atr1, 180);
    const atrRel1 = atr1.map((a, i) => (med1[i]! > 0 ? a / med1[i]! : 1));
    const c4 = h4.map((k) => k.c); const e50 = ema(c4, 50); const atr4 = atr(h4, 14);
    const e20s = ema(c4, 20);
    const up4 = h4.map((_, i) => e20s[i]! > e50[i]!);
    const ext4 = h4.map((k, i) => (atr4[i]! > 0 ? Math.abs(k.c - e50[i]!) / atr4[i]! : 0));
    feat.set(sym, { t1: h1.map((k) => k.t), up4, t4: h4.map((k) => k.t), atrRel1, ext4 });
    process.stderr.write(`  ${sym}: 1h=${h1.length} 4h=${h4.length}\n`);
  }

  // --closed: use only the PRIOR fully-closed candle (shift lookup back one
  // interval) to eliminate any intra-candle look-ahead. 1h interval = 3600s,
  // 4h = 14400s.
  const CLOSED = process.argv.includes('--closed');
  const LAG1 = CLOSED ? 3600_000 : 0;
  const LAG4 = CLOSED ? 4 * 3600_000 : 0;
  function featAt(t: Trade): Feat {
    const f = feat.get(t.symbol); if (!f) return null;
    const i1 = idxAt(t.entryAt - LAG1, f.t1); const i4 = idxAt(t.entryAt - LAG4, f.t4);
    if (i1 < 0 || i4 < 50) return null;
    return { up: f.up4[i4]!, atrRel: f.atrRel1[i1]!, ext: f.ext4[i4]! };
  }

  // attach features
  const enr = trades.map((t) => ({ t, f: featAt(t) }));
  const counter = (t: Trade, up: boolean) => (t.side === 'long' && !up) || (t.side === 'short' && up);

  const buckets: Record<string, (e: { t: Trade; f: Feat }) => boolean> = {
    bt: (e) => e.t.source === 'bt',
    live: (e) => e.t.source === 'live',
    'live-crash': (e) => e.t.source === 'live' && e.t.closedAt >= CRASH_START && e.t.closedAt < CRASH_END,
  };

  const gates: { name: string; fire: (f: NonNullable<Feat>) => boolean }[] = [
    { name: 'atrRel>1.5', fire: (f) => f.atrRel > 1.5 },
    { name: 'atrRel>2.0', fire: (f) => f.atrRel > 2.0 },
    { name: 'atrRel>2.5', fire: (f) => f.atrRel > 2.5 },
    { name: 'ext>3.0', fire: (f) => f.ext > 3.0 },
    { name: 'ext>4.0', fire: (f) => f.ext > 4.0 },
  ];

  const net = (es: { t: Trade; f: Feat }[]) => es.reduce((a, e) => a + e.t.r, 0) * 100;
  console.log('\nGate suppresses a COUNTER-TREND entry only when the vol signal fires. Aligned entries always kept.');
  console.log('Δ = gated_net − base_net (percentage points of $1000-notional return).\n');
  for (const [bname, bsel] of Object.entries(buckets)) {
    const es = enr.filter(bsel);
    const base = net(es);
    const nCounter = es.filter((e) => e.f && counter(e.t, e.f.up)).length;
    console.log(`### ${bname}  (N=${es.length}, base_net=${base.toFixed(1)}%, counter-trend=${nCounter})`);
    for (const g of gates) {
      const kept = es.filter((e) => !(e.f && counter(e.t, e.f.up) && g.fire(e.f)));
      const skipped = es.length - kept.length;
      const gnet = net(kept);
      console.log(`   ${g.name.padEnd(11)} skip ${String(skipped).padStart(3)}  gated_net ${gnet.toFixed(1).padStart(7)}%  Δ ${(gnet - base >= 0 ? '+' : '') + (gnet - base).toFixed(1)}`);
    }
    console.log('');
  }
  console.log('READ: want bt Δ ≈ 0 (edge preserved) AND live-crash Δ strongly positive (tail cut).');
})().catch((e) => { console.error(e); process.exit(1); });
