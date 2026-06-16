/**
 * IDEA #4 (ideation rank-4) — ANCHORED SNAPBACK EXIT on the liquidation-vacuum maker
 * (clone of backtest-liqvacuum.ts; changes the EXIT geometry, not the entry).
 *
 * Thesis: runVacuum exits at a FIXED tgt (0.4-0.6%). But the vacuum thesis is that
 * price OVERSHOT a reference and reverts TO it — the pre-cascade price, not an
 * arbitrary distance. A fixed tgt UNDER-exits big alt flushes (leaves snapback on
 * the table → shrinks the +cost cushion that kills XRP/DOGE/ADA) and mis-sizes
 * small ones. Anchoring the maker exit to the pre-cascade mid (close[i-velBars])
 * self-scales to cascade size — exactly what differs across coins — and is the
 * direct lever on gross-per-trade, hence on cushion survival.
 *
 * Rule: keep runVacuum entry. EXIT maker limit at anchorPx = close[i-velBars],
 * capped: long tgtPx = min(anchorPx, entry*(1+capTgt)); short = max(anchorPx,
 * entry*(1-capTgt)). SKIP if anchorPx doesn't clear entry by >= minTgt (no
 * negative-edge trades). PRE-REGISTERED A/B vs the fixed-tgt baseline (mode='fixed'
 * reproduces the original). Pure kline math — NO micro extension → runs on the FULL
 * ~10.5mo liq window. PASS only if an anchored mode is green incl. +cost on >=4/10
 * AND beats fixed-tgt in survivor count OR median +cost margin, on BOTH windows.
 *
 * Run on the VPS. pnpm tsx scripts/backtest-liqvacuum-anchor.ts [days]
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

type Cfg = { sig: string; core: string; mode: 'fixed' | 'anchor'; liqK: number; d: number; tgt: number; capTgt: number; minTgt: number; sl: number; ttl: number; hold: number; velBars: number; velThr: number };
const CFGS: Cfg[] = [];
// baseline (fixed tgt) — reproduces backtest-liqvacuum.ts
for (const liqK of [4, 6]) for (const d of [0.002, 0.004]) for (const tgt of [0.004, 0.006]) for (const velThr of [0.005, 0.008])
  CFGS.push({ sig: `FIX_K${liqK}d${d}t${tgt}v${velThr}`, core: `K${liqK}d${d}v${velThr}`, mode: 'fixed', liqK, d, tgt, capTgt: 0, minTgt: 0, sl: 0.015, ttl: 10, hold: 30, velBars: 3, velThr });
// anchor (pre-cascade mid) — tgt ignored
for (const liqK of [4, 6]) for (const d of [0.002, 0.004]) for (const velThr of [0.005, 0.008]) for (const capTgt of [0.008, 0.012]) for (const minTgt of [0.002, 0.003])
  CFGS.push({ sig: `ANC_K${liqK}d${d}v${velThr}c${capTgt}m${minTgt}`, core: `K${liqK}d${d}v${velThr}`, mode: 'anchor', liqK, d, tgt: 0, capTgt, minTgt, sl: 0.015, ttl: 10, hold: 30, velBars: 3, velThr });

/** realized NET % per trade (maker model; fixed or anchored exit). */
function runVacuum(c: Candle[], liq: (number | null)[], cfg: Cfg): number[] {
  const liqAvg = rollMean(liq, 240);
  const out: number[] = []; const n = c.length;
  let i = 250;
  while (i < n - 1) {
    const lq = liq[i]; const la = liqAvg[i];
    if (lq == null || !(la! > 0) || lq < cfg.liqK * la!) { i++; continue; }
    const ref = c[i - cfg.velBars]; if (!ref) { i++; continue; }
    const down = (ref.c - c[i]!.c) / ref.c;
    const up = -down;
    let side: 1 | -1 | 0 = 0;
    if (down >= cfg.velThr) side = 1; else if (up >= cfg.velThr) side = -1;
    if (side === 0) { i++; continue; }
    const limit = side === 1 ? c[i]!.c * (1 - cfg.d) : c[i]!.c * (1 + cfg.d);
    let fi = -1;
    for (let j = i + 1; j <= Math.min(n - 1, i + cfg.ttl); j++) { if (side === 1 ? c[j]!.l <= limit : c[j]!.h >= limit) { fi = j; break; } }
    if (fi < 0) { i++; continue; }
    const entry = limit;
    // ── EXIT TARGET: fixed vs anchored ────────────────────────────────────
    let tgtPx: number;
    if (cfg.mode === 'fixed') {
      tgtPx = side === 1 ? entry * (1 + cfg.tgt) : entry * (1 - cfg.tgt);
    } else {
      const anchorPx = ref.c;                                            // pre-cascade mid (close[i-velBars])
      if (side === 1) {
        if (anchorPx < entry * (1 + cfg.minTgt)) { i++; continue; }      // snapback too small → skip (no negative-edge)
        tgtPx = Math.min(anchorPx, entry * (1 + cfg.capTgt));            // cap so a huge overshoot is still fillable
      } else {
        if (anchorPx > entry * (1 - cfg.minTgt)) { i++; continue; }
        tgtPx = Math.max(anchorPx, entry * (1 - cfg.capTgt));
      }
    }
    // ──────────────────────────────────────────────────────────────────────
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

type Row = { sig: string; mode: string; coin: string; n: number; net: number; net2: number; pf: number; wr: number; dd: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  const rows: Row[] = [];
  const cache = new Map<string, { c: Candle[]; liq: (number | null)[] }>();
  console.log(`Liq-vacuum MAKER + ANCHORED EXIT · 1m · ${SYMBOLS.length} coins · ${CFGS.length} configs (16 fixed baseline + 32 anchor) · ${DAYS}d · maker ${MK}/taker ${TK}%\n`);
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
      rows.push({ sig: cfg.sig, mode: cfg.mode, coin, n: r.length, net: net(r), net2: netStress(r, MK + TK), pf: pf(r), wr: wr(r), dd: dd(r), isN, oosN, folds: f, green });
    }
    process.stderr.write(`  ${cfg.sig} done\n`);
  }
  writeFileSync('data/liqvacuum-anchor-results.json', JSON.stringify(rows, null, 2));

  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(5)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(6)} +cost ${String(r.net2).padStart(6)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% DD-${String(r.dd).padStart(5)} f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  const robustBy = (mode: string) => { const m = new Map<string, Row[]>(); for (const r of rows.filter((x) => x.mode === mode)) { const a = m.get(r.sig) ?? []; a.push(r); m.set(r.sig, a); } return [...m.entries()].map(([sig, rs]) => ({ sig, greens: rs.filter((r) => r.green).map((r) => r.coin).sort(), rs })).filter((x) => x.greens.length >= 4).sort((a, b) => b.greens.length - a.greens.length); };

  const fixR = robustBy('fixed'); const ancR = robustBy('anchor');
  const fixBest = fixR[0]?.greens.length ?? 0; const fixCoins = new Set(fixR.flatMap((x) => x.greens));
  console.log('===== A/B: ANCHORED EXIT vs FIXED-tgt baseline =====');
  console.log(`  fixed baseline: best robust ${fixBest}/10 ${fixR[0] ? `(${fixR[0].sig} {${fixR[0].greens.join(',')}})` : '— none robust —'}`);
  console.log(`  anchor: ${ancR.length} robust configs (green>=4):`);
  if (!ancR.length) console.log('    — none robust —');
  for (const x of ancR.slice(0, 6)) { const added = x.greens.filter((c) => !fixCoins.has(c)); console.log(`    ${x.sig.padEnd(30)} {${x.greens.join(',')}}${added.length ? ` +[${added.join(',')}]` : ''}`); }
  console.log('\n===== VERDICT =====');
  const beats = ancR.find((x) => x.greens.length > fixBest || x.greens.some((c) => !fixCoins.has(c)));
  if (beats) { const added = beats.greens.filter((c) => !fixCoins.has(c)); console.log(`  ✓ CANDIDATE PASS (this window) — ${beats.sig}: ${beats.greens.length}/10 {${beats.greens.join(',')}}${added.length ? `, adds [${added.join(',')}] vs fixed` : `, beats fixed count ${fixBest}`}.`); console.log('  → confirm on the second window before believing it.'); }
  else console.log(`  ✗ KILL — anchored exit does NOT beat fixed-tgt on survivor count or add a new coin (best anchor ${ancR[0]?.greens.length ?? 0} vs fixed ${fixBest}).`);

  console.log('\n===== green rows (detail) =====');
  for (const mode of ['fixed', 'anchor']) { const gr = rows.filter((r) => r.mode === mode && r.green); if (gr.length) { console.log(`\n  ◆ ${mode} → ${gr.length} green`); console.log(gr.sort((a, b) => b.net - a.net).slice(0, 12).map(line).join('\n')); } }
  console.log('\n(+cost = survives an EXTRA maker+taker RT.) Full → data/liqvacuum-anchor-results.json');
})().catch((e) => { console.error(e); process.exit(1); });
