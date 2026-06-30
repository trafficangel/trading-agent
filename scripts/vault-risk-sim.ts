/**
 * VAULT RISK-LAYER SIM — design the VAULT-READY book on data, not blind. Reconstructs the trade streams
 * of BOTH edges (wick-fade deep-dislocation + funding-flip OI-gated) with timestamps, builds a DAILY
 * portfolio equity curve, and compares sizing schemes at the SAME risk budget (each scheme scaled to 15%
 * annualized vol — so maxDD/Calmar are apples-to-apples: which delivers more return + smoother curve per
 * unit of risk?). Goal = max Calmar (return/maxDD) + small correlated-tail, NOT max %.
 *
 * Schemes: flat-equal · risk-parity (1/vol) · risk-parity + CORR-CAP (cap a day's gross when many coins
 * fire together — the correlated-alt-flush tail). Edge sets: wick-only / flip-only / BLEND.
 * Run on the VPS (needs hl_micro funding + bybit_micro OI): pnpm tsx scripts/vault-risk-sim.ts [days]
 */
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned, loadBybitAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const WICK = [{ c: 'DOGE', x: 0.03 }, { c: 'ICP', x: 0.03 }, { c: 'NEAR', x: 0.03 }, { c: 'ATOM', x: 0.03 }, { c: 'TON', x: 0.02 }, { c: 'CRV', x: 0.03 }, { c: 'ENA', x: 0.03 }, { c: 'TIA', x: 0.03 }, { c: 'kPEPE', x: 0.03 }];
const FLIP = ['ETH', 'ADA', 'XRP', 'AVAX'];
const DAYS = Number(process.argv[2] ?? 360);
const NOW = Date.now();
const TGT_VOL = 0.15; // annualized vol budget all schemes are scaled to
const DAYMS = 86_400_000;
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const std = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };

type Trade = { ts: number; coin: string; pnl: number };

// ── WICK-FADE deep-dislocation fade (5m): rest ±X, fill on touch, fade to mid, exit target/time/stop ──
const W_RT = 0.10, W_HF = 6, W_EX = 12, W_STOP = 0.03;
function wickTrades(coin: string, x: number, c: Candle[]): Trade[] {
  const n = c.length; const out: Trade[] = []; let guard = -1;
  for (let i = 50; i < n - W_EX - W_HF - 1; i++) {
    if (i <= guard) continue; const mid = c[i]!.c;
    for (const side of [1, -1] as const) {
      const lim = side === 1 ? mid * (1 - x) : mid * (1 + x);
      let fb = -1; for (let j = i + 1; j <= i + W_HF; j++) { if (side === 1 ? c[j]!.l <= lim : c[j]!.h >= lim) { fb = j; break; } }
      if (fb < 0) continue;
      const tgt = mid, stp = side === 1 ? lim * (1 - W_STOP) : lim * (1 + W_STOP);
      let ex = c[Math.min(n - 1, fb + W_EX)]!.c;
      for (let j = fb + 1; j <= Math.min(n - 1, fb + W_EX); j++) { if (side === 1 ? c[j]!.l <= stp : c[j]!.h >= stp) { ex = stp; break; } if (side === 1 ? c[j]!.h >= tgt : c[j]!.l <= tgt) { ex = tgt; break; } }
      out.push({ ts: c[fb]!.t, coin, pnl: (side === 1 ? (ex - lim) / lim : (lim - ex) / lim) * 100 - W_RT });
      guard = fb + 1;
    }
  }
  return out;
}

// ── FUNDING-FLIP (1h, gated): |z|>=2 within fw then sign-flip, gate OI-ROC(12h)>0, 24h hold ──
const F_W = 360, F_Z = 2, F_FW = 6, F_HOLD = 24, F_RT = 0.07;
function rollMS(a: (number | null)[], i: number, W: number) { let s = 0, ss = 0, k = 0; for (let j = Math.max(0, i - W + 1); j <= i; j++) { const v = a[j]; if (v != null) { s += v; ss += v * v; k++; } } if (k < W / 2) return { m: 0, sd: 0 }; const m = s / k; return { m, sd: Math.sqrt(Math.max(0, ss / k - m * m)) }; }
function flipTrades(coin: string, c: Candle[], f: (number | null)[], oi: (number | null)[]): Trade[] {
  const n = c.length; const out: Trade[] = []; let guard = -1;
  for (let i = F_W; i < n - 1; i++) {
    if (i <= guard) continue; const { m, sd } = rollMS(f, i, F_W); if (!(sd > 0)) continue;
    const pw = f.slice(Math.max(0, i - F_FW - 1), i);
    const wasPos = pw.some((v) => v != null && (v - m) / sd >= F_Z), wasNeg = pw.some((v) => v != null && (v - m) / sd <= -F_Z);
    const now = f[i], prev = f[i - 1]; if (now == null || prev == null) continue;
    let side: 1 | -1 | 0 = 0; if (wasPos && prev > 0 && now <= 0) side = 1; else if (wasNeg && prev < 0 && now >= 0) side = -1;
    if (side === 0) continue;
    const roc = oi[i] != null && oi[i - 12] != null && oi[i - 12]! !== 0 ? (oi[i]! - oi[i - 12]!) / Math.abs(oi[i - 12]!) : null;
    if (roc == null || roc <= 0) continue; // OI-build-up gate
    const e = c[i]!.c, xp = c[Math.min(n - 1, i + F_HOLD)]!.c;
    out.push({ ts: c[i]!.t, coin, pnl: (side === 1 ? (xp - e) / e : (e - xp) / e) * 100 - F_RT });
    guard = i + F_HOLD;
  }
  return out;
}

