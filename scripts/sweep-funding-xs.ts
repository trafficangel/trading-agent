/**
 * FUNDING CROSS-SECTION (dollar-neutral) — the genuinely-untested funding angle. The funding SIGNAL
 * is verified (funding-flip is live in testnet), but only DIRECTIONALLY per-coin. This is the
 * market-neutral panel version: each rebalance, rank the 10 coins by per-coin funding z-score, take
 * a dollar-neutral long/short spread on the extremes — panel beta (which sank every directional bet)
 * cancels, harvesting only the relative positioning signal. Rebalance every H hours (faster than the
 * 24h flip), settled funding from hl_micro + 1h klines for returns. A/B reversion (short the crowded)
 * vs momentum (follow), placebo (shuffle funding → must die), 2 windows, cost-stress x2/x3.
 * Run on the VPS. pnpm tsx scripts/sweep-funding-xs.ts [days] [endOffset]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const END_OFFSET = Number(process.argv[3] ?? 0);
const NOW = Date.now() - END_OFFSET * 86_400_000;
const DAYS = Number(process.argv[2] ?? 320);
const FEE_RT = 0.07; // HL taker RT % per leg per rebalance
const PLACEBO = process.env.PLACEBO === '1';
const HR = 3_600_000;

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function net(r: number[], e = 0) { return Math.round(r.reduce((s, x) => s + x - e, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function sharpe(r: number[]) { if (r.length < 2) return 0; const m = mean(r); const sd = Math.sqrt(mean(r.map((x) => (x - m) ** 2))); return sd > 0 ? Math.round((m / sd) * 100) / 100 : 0; }
function dd(r: number[]) { let c = 0, p = 0, d = 0; for (const x of r) { c += x; if (c > p) p = c; if (p - c > d) d = p - c; } return Math.round(d * 10) / 10; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }

type Cfg = { sig: string; W: number; H: number; k: number; follow: boolean };
const CFGS: Cfg[] = [];
for (const W of [240, 480]) for (const H of [4, 8]) for (const k of [2, 3]) for (const follow of [false, true])
  CFGS.push({ sig: `W${W}H${H}k${k}${follow ? '_F' : '_R'}`, W, H, k, follow });

type Aligned = { ts: number[]; close: number[][]; fund: (number | null)[][] }; // [t][coin]

async function buildPanel(): Promise<Aligned> {
  const maps: Map<number, { c: number; f: number | null }>[] = [];
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    const candles: Candle[] = await getKlines(sym, '60', NOW - DAYS * 86_400_000, NOW);
    const fa = loadMicroAligned(coin, '60', candles).funding;
    const mp = new Map<number, { c: number; f: number | null }>();
    for (let i = 0; i < candles.length; i++) mp.set(candles[i]!.t, { c: candles[i]!.c, f: fa[i] ?? null });
    maps.push(mp);
  }
  const spine = [...maps[0]!.keys()].filter((ts) => maps.every((mp) => mp.has(ts))).sort((a, b) => a - b);
  const close: number[][] = []; const fund: (number | null)[][] = [];
  for (const ts of spine) { close.push(maps.map((mp) => mp.get(ts)!.c)); fund.push(maps.map((mp) => mp.get(ts)!.f)); }
  // PLACEBO: circular-shift each coin's funding column → decorrelate from price; the edge must die.
  if (PLACEBO) { const n = spine.length; const sh = Math.floor(n / 2) + 137; for (let i = 0; i < n; i++) { const j = (i + sh) % n; close[i]; fund[i] = fund[i]!.map((_, c) => fund[j]![c]!); } }
  return { ts: spine, close, fund };
}

/** per-coin funding z over the trailing W bars at index t. */
function fundZ(P: Aligned, t: number, coin: number, W: number): number | null {
  let s = 0, ss = 0, nn = 0;
  for (let j = Math.max(0, t - W + 1); j <= t; j++) { const v = P.fund[j]![coin]; if (v != null) { s += v; ss += v * v; nn++; } }
  if (nn < W / 2) return null;
  const m = s / nn; const sd = Math.sqrt(Math.max(0, ss / nn - m * m));
  const cur = P.fund[t]![coin];
  return cur != null && sd > 0 ? (cur - m) / sd : null;
}

