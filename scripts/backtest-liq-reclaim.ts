/**
 * liqAbsorbReclaim — fast (1m, ~15-30min hold) liquidation-EXHAUSTION snapback, the top survivor
 * of the fast-event-signal ideation. The funding-flip lesson applied to minute-scale liq events:
 * don't fade the climax magnitude (that's the killed liqCascadeFade) — wait for a PRICE-FACT
 * completion: a liq climax, then the feed goes QUIET, then price RECLAIMS the pre-cascade level
 * (= resting liquidity absorbed the forced flow and the flushed cohort is trapped). Then ride the
 * snapback. The reclaim is binary + look-ahead-safe → almost impossible to curve-fit.
 *
 * A/B (the mandatory gate): reclaimGate ON (full liqAbsorbReclaim) vs OFF (fade the climax
 * immediately = ungated liqCascadeFade baseline). PASS only if ON is cross-symbol robust (>=4/10)
 * AND beats OFF — else the reclaim adds nothing and it's the re-skin that already died.
 *
 * Causal: climax at k, reclaim confirmed at i>k from candles/liq[<=i], enter at close[i]. liq from
 * hl_micro (~10.5mo). Symbol-outer (RAM-safe for 1m). Run on the VPS. pnpm tsx scripts/backtest-liq-reclaim.ts [days]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 180);
const TK = 0.07; // HL taker RT %

function rollMean(a: (number | null)[], W: number): number[] {
  const out = new Array<number>(a.length); let s = 0; const buf: number[] = [];
  for (let i = 0; i < a.length; i++) { const v = a[i] ?? 0; buf.push(v); s += v; if (buf.length > W) s -= buf.shift()!; out[i] = s / buf.length; }
  return out;
}

type Cfg = { sig: string; core: string; liqK: number; M: number; velBars: number; velThr: number; tgt: number; hold: number; slPct: number; gate: boolean };
const CFGS: Cfg[] = [];
for (const liqK of [4, 6]) for (const M of [5, 8]) for (const tgt of [0.004, 0.006]) for (const hold of [15, 30]) for (const gate of [true, false]) {
  const core = `K${liqK}M${M}t${tgt}h${hold}`;
  CFGS.push({ sig: `${core}${gate ? '_RC' : '_x'}`, core, liqK, M, velBars: 3, velThr: 0.005, tgt, hold, slPct: 0.015, gate });
}

/** realized NET % per trade (taker RT subtracted). climax→(quiet+reclaim if gate)→snapback. */
function run(c: Candle[], liq: (number | null)[], base: number[], cfg: Cfg): number[] {
  const out: number[] = []; const n = c.length; let guard = -1;
  for (let k = 250; k < n - 2; k++) {
    if (k <= guard) continue;
    const lq = liq[k]; const bk = base[k]!;
    if (lq == null || !(bk > 0) || lq < cfg.liqK * bk) continue;       // not a liq climax
    const ref = c[k - cfg.velBars]; if (!ref) continue;
    const ret = (c[k]!.c - ref.c) / ref.c;
    const side: 1 | -1 | 0 = ret <= -cfg.velThr ? 1 : ret >= cfg.velThr ? -1 : 0; // down-climax→long, up→short
    if (side === 0) continue;
    const preCascade = c[k - 1]!.c;
    let climaxLow = c[k]!.l, climaxHigh = c[k]!.h;
    for (let j = k - 2; j <= k; j++) { if (c[j]!.l < climaxLow) climaxLow = c[j]!.l; if (c[j]!.h > climaxHigh) climaxHigh = c[j]!.h; }
    let ei = -1;
    if (cfg.gate) {
      // scan forward for the reclaim minute within M bars
      for (let i = k + 1; i <= Math.min(n - 2, k + cfg.M); i++) {
        if ((liq[i] ?? 0) >= 1.5 * (base[i] || 1)) { break; }            // feed re-ignited → abort this climax
        if (side === 1 && c[i]!.l < climaxLow) { climaxLow = c[i]!.l; continue; } // made a new low → not absorbed yet, keep waiting (update extreme)
        if (side === -1 && c[i]!.h > climaxHigh) { climaxHigh = c[i]!.h; continue; }
        if (side === 1 && c[i]!.c > preCascade) { ei = i; break; }       // RECLAIM up = absorbed
        if (side === -1 && c[i]!.c < preCascade) { ei = i; break; }
      }
    } else {
      ei = Math.min(n - 2, k + 1);                                       // ungated baseline: fade the climax immediately
    }
    if (ei < 0) continue;
    const entry = c[ei]!.c;
    const tgtPx = side === 1 ? entry * (1 + cfg.tgt) : entry * (1 - cfg.tgt);
    const slPx = side === 1 ? entry * (1 - cfg.slPct) : entry * (1 + cfg.slPct);
    let exit = 0; const kmax = Math.min(n - 1, ei + cfg.hold);
    let j = ei + 1;
    for (; j <= kmax; j++) {
      if (side === 1 ? c[j]!.l <= slPx : c[j]!.h >= slPx) { exit = slPx; break; }
      if (side === 1 ? c[j]!.h >= tgtPx : c[j]!.l <= tgtPx) { exit = tgtPx; break; }
    }
    if (exit === 0) exit = c[kmax]!.c;
    const gross = side === 1 ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
    out.push(gross - TK);
    guard = kmax;
  }
  return out;
}