function metrics(daily: number[]): { ann: number; sharpe: number; maxdd: number; calmar: number; worst: number; downPct: number } {
  if (daily.length < 10) return { ann: 0, sharpe: 0, maxdd: 0, calmar: 0, worst: 0, downPct: 0 };
  const sd = std(daily); const scale = sd > 0 ? (TGT_VOL / (sd * Math.sqrt(365))) : 0; // normalize to TGT_VOL annualized
  const r = daily.map((d) => d * scale);
  let eq = 0, peak = 0, dd = 0; for (const x of r) { eq += x; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  const ann = mean(r) * 365, sh = std(r) > 0 ? mean(r) / std(r) * Math.sqrt(365) : 0;
  return { ann: Math.round(ann * 10) / 10, sharpe: Math.round(sh * 100) / 100, maxdd: Math.round(dd * 10) / 10, calmar: dd < 0 ? Math.round(ann / -dd * 100) / 100 : 99, worst: Math.round(Math.min(...r) * 100) / 100, downPct: Math.round(r.filter((x) => x < 0).length / r.length * 100) };
}

/** build daily portfolio return series for a trade set under a sizing scheme (coin weights + corr-cap). */
function dailySeries(trades: Trade[], coinW: Record<string, number>, corrCap: number | null): number[] {
  const byDay = new Map<number, Trade[]>();
  for (const t of trades) { const d = Math.floor(t.ts / DAYMS); const a = byDay.get(d); if (a) a.push(t); else byDay.set(d, [t]); }
  const days = [...byDay.keys()].sort((a, b) => a - b); if (!days.length) return [];
  const out: number[] = [];
  for (let d = days[0]!; d <= days[days.length - 1]!; d++) {
    const ts = byDay.get(d) ?? [];
    let gross = 0, pnl = 0;
    for (const t of ts) { const w = coinW[t.coin] ?? 1; gross += w; pnl += w * t.pnl; }
    if (corrCap != null && gross > corrCap && gross > 0) pnl *= corrCap / gross; // cap a day's correlated gross
    out.push(pnl);
  }
  return out;
}

(async () => {
  console.log(`VAULT RISK-LAYER SIM · ${DAYS}d · all schemes scaled to ${TGT_VOL * 100}% ann vol · goal = max Calmar + small worst-day\n`);
  const wick: Trade[] = [], flip: Trade[] = [];
  for (const w of WICK) { try { const c = await getKlines(`${w.c}USDT`, '5', NOW - DAYS * DAYMS, NOW); if (c.length > 800) wick.push(...wickTrades(w.c, w.x, c)); } catch { /* skip */ } }
  for (const coin of FLIP) { try { const c = await getKlines(`${coin}USDT`, '60', NOW - DAYS * DAYMS, NOW); const f = loadMicroAligned(coin, '60', c).funding; const oi = loadBybitAligned(coin, '60', c).oi; if (c.length > 500) flip.push(...flipTrades(coin, c, f, oi)); } catch { /* skip */ } }
  const blend = [...wick, ...flip];
  process.stderr.write(`  wick trades ${wick.length} · flip trades ${flip.length}\n`);

  const allCoins = [...new Set(blend.map((t) => t.coin))];
  const coinStd: Record<string, number> = {}; for (const c of allCoins) coinStd[c] = std(blend.filter((t) => t.coin === c).map((t) => t.pnl)) || 1;
  const flatW: Record<string, number> = {}; for (const c of allCoins) flatW[c] = 1;
  const rpW: Record<string, number> = {}; for (const c of allCoins) rpW[c] = 1 / coinStd[c]!;

  const sets: [string, Trade[]][] = [['wick-only', wick], ['flip-only', flip], ['BLEND', blend]];
  const schemes: [string, Record<string, number>, number | null][] = [
    ['flat-equal', flatW, null],
    ['risk-parity', rpW, null],
    ['risk-parity+corr-cap', rpW, 3 * mean(Object.values(rpW))],
  ];
  console.log('edge-set    scheme                  annRet%  Sharpe  maxDD%  Calmar  worstDay%  down%');
  for (const [sn, st] of sets) for (const [scn, w, cap] of schemes) {
    const m = metrics(dailySeries(st, w, cap));
    console.log(`${sn.padEnd(11)} ${scn.padEnd(22)} ${String(m.ann).padStart(6)}  ${String(m.sharpe).padStart(5)}  ${String(m.maxdd).padStart(6)}  ${String(m.calmar).padStart(5)}  ${String(m.worst).padStart(7)}   ${m.downPct}`);
  }
  console.log('\nREAD: same 15% vol budget for all → higher Calmar + smaller |worstDay| = SMOOTHER (vault-ready).');
  console.log('  Expect BLEND > each-alone (two ~uncorrelated edges) and corr-cap to shrink the worst-day tail.');
})().catch((e) => { console.error(e); process.exit(1); });