/** dollar-neutral spread net % per rebalance. reversion: long lowest-z / short highest-z. */
function run(P: Aligned, cfg: Cfg): number[] {
  const N = P.ts.length; const nc = SYMBOLS.length; const out: number[] = [];
  for (let t = cfg.W; t + cfg.H < N; t += cfg.H) {
    const z: { i: number; z: number }[] = [];
    for (let i = 0; i < nc; i++) { const zi = fundZ(P, t, i, cfg.W); if (zi != null) z.push({ i, z: zi }); }
    if (z.length < 2 * cfg.k) continue;
    z.sort((a, b) => a.z - b.z);
    const lowZ = z.slice(0, cfg.k).map((x) => x.i);   // least crowded
    const highZ = z.slice(z.length - cfg.k).map((x) => x.i); // most crowded
    // reversion: long least-crowded, short most-crowded. follow(momentum): opposite.
    const longIdx = cfg.follow ? highZ : lowZ;
    const shortIdx = cfg.follow ? lowZ : highZ;
    const fwd = (i: number) => P.close[t + cfg.H]![i]! / P.close[t]![i]! - 1;
    const gross = (mean(longIdx.map(fwd)) - mean(shortIdx.map(fwd))) * 100;
    out.push(gross - 2 * FEE_RT);
  }
  return out;
}

type Row = { sig: string; follow: boolean; n: number; net: number; net2: number; net3: number; pf: number; wr: number; sharpe: number; dd: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  console.log(`FUNDING CROSS-SECTION · ${SYMBOLS.length} coins · 1h · ${DAYS}d end ${END_OFFSET}d ago · dollar-neutral · cost ${2 * FEE_RT}%/rebal${PLACEBO ? ' · PLACEBO' : ''}\n`);
  const P = await buildPanel();
  const cov = P.fund.filter((row) => row.some((x) => x != null)).length / P.ts.length;
  console.log(`spine ${P.ts.length} 1h-bars (${(P.ts.length / 24).toFixed(0)}d), funding cov ${(cov * 100).toFixed(0)}%\n`);
  const rows: Row[] = [];
  for (const cfg of CFGS) {
    const r = run(P, cfg);
    if (r.length < 16) continue;
    const cut = Math.floor(r.length * 0.7);
    const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
    const green = r.length >= 20 && net(r) > 0 && pf(r) > 1.2 && isN > 0 && oosN > 0 && net(r, 2 * FEE_RT) > 0 && f >= 3;
    rows.push({ sig: cfg.sig, follow: cfg.follow, n: r.length, net: net(r), net2: net(r, 2 * FEE_RT), net3: net(r, 4 * FEE_RT), pf: pf(r), wr: wr(r), sharpe: sharpe(r), dd: dd(r), isN, oosN, folds: f, green });
  }
  writeFileSync('data/funding-xs-results.json', JSON.stringify(rows, null, 2));
  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.sig.padEnd(12)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(6)} +cost ${String(r.net2).padStart(6)} x3 ${String(r.net3).padStart(6)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% Sh ${String(r.sharpe).padStart(5)} DD-${String(r.dd).padStart(5)} f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  for (const [name, fl] of [['REVERSION (short crowded)', false], ['MOMENTUM (follow)', true]] as const) {
    const fr = rows.filter((r) => r.follow === fl).sort((a, b) => b.net2 - a.net2);
    console.log(`===== ${name} — ${fr.filter((r) => r.green).length}/${fr.length} green (incl. x2 cost) =====`);
    console.log(fr.map(line).join('\n') || '  — none —'); console.log('');
  }
  console.log('VERDICT: real edge = a PLATEAU of green configs surviving x2 cost + folds + IS/OOS, that DIES under PLACEBO. Full → data/funding-xs-results.json');
})().catch((e) => { console.error(e); process.exit(1); });
