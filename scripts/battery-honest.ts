/**
 * BATTERY-HONEST — re-validate EVERY live decision on a CORRECTED battery. The operator asked to audit the
 * battery itself; three real defects found:
 *  1. BROKEN PRNG in the sign-flip null: `st*1103515245` exceeds 2^53 before the &0x7fffffff mask → float
 *     precision loss corrupts the LCG (measured: cycles as short as 220, deciles off by ±4%). Fixed here with
 *     Math.imul (exact int32). Reports pBroken vs pFixed side by side to isolate the impact.
 *  2. SIM OPTIMISM #1 — same-bar stop-through: the fill bar itself can breach the stop (a monster candle fills
 *     at −X% and keeps going past the stop); the old sim only checks stops from fb+1 → those trades got a
 *     chance to recover. Honest: if the fill bar breaches the stop, the trade exits AT the stop.
 *  3. SIM OPTIMISM #2 — overlapping trades: old guard=fb+1 lets new trades open while the previous one is
 *     still in its exit window; live holds ONE position per coin and pulls quotes while holding. Honest:
 *     guard = the trade's EXIT bar. Sides also can't both fill from one anchor (earliest-touch wins).
 *  4. SIM OPTIMISM #3 — stop slippage: live catastrophe fills slip past the level (observed −3.517% vs −3.0%);
 *     honest: stop exits pay an extra 0.5% (SLIP), matching the one live observation. Target/time exits unchanged.
 * Verdict per (coin, live depth, enabled sides): keep-bar = net>0 @0.10 AND pFixed<0.05 on the HONEST series.
 * Includes the 3 pending ladder rungs and the majors CONTROLS (must stay dead). Bybit cache (RUN ON VPS).
 *   pnpm tsx scripts/battery-honest.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

type Row = { coin: string; sym: string; x: number; sides: (1 | -1)[]; tag: string };
const BOTH: (1 | -1)[] = [1, -1], LONG: (1 | -1)[] = [1], SHORT: (1 | -1)[] = [-1];
const LIVE: Row[] = [
  { coin: 'DOGE', sym: 'DOGE', x: 0.025, sides: BOTH, tag: 'live' }, { coin: 'ICP', sym: 'ICP', x: 0.025, sides: BOTH, tag: 'live' },
  { coin: 'NEAR', sym: 'NEAR', x: 0.025, sides: BOTH, tag: 'live' }, { coin: 'ATOM', sym: 'ATOM', x: 0.03, sides: LONG, tag: 'live' },
  { coin: 'TON', sym: 'TON', x: 0.02, sides: BOTH, tag: 'live' }, { coin: 'CRV', sym: 'CRV', x: 0.03, sides: BOTH, tag: 'live' },
  { coin: 'ENA', sym: 'ENA', x: 0.025, sides: BOTH, tag: 'live' }, { coin: 'TIA', sym: 'TIA', x: 0.025, sides: BOTH, tag: 'live' },
  { coin: 'kPEPE', sym: '1000PEPE', x: 0.03, sides: BOTH, tag: 'live' }, { coin: 'RENDER', sym: 'RENDER', x: 0.03, sides: BOTH, tag: 'live' },
  { coin: 'POPCAT', sym: 'POPCAT', x: 0.025, sides: BOTH, tag: 'live' }, { coin: 'JUP', sym: 'JUP', x: 0.025, sides: BOTH, tag: 'live' },
  { coin: 'AR', sym: 'AR', x: 0.03, sides: BOTH, tag: 'live' }, { coin: 'BLUR', sym: 'BLUR', x: 0.025, sides: BOTH, tag: 'live' },
  { coin: 'LTC', sym: 'LTC', x: 0.03, sides: LONG, tag: 'live' }, { coin: 'GOAT', sym: 'GOAT', x: 0.03, sides: BOTH, tag: 'live' },
  { coin: 'EIGEN', sym: 'EIGEN', x: 0.03, sides: BOTH, tag: 'live' }, { coin: 'MANTA', sym: 'MANTA', x: 0.03, sides: BOTH, tag: 'live' },
  { coin: 'XRP', sym: 'XRP', x: 0.02, sides: BOTH, tag: 'live' }, { coin: 'JTO', sym: 'JTO', x: 0.03, sides: BOTH, tag: 'live' },
  { coin: 'SNX', sym: 'SNX', x: 0.03, sides: BOTH, tag: 'live' }, { coin: 'APE', sym: 'APE', x: 0.03, sides: BOTH, tag: 'live' },
  { coin: 'ZRO', sym: 'ZRO', x: 0.03, sides: BOTH, tag: 'live' }, { coin: 'W', sym: 'W', x: 0.03, sides: BOTH, tag: 'live' },
  { coin: 'ALT', sym: 'ALT', x: 0.03, sides: SHORT, tag: 'live' }, { coin: 'PNUT', sym: 'PNUT', x: 0.03, sides: BOTH, tag: 'live' },
  { coin: 'DOGE', sym: 'DOGE', x: 0.035, sides: BOTH, tag: 'rung' }, { coin: 'ATOM', sym: 'ATOM', x: 0.035, sides: LONG, tag: 'rung' },
  { coin: 'ICP', sym: 'ICP', x: 0.035, sides: BOTH, tag: 'rung' },
  { coin: 'BTC', sym: 'BTC', x: 0.03, sides: BOTH, tag: 'CTRL' }, { coin: 'ETH', sym: 'ETH', x: 0.03, sides: BOTH, tag: 'CTRL' },
  { coin: 'SOL', sym: 'SOL', x: 0.03, sides: BOTH, tag: 'CTRL' }, { coin: 'LINK', sym: 'LINK', x: 0.03, sides: BOTH, tag: 'CTRL' },
];
const TF = String(process.argv[2] ?? '5');
const WIN_DAYS = 180, WINDOWS = [0, 180, 360], K = 200;
const Hfill = 6, exitH = 12, STOP = 0.03, SLIP = 0.005;

const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const kelly = (a: number[]) => { const m = mean(a) / 100, s = sd(a) / 100; return s > 0 ? Math.round(m / (s * s) * 100) / 100 : 0; };

/** OLD sim (battery as used until now) — for the delta columns. */
function tradesOld(c: Candle[], X: number, sides: (1 | -1)[]): number[] {
  const n = c.length; const out: number[] = []; let guard = -1;
  for (let i = 50; i < n - exitH - Hfill - 1; i++) {
    if (i <= guard) continue;
    const mid = c[i]!.c;
    for (const side of sides) {
      const limit = side === 1 ? mid * (1 - X) : mid * (1 + X);
      let fb = -1; for (let j = i + 1; j <= i + Hfill; j++) { if (side === 1 ? c[j]!.l <= limit : c[j]!.h >= limit) { fb = j; break; } }
      if (fb < 0) continue;
      const target = mid; const stopPx = side === 1 ? limit * (1 - STOP) : limit * (1 + STOP);
      let exit = c[Math.min(n - 1, fb + exitH)]!.c;
      for (let j = fb + 1; j <= Math.min(n - 1, fb + exitH); j++) {
        if (side === 1 ? c[j]!.l <= stopPx : c[j]!.h >= stopPx) { exit = stopPx; break; }
        if (side === 1 ? c[j]!.h >= target : c[j]!.l <= target) { exit = target; break; }
      }
      out.push((side === 1 ? (exit - limit) / limit : (limit - exit) / limit) * 100);
      guard = fb + 1;
    }
  }
  return out;
}

