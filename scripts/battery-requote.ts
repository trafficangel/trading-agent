/**
 * BATTERY-REQUOTE — the new CANONICAL per-coin battery with LIVE FILL MECHANICS: a TRAILING anchor that
 *  re-anchors on >1% drift (like the live runner's requote), so only FAST dislocations fill — the old static
 *  30-min-anchor battery counted slow-drift fills the live runner never takes (sim ~37 fills/day vs 2.8 live).
 * Sections:
 *  1. PER-COIN keep verdicts at the live config (hold 30m, stop 4%, cd 30m, ladder, disabled sides).
 *  2. POOLED re-check of the three recent parameter decisions under the new lens: hold {30,60} × stop {3,4}
 *     × cooldown {0,30m} — do they still hold with live fill mechanics?
 *  3. FILL-SPEED split (fresh anchor ≤2 bars vs stale): are the FAST fills (the only ones live really takes,
 *     given its 1-min requote is stricter than this 5m approximation) better or worse than the slow ones?
 * Honest exits (same-bar stop-through, 0.25% stop slip), verdict at real 0.05% RT, Math.imul null K200.
 * Bybit cache (RUN ON VPS).
 *   pnpm tsx scripts/battery-requote.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

type Row = { coin: string; sym: string; x: number; sides: (1 | -1)[]; deep?: number };
const BOTH: (1 | -1)[] = [1, -1], LONG: (1 | -1)[] = [1], SHORT: (1 | -1)[] = [-1];
const LIVE: Row[] = [
  { coin: 'DOGE', sym: 'DOGE', x: 0.025, sides: BOTH, deep: 0.035 }, { coin: 'ICP', sym: 'ICP', x: 0.035, sides: BOTH },
  { coin: 'NEAR', sym: 'NEAR', x: 0.025, sides: BOTH }, { coin: 'ATOM', sym: 'ATOM', x: 0.03, sides: LONG, deep: 0.035 },
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
const SLIP = 0.0025, COST = 0.05, DRIFT = 0.01;

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

type T = { g: number; kind: 'target' | 'time' | 'cat'; age: number };
function simRequote(c: Candle[], r: Row, exitH: number, stop: number, cdBars: number, tgtTouch = true, sbHarsh = true): T[] {
  const n = c.length; const out: T[] = [];
  let anchor = 0, anchorBar = 0, cdUntil = -1;
  let pos: { side: 1 | -1; entry: number; anchorMid: number; entryBar: number; age: number } | null = null;
  for (let i = 1; i < n; i++) {
    const bar = c[i]!;
    if (pos) {
      const target = pos.anchorMid;
      const stopPx = pos.side === 1 ? pos.entry * (1 - stop) : pos.entry * (1 + stop);
      const stopFill = pos.side === 1 ? stopPx * (1 - SLIP) : stopPx * (1 + SLIP);
      let exit: number | null = null, kind: T['kind'] = 'time';
      if (pos.side === 1 ? bar.l <= stopPx : bar.h >= stopPx) { exit = stopFill; kind = 'cat'; }
      else if (tgtTouch && (pos.side === 1 ? bar.h >= target : bar.l <= target)) { exit = target; kind = 'target'; }
      else if (!tgtTouch && (pos.side === 1 ? bar.c >= target : bar.c <= target)) { exit = bar.c; kind = 'target'; } // close-mode: the 1-min MID poll sees the level only at bar close (pessimistic bound); exit at market ≈ close
      else if (i - pos.entryBar >= exitH) { exit = bar.c; kind = 'time'; }
      if (exit != null) {
        out.push({ g: (pos.side === 1 ? (exit - pos.entry) / pos.entry : (pos.entry - exit) / pos.entry) * 100, kind, age: pos.age });
        if (kind === 'cat') cdUntil = i + cdBars;
        pos = null; anchor = 0;
      }
      continue;
    }
    if (i <= cdUntil) continue;
    if (anchor <= 0) { anchor = c[i - 1]!.c; anchorBar = i - 1; }
    let filled: { side: 1 | -1; entry: number } | null = null;
    for (const side of r.sides) {
      const depths = r.deep != null ? [r.x, r.deep] : [r.x];
      for (const d of depths) {
        const limit = side === 1 ? anchor * (1 - d) : anchor * (1 + d);
        if (side === 1 ? bar.l <= limit : bar.h >= limit) {
          if (!filled || (side === 1 ? limit > filled.entry : limit < filled.entry)) filled = { side, entry: limit };
        }
      }
    }
    if (filled) {
      const age = i - anchorBar;
      const stopPx = filled.side === 1 ? filled.entry * (1 - stop) : filled.entry * (1 + stop);
      if (sbHarsh && (filled.side === 1 ? bar.l <= stopPx : bar.h >= stopPx)) {
        const stopFill = filled.side === 1 ? stopPx * (1 - SLIP) : stopPx * (1 + SLIP);
        out.push({ g: (filled.side === 1 ? (stopFill - filled.entry) / filled.entry : (filled.entry - stopFill) / filled.entry) * 100, kind: 'cat', age });
        cdUntil = i + cdBars;
        anchor = 0;
      } else {
        pos = { side: filled.side, entry: filled.entry, anchorMid: anchor, entryBar: i, age };
        anchor = 0;
      }
      continue;
    }
    if (Math.abs(bar.c - anchor) / anchor > DRIFT) { anchor = bar.c; anchorBar = i; }
  }
  return out;
}

function verdictLine(label: string, perWin: T[][], showMix = true): void {
  const all = perWin.flat();
  const g = all.map((t) => t.g);
  if (g.length < 20) { console.log(`${label.padEnd(14)} n=${g.length} — too few`); return; }
  const net = (cost: number) => Math.round((mean(g) - cost) * g.length * 10) / 10;
  const wNets = perWin.map((w) => w.length ? Math.round((mean(w.map((t) => t.g)) - COST) * w.length * 10) / 10 : NaN);
  const persist = perWin.filter((w) => w.length >= 8 && (mean(w.map((t) => t.g)) - COST) * w.length > 0).length;
  const p = pFixed(g, COST);
  const keep = net(COST) > 0 && p < 0.05 && kelly(g.map((x) => x - COST)) > 0 && persist >= 2;
  const mix = (k: T['kind']) => Math.round(all.filter((t) => t.kind === k).length / all.length * 100);
  console.log(`${label.padEnd(14)} ${String(g.length).padStart(5)}  ${mean(g).toFixed(3).padStart(7)} ${String(net(COST)).padStart(8)}  ${wNets.map((x) => Number.isNaN(x) ? '—' : String(x)).join('/').padEnd(22)} ${showMix ? `${String(mix('target')).padStart(3)}%/${String(mix('time')).padStart(3)}%/${String(mix('cat')).padStart(3)}%` : '           '}  ${String(kelly(g.map((x) => x - COST))).padStart(6)} ${persist}/3 ${p.toFixed(2)}  ${keep ? '✅ keep' : '❌'}`);
}

(async () => {
  console.log(`BATTERY-REQUOTE · ${TF}m · trailing-anchor fills (live mechanics) · honest exits · verdict@${COST} · K${K}\n`);
  const data: { row: Row; wins: Candle[][] }[] = [];
  for (const row of LIVE) {
    const wins: Candle[][] = [];
    for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { const c = await getKlines(`${row.sym}USDT`, TF, end - WIN_DAYS * 86_400_000, end); wins.push(c.length >= 3000 ? c : []); } catch { wins.push([]); } }
    data.push({ row, wins });
    process.stderr.write(`  ${row.coin}\n`);
  }
  console.log('── 1. PER-COIN verdicts (live config: hold 30m, stop 4%, cd 30m) ──');
  console.log('coin            n     avg%    net@.05  w0/w1/w2               tgt/time/cat     Kelly  per  p    verdict');
  for (const { row, wins } of data) {
    verdictLine(row.coin, wins.map((c) => c.length ? simRequote(c, row, 6, 0.04, 6) : []));
  }
  console.log('\n── 2. POOLED re-check of the recent parameter decisions ──');
  for (const [label, exitH, stop, cd] of [['30m/4%/cd30*', 6, 0.04, 6], ['30m/4%/cd0', 6, 0.04, 0], ['30m/3%/cd30', 6, 0.03, 6], ['60m/4%/cd30', 12, 0.04, 6], ['60m/3%/cd0 (old)', 12, 0.03, 0]] as [string, number, number, number][]) {
    const perWin: T[][] = [[], [], []];
    for (const { row, wins } of data) wins.forEach((c, wi) => { if (c.length) perWin[wi]!.push(...simRequote(c, row, exitH, stop, cd)); });
    verdictLine(label, perWin);
  }
  console.log('\n── 3. FILL-SPEED split at live config (fast = anchor ≤2 bars old at fill — closest to what live takes) ──');
  const fast: T[][] = [[], [], []], slow: T[][] = [[], [], []];
  for (const { row, wins } of data) wins.forEach((c, wi) => {
    if (!c.length) return;
    for (const t of simRequote(c, row, 6, 0.04, 6)) (t.age <= 2 ? fast : slow)[wi]!.push(t);
  });
  verdictLine('FAST (≤10m)', fast);
  verdictLine('SLOW (stale)', slow);
  console.log('\n── 4. FIDELITY BRACKETS (live truth is inside) + resting-TP economics ──');
  const combos: [string, boolean, boolean][] = [
    ['tgtTouch+sbHarsh (ruler)*', true, true],
    ['tgtClose+sbHarsh (pess)', false, true],
    ['tgtTouch+sbSoft (opt)', true, false],
    ['tgtClose+sbSoft', false, false],
  ];
  for (const [label, tt, sb] of combos) {
    for (const tpMaker of [false, true]) {
      if (tpMaker && !tt) continue; // the resting TP is exactly what MAKES touch-mode true live
      const perWin: T[][] = [[], [], []];
      for (const { row, wins } of data) wins.forEach((c, wi) => { if (c.length) perWin[wi]!.push(...simRequote(c, row, 6, 0.04, 6, tt, sb)); });
      const all = perWin.flat();
      const costOf = (t: T) => (tpMaker && t.kind === 'target' ? 0.03 : COST);
      const gn = all.map((t) => t.g - costOf(t));
      const net = Math.round(mean(gn) * gn.length * 10) / 10;
      const wN = perWin.map((w) => Math.round(w.reduce((s2, t) => s2 + t.g - costOf(t), 0) * 10) / 10);
      console.log(`${(label + (tpMaker ? ' +TP' : '')).padEnd(28)} n=${String(all.length).padStart(5)}  avgNet ${mean(gn).toFixed(3).padStart(7)}  TOTAL ${String(net).padStart(8)}  w ${wN.join('/')}`);
    }
  }
  console.log('\nkeep-bar: net>0@0.05 · pK200<0.05 · Kelly>0 · persist≥2/3. FAST-vs-SLOW predicts live per-fill quality.');
})().catch((e) => { console.error(e); process.exit(1); });
