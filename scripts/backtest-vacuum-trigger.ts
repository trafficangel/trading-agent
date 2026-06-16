/**
 * TRACK 2a — LIVE-TRIGGER TEST for the BNB+ADA maker-vacuum.
 *
 * HL's public WS has NO global live liquidation feed (trades carry no liq flag;
 * liquidations are per-user userEvents/userFills only). So we CANNOT populate
 * liq_vol live → the liq-triggered vacuum can't fire live as-designed. Question:
 * does the vacuum edge survive on a LIVE-AVAILABLE trigger — pure price velocity
 * (velThr over velBars, klines only) — without the liq_vol gate?
 *
 * A/B: trig='liq' (current: liq cascade + velThr) vs trig='vel' (velThr ALONE, no
 * liq). Same maker entry/exit, with the validated bigger TP {0.6,1.0,1.4%}. If
 * BNB+ADA stay green incl. +cost on 'vel' → forward-validation is trivial (price
 * velocity, no feed). If 'vel' degrades badly → the liq gate is load-bearing and we
 * need a live proxy (OI-drop, forward-collected). Pure kline + liq(for the liq arm).
 *
 * Run on the VPS. pnpm tsx scripts/backtest-vacuum-trigger.ts [days]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 180);
const MK = 0.02, TK = 0.045;
const FOCUS = new Set(['BNB', 'ADA']); // the 2-coin edge we're trying to take live

function rollMean(a: (number | null)[], W: number): number[] {
  const out = new Array<number>(a.length); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] ?? 0; if (i >= W) s -= a[i - W] ?? 0; out[i] = s / Math.min(i + 1, W); }
  return out;
}

type Cfg = { sig: string; trig: 'liq' | 'vel'; liqK: number; d: number; tgt: number; sl: number; ttl: number; hold: number; velBars: number; velThr: number; gap: number };
const CFGS: Cfg[] = [];
for (const trig of ['liq', 'vel'] as const)
  for (const liqK of [4, 6]) for (const d of [0.002, 0.004]) for (const tgt of [0.006, 0.010, 0.014]) for (const velThr of [0.005, 0.008]) {
    if (trig === 'vel' && liqK === 6) continue; // liqK irrelevant for vel — keep one copy
    CFGS.push({ sig: `${trig}_K${liqK}d${d}t${tgt}v${velThr}`, trig, liqK, d, tgt, sl: 0.015, ttl: 10, hold: 30, velBars: 3, velThr, gap: 5 });
  }

/** realized NET % per trade. trig='liq': liq cascade + velThr. trig='vel': velThr alone. */
function runVacuum(c: Candle[], liq: (number | null)[], cfg: Cfg): number[] {
  const liqAvg = cfg.trig === 'liq' ? rollMean(liq, 240) : [];
  const out: number[] = []; const n = c.length;
  let i = 250; let lastTrig = -999;
  while (i < n - 1) {
    if (cfg.trig === 'liq') {
      const lq = liq[i]; const la = liqAvg[i];
      if (lq == null || !(la! > 0) || lq < cfg.liqK * la!) { i++; continue; }
    } else {
      if (i - lastTrig < cfg.gap) { i++; continue; }   // min gap between velocity triggers (avoid re-firing the same flush)
    }
    const ref = c[i - cfg.velBars]; if (!ref) { i++; continue; }
    const down = (ref.c - c[i]!.c) / ref.c;
    const up = -down;
    let side: 1 | -1 | 0 = 0;
    if (down >= cfg.velThr) side = 1; else if (up >= cfg.velThr) side = -1;
    if (side === 0) { i++; continue; }
    if (cfg.trig === 'vel') lastTrig = i;
    const limit = side === 1 ? c[i]!.c * (1 - cfg.d) : c[i]!.c * (1 + cfg.d);
    let fi = -1;
    for (let j = i + 1; j <= Math.min(n - 1, i + cfg.ttl); j++) { if (side === 1 ? c[j]!.l <= limit : c[j]!.h >= limit) { fi = j; break; } }
    if (fi < 0) { i++; continue; }
    const entry = limit;
    const tgtPx = side === 1 ? entry * (1 + cfg.tgt) : entry * (1 - cfg.tgt);
    const slPx = side === 1 ? entry * (1 - cfg.sl) : entry * (1 + cfg.sl);
    let exit = 0; let exitFee = TK;
    let k = fi + 1; const kmax = Math.min(n - 1, fi + cfg.hold);
    for (; k <= kmax; k++) {
      if (side === 1 ? c[k]!.l <= slPx : c[k]!.h >= slPx) { exit = slPx; exitFee = TK; break; }
      if (side === 1 ? c[k]!.h >= tgtPx : c[k]!.l <= tgtPx) { exit = tgtPx; exitFee = MK; break; }
    }
    if (exit === 0) { exit = c[kmax]!.c; exitFee = TK; }
    const gross = side === 1 ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
    out.push(gross - MK - exitFee);
    i = k + 1;
  }
  return out;
}

