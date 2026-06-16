/**
 * IDEA #5 (ideation rank-5) — LARGE-PRINT / ONE-SIDED CVD-CLIMAX VACUUM (NEW trigger).
 *
 * A single large one-sided aggressive sweep (a minute where taker buy or sell volume
 * massively exceeds normal) is impatient/forced flow that overshoots and leaves NO
 * liquidation print — so the liq-vacuum misses it. Detect the EFFECT directly: an
 * extreme one-minute |CVD| spike + extreme one-sidedness (sellFrac) + a sharp price
 * move, then arm a maker limit ONLY if the next minute's aggression collapses (the
 * exhaustion fill-gate that fixes the OOS-dead taker liqCascadeFade). INDEPENDENT of
 * liquidations → fires where the vacuum is silent. Needs cvd + buy_vol/sell_vol (now
 * surfaced by loadMicroAligned) → runs on the CVD window (~60d backfilled).
 *
 * A/B (mechanism refutation): collapseGate ON vs OFF. If dropping the next-minute-CVD-
 * collapse gate does NOT hurt, exhaustion is not the edge → it's just impulse-fade
 * (the failure that killed taker liqCascadeFade) → KILL. Also: if green coins ⊆ {BNB},
 * redundant with the liq-vacuum → KILL. PASS = green incl. +cost on >=4/10.
 *
 * Run on the VPS (after the CVD backfill). pnpm tsx scripts/backtest-printvacuum.ts [days]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 60);
const MK = 0.02, TK = 0.045;

function rollMean(a: (number | null)[], W: number): number[] {
  const out = new Array<number>(a.length); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] ?? 0; if (i >= W) s -= a[i - W] ?? 0; out[i] = s / Math.min(i + 1, W); }
  return out;
}

type Cfg = { sig: string; core: string; cvdK: number; oneSided: number; d: number; tgt: number; collapse: boolean; sl: number; ttl: number; hold: number; velBars: number; velThr: number };
const CFGS: Cfg[] = [];
for (const cvdK of [3, 5]) for (const oneSided of [0.75, 0.85]) for (const d of [0.002, 0.004]) for (const tgt of [0.006, 0.010]) for (const collapse of [true, false]) {
  const core = `cK${cvdK}o${oneSided}d${d}t${tgt}`;
  CFGS.push({ sig: `${core}${collapse ? '_G' : '_x'}`, core, cvdK, oneSided, d, tgt, collapse, sl: 0.012, ttl: 8, hold: 20, velBars: 3, velThr: 0.005 });
}

/** realized NET % per trade. Trigger = one-sided CVD climax + price move (+ optional collapse gate). */
function runPrint(c: Candle[], cvd: (number | null)[], buyV: (number | null)[], sellV: (number | null)[], cfg: Cfg): number[] {
  const absCvd = cvd.map((x) => (x == null ? null : Math.abs(x)));
  const absAvg = rollMean(absCvd, 240);
  const out: number[] = []; const n = c.length;
  let i = 250;
  while (i < n - 1) {
    const cv = cvd[i]; const aa = absAvg[i];
    if (cv == null || !(aa > 0) || Math.abs(cv) < cfg.cvdK * aa) { i++; continue; }   // not a CVD climax
    const bv = buyV[i]; const sv = sellV[i];
    if (bv == null || sv == null || bv + sv <= 0) { i++; continue; }
    const sellFrac = sv / (bv + sv);
    let side: 1 | -1 | 0 = 0;
    if (sellFrac >= cfg.oneSided) side = 1;          // down-print (sellers aggressive) → long fade
    else if (sellFrac <= 1 - cfg.oneSided) side = -1; // up-print (buyers aggressive) → short fade
    if (side === 0) { i++; continue; }
    const ref = c[i - cfg.velBars]; if (!ref) { i++; continue; }
    const move = side === 1 ? (ref.c - c[i]!.c) / ref.c : (c[i]!.c - ref.c) / ref.c;
    if (move < cfg.velThr) { i++; continue; }        // price must have moved in the print direction
    // collapse fill-gate: next-minute aggression must have collapsed (exhaustion)
    if (cfg.collapse) {
      const nx = cvd[i + 1];
      if (nx == null || Math.abs(nx) >= 0.5 * Math.abs(cv)) { i++; continue; } // still feeding → skip
    }
    const armBar = cfg.collapse ? i + 1 : i;          // arm after the collapse confirm (causal)
    const limit = side === 1 ? c[armBar]!.c * (1 - cfg.d) : c[armBar]!.c * (1 + cfg.d);
    let fi = -1;
    for (let j = armBar + 1; j <= Math.min(n - 1, armBar + cfg.ttl); j++) { if (side === 1 ? c[j]!.l <= limit : c[j]!.h >= limit) { fi = j; break; } }
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

type Row = { sig: string; core: string; collapse: boolean; coin: string; n: number; net: number; net2: number; pf: number; wr: number; dd: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  const rows: Row[] = [];
  const cache = new Map<string, { c: Candle[]; cvd: (number | null)[]; buyV: (number | null)[]; sellV: (number | null)[]; cov: number }>();
  console.log(`Large-print CVD-climax VACUUM · 1m · ${SYMBOLS.length} coins · ${CFGS.length} configs (collapse-gate A/B) · ${DAYS}d · maker ${MK}/taker ${TK}%\n`);
  for (const cfg of CFGS) {
    for (const sym of SYMBOLS) {
      const coin = sym.replace('USDT', '');
      let cm = cache.get(sym);
      if (!cm) { try { const c = await getKlines(sym, '1', NOW - DAYS * 86_400_000, NOW); const m = loadMicroAligned(coin, '1', c); cm = { c, cvd: m.cvd, buyV: m.buyVol, sellV: m.sellVol, cov: m.coverage }; cache.set(sym, cm); } catch (e) { process.stderr.write(`${sym}: ${(e as Error).message}\n`); continue; } }
      if (cm.c.length < 500) continue;
      const r = runPrint(cm.c, cm.cvd, cm.buyV, cm.sellV, cfg);
      if (r.length < 15) continue;
      const cut = Math.floor(r.length * 0.7);
      const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
      const green = r.length >= 25 && net(r) > 0 && pf(r) > 1.3 && isN > 0 && oosN > 0 && netStress(r, MK + TK) > 0 && (r.length >= 16 ? f >= 3 : true);
      rows.push({ sig: cfg.sig, core: cfg.core, collapse: cfg.collapse, coin, n: r.length, net: net(r), net2: netStress(r, MK + TK), pf: pf(r), wr: wr(r), dd: dd(r), isN, oosN, folds: f, green });
    }
    process.stderr.write(`  ${cfg.sig} done\n`);
  }
  const covLine = [...cache.entries()].map(([s, cm]) => `${s.replace('USDT', '')}:${cm.cov}`).join(' ');
  console.log(`cvd/flow coverage in window: ${covLine}\n`);
  writeFileSync('data/printvacuum-results.json', JSON.stringify(rows, null, 2));

  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(5)} ${r.sig.padEnd(20)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(6)} +cost ${String(r.net2).padStart(6)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% DD-${String(r.dd).padStart(5)} f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  const robust = (gated: boolean) => { const m = new Map<string, string[]>(); for (const r of rows.filter((x) => x.collapse === gated && x.green)) { const a = m.get(r.core) ?? []; a.push(r.coin); m.set(r.core, a); } return [...m.entries()].map(([core, coins]) => ({ core, coins: coins.sort() })).filter((x) => x.coins.length >= 4).sort((a, b) => b.coins.length - a.coins.length); };

  const gOn = robust(true); const gOff = robust(false);
  console.log('===== A/B: collapse-gate ON vs OFF (cross-symbol robust ≥4) =====');
  console.log(`  collapse ON : ${gOn.length ? gOn.map((x) => `${x.core}{${x.coins.join(',')}}`).join('  ') : '— none robust —'}`);
  console.log(`  collapse OFF: ${gOff.length ? gOff.map((x) => `${x.core}{${x.coins.join(',')}}`).join('  ') : '— none robust —'}`);
  console.log('\n===== VERDICT =====');
  const onBest = gOn[0]?.coins.length ?? 0; const offBest = gOff[0]?.coins.length ?? 0;
  if (onBest >= 4 && onBest > offBest) console.log(`  ✓ CANDIDATE PASS — collapse-gated robust ${onBest}/10 {${gOn[0]!.coins.join(',')}}, BEATS un-gated (${offBest}) → exhaustion IS the edge. Confirm on a 2nd window once more CVD history is backfilled.`);
  else if (onBest >= 4 && onBest <= offBest) console.log(`  ~ collapse-gated robust ${onBest}/10 but un-gated matches (${offBest}) → the collapse gate adds nothing = impulse-fade re-skin (the liqCascadeFade failure). Treat as suspect.`);
  else console.log(`  ✗ KILL — collapse-gated robust ${onBest}/10 (<4). No cross-symbol large-print edge on this window.`);
  // BNB-subset check
  if (onBest >= 4 && gOn[0]!.coins.every((c) => c === 'BNB')) console.log(`  (NB: green ⊆ {BNB} → redundant with liq-vacuum → KILL.)`);

  console.log('\n===== green rows (detail) =====');
  const gr = rows.filter((r) => r.green); if (gr.length) console.log(gr.sort((a, b) => b.net2 - a.net2).slice(0, 16).map(line).join('\n')); else console.log('  — none green —');
  console.log('\n(+cost = survives an EXTRA maker+taker RT.) Full → data/printvacuum-results.json');
})().catch((e) => { console.error(e); process.exit(1); });