function net(r: number[], e = 0) { return Math.round(r.reduce((s, x) => s + x - e, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }

type Row = { sig: string; core: string; gate: boolean; coin: string; n: number; net: number; net2: number; net3: number; pf: number; wr: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  console.log(`liqAbsorbReclaim · 1m · ${SYMBOLS.length} coins · ${CFGS.length} cfgs (reclaim A/B) · ${DAYS}d · HL taker ${TK}%\n`);
  const rows: Row[] = [];
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    let c: Candle[];
    try { c = await getKlines(sym, '1', NOW - DAYS * 86_400_000, NOW); } catch (e) { process.stderr.write(`${sym}: ${(e as Error).message}\n`); continue; }
    if (c.length < 5000) continue;
    const m = loadMicroAligned(coin, '1', c);
    const base = rollMean(m.liq, 240);
    const cov = Math.round((m.liq.filter((x) => x != null && x > 0).length / c.length) * 100);
    for (const cfg of CFGS) {
      const r = run(c, m.liq, base, cfg);
      if (r.length < 15) continue;
      const cut = Math.floor(r.length * 0.7);
      const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
      const n1 = net(r), n2 = net(r, TK), n3 = net(r, 2 * TK);
      const green = r.length >= 20 && n1 > 0 && pf(r) > 1.2 && isN > 0 && oosN > 0 && n2 > 0 && f >= 3;
      rows.push({ sig: cfg.sig, core: cfg.core, gate: cfg.gate, coin, n: r.length, net: n1, net2: n2, net3: n3, pf: pf(r), wr: wr(r), isN, oosN, folds: f, green });
    }
    process.stderr.write(`  ${coin}: ${c.length} bars, liq cov ${cov}%\n`);
  }
  writeFileSync('data/liq-reclaim-results.json', JSON.stringify(rows, null, 2));

  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(5)} ${r.sig.padEnd(18)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(6)} +cost ${String(r.net2).padStart(6)} x3 ${String(r.net3).padStart(6)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  const robust = (gate: boolean) => { const m = new Map<string, string[]>(); for (const r of rows.filter((x) => x.gate === gate && x.green)) { const a = m.get(r.core) ?? []; a.push(r.coin); m.set(r.core, a); } return [...m.entries()].map(([core, coins]) => ({ core, coins: coins.sort() })).filter((x) => x.coins.length >= 4).sort((a, b) => b.coins.length - a.coins.length); };
  const rc = robust(true), un = robust(false);
  console.log('===== A/B: RECLAIM-gate ON vs ungated climax-fade · cross-symbol robust >=4/10 =====');
  console.log(`  RECLAIM ON : ${rc.length ? rc.map((x) => `${x.core}{${x.coins.join(',')}}`).join('  ') : '— none robust —'}`);
  console.log(`  UNGATED    : ${un.length ? un.map((x) => `${x.core}{${x.coins.join(',')}}`).join('  ') : '— none robust —'}`);
  console.log('\n===== VERDICT =====');
  const rcB = rc[0]?.coins.length ?? 0, unB = un[0]?.coins.length ?? 0;
  if (rcB >= 4 && rcB > unB) console.log(`  ✓ CANDIDATE — reclaim robust ${rcB}/10 {${rc[0]!.coins.join(',')}} BEATS ungated (${unB}) → the price-reclaim completion IS the edge. Verify (2nd window + maker A/B) before any deploy.`);
  else if (rcB >= 4 && rcB <= unB) console.log(`  ~ reclaim ${rcB}/10 but ungated matches (${unB}) → reclaim adds nothing = liqCascadeFade re-skin. Suspect.`);
  else console.log(`  ✗ KILL — reclaim robust ${rcB}/10 (<4). No cross-symbol fast liq-reclaim edge on this window.`);

  console.log('\n===== green rows (top by +cost) =====');
  const gr = rows.filter((r) => r.green); console.log(gr.length ? gr.sort((a, b) => b.net2 - a.net2).slice(0, 16).map(line).join('\n') : '  — none green —');
  console.log('\nFull → data/liq-reclaim-results.json');
})().catch((e) => { console.error(e); process.exit(1); });