function net(r: number[]) { return Math.round(r.reduce((s, x) => s + x, 0) * 10) / 10; }
function netStress(r: number[], extra: number) { return Math.round(r.reduce((s, x) => s + x - extra, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function dd(r: number[]) { let c = 0, p = 0, d = 0; for (const x of r) { c += x; if (c > p) p = c; if (p - c > d) d = p - c; } return Math.round(d * 10) / 10; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }

type Row = { sig: string; trig: string; coin: string; n: number; net: number; net2: number; pf: number; wr: number; dd: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  const rows: Row[] = [];
  const cache = new Map<string, { c: Candle[]; liq: (number | null)[] }>();
  console.log(`Vacuum LIVE-TRIGGER test (liq-cascade vs velocity-only) · 1m · ${SYMBOLS.length} coins · ${CFGS.length} configs · ${DAYS}d · maker ${MK}/taker ${TK}%\n`);
  for (const cfg of CFGS) {
    for (const sym of SYMBOLS) {
      const coin = sym.replace('USDT', '');
      let cm = cache.get(sym);
      if (!cm) { try { const c = await getKlines(sym, '1', NOW - DAYS * 86_400_000, NOW); cm = { c, liq: loadMicroAligned(coin, '1', c).liq }; cache.set(sym, cm); } catch (e) { process.stderr.write(`${sym}: ${(e as Error).message}\n`); continue; } }
      if (cm.c.length < 500) continue;
      const r = runVacuum(cm.c, cm.liq, cfg);
      if (r.length < 15) continue;
      const cut = Math.floor(r.length * 0.7);
      const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
      const green = r.length >= 25 && net(r) > 0 && pf(r) > 1.3 && isN > 0 && oosN > 0 && netStress(r, MK + TK) > 0 && (r.length >= 16 ? f >= 3 : true);
      rows.push({ sig: cfg.sig, trig: cfg.trig, coin, n: r.length, net: net(r), net2: netStress(r, MK + TK), pf: pf(r), wr: wr(r), dd: dd(r), isN, oosN, folds: f, green });
    }
    process.stderr.write(`  ${cfg.sig} done\n`);
  }
  writeFileSync('data/vacuum-trigger-results.json', JSON.stringify(rows, null, 2));

  const best = (rs: Row[]) => { const g = rs.filter((r) => r.green); const pool = g.length ? g : rs; return pool.sort((a, b) => b.net2 - a.net2)[0]; };
  const coins = [...new Set(rows.map((r) => r.coin))].sort();
  const fmt = (b: Row | undefined) => b ? `${b.green ? '✅' : '  '} net${String(b.net).padStart(6)} +cost${String(b.net2).padStart(6)} N${String(b.n).padStart(4)} PF${String(b.pf).padStart(5)} WR${b.wr}% f${b.folds}/4 (${b.sig.replace(/^(liq|vel)_/, '')})` : '—';
  console.log('===== PER-COIN: liq-cascade trigger vs VELOCITY-ONLY trigger (best by +cost) =====');
  for (const coin of coins) {
    const bl = best(rows.filter((r) => r.trig === 'liq' && r.coin === coin));
    const bv = best(rows.filter((r) => r.trig === 'vel' && r.coin === coin));
    const star = FOCUS.has(coin) ? '★' : ' ';
    console.log(`${star}${coin.padEnd(5)} liq: ${fmt(bl)}`);
    console.log(` ${''.padEnd(5)} vel: ${fmt(bv)}`);
  }
  console.log('\n===== VERDICT (★ = the BNB/ADA edge we want live) =====');
  for (const coin of ['BNB', 'ADA']) {
    const bl = best(rows.filter((r) => r.trig === 'liq' && r.coin === coin));
    const bv = best(rows.filter((r) => r.trig === 'vel' && r.coin === coin));
    if (bv?.green && (bv.net2 >= (bl?.net2 ?? -99) * 0.7)) console.log(`  ✓ ${coin}: velocity-only HOLDS (vel +cost ${bv.net2} vs liq ${bl?.net2 ?? '—'}) → can trigger LIVE on price velocity, no liq feed needed.`);
    else if (bv?.green) console.log(`  ~ ${coin}: velocity-only green but weaker (vel +cost ${bv.net2} vs liq ${bl?.net2 ?? '—'}) → usable live but the liq gate adds value.`);
    else console.log(`  ✗ ${coin}: velocity-only FAILS (vel best +cost ${bv?.net2 ?? '—'}, green=${bv?.green}) → liq gate is load-bearing; live needs an OI-drop proxy (forward-collect).`);
  }
  console.log('\n(+cost = survives an EXTRA maker+taker RT.) Full → data/vacuum-trigger-results.json');
})().catch((e) => { console.error(e); process.exit(1); });
