/**
 * BIG INDICATOR/SIGNAL SWEEP — 1-15m, the classic indicators NOT yet swept systematically, each in
 * MR + momentum form. LOWER bar per operator: report ANY genuine HOOK (net>0 after cost, IS/OOS both
 * positive — single-coin OK), and surface MONEY-MANAGEMENT metrics (Kelly fraction ≈ μ/σ², expectancy,
 * Sharpe) so a marginal-but-real edge that sizing can pull into a viable book isn't discarded. Honest:
 * sizing amplifies a real edge, it can't rescue a negative one — so the hook must clear cost + OOS.
 * Run on the VPS. pnpm tsx scripts/sweep-indicators.ts [days]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { sma, ema, atr, rsi, rollingStd, type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 320);
const TK = 0.07;

// ── extra indicators (not in indicators.ts) ───────────────────────────────
function stochK(c: Candle[], p: number): number[] { const o = new Array<number>(c.length).fill(50); for (let i = p - 1; i < c.length; i++) { let hi = -Infinity, lo = Infinity; for (let j = i - p + 1; j <= i; j++) { hi = Math.max(hi, c[j]!.h); lo = Math.min(lo, c[j]!.l); } o[i] = hi > lo ? ((c[i]!.c - lo) / (hi - lo)) * 100 : 50; } return o; }
function cci(c: Candle[], p: number): number[] { const tp = c.map((x) => (x.h + x.l + x.c) / 3); const m = sma(tp, p); const o = new Array<number>(c.length).fill(0); for (let i = p - 1; i < c.length; i++) { let md = 0; for (let j = i - p + 1; j <= i; j++) md += Math.abs(tp[j]! - m[i]!); md /= p; o[i] = md > 0 ? (tp[i]! - m[i]!) / (0.015 * md) : 0; } return o; }
function roc(c: Candle[], p: number): number[] { const o = new Array<number>(c.length).fill(0); for (let i = p; i < c.length; i++) o[i] = (c[i]!.c / c[i - p]!.c - 1) * 100; return o; }
function willR(c: Candle[], p: number): number[] { const o = new Array<number>(c.length).fill(-50); for (let i = p - 1; i < c.length; i++) { let hi = -Infinity, lo = Infinity; for (let j = i - p + 1; j <= i; j++) { hi = Math.max(hi, c[j]!.h); lo = Math.min(lo, c[j]!.l); } o[i] = hi > lo ? ((hi - c[i]!.c) / (hi - lo)) * -100 : -50; } return o; }
function mfi(c: Candle[], p: number): number[] { const tp = c.map((x) => (x.h + x.l + x.c) / 3); const o = new Array<number>(c.length).fill(50); for (let i = p; i < c.length; i++) { let pos = 0, neg = 0; for (let j = i - p + 1; j <= i; j++) { const mf = tp[j]! * c[j]!.v; if (tp[j]! > tp[j - 1]!) pos += mf; else neg += mf; } o[i] = neg > 0 ? 100 - 100 / (1 + pos / neg) : 100; } return o; }
function sessionVwapDev(c: Candle[]): number[] { const o = new Array<number>(c.length).fill(0); let day = -1, pv = 0, vv = 0; for (let i = 0; i < c.length; i++) { const d = Math.floor(c[i]!.t / 86_400_000); if (d !== day) { day = d; pv = 0; vv = 0; } const tp = (c[i]!.h + c[i]!.l + c[i]!.c) / 3; pv += tp * c[i]!.v; vv += c[i]!.v; const vwap = vv > 0 ? pv / vv : c[i]!.c; o[i] = (c[i]!.c - vwap) / vwap; } return o; }

type Bundle = { c: Candle[]; rsi: number[]; ef: number[]; es: number[]; bbU: number[]; bbL: number[]; sd: number[]; m20: number[]; stoch: number[]; macd: number[]; macdSig: number[]; cci: number[]; roc: number[]; willR: number[]; mfi: number[]; vwapDev: number[]; st: number[] };
function build(c: Candle[]): Bundle {
  const close = c.map((x) => x.c);
  const m20 = sma(close, 20); const sd = rollingStd(close, 20);
  const bbU = m20.map((m, i) => m + 2 * sd[i]!); const bbL = m20.map((m, i) => m - 2 * sd[i]!);
  const e12 = ema(close, 12), e26 = ema(close, 26); const macd = e12.map((x, i) => x - e26[i]!); const macdSig = ema(macd, 9);
  const a = atr(c, 10); const st = c.map((x, i) => x.c - 2 * a[i]!); // simple supertrend-ish lower band
  return { c, rsi: rsi(c, 14), ef: ema(close, 9), es: ema(close, 21), bbU, bbL, sd, m20, stoch: stochK(c, 14), macd, macdSig, cci: cci(c, 20), roc: roc(c, 10), willR: willR(c, 14), mfi: mfi(c, 14), vwapDev: sessionVwapDev(c), st };
}

type Ev = { i: number; side: 1 | -1 };
type SigDef = { name: string; gen: (B: Bundle) => Ev[] };
const SIGS: SigDef[] = [
  { name: 'rsiMR', gen: (B) => evs(B, (i) => (B.rsi[i]! < 30 ? 1 : B.rsi[i]! > 70 ? -1 : 0)) },
  { name: 'rsiMom', gen: (B) => evs(B, (i) => (B.rsi[i - 1]! < 50 && B.rsi[i]! >= 50 ? 1 : B.rsi[i - 1]! > 50 && B.rsi[i]! <= 50 ? -1 : 0)) },
  { name: 'bbMR', gen: (B) => evs(B, (i) => (B.c[i]!.c < B.bbL[i]! ? 1 : B.c[i]!.c > B.bbU[i]! ? -1 : 0)) },
  { name: 'bbBreak', gen: (B) => evs(B, (i) => (B.c[i]!.c > B.bbU[i]! ? 1 : B.c[i]!.c < B.bbL[i]! ? -1 : 0)) },
  { name: 'stochMR', gen: (B) => evs(B, (i) => (B.stoch[i]! < 20 ? 1 : B.stoch[i]! > 80 ? -1 : 0)) },
  { name: 'macdCross', gen: (B) => evs(B, (i) => (B.macd[i - 1]! < B.macdSig[i - 1]! && B.macd[i]! >= B.macdSig[i]! ? 1 : B.macd[i - 1]! > B.macdSig[i - 1]! && B.macd[i]! <= B.macdSig[i]! ? -1 : 0)) },
  { name: 'emaCross', gen: (B) => evs(B, (i) => (B.ef[i - 1]! < B.es[i - 1]! && B.ef[i]! >= B.es[i]! ? 1 : B.ef[i - 1]! > B.es[i - 1]! && B.ef[i]! <= B.es[i]! ? -1 : 0)) },
  { name: 'cciMR', gen: (B) => evs(B, (i) => (B.cci[i]! < -150 ? 1 : B.cci[i]! > 150 ? -1 : 0)) },
  { name: 'cciMom', gen: (B) => evs(B, (i) => (B.cci[i - 1]! < 100 && B.cci[i]! >= 100 ? 1 : B.cci[i - 1]! > -100 && B.cci[i]! <= -100 ? -1 : 0)) },
  { name: 'willMR', gen: (B) => evs(B, (i) => (B.willR[i]! < -80 ? 1 : B.willR[i]! > -20 ? -1 : 0)) },
  { name: 'mfiMR', gen: (B) => evs(B, (i) => (B.mfi[i]! < 20 ? 1 : B.mfi[i]! > 80 ? -1 : 0)) },
  { name: 'rocMom', gen: (B) => evs(B, (i) => (B.roc[i]! > 1.5 ? 1 : B.roc[i]! < -1.5 ? -1 : 0)) },
  { name: 'vwapMR', gen: (B) => evs(B, (i) => (B.vwapDev[i]! < -0.012 ? 1 : B.vwapDev[i]! > 0.012 ? -1 : 0)) },
  { name: 'stochBBconf', gen: (B) => evs(B, (i) => (B.stoch[i]! < 20 && B.c[i]!.c < B.bbL[i]! ? 1 : B.stoch[i]! > 80 && B.c[i]!.c > B.bbU[i]! ? -1 : 0)) }, // confluence
];
function evs(B: Bundle, rule: (i: number) => 1 | -1 | 0): Ev[] { const out: Ev[] = []; for (let i = 30; i < B.c.length - 1; i++) { const s = rule(i); if (s !== 0) out.push({ i, side: s }); } return out; }

/** backtest events with target/SL/time-stop, NET % per trade (taker RT). */
function bt(c: Candle[], evList: Ev[], tgt: number, sl: number, hold: number): number[] {
  const out: number[] = []; const n = c.length; let guard = -1;
  for (const e of evList) {
    if (e.i <= guard) continue;
    const entry = c[e.i]!.c; const side = e.side;
    const tgtPx = side === 1 ? entry * (1 + tgt) : entry * (1 - tgt);
    const slPx = side === 1 ? entry * (1 - sl) : entry * (1 + sl);
    let exit = 0; const kmax = Math.min(n - 1, e.i + hold); let k = e.i + 1;
    for (; k <= kmax; k++) { if (side === 1 ? c[k]!.l <= slPx : c[k]!.h >= slPx) { exit = slPx; break; } if (side === 1 ? c[k]!.h >= tgtPx : c[k]!.l <= tgtPx) { exit = tgtPx; break; } }
    if (exit === 0) exit = c[kmax]!.c;
    out.push((side === 1 ? (exit - entry) / entry : (entry - exit) / entry) * 100 - TK);
    guard = kmax;
  }
  return out;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function net(r: number[], e = 0) { return Math.round(r.reduce((s, x) => s + x - e, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }
function kelly(r: number[]) { const m = mean(r); const v = mean(r.map((x) => (x - m) ** 2)); return v > 0 ? Math.round((m / v) * 100) / 100 : 0; } // Kelly fraction ≈ μ/σ² (per-trade, %-units)
function sharpe(r: number[]) { const m = mean(r); const sd = Math.sqrt(mean(r.map((x) => (x - m) ** 2))); return sd > 0 ? Math.round((m / sd) * 100) / 100 : 0; }

type Row = { sig: string; coin: string; tf: string; n: number; net: number; net2: number; pf: number; wr: number; exp: number; kelly: number; sharpe: number; isN: number; oosN: number; folds: number; hook: boolean };

(async () => {
  const rows: Row[] = [];
  const TFS = ['5', '15']; const HOLDS = [6, 12]; const TGT = 0.006; const SL = 0.012;
  console.log(`INDICATOR SWEEP · ${SIGS.length} signals × ${TFS.length}tf × ${HOLDS.length}hold × ${SYMBOLS.length} coins · ${DAYS}d · HL taker ${TK}% · LOWER bar (hook = net2>0 + IS/OOS+ + folds≥3, single-coin OK)\n`);
  for (const tf of TFS) {
    for (const sym of SYMBOLS) {
      let c: Candle[]; try { c = await getKlines(sym, tf, NOW - DAYS * 86_400_000, NOW); } catch { continue; }
      if (c.length < 800) continue;
      const B = build(c);
      for (const sd of SIGS) {
        const ev = sd.gen(B);
        for (const hold of HOLDS) {
          const r = bt(c, ev, TGT, SL, hold);
          if (r.length < 25) continue;
          const cut = Math.floor(r.length * 0.7); const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
          const n2 = net(r, TK);
          const hook = r.length >= 30 && net(r) > 0 && n2 > 0 && pf(r) > 1.1 && isN > 0 && oosN > 0 && f >= 3 && kelly(r) > 0;
          rows.push({ sig: `${sd.name}-${tf}h${hold}`, coin: sym.replace('USDT', ''), tf, n: r.length, net: net(r), net2: n2, pf: pf(r), wr: wr(r), exp: Math.round(mean(r) * 1000) / 1000, kelly: kelly(r), sharpe: sharpe(r), isN, oosN, folds: f, hook });
        }
      }
    }
  }
  writeFileSync('data/indicator-sweep-results.json', JSON.stringify(rows, null, 2));
  const hooks = rows.filter((r) => r.hook).sort((a, b) => b.kelly * b.net2 - a.kelly * a.net2);
  console.log(`===== HOOKS (real edge after cost + IS/OOS+, sortable by money-mgmt) — ${hooks.length} found =====`);
  console.log('   coin  sig                 N    net  +cost   PF  WR%  exp%/tr  KELLY  Sharpe  IS/OOS');
  for (const r of hooks.slice(0, 30)) console.log(`✅ ${r.coin.padEnd(5)} ${r.sig.padEnd(18)} ${String(r.n).padStart(4)} ${String(r.net).padStart(6)} ${String(r.net2).padStart(6)} ${String(r.pf).padStart(4)} ${String(r.wr).padStart(3)} ${String(r.exp).padStart(7)} ${String(r.kelly).padStart(6)} ${String(r.sharpe).padStart(6)}  ${r.isN}/${r.oosN}`);
  // cross-symbol robustness among hooks (how many coins per signature)
  const bySig = new Map<string, string[]>(); for (const r of hooks) { const a = bySig.get(r.sig.replace(/-.*/, '')) ?? []; a.push(r.coin); bySig.set(r.sig.replace(/-.*/, ''), a); }
  const multi = [...bySig.entries()].map(([s, cs]) => ({ s, n: new Set(cs).size, coins: [...new Set(cs)].sort() })).filter((x) => x.n >= 3).sort((a, b) => b.n - a.n);
  console.log(`\n===== signals with hooks on ≥3 coins (broader) =====`);
  console.log(multi.length ? multi.map((x) => `  ${x.s}: ${x.n} coins {${x.coins.join(',')}}`).join('\n') : '  — none on ≥3 coins —');
  console.log(`\n(${hooks.length} hooks / ${rows.length} tested. KELLY = per-trade μ/σ² fraction; exp% = mean net per trade.) Full → data/indicator-sweep-results.json`);
})().catch((e) => { console.error(e); process.exit(1); });
