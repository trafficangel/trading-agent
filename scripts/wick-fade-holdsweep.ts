/**
 * WICK-FADE HOLD SWEEP — is 60 min the right time-stop? (operator's question; never actually swept — the
 * original backtest fixed exitH=12 by construction.) Sweeps hold ∈ {30m,60m,90m,120m,180m} on the HONEST
 * battery (post-audit sim: one-position lock, same-bar stop-through, 0.25% stop slippage, Math.imul null)
 * at the LIVE config (21 coins, live depths, disabled sides). Longer holds also RECYCLE capital slower
 * (the lock suppresses later fills), so the honest comparison is TOTAL net per 540d, not just avg/trade.
 * OVERFIT GUARD (kill-lens): only move off 60m if an alternative is BETTER in a coherent, monotone way AND
 * persists per-window — a spike at one value = noise, keep 60m. Bybit cache (RUN ON VPS).
 *   pnpm tsx scripts/wick-fade-holdsweep.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

type Row = { coin: string; sym: string; x: number; sides: (1 | -1)[] };
const BOTH: (1 | -1)[] = [1, -1], LONG: (1 | -1)[] = [1], SHORT: (1 | -1)[] = [-1];
const LIVE: Row[] = [
  { coin: 'DOGE', sym: 'DOGE', x: 0.025, sides: BOTH }, { coin: 'ICP', sym: 'ICP', x: 0.035, sides: BOTH },
  { coin: 'NEAR', sym: 'NEAR', x: 0.025, sides: BOTH }, { coin: 'ATOM', sym: 'ATOM', x: 0.03, sides: LONG },
  { coin: 'TON', sym: 'TON', x: 0.02, sides: BOTH }, { coin: 'CRV', sym: 'CRV', x: 0.03, sides: BOTH },
  { coin: 'ENA', sym: 'ENA', x: 0.025, sides: BOTH }, { coin: 'TIA', sym: 'TIA', x: 0.025, sides: BOTH },
  { coin: 'kPEPE', sym: '1000PEPE', x: 0.03, sides: BOTH }, { coin: 'RENDER', sym: 'RENDER', x: 0.03, sides: BOTH },
  { coin: 'POPCAT', sym: 'POPCAT', x: 0.025, sides: BOTH }, { coin: 'JUP', sym: 'JUP', x: 0.025, sides: BOTH },
  { coin: 'AR', sym: 'AR', x: 0.03, sides: BOTH }, { coin: 'BLUR', sym: 'BLUR', x: 0.025, sides: BOTH },
  { coin: 'LTC', sym: 'LTC', x: 0.03, sides: LONG }, { coin: 'EIGEN', sym: 'EIGEN', x: 0.03, sides: BOTH },
  { coin: 'MANTA', sym: 'MANTA', x: 0.03, sides: BOTH }, { coin: 'XRP', sym: 'XRP', x: 0.02, sides: BOTH },
  { coin: 'JTO', sym: 'JTO', x: 0.03, sides: BOTH }, { coin: 'ALT', sym: 'ALT', x: 0.03, sides: SHORT },
  { coin: 'PNUT', sym: 'PNUT', x: 0.03, sides: BOTH },
];
const TF = String(process.argv[2] ?? '5');
const WIN_DAYS = 180, WINDOWS = [0, 180, 360], K = 200;
const Hfill = 6, STOP = 0.03, SLIP = 0.0025, COST = 0.05;
const HOLDS = [6, 12, 18, 24, 36]; // bars of 5m = 30/60/90/120/180 min

const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const kelly = (a: number[]) => { const m = mean(a) / 100, s = sd(a) / 100; return s > 0 ? Math.round(m / (s * s) * 100) / 100 : 0; };
function pFixed(g: number[], cost: number): number {
  const real = g.reduce((s, x) => s + x - cost, 0);
  let ge = 0;
  for (let s = 0; s < K; s++) {
    let st = (Math.imul(2654435761, s + 1) >>> 4) & 0x7fffffff, acc = 0;
    for (const x of g) { st = (Math.imul(st, 1103515245) + 12345) & 0x7fffffff; acc += ((st / 0x7fffffff) < 0.5 ? -x : x) - cost; }
    if (acc >= real) ge++;
  }
  return ge / K;
}

type T = { g: number; kind: 'target' | 'time' | 'cat' };
function sim(c: Candle[], X: number, sides: (1 | -1)[], exitH: number): T[] {
  const n = c.length; const out: T[] = []; let guard = -1;
  for (let i = 50; i < n - exitH - Hfill - 1; i++) {
    if (i <= guard) continue;
    const mid = c[i]!.c;
    let best: { side: 1 | -1; fb: number } | null = null;
    for (const side of sides) {
      const limit = side === 1 ? mid * (1 - X) : mid * (1 + X);
      for (let j = i + 1; j <= i + Hfill; j++) {
        if (side === 1 ? c[j]!.l <= limit : c[j]!.h >= limit) { if (!best || j < best.fb) best = { side, fb: j }; break; }
      }
    }
    if (!best) continue;
    const { side, fb } = best;
    const limit = side === 1 ? mid * (1 - X) : mid * (1 + X);
    const target = mid; const stopPx = side === 1 ? limit * (1 - STOP) : limit * (1 + STOP);
    const stopFill = side === 1 ? stopPx * (1 - SLIP) : stopPx * (1 + SLIP);
    let exit: number, exitBar: number, kind: T['kind'] = 'time';
    if (side === 1 ? c[fb]!.l <= stopPx : c[fb]!.h >= stopPx) { exit = stopFill; exitBar = fb; kind = 'cat'; }
    else {
      exit = c[Math.min(n - 1, fb + exitH)]!.c; exitBar = Math.min(n - 1, fb + exitH);
      for (let j = fb + 1; j <= Math.min(n - 1, fb + exitH); j++) {
        if (side === 1 ? c[j]!.l <= stopPx : c[j]!.h >= stopPx) { exit = stopFill; exitBar = j; kind = 'cat'; break; }
        if (side === 1 ? c[j]!.h >= target : c[j]!.l <= target) { exit = target; exitBar = j; kind = 'target'; break; }
      }
    }
    out.push({ g: (side === 1 ? (exit - limit) / limit : (limit - exit) / limit) * 100, kind });
    guard = exitBar;
  }
  return out;
}

(async () => {
  console.log(`WICK-FADE HOLD SWEEP · ${TF}m · honest sim (lock+same-bar+${SLIP * 100}% slip) · verdict@${COST} · K${K} · live 21-coin config\n`);
  // preload all data once
  const data: { row: Row; wins: Candle[][] }[] = [];
  for (const row of LIVE) {
    const wins: Candle[][] = [];
    for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { const c = await getKlines(`${row.sym}USDT`, TF, end - WIN_DAYS * 86_400_000, end); wins.push(c.length >= 3000 ? c : []); } catch { wins.push([]); } }
    data.push({ row, wins });
    process.stderr.write(`  ${row.coin} loaded\n`);
  }
  console.log('hold    n      avg%    TOTAL net@.05  net/win w0/w1/w2       target% time% cat%   Kelly   p');
  for (const exitH of HOLDS) {
    const all: T[] = []; const perWin: T[][] = [[], [], []];
    for (const { row, wins } of data) {
      wins.forEach((c, wi) => { if (c.length) { const t = sim(c, row.x, row.sides, exitH); all.push(...t); perWin[wi]!.push(...t); } });
    }
    const g = all.map((t) => t.g);
    const net = Math.round((mean(g) - COST) * g.length * 10) / 10;
    const wNets = perWin.map((w) => Math.round((mean(w.map((t) => t.g)) - COST) * w.length * 10) / 10);
    const mix = (k: T['kind']) => Math.round(all.filter((t) => t.kind === k).length / all.length * 100);
    console.log(`${String(exitH * 5).padStart(3)}m ${String(g.length).padStart(6)}  ${mean(g).toFixed(3).padStart(7)}  ${String(net).padStart(9)}      ${wNets.map(String).join(' / ').padEnd(20)} ${String(mix('target')).padStart(5)}% ${String(mix('time')).padStart(4)}% ${String(mix('cat')).padStart(4)}%  ${String(kelly(g.map((x) => x - COST))).padStart(6)}  ${pFixed(g, COST).toFixed(3)}`);
  }
  console.log('\nDecision bar: move off 60m ONLY for a coherent monotone improvement that persists in all 3 windows (a one-value spike = noise → keep 60m).');
})().catch((e) => { console.error(e); process.exit(1); });
