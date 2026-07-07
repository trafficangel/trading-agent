/**
 * WICK-FADE LADDER SWEEP — is a SECOND, DEEPER rung worth adding per coin? A ladder (e.g. 2.5% + 3.5%) only
 * makes sense if the deep rung carries a STANDALONE edge (the avg-entry interaction when both rungs fill is
 * second-order). Tests X_deep ∈ {X_live+0.5pt, X_live+1pt} per live coin with the standard battery (3×180d,
 * K100 sign-flip null, cost ladder). LADDER-OK = deep rung passes the kill-lens at real cost. Implementation
 * constraint to check AFTER: each rung needs ≥$11 notional → laddered coins need ~2× per-coin allocation
 * (capital-bound; likely a top-N subset). Bybit data (RUN ON VPS; cached).
 *   pnpm tsx scripts/wick-fade-ladder.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

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
  console.log(`WICK-FADE LADDER SWEEP · ${TF}m · deep rungs X+0.5pt / X+1pt vs live X · null K${K}\n`);
  console.log('coin        X     n     net@.05  net@.10  net@.15   Kelly  persist nullP  verdict');
  const ladderOk: string[] = [];
  for (const [coin, liveX] of Object.entries(LIVE_X)) {
    const wins: Candle[][] = [];
    for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { const c = await getKlines(`${coin}USDT`, TF, end - WIN_DAYS * 86_400_000, end); wins.push(c.length >= 3000 ? c : []); } catch { wins.push([]); } }
    if (wins.filter((w) => w.length).length < 2) { console.log(`${coin} — <2 windows — skip`); continue; }
    for (const X of [liveX, liveX + 0.005, liveX + 0.01]) {
      const perWin = wins.map((c) => c.length ? trades(c, X) : []);
      const g = perWin.flat();
      const tag = X === liveX ? 'live' : X === liveX + 0.005 ? '+0.5' : '+1.0';
      if (g.length < 30) { console.log(`${coin.padEnd(9)} ${(X * 100).toFixed(1).padStart(4)}%${tag === 'live' ? '*' : ' '} n=${g.length} — too few`); continue; }
      const net = (cost: number) => Math.round((mean(g) - cost) * g.length * 10) / 10;
      const netReal = g.map((x) => x - 0.10);
      const persist = perWin.filter((w) => w.length >= 8 && (mean(w) - 0.10) * w.length > 0).length;
      let ge = 0; const real = mean(netReal) * netReal.length;
      // FIXED PRNG (Jul 7): Math.imul keeps the LCG in exact int32 — the old `st*1103515245` overflowed 2^53 before
      // the mask → float corruption (cycles as short as 220). Matches scripts/battery-honest.ts pValue(fixed=true).
      for (let s = 0; s < K; s++) { let st = (Math.imul(2654435761, s + 1) >>> 4) & 0x7fffffff; let acc = 0; for (const x of g) { st = (Math.imul(st, 1103515245) + 12345) & 0x7fffffff; acc += ((st / 0x7fffffff) < 0.5 ? -x : x) - 0.10; } ge += (acc >= real ? 1 : 0); }
      const nullP = ge / K;
      const ok = net(0.05) > 0 && net(0.10) > 0 && nullP < 0.05 && kelly(netReal) > 0 && persist >= 2;
      if (ok && tag !== 'live') ladderOk.push(`${coin}@${(X * 100).toFixed(1)}%`);
      console.log(`${coin.padEnd(9)} ${(X * 100).toFixed(1).padStart(4)}%${tag === 'live' ? '*' : ' '} ${String(g.length).padStart(5)}  ${String(net(0.05)).padStart(7)} ${String(net(0.10)).padStart(7)} ${String(net(0.15)).padStart(7)}  ${String(kelly(netReal)).padStart(6)}  ${persist}/${perWin.filter((w) => w.length > 0).length}  ${nullP.toFixed(2)}  ${tag !== 'live' && ok ? '✅ rung' : ''}`);
    }
  }
  console.log(`\n✅ LADDER-OK deep rungs (kill-lens at real cost): ${ladderOk.length ? ladderOk.join(', ') : 'none'}`);
  console.log('(* = current live depth, for reference. Implementation is capital-bound: each rung ≥$11 notional ⇒ ~2× per-coin allocation ⇒ ladder a top-N subset.)');
})().catch((e) => { console.error(e); process.exit(1); });