/** HONEST sim: one-position lock (guard = exit bar), earliest-touch side wins per anchor,
 *  same-bar stop-through exits at the stop, stop exits pay SLIP. */
function tradesHonest(c: Candle[], X: number, sides: (1 | -1)[]): { g: number; cat: boolean }[] {
  const n = c.length; const out: { g: number; cat: boolean }[] = []; let guard = -1;
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
    const stopFill = side === 1 ? stopPx * (1 - SLIP) : stopPx * (1 + SLIP); // stops slip past the level
    let exit: number; let exitBar: number; let cat = false;
    if (side === 1 ? c[fb]!.l <= stopPx : c[fb]!.h >= stopPx) { exit = stopFill; exitBar = fb; cat = true; } // fill bar blew through the stop
    else {
      exit = c[Math.min(n - 1, fb + exitH)]!.c; exitBar = Math.min(n - 1, fb + exitH);
      for (let j = fb + 1; j <= Math.min(n - 1, fb + exitH); j++) {
        if (side === 1 ? c[j]!.l <= stopPx : c[j]!.h >= stopPx) { exit = stopFill; exitBar = j; cat = true; break; }
        if (side === 1 ? c[j]!.h >= target : c[j]!.l <= target) { exit = target; exitBar = j; break; }
      }
    }
    out.push({ g: (side === 1 ? (exit - limit) / limit : (limit - exit) / limit) * 100, cat });
    guard = exitBar; // ONE position per coin: no new anchors until flat (matches the live runner)
  }
  return out;
}

