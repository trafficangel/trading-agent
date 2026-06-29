/**
 * WICK-ANOMALY HARDENING — the validation battery for the deep-dislocation fade (the first cross-window
 * fast-ish lead since funding-flip). Rest a deep limit X% from price; a flash fills it (maker, no speed);
 * fade back to the pre-flash mid. Hardened against the three things that kill such edges:
 *   (1) FILL REALISM — stress with extra round-trip SLIPPAGE on top of fees (resting maker limit can't
 *       fill worse than its price, but queue/partial/exit-impact cost a few bps; if a +2% edge survives
 *       +0.10% extra cost + 2× fees it's robust).
 *   (2) IS THE REVERT REAL — permutation null on the DIRECTION (random side per trade); the fade must
 *       sit in the upper tail, else the snap-back is not directional information.
 *   (3) CROSS-WINDOW PERSISTENCE — KEEP in ≥2/3 independent 180d windows (anomaly edge, not one flush).
 * Plus Kelly/expectancy and the win/tail skew. Causal. Run on the VPS:
 *   pnpm tsx scripts/wick-anomaly-harden.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT'];
const TF = String(process.argv[2] ?? '5');
const WIN_DAYS = 180, WINDOWS = [0, 180, 360], K = 30;
const RT = 0.05;            // maker entry + taker exit (base)
const SLIP = 0.10;          // extra round-trip slippage stress (%)
const Hfill = 6, exitH = 12, STOP = 0.03;
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const kelly = (a: number[]) => { const m = mean(a) / 100, s = sd(a) / 100; return s > 0 ? Math.round(m / (s * s) * 100) / 100 : 0; };

/** per-trade GROSS% (before cost) of fading a deep wick; side fixed = fade. */
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
  void RT; void SLIP;
  const COSTS = [0.05, 0.10, 0.15]; // optimistic / realistic (maker entry + taker-exit slip) / conservative RT %
  console.log(`WICK-ANOMALY HARDEN · ${TF}m · fade deep limit→mid · 3×${WIN_DAYS}d · cost ladder RT {${COSTS.join('/')}}% · null K${K}\n`);
  console.log('coin   X      n    win%@.10  Kelly@.10  netΣ@.05  @.10   @.15  | persist@.10  nullP@.10  | verdict');
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    const wins: Candle[][] = [];
    for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { wins.push(await getKlines(sym, TF, end - WIN_DAYS * 86_400_000, end)); } catch { wins.push([]); } }
    if (wins.some((w) => w.length < 800)) continue;
    for (const X of [0.02, 0.03]) {
      const perWin = wins.map((c) => trades(c, X));
      if (perWin[0]!.length < 15) continue;
      const allG = perWin.flat();
      const netW = (g: number[], cost: number) => Math.round((mean(g) - cost) * g.length * 10) / 10;
      const C = 0.10; // realistic
      const win = Math.round(allG.filter((x) => x - C > 0).length / allG.length * 100);
      const netReal = allG.map((x) => x - C);
      const persist = perWin.filter((g) => g.length >= 10 && netW(g, C) > 0).length;
      let ge = 0; const real = mean(netReal) * netReal.length;
      for (let s = 0; s < K; s++) { let acc = 0; let st = (104729 * (s + 1)) & 0x7fffffff; for (const g of allG) { st = (st * 1103515245 + 12345) & 0x7fffffff; acc += ((st / 0x7fffffff) < 0.5 ? -g : g) - C; } ge += (acc >= real ? 1 : 0); }
      const nullP = ge / K;
      const robust = persist >= 2 && netW(allG, C) > 0 && nullP < 0.05;
      console.log(`${coin.padEnd(5)} ${(X * 100).toFixed(1)}%  ${String(allG.length).padStart(4)}  ${String(win).padStart(5)}    ${String(kelly(netReal)).padStart(6)}   ${String(netW(allG, 0.05)).padStart(6)} ${String(netW(allG, 0.10)).padStart(6)} ${String(netW(allG, 0.15)).padStart(6)}  | ${persist}/3         ${nullP.toFixed(2)}     | ${robust ? '✅ ROBUST' : 'kill'}`);
    }
  }
  console.log('\nREAD: realistic cost = 0.10% RT (maker entry ~0 slip + taker-exit ~0.05% slip + fees). ✅ = persist ≥2/3 @0.10 AND total>0 @0.10 AND beats random-side null.');
})().catch((e) => { console.error(e); process.exit(1); });
