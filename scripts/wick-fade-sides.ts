/**
 * WICK-FADE SIDE SPLIT — does each live coin earn on BOTH sides (long = fade a flush-down, short = fade a
 * spike-up), or is one side ballast? Runs at each coin's LIVE depth (COIN_X mirror), 3×180d windows, per-side
 * stats + K100 sign-flip null. DECISION BAR (conservative — dropping a positive-but-weak side loses money):
 * a side is a DROP candidate only if net<0 at the REAL cost (0.05% and 0.10%) with n≥100; weak-but-positive
 * sides STAY. Freed margin from dropped sides → better Kelly on the rest. Bybit data (RUN ON VPS; cached).
 *   pnpm tsx scripts/wick-fade-sides.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

// live COIN_X mirror (Bybit symbols: kPEPE→1000PEPE). TON halted but included for completeness.
const LIVE_X: Record<string, number> = {
  DOGE: 0.025, ICP: 0.025, NEAR: 0.025, ATOM: 0.03, TON: 0.02, CRV: 0.03, ENA: 0.025, TIA: 0.025, '1000PEPE': 0.03,
  RENDER: 0.03, POPCAT: 0.025, JUP: 0.025, AR: 0.03, BLUR: 0.025, LTC: 0.03, GOAT: 0.03, EIGEN: 0.03, MANTA: 0.03,
  XRP: 0.02, JTO: 0.03, SNX: 0.03, APE: 0.03, ZRO: 0.03, W: 0.03, ALT: 0.03, PNUT: 0.03,
};
const TF = String(process.argv[2] ?? '5');
const WIN_DAYS = 180, WINDOWS = [0, 180, 360], K = 100;
const Hfill = 6, exitH = 12, STOP = 0.03;

const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const kelly = (a: number[]) => { const m = mean(a) / 100, s = sd(a) / 100; return s > 0 ? Math.round(m / (s * s) * 100) / 100 : 0; };

function trades(c: Candle[], X: number, wantSide: 1 | -1): number[] {
  const n = c.length; const out: number[] = []; let guard = -1;
  for (let i = 50; i < n - exitH - Hfill - 1; i++) {
    if (i <= guard) continue;
    const mid = c[i]!.c;
    for (const side of [1, -1] as const) {
      const limit = side === 1 ? mid * (1 - X) : mid * (1 + X);
      let fb = -1; for (let j = i + 1; j <= i + Hfill; j++) { if (side === 1 ? c[j]!.l <= limit : c[j]!.h >= limit) { fb = j; break; } }
      if (fb < 0) continue;
      // guard advances on EVERY fill (both sides) so per-side stats stay comparable to the live one-position book
      if (side === wantSide) {
        const target = mid; const stopPx = side === 1 ? limit * (1 - STOP) : limit * (1 + STOP);
        let exit = c[Math.min(n - 1, fb + exitH)]!.c;
        for (let j = fb + 1; j <= Math.min(n - 1, fb + exitH); j++) {
          if (side === 1 ? c[j]!.l <= stopPx : c[j]!.h >= stopPx) { exit = stopPx; break; }
          if (side === 1 ? c[j]!.h >= target : c[j]!.l <= target) { exit = target; break; }
        }
        out.push((side === 1 ? (exit - limit) / limit : (limit - exit) / limit) * 100);
      }
      guard = fb + 1;
    }
  }
  return out;
}

function row(coin: string, X: number, label: string, perWin: number[][], pooled: Record<string, number[]>): void {
  const g = perWin.flat();
  (pooled[label] ??= []).push(...g);
  if (g.length < 30) { console.log(`${coin.padEnd(9)} ${(X * 100).toFixed(1).padStart(4)}% ${label.padEnd(6)} n=${g.length} — too few`); return; }
  const net = (cost: number) => Math.round((mean(g) - cost) * g.length * 10) / 10;
  const netReal = g.map((x) => x - 0.10);
  const persist = perWin.filter((w) => w.length >= 8 && (mean(w) - 0.10) * w.length > 0).length;
  let ge = 0; const real = mean(netReal) * netReal.length;
  for (let s = 0; s < K; s++) { let acc = 0; let st = (2654435761 * (s + 1)) & 0x7fffffff; for (const x of g) { st = (st * 1103515245 + 12345) & 0x7fffffff; acc += ((st / 0x7fffffff) < 0.5 ? -x : x) - 0.10; } ge += (acc >= real ? 1 : 0); }
  const drop = net(0.05) < 0 && net(0.10) < 0 && g.length >= 100;
  console.log(`${coin.padEnd(9)} ${(X * 100).toFixed(1).padStart(4)}% ${label.padEnd(6)} ${String(g.length).padStart(5)}  ${String(net(0.05)).padStart(7)} ${String(net(0.10)).padStart(7)} ${String(net(0.15)).padStart(7)}  ${String(kelly(netReal)).padStart(6)}  ${persist}/${perWin.filter((w) => w.length > 0).length}  ${(ge / K).toFixed(2)}  ${drop ? '❌ DROP?' : ''}`);
}

(async () => {
  console.log(`WICK-FADE SIDE SPLIT · ${TF}m · LIVE depths · long=fade flush-down, short=fade spike-up · null K${K}\n`);
  console.log('coin        X    side    n     net@.05  net@.10  net@.15   Kelly  persist nullP');
  const pooled: Record<string, number[]> = {};
  for (const [coin, X] of Object.entries(LIVE_X)) {
    const wins: Candle[][] = [];
    for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { const c = await getKlines(`${coin}USDT`, TF, end - WIN_DAYS * 86_400_000, end); wins.push(c.length >= 3000 ? c : []); } catch { wins.push([]); } }
    if (wins.filter((w) => w.length).length < 2) { console.log(`${coin} — <2 windows — skip`); continue; }
    row(coin, X, 'LONG', wins.map((c) => c.length ? trades(c, X, 1) : []), pooled);
    row(coin, X, 'SHORT', wins.map((c) => c.length ? trades(c, X, -1) : []), pooled);
  }
  console.log('\n=== POOLED across live coins ===');
  for (const label of ['LONG', 'SHORT']) {
    const g = pooled[label] ?? [];
    const net = (cost: number) => Math.round((mean(g) - cost) * g.length * 10) / 10;
    console.log(`${label.padEnd(6)} n=${g.length}  net@.05=${net(0.05)}  @.10=${net(0.10)}  @.15=${net(0.15)}  Kelly=${kelly(g.map((x) => x - 0.10))}  avg=${mean(g).toFixed(3)}%/trade`);
  }
  console.log('\nDROP? = net<0 at BOTH real costs (0.05/0.10) with n≥100 — candidates to disable that side in COIN_X. Weak-but-positive sides STAY.');
})().catch((e) => { console.error(e); process.exit(1); });
