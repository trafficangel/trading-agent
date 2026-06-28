/**
 * FACTOR-RESIDUAL MEAN-REVERSION (workflow rank-1, "last untested fast families") — trade the
 * IDIOSYNCRATIC residual of an alt vs a 2-factor (BTC+ETH) fair value, NOT price-vs-its-own-mean
 * (dead) and NOT the single-BTC ratio (dead: its residual was mostly common ETH noise). Removing
 * the common BTC+ETH move leaves a small, genuinely alt-specific residual whose ≥2.5σ excursions are
 * mechanical liquidity air-pockets / lagged catch-up → mean-revert.
 *
 * PERSIST thesis (the bar VPIN failed): regime-NEUTRAL (common move stripped → signal doesn't flip
 * with the trend), and edge scales with cross-sectional DISPERSION — which was HIGH in the recent
 * window that killed price-MR/VPIN. So the mechanism is fed, not starved, by that regime.
 *
 * Incremental EWMA-OLS (causal: betas + residual at bar i use only data ≤ i; enter close[i]). Exit =
 * z reverts through exitZ OR maxHold time-stop OR |z|≥stopZ de-cointegration cut. Half-life exit
 * LOCKED (not swept) per the overfit guard. CROSS-WINDOW lens: 3 independent 180d windows, KEEP per
 * window = N≥30 · net>0 @real 0.07% (and a 2× fee = 0.14% stress) · perm-null p<0.05 · Kelly>0;
 * ROBUST = KEEP in ≥2/3. Run on the VPS: pnpm tsx scripts/factor-residual-mr.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const ALTS = ['SOL', 'BNB', 'XRP', 'ADA', 'LTC', 'LINK', 'DOGE', 'AVAX'];
const TF = String(process.argv[2] ?? '5');
const WIN_DAYS = 180;
const WINDOWS = [0, 180, 360];
const K = 20;
const COST = 0.07;
const HL_BETA = 200, HL_STD = 40, MAXHOLD = 12, STOPZ = 4; // LOCKED exit/estimator params (overfit guard)
const aBeta = 1 - Math.pow(0.5, 1 / HL_BETA), aStd = 1 - Math.pow(0.5, 1 / HL_STD);

const mean = (r: number[]) => r.length ? r.reduce((s, x) => s + x, 0) / r.length : 0;
const sd = (r: number[]) => { if (r.length < 2) return 0; const m = mean(r); return Math.sqrt(r.reduce((s, x) => s + (x - m) * (x - m), 0) / (r.length - 1)); };
const kelly = (r: number[]) => { const m = mean(r) / 100, s = sd(r) / 100; return s > 0 ? m / (s * s) : 0; };

/** causal standardized residual z[i] of logAlt vs EWMA-OLS on (logBTC, logETH). z[i]=null until warm. */
function residualZ(alt: number[], btc: number[], eth: number[]): (number | null)[] {
  const n = alt.length; const z: (number | null)[] = Array(n).fill(null);
  // EWMA accumulators for the centered 2-factor normal equations
  let mB = 0, mE = 0, mA = 0, sBB = 0, sEE = 0, sBE = 0, sBA = 0, sEA = 0, mErr = 0, vErr = 0; let warm = 0;
  for (let i = 0; i < n; i++) {
    const lB = Math.log(btc[i]!), lE = Math.log(eth[i]!), lA = Math.log(alt[i]!);
    if (i === 0) { mB = lB; mE = lE; mA = lA; warm++; continue; }
    mB += aBeta * (lB - mB); mE += aBeta * (lE - mE); mA += aBeta * (lA - mA);
    const dB = lB - mB, dE = lE - mE, dA = lA - mA;
    sBB += aBeta * (dB * dB - sBB); sEE += aBeta * (dE * dE - sEE); sBE += aBeta * (dB * dE - sBE);
    sBA += aBeta * (dB * dA - sBA); sEA += aBeta * (dE * dA - sEA);
    warm++;
    const det = sBB * sEE - sBE * sBE;
    if (warm < HL_BETA || !(Math.abs(det) > 1e-12)) continue;
    const bB = (sBA * sEE - sEA * sBE) / det; const bE = (sEA * sBB - sBA * sBE) / det;
    const a0 = mA - bB * mB - bE * mE;
    const err = lA - (a0 + bB * lB + bE * lE); // residual at bar i (uses only ≤ i)
    // EWMA mean/var of residual for standardization
    mErr += aStd * (err - mErr); vErr += aStd * ((err - mErr) * (err - mErr) - vErr);
    const sdErr = Math.sqrt(Math.max(1e-18, vErr));
    if (warm >= HL_BETA + HL_STD && sdErr > 0) z[i] = (err - mErr) / sdErr;
  }
  return z;
}

type Cfg = { entryZ: number; exitZ: number };
const CFGS: Cfg[] = [];
for (const entryZ of [2.5, 3.0]) for (const exitZ of [0.0, 0.5]) CFGS.push({ entryZ, exitZ });

