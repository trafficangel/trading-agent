/**
 * WICK-ANOMALY VERIFY — adversarial re-test of a SHORTLIST from the universe scan, before adding real money.
 * Stronger null (K=100 default vs the scan's K=30 — the [[multishuffle-null]] standard), and a full cost
 * ladder (0.05% real HL fees-only / 0.10% / 0.15% conservative) so we see the margin of safety, not just a
 * pass/fail at one cost. KEEP bar (real-money): persist≥2 · net>0 at 0.10% · nullP<0.05 at K100 · Kelly>0;
 * STRONG = also net>0 at 0.15%. Bybit data (RUN ON VPS; cached from the scan → fast).
 *   pnpm tsx scripts/wick-anomaly-verify.ts RENDER,POPCAT,JUP [K] [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const COINS = (process.argv[2] ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
const K = Number(process.argv[3] ?? 100);
const TF = String(process.argv[4] ?? '5');
const WIN_DAYS = 180, WINDOWS = [0, 180, 360];
const Hfill = 6, exitH = 12, STOP = 0.03;
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const kelly = (a: number[]) => { const m = mean(a) / 100, s = sd(a) / 100; return s > 0 ? Math.round(m / (s * s) * 100) / 100 : 0; };

function trades(c: Candle[], X: number): number[] {
  const n = c.length; const out: number[] = []; let guard = -1;
  for (let i = 50; i < n - exitH - Hfill - 1; i++) {
    if (i <= guard) continue;
    const mid = c[i]!.c;
    for (const side of [1, -1] as const) {
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

(async () => {
  if (!COINS.length) { console.error('usage: pnpm tsx scripts/wick-anomaly-verify.ts RENDER,POPCAT,JUP [K] [tf]'); process.exit(1); }
  console.log(`WICK-ANOMALY VERIFY · ${TF}m · null K${K} · cost ladder 0.05/0.10/0.15% · up to 3×${WIN_DAYS}d\n`);
  console.log('coin      X    win   n     net@.05  @.10   @.15   Kelly  persist  nullP  verdict');
  for (const coin of COINS) {
    const wins: Candle[][] = [];
    for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { const c = await getKlines(`${coin}USDT`, TF, end - WIN_DAYS * 86_400_000, end); wins.push(c.length >= 800 ? c : []); } catch { wins.push([]); } }
    const valid = wins.filter((w) => w.length > 0).length;
    if (valid < 2) { console.log(`${coin.padEnd(9)} — only ${valid} valid window(s) — skip`); continue; }
    for (const X of [0.02, 0.03]) {
      const perWin = wins.map((c) => c.length ? trades(c, X) : []);
      const allG = perWin.flat();
      if (allG.length < 30) continue;
      const netW = (g: number[], cost: number) => Math.round((mean(g) - cost) * g.length * 10) / 10;
      const C = 0.10;
      const netReal = allG.map((x) => x - C);
      const persist = perWin.filter((g) => g.length >= 10 && netW(g, C) > 0).length;
      let ge = 0; const real = mean(netReal) * netReal.length;
      for (let s = 0; s < K; s++) { let acc = 0; let st = (2654435761 * (s + 1)) & 0x7fffffff; for (const g of allG) { st = (st * 1103515245 + 12345) & 0x7fffffff; acc += ((st / 0x7fffffff) < 0.5 ? -g : g) - C; } ge += (acc >= real ? 1 : 0); }
      const nullP = ge / K;
      const keep = persist >= 2 && netW(allG, 0.10) > 0 && nullP < 0.05 && kelly(netReal) > 0;
      const strong = keep && netW(allG, 0.15) > 0;
      console.log(`${coin.padEnd(9)} ${(X * 100).toFixed(0)}%  ${valid}w  ${String(allG.length).padStart(5)}  ${String(netW(allG, 0.05)).padStart(6)} ${String(netW(allG, 0.10)).padStart(6)} ${String(netW(allG, 0.15)).padStart(6)}  ${String(kelly(netReal)).padStart(5)}   ${persist}/${valid}    ${nullP.toFixed(2)}   ${strong ? '⭐ STRONG' : keep ? '✅ keep' : 'kill'}`);
    }
  }
  console.log('\n⭐ STRONG = keep AND net>0 at conservative 0.15% (best margin of safety). ✅ keep = net>0 at 0.10% + K100 null + Kelly>0.');
})().catch((e) => { console.error(e); process.exit(1); });