// sign-flip null: BROKEN legacy PRNG vs FIXED (Math.imul — exact int32, no float corruption)
function pValue(g: number[], cost: number, fixed: boolean): number {
  const real = g.reduce((s, x) => s + x - cost, 0);
  let ge = 0;
  for (let s = 0; s < K; s++) {
    let st = fixed ? (Math.imul(2654435761, s + 1) >>> 4) & 0x7fffffff : (2654435761 * (s + 1)) & 0x7fffffff;
    let acc = 0;
    for (const x of g) {
      st = fixed ? (Math.imul(st, 1103515245) + 12345) & 0x7fffffff : (st * 1103515245 + 12345) & 0x7fffffff;
      acc += ((st / 0x7fffffff) < 0.5 ? -x : x) - cost;
    }
    if (acc >= real) ge++;
  }
  return ge / K;
}

(async () => {
  console.log(`BATTERY-HONEST · ${TF}m · corrected null (Math.imul) + one-position lock + same-bar stop-through + ${SLIP * 100}% stop slippage · K${K}\n`);
  console.log('coin       X    tag    nOld  nHon   avgOld  avgHon  net@.05  net@.10   cat%  Kelly  pBrk pFix  verdict');
  for (const r of LIVE) {
    const wins: Candle[][] = [];
    for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { const c = await getKlines(`${r.sym}USDT`, TF, end - WIN_DAYS * 86_400_000, end); wins.push(c.length >= 3000 ? c : []); } catch { wins.push([]); } }
    if (wins.filter((w) => w.length).length < 2) { console.log(`${r.coin} — <2 windows — skip`); continue; }
    const old = wins.flatMap((c) => c.length ? tradesOld(c, r.x, r.sides) : []);
    const hon = wins.flatMap((c) => c.length ? tradesHonest(c, r.x, r.sides) : []);
    const g = hon.map((t) => t.g);
    if (g.length < 20) { console.log(`${r.coin.padEnd(9)} ${(r.x * 100).toFixed(1).padStart(4)}% ${r.tag.padEnd(5)} n=${g.length} — too few`); continue; }
    const net = (cost: number) => Math.round((mean(g) - cost) * g.length * 10) / 10;
    const catPct = Math.round(hon.filter((t) => t.cat).length / hon.length * 1000) / 10;
    const pB = pValue(g, 0.10, false), pF = pValue(g, 0.10, true);
    const keep = net(0.10) > 0 && pF < 0.05 && kelly(g.map((x) => x - 0.10)) > 0;
    console.log(`${r.coin.padEnd(9)} ${(r.x * 100).toFixed(1).padStart(4)}% ${r.tag.padEnd(5)} ${String(old.length).padStart(5)} ${String(g.length).padStart(5)}  ${mean(old).toFixed(3).padStart(7)} ${mean(g).toFixed(3).padStart(7)} ${String(net(0.05)).padStart(8)} ${String(net(0.10)).padStart(8)}  ${String(catPct).padStart(5)}  ${String(kelly(g.map((x) => x - 0.10))).padStart(5)}  ${pB.toFixed(2)} ${pF.toFixed(2)}  ${r.tag === 'CTRL' ? (keep ? '🚩 CTRL LIT' : 'dead ✓') : keep ? '✅ keep' : '❌ FAILS honest'}`);
  }
  console.log('\nverdict = net>0 @0.10 AND pFixed<0.05 AND Kelly>0 on the HONEST series. CTRL must stay dead.');
})().catch((e) => { console.error(e); process.exit(1); });