/** trades (net%) — long when z≤−entryZ, short when z≥+entryZ; exit z-revert/time/stop. shift = null. */
function run(c: Candle[], z: (number | null)[], cfg: Cfg, cost: number, shift = 0): number[] {
  const n = c.length; const out: number[] = []; let i = 0;
  const zS = shift ? z.map((_, k) => z[((k + shift) % n + n) % n]!) : z;
  while (i < n - 1) {
    const zi = zS[i]; if (zi == null || Math.abs(zi) < cfg.entryZ) { i++; continue; }
    const side: 1 | -1 = zi <= -cfg.entryZ ? 1 : -1;
    const entry = c[i]!.c; let j = i + 1; let exit = c[n - 1]!.c;
    for (; j < n && j <= i + MAXHOLD; j++) {
      const zj = zS[j];
      if (zj != null && (side === 1 ? zj >= -cfg.exitZ : zj <= cfg.exitZ)) { exit = c[j]!.c; break; } // reverted
      if (zj != null && (side === 1 ? zj <= -STOPZ : zj >= STOPZ)) { exit = c[j]!.c; break; }            // de-cointegration cut
      exit = c[j]!.c;
    }
    out.push((side === 1 ? (exit - entry) / entry : (entry - exit) / entry) * 100 - cost);
    i = Math.min(j, i + MAXHOLD) + 1; // no overlap
  }
  return out;
}

(async () => {
  console.log(`FACTOR-RESIDUAL MR (alt ~ BTC+ETH) · ${TF}m · 3×${WIN_DAYS}d · cross-window persistence · real ${COST}% (+2× stress)\n`);
  type Wr = { net: number; net2: number; n: number; nullP: number; keep: boolean };
  type Res = { coin: string; cfg: string; w: Wr[]; persist: number; tot: number };
  const results: Res[] = [];
  for (const coin of ALTS) {
    for (const cfg of CFGS) {
      const w: Wr[] = [];
      for (const off of WINDOWS) {
        const end = Date.now() - off * 86_400_000; const from = end - WIN_DAYS * 86_400_000;
        let alt: Candle[], btcC: Candle[], ethC: Candle[];
        try { alt = await getKlines(`${coin}USDT`, TF, from, end); btcC = await getKlines('BTCUSDT', TF, from, end); ethC = await getKlines('ETHUSDT', TF, from, end); }
        catch { w.push({ net: 0, net2: 0, n: 0, nullP: 1, keep: false }); continue; }
        const bMap = new Map(btcC.map((k) => [k.t, k.c])); const eMap = new Map(ethC.map((k) => [k.t, k.c]));
        const rows = alt.filter((k) => bMap.has(k.t) && eMap.has(k.t));
        if (rows.length < 600) { w.push({ net: 0, net2: 0, n: 0, nullP: 1, keep: false }); continue; }
        const z = residualZ(rows.map((k) => k.c), rows.map((k) => bMap.get(k.t)!), rows.map((k) => eMap.get(k.t)!));
        const r = run(rows, z, cfg, COST);
        if (r.length < 30) { w.push({ net: 0, net2: 0, n: r.length, nullP: 1, keep: false }); continue; }
        const realNet = mean(r) * r.length; const r2 = run(rows, z, cfg, 2 * COST);
        let nullP = 1;
        if (realNet > 0 && kelly(r) > 0) { let ge = 0; for (let s = 0; s < K; s++) { const sh = Math.floor((rows.length * (s + 1)) / (K + 1)) + 43 * (s + 1); const rn = run(rows, z, cfg, COST, sh); ge += (mean(rn) * rn.length >= realNet) ? 1 : 0; } nullP = ge / K; }
        const keep = r.length >= 30 && realNet > 0 && mean(r2) * r2.length > 0 && nullP < 0.05 && kelly(r) > 0;
        w.push({ net: Math.round(realNet * 10) / 10, net2: Math.round(mean(r2) * r2.length * 10) / 10, n: r.length, nullP, keep });
      }
      const persist = w.filter((x) => x.keep).length;
      results.push({ coin, cfg: `eZ${cfg.entryZ}xZ${cfg.exitZ}`, w, persist, tot: w.reduce((s, x) => s + x.net, 0) });
    }
    process.stderr.write(`  ${coin} done\n`);
  }
  results.sort((a, b) => b.persist - a.persist || b.tot - a.tot);
  const robust = results.filter((r) => r.persist >= 2);
  console.log(`===== ROBUST: KEEP in ≥2/3 windows (real-not-lottery) — ${robust.length} =====`);
  const fmt = (r: Res) => `${r.persist}/3 ${r.coin.padEnd(5)} ${r.cfg.padEnd(10)} W0[net ${String(r.w[0]!.net).padStart(6)} +2x ${String(r.w[0]!.net2).padStart(6)} N${r.w[0]!.n} p${r.w[0]!.nullP.toFixed(2)}] W1[${String(r.w[1]!.net).padStart(6)} p${r.w[1]!.nullP.toFixed(2)}] W2[${String(r.w[2]!.net).padStart(6)} p${r.w[2]!.nullP.toFixed(2)}]`;
  console.log(robust.length ? robust.map(fmt).join('\n') : '  — none persist across windows —');
  console.log(`\ncontext — top 8 by total net (incl. persist<2):\n${results.slice(0, 8).map(fmt).join('\n')}`);
})().catch((e) => { console.error(e); process.exit(1); });
