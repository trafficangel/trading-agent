/**
 * WICK-FADE PARAM SWEEP — the remaining fixed-by-construction parameters, swept 1-D around the live baseline
 * (NOT a full grid — a 3-D grid would be a multiple-testing lottery; each dimension moves only on the same
 * plateau + all-3-windows bar that moved the time-stop):
 *   A. CATASTROPHE STOP ∈ {2, 2.5, 3, 4, 5}% (live: 3%)
 *   B. TARGET FRACTION ∈ {0.6, 0.8, 1.0} of the reversion to anchor mid (live: 1.0 = full mid)
 *   C. POST-STOP COOLDOWN ∈ {0, 6, 12, 24} bars before re-quoting the coin (live: 0)
 * Honest battery (one-position lock, same-bar stop-through, 0.25% stop slip, Math.imul null), live 21-coin
 * config, hold = 30m (exitH=6, the new live value). Bybit cache (RUN ON VPS).
 *   pnpm tsx scripts/wick-fade-paramsweep.ts [tf]
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
const Hfill = 6, EXITH = 6, SLIP = 0.0025, COST = 0.05;
const BASE = { stop: 0.03, frac: 1.0, cd: 0 };

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
function sim(c: Candle[], X: number, sides: (1 | -1)[], stop: number, frac: number, cd: number): T[] {
  const n = c.length; const out: T[] = []; let guard = -1;
  for (let i = 50; i < n - EXITH - Hfill - 1; i++) {
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
    const entry = side === 1 ? mid * (1 - X) : mid * (1 + X);
    const target = entry + frac * (mid - entry); // frac of the reversion to the anchor mid (same formula both sides)
    const stopPx = side === 1 ? entry * (1 - stop) : entry * (1 + stop);
    const stopFill = side === 1 ? stopPx * (1 - SLIP) : stopPx * (1 + SLIP);
    let exit: number, exitBar: number, kind: T['kind'] = 'time';
    if (side === 1 ? c[fb]!.l <= stopPx : c[fb]!.h >= stopPx) { exit = stopFill; exitBar = fb; kind = 'cat'; }
    else {
      exit = c[Math.min(n - 1, fb + EXITH)]!.c; exitBar = Math.min(n - 1, fb + EXITH);
      for (let j = fb + 1; j <= Math.min(n - 1, fb + EXITH); j++) {
        if (side === 1 ? c[j]!.l <= stopPx : c[j]!.h >= stopPx) { exit = stopFill; exitBar = j; kind = 'cat'; break; }
        if (side === 1 ? c[j]!.h >= target : c[j]!.l <= target) { exit = target; exitBar = j; kind = 'target'; break; }
      }
    }
    out.push({ g: (side === 1 ? (exit - entry) / entry : (entry - exit) / entry) * 100, kind });
    guard = exitBar + (kind === 'cat' ? cd : 0); // post-stop cooldown suppresses immediate re-fill into the same cascade
  }
  return out;
}

(async () => {
  console.log(`WICK-FADE PARAM SWEEP · ${TF}m · honest sim · hold 30m · verdict@${COST} · K${K} · live 21-coin config\n`);
  const data: { row: Row; wins: Candle[][] }[] = [];
  for (const row of LIVE) {
    const wins: Candle[][] = [];
    for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { const c = await getKlines(`${row.sym}USDT`, TF, end - WIN_DAYS * 86_400_000, end); wins.push(c.length >= 3000 ? c : []); } catch { wins.push([]); } }
    data.push({ row, wins });
    process.stderr.write(`  ${row.coin}\n`);
  }
  function runCfg(label: string, stop: number, frac: number, cd: number): void {
    const all: T[] = []; const perWin: T[][] = [[], [], []];
    for (const { row, wins } of data) wins.forEach((c, wi) => { if (c.length) { const t = sim(c, row.x, row.sides, stop, frac, cd); all.push(...t); perWin[wi]!.push(...t); } });
    const g = all.map((t) => t.g);
    const net = Math.round((mean(g) - COST) * g.length * 10) / 10;
    const wNets = perWin.map((w) => Math.round((mean(w.map((t) => t.g)) - COST) * w.length * 10) / 10);
    const mix = (k: T['kind']) => Math.round(all.filter((t) => t.kind === k).length / all.length * 100);
    console.log(`${label.padEnd(14)} ${String(g.length).padStart(6)}  ${mean(g).toFixed(3).padStart(7)}  ${String(net).padStart(9)}   ${wNets.map(String).join(' / ').padEnd(24)} ${String(mix('target')).padStart(4)}% ${String(mix('time')).padStart(4)}% ${String(mix('cat')).padStart(4)}%  ${String(kelly(g.map((x) => x - COST))).padStart(6)}  ${pFixed(g, COST).toFixed(3)}`);
  }
  console.log('config          n      avg%    TOTAL@.05   w0 / w1 / w2             tgt% time% cat%   Kelly   p');
  console.log('── A. CATASTROPHE STOP (frac=1.0, cd=0) ──');
  for (const stop of [0.02, 0.025, 0.03, 0.04, 0.05]) runCfg(`stop ${(stop * 100).toFixed(1)}%${stop === BASE.stop ? '*' : ''}`, stop, BASE.frac, BASE.cd);
  console.log('── B. TARGET FRACTION of the reversion (stop=3%, cd=0) ──');
  for (const frac of [0.6, 0.8, 1.0]) runCfg(`frac ${frac.toFixed(1)}${frac === BASE.frac ? '*' : ''}`, BASE.stop, frac, BASE.cd);
  console.log('── C. POST-STOP COOLDOWN (stop=3%, frac=1.0) ──');
  for (const cd of [0, 6, 12, 24]) runCfg(`cd ${String(cd * 5).padStart(3)}m${cd === BASE.cd ? '*' : ''}`, BASE.stop, BASE.frac, cd);
  console.log('── D. COMBINED candidates (joint effect — A and C were only tested separately) ──');
  runCfg('4% + cd30m', 0.04, 1.0, 6);
  runCfg('4% + cd60m', 0.04, 1.0, 12);
  console.log('\n(* = live baseline. Move only on a coherent plateau better in ALL 3 windows — the time-stop bar.)');
})().catch((e) => { console.error(e); process.exit(1); });
