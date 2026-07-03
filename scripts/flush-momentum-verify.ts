/**
 * FLUSH-MOMENTUM VERIFY — harden the F1@3% candidate from fast-edge-sweep before any excitement:
 *  (1) per-coin breadth (is it broad or one meme carrying the pool?) + per-window persistence (3×180d),
 *  (2) entry-slippage stress: taker entry DURING a cascade slips — net at RT 0.09 + {0.1, 0.2}% extra,
 *  (3) direction split (follow-crash shorts vs follow-pump longs),
 *  (4) OVERLAP with the live wick-fade: share of F1 signal bars within ±3 bars of a wick-fade fill at the
 *      coin's live depth — they trade OPPOSITE sides of the same cascade (F1 rides the continuation phase,
 *      the fade rides the reversion phase); on one One-Way account same-coin positions would collide.
 * Honest framework throughout: next-bar-open entry, 2% stop intrabar, exit close of H, one-position lock,
 * fixed Math.imul null K200. Bybit cache (RUN ON VPS).
 *   pnpm tsx scripts/flush-momentum-verify.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const LIVE_X: Record<string, number> = {
  DOGE: 0.025, ICP: 0.035, NEAR: 0.025, ATOM: 0.03, TON: 0.02, CRV: 0.03, ENA: 0.025, TIA: 0.025, '1000PEPE': 0.03,
  RENDER: 0.03, POPCAT: 0.025, JUP: 0.025, AR: 0.03, BLUR: 0.025, LTC: 0.03, EIGEN: 0.03, MANTA: 0.03,
  XRP: 0.02, JTO: 0.03, ALT: 0.03, PNUT: 0.03,
};
const MAJORS = ['BTC', 'ETH', 'SOL', 'LINK'];
const TF = String(process.argv[2] ?? '5');
const WIN_DAYS = 180, WINDOWS = [0, 180, 360], K = 200;
const T = 0.03, H = 6, STOPP = 0.02, COST = 0.09;

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

type Ev = { g: number; dir: 1 | -1; bar: number; win: number };
function momentum(c: Candle[], win: number): Ev[] {
  const n = c.length; const out: Ev[] = []; let guard = -1;
  for (let i = 2; i < n - H - 2; i++) {
    if (i <= guard) continue;
    const ret = c[i]!.c / c[i - 1]!.c - 1;
    if (Math.abs(ret) < T) continue;
    const dir: 1 | -1 = ret > 0 ? 1 : -1;
    const entry = c[i + 1]!.o; if (!(entry > 0)) continue;
    const stopPx = dir === 1 ? entry * (1 - STOPP) : entry * (1 + STOPP);
    let exit = c[i + 1 + H]!.c, exitBar = i + 1 + H;
    for (let j = i + 1; j <= i + 1 + H; j++) { if (dir === 1 ? c[j]!.l <= stopPx : c[j]!.h >= stopPx) { exit = stopPx; exitBar = j; break; } }
    out.push({ g: dir * (exit / entry - 1) * 100, dir, bar: i, win });
    guard = exitBar;
  }
  return out;
}

/** wick-fade FILL BARS at depth X (honest: earliest touch, lock) — for the overlap measurement. */
function fadeFillBars(c: Candle[], X: number): Set<number> {
  const n = c.length; const fills = new Set<number>(); let guard = -1;
  for (let i = 50; i < n - 12 - 6 - 1; i++) {
    if (i <= guard) continue;
    const mid = c[i]!.c;
    let fb = -1;
    for (let j = i + 1; j <= i + 6; j++) { if (c[j]!.l <= mid * (1 - X) || c[j]!.h >= mid * (1 + X)) { fb = j; break; } }
    if (fb < 0) continue;
    fills.add(fb);
    guard = fb + 12; // approximate hold
  }
  return fills;
}

(async () => {
  console.log(`FLUSH-MOMENTUM VERIFY · ${TF}m · T=3% H=${H} stop ${STOPP * 100}% · next-bar-open · null K${K}\n`);
  console.log('coin       n    avg%    net@.09  +slip.1  +slip.2  Kelly   p     w0/w1/w2 net@.09      long/short avg   fadeOverlap');
  const pooled: Ev[] = [];
  for (const [coin] of [...Object.entries(LIVE_X), ...MAJORS.map((m) => [m, 0.03] as [string, number])]) {
    const evs: Ev[] = []; const winNets: number[] = []; let overlapN = 0, sigN = 0;
    for (let w = 0; w < WINDOWS.length; w++) {
      const end = Date.now() - WINDOWS[w]! * 86_400_000;
      let c: Candle[] = [];
      try { c = await getKlines(`${coin}USDT`, TF, end - WIN_DAYS * 86_400_000, end); } catch { /* skip window */ }
      if (c.length < 3000) { winNets.push(NaN); continue; }
      const e = momentum(c, w);
      evs.push(...e);
      winNets.push(Math.round((mean(e.map((x) => x.g)) - COST) * e.length * 10) / 10);
      const lx = LIVE_X[coin];
      if (lx != null && e.length) {
        const fills = fadeFillBars(c, lx);
        for (const ev of e) { sigN++; for (let d = -3; d <= 3; d++) { if (fills.has(ev.bar + d)) { overlapN++; break; } } }
      }
    }
    if (evs.length < 15) { console.log(`${coin.padEnd(9)} n=${evs.length} — too few`); continue; }
    const g = evs.map((e) => e.g);
    const net = (cost: number) => Math.round((mean(g) - cost) * g.length * 10) / 10;
    const lg = evs.filter((e) => e.dir === 1).map((e) => e.g), sh = evs.filter((e) => e.dir === -1).map((e) => e.g);
    const ov = sigN ? Math.round(overlapN / sigN * 100) : NaN;
    if (LIVE_X[coin] != null) pooled.push(...evs);
    console.log(`${coin.padEnd(9)} ${String(g.length).padStart(4)} ${mean(g).toFixed(3).padStart(7)} ${String(net(COST)).padStart(8)} ${String(net(COST + 0.10)).padStart(8)} ${String(net(COST + 0.20)).padStart(8)} ${String(kelly(g.map((x) => x - COST))).padStart(6)} ${pFixed(g, COST).toFixed(2).padStart(5)}   ${winNets.map((x) => Number.isNaN(x) ? '—' : String(x)).join('/').padEnd(22)} ${mean(lg).toFixed(2)}(${lg.length})/${mean(sh).toFixed(2)}(${sh.length})   ${Number.isNaN(ov) ? '—' : ov + '%'}`);
  }
  const g = pooled.map((e) => e.g);
  const net = (cost: number) => Math.round((mean(g) - cost) * g.length * 10) / 10;
  const lg = pooled.filter((e) => e.dir === 1).map((e) => e.g), sh = pooled.filter((e) => e.dir === -1).map((e) => e.g);
  console.log(`\nPOOLED ALTS: n=${g.length} avg=${mean(g).toFixed(3)} net@.09=${net(COST)} +slip.1=${net(0.19)} +slip.2=${net(0.29)} Kelly=${kelly(g.map((x) => x - COST))} p=${pFixed(g, COST).toFixed(3)}`);
  console.log(`direction: follow-PUMP long avg ${mean(lg).toFixed(3)} (n=${lg.length}) · follow-CRASH short avg ${mean(sh).toFixed(3)} (n=${sh.length})`);
})().catch((e) => { console.error(e); process.exit(1); });
