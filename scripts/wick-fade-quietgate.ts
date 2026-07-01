/**
 * WICK-FADE QUIET-GATE — the INVERSE of the (failed) volume-spike gate. wick-fade-gated.ts showed gating a
 * frequent fade ON a volume SPIKE makes it WORSE (a spike = toxic informed continuation, not reversion). The
 * direct implication: fade only LOW-VOLUME dislocations — a deep wick with NO abnormal volume is a thin-book
 * AIR-POCKET (a stop run into a vacuum, no real flow) that snaps back. Gate: keep the fill only if the fill
 * bar's volume z-score ≤ threshold (quiet). Tests QUIET@0.5 and QUIET@0.0 vs UNGATED, on the frequent X range
 * (1.5/2/2.5%). Same K100 null + cost ladder. Bybit data (RUN ON VPS; cached → fast).
 *   pnpm tsx scripts/wick-fade-quietgate.ts POPCAT,RENDER,DOGE 100 5
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const COINS = (process.argv[2] ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
const K = Number(process.argv[3] ?? 100);
const TF = String(process.argv[4] ?? '5');
const WIN_DAYS = 180, WINDOWS = [0, 180, 360];
const Hfill = 6, exitH = 12, STOP = 0.03, VOL_W = 96;
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const kelly = (a: number[]) => { const m = mean(a) / 100, s = sd(a) / 100; return s > 0 ? Math.round(m / (s * s) * 100) / 100 : 0; };

function volZ(c: Candle[], i: number): number {
  if (i < VOL_W) return 99;
  let s = 0, ss = 0; for (let j = i - VOL_W; j < i; j++) { const v = c[j]!.v; s += v; ss += v * v; }
  const m = s / VOL_W, sdv = Math.sqrt(Math.max(0, ss / VOL_W - m * m));
  return sdv > 0 ? (c[i]!.v - m) / sdv : 0;
}

// gate: null = ungated; number = keep fill only if volZ(fillBar) <= that threshold (quiet)
function trades(c: Candle[], X: number, quietThr: number | null): number[] {
  const n = c.length; const out: number[] = []; let guard = -1;
  for (let i = 50; i < n - exitH - Hfill - 1; i++) {
    if (i <= guard) continue;
    const mid = c[i]!.c;
    for (const side of [1, -1] as const) {
      const limit = side === 1 ? mid * (1 - X) : mid * (1 + X);
      let fb = -1; for (let j = i + 1; j <= i + Hfill; j++) { if (side === 1 ? c[j]!.l <= limit : c[j]!.h >= limit) { fb = j; break; } }
      if (fb < 0) continue;
      if (quietThr !== null && volZ(c, fb) > quietThr) { continue; } // keep only QUIET (low-volume) fills
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

function stats(perWin: number[][], label: string, coin: string, X: number): void {
  const allG = perWin.flat();
  if (allG.length < 20) { console.log(`${coin.padEnd(8)} ${(X * 100).toFixed(1)}% ${label.padEnd(10)} n=${allG.length} — too few`); return; }
  const netW = (g: number[], cost: number) => Math.round((mean(g) - cost) * g.length * 10) / 10;
  const netReal = allG.map((x) => x - 0.10);
  const persist = perWin.filter((g) => g.length >= 8 && netW(g, 0.10) > 0).length;
  let ge = 0; const real = mean(netReal) * netReal.length;
  for (let s = 0; s < K; s++) { let acc = 0; let st = (2654435761 * (s + 1)) & 0x7fffffff; for (const g of allG) { st = (st * 1103515245 + 12345) & 0x7fffffff; acc += ((st / 0x7fffffff) < 0.5 ? -g : g) - 0.10; } ge += (acc >= real ? 1 : 0); }
  const nullP = ge / K;
  const keep = persist >= 2 && netW(allG, 0.10) > 0 && nullP < 0.05 && kelly(netReal) > 0;
  const strong = keep && netW(allG, 0.15) > 0;
  console.log(`${coin.padEnd(8)} ${(X * 100).toFixed(1)}% ${label.padEnd(10)} ${String(allG.length).padStart(5)}  ${String(netW(allG, 0.05)).padStart(6)} ${String(netW(allG, 0.10)).padStart(6)} ${String(netW(allG, 0.15)).padStart(6)}  ${String(kelly(netReal)).padStart(5)}  ${persist}/${perWin.filter((w) => w.length > 0).length}  ${nullP.toFixed(2)}  ${strong ? '⭐' : keep ? '✅' : ''}`);
}

(async () => {
  if (!COINS.length) { console.error('usage: pnpm tsx scripts/wick-fade-quietgate.ts POPCAT,RENDER,DOGE 100 5'); process.exit(1); }
  console.log(`WICK-FADE QUIET-GATE · ${TF}m · fade only LOW-volume fills · null K${K} · cost 0.05/0.10/0.15\n`);
  console.log('coin     X     mode        n     net@.05 @.10   @.15   Kelly persist nullP');
  for (const coin of COINS) {
    const wins: Candle[][] = [];
    for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { const c = await getKlines(`${coin}USDT`, TF, end - WIN_DAYS * 86_400_000, end); wins.push(c.length >= 800 ? c : []); } catch { wins.push([]); } }
    if (wins.filter((w) => w.length).length < 2) { console.log(`${coin} — <2 windows — skip`); continue; }
    for (const X of [0.015, 0.02, 0.025]) {
      stats(wins.map((c) => c.length ? trades(c, X, null) : []), 'UNGATED', coin, X);
      stats(wins.map((c) => c.length ? trades(c, X, 0.5) : []), 'QUIET≤0.5', coin, X);
      stats(wins.map((c) => c.length ? trades(c, X, 0.0) : []), 'QUIET≤0.0', coin, X);
    }
    console.log('');
  }
  console.log('⭐/✅ on QUIET where UNGATED is negative = the low-volume (air-pocket) condition is the classifier → a frequent 3rd edge.');
})().catch((e) => { console.error(e); process.exit(1); });
