/**
 * IDEA #1 (ideation top-pick) — BOOK-REFILL / IMBALANCE-CONFIRMATION GATE on the
 * liquidation-vacuum maker (clone of backtest-liqvacuum.ts + one gate).
 *
 * Thesis: a clean vacuum empties one side of the L2 book; the snapback IS the
 * surviving/refilling side. XRP/DOGE/ADA give +net but DIE on the adverse-selection
 * cushion (+cost) because their cascades do NOT snap cleanly. Gate the maker entry
 * on the cascade-window book imbalance: take the LONG (down-flush) only if bids are
 * thick (mean imb over [i-velBars..i] >= +g); SHORT only if asks thick (<= -g).
 * Where the book does NOT refill (imb neutral / follows the move) the cascade is
 * real repricing → we'd be adversely selected → skip. Gate keeps only structurally-
 * reverting cascades. ~one gate on top of runVacuum; uses ONLY liq + imb (both in
 * loadMicroAligned). book_imb coverage ~6mo (Dec 15 → Jun 16) → run DAYS<=150.
 *
 * PRE-REGISTERED A/B (the whole point): each core config runs at g=null (ungated
 * baseline) AND g in {0.15,0.30}. PASS only if a single (core,g) is green incl.
 * +cost on >=4/10 coins AND its green set ADDS >=1 coin the baseline missed (not
 * BNB-only, not a subset of baseline). Run on BOTH a 60d and a ~150d window.
 *
 * Run on the VPS. pnpm tsx scripts/backtest-liqvacuum-imb.ts [days]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 60);
const MK = 0.02, TK = 0.045; // HL maker / taker per side %
const G_VALUES: (number | null)[] = [null, 0.15, 0.30]; // null = ungated baseline

function rollMean(a: (number | null)[], W: number): number[] {
  const out = new Array<number>(a.length); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] ?? 0; if (i >= W) s -= a[i - W] ?? 0; out[i] = s / Math.min(i + 1, W); }
  return out;
}

type Cfg = { sig: string; core: string; g: number | null; liqK: number; d: number; tgt: number; sl: number; ttl: number; hold: number; velBars: number; velThr: number };
const CFGS: Cfg[] = [];
for (const liqK of [4, 6]) for (const d of [0.002, 0.004]) for (const tgt of [0.004, 0.006]) for (const velThr of [0.005, 0.008]) for (const g of G_VALUES) {
  const core = `K${liqK}d${d}t${tgt}v${velThr}`;
  CFGS.push({ sig: `${core}g${g ?? 'NONE'}`, core, g, liqK, d, tgt, sl: 0.015, ttl: 10, hold: 30, velBars: 3, velThr });
}

/** returns realized NET % per trade for one coin+config (maker model + book-refill gate). */
function runVacuum(c: Candle[], liq: (number | null)[], imb: (number | null)[], cfg: Cfg): number[] {
  const liqAvg = rollMean(liq, 240);
  const out: number[] = []; const n = c.length;
  let i = 250;
  while (i < n - 1) {
    const lq = liq[i]; const la = liqAvg[i];
    if (lq == null || !(la! > 0) || lq < cfg.liqK * la!) { i++; continue; }
    const ref = c[i - cfg.velBars]; if (!ref) { i++; continue; }
    const down = (ref.c - c[i]!.c) / ref.c;   // >0 = price fell into the flush
    const up = -down;
    let side: 1 | -1 | 0 = 0;
    if (down >= cfg.velThr) side = 1; else if (up >= cfg.velThr) side = -1;
    if (side === 0) { i++; continue; }
    // ── BOOK-REFILL GATE ──────────────────────────────────────────────────
    if (cfg.g != null) {
      let s = 0; let ok = true;
      for (let b = i - cfg.velBars; b <= i; b++) { const v = imb[b]; if (v == null) { ok = false; break; } s += v; }
      if (!ok) { i++; continue; }                                  // missing book data in window → skip
      const imbConf = s / (cfg.velBars + 1);                       // mean book_imb over the flush
      if (side === 1 && imbConf < cfg.g) { i++; continue; }        // long needs bids thick (imb >= +g)
      if (side === -1 && imbConf > -cfg.g) { i++; continue; }      // short needs asks thick (imb <= -g)
    }
    // ──────────────────────────────────────────────────────────────────────
    const limit = side === 1 ? c[i]!.c * (1 - cfg.d) : c[i]!.c * (1 + cfg.d);
    // rest the maker limit; fill only if a later bar touches it within TTL
    let fi = -1;
    for (let j = i + 1; j <= Math.min(n - 1, i + cfg.ttl); j++) { if (side === 1 ? c[j]!.l <= limit : c[j]!.h >= limit) { fi = j; break; } }
    if (fi < 0) { i++; continue; }                     // unfilled — missed cascade costs nothing
    const entry = limit;
    const tgtPx = side === 1 ? entry * (1 + cfg.tgt) : entry * (1 - cfg.tgt);
    const slPx = side === 1 ? entry * (1 - cfg.sl) : entry * (1 + cfg.sl);
    let exit = 0; let exitFee = TK;                    // default exit = taker (time/SL)
    let k = fi + 1; const kmax = Math.min(n - 1, fi + cfg.hold);
    for (; k <= kmax; k++) {
      if (side === 1 ? c[k]!.l <= slPx : c[k]!.h >= slPx) { exit = slPx; exitFee = TK; break; }   // catastrophe first
      if (side === 1 ? c[k]!.h >= tgtPx : c[k]!.l <= tgtPx) { exit = tgtPx; exitFee = MK; break; } // maker snapback
    }
    if (exit === 0) { exit = c[kmax]!.c; exitFee = TK; }                                            // time exit
    const gross = side === 1 ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
    out.push(gross - MK - exitFee);                    // entry maker + exit fee
    i = k + 1;                                          // step past the trade
  }
  return out;
}

function net(r: number[]) { return Math.round(r.reduce((s, x) => s + x, 0) * 10) / 10; }
function netStress(r: number[], extra: number) { return Math.round(r.reduce((s, x) => s + x - extra, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function dd(r: number[]) { let c = 0, p = 0, d = 0; for (const x of r) { c += x; if (c > p) p = c; if (p - c > d) d = p - c; } return Math.round(d * 10) / 10; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }

type Row = { sig: string; core: string; g: number | null; coin: string; n: number; net: number; net2: number; pf: number; wr: number; dd: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  const rows: Row[] = [];
  const cache = new Map<string, { c: Candle[]; liq: (number | null)[]; imb: (number | null)[]; cov: number }>();
  console.log(`Liq-vacuum MAKER + BOOK-REFILL gate · 1m · ${SYMBOLS.length} coins · ${CFGS.length} configs (incl. g=null baseline) · ${DAYS}d · maker ${MK}/taker ${TK}%\n`);
  for (const cfg of CFGS) {
    for (const sym of SYMBOLS) {
      const coin = sym.replace('USDT', '');
      let cm = cache.get(sym);
      if (!cm) {
        try { const c = await getKlines(sym, '1', NOW - DAYS * 86_400_000, NOW); const m = loadMicroAligned(coin, '1', c); cm = { c, liq: m.liq, imb: m.imb, cov: m.coverage }; cache.set(sym, cm); }
        catch (e) { process.stderr.write(`${sym}: ${(e as Error).message}\n`); continue; }
      }
      if (cm.c.length < 500) continue;
      const r = runVacuum(cm.c, cm.liq, cm.imb, cfg);
      if (r.length < 15) continue;
      const cut = Math.floor(r.length * 0.7);
      const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
      const green = r.length >= 25 && net(r) > 0 && pf(r) > 1.3 && isN > 0 && oosN > 0 && netStress(r, MK + TK) > 0 && (r.length >= 16 ? f >= 3 : true);
      rows.push({ sig: cfg.sig, core: cfg.core, g: cfg.g, coin, n: r.length, net: net(r), net2: netStress(r, MK + TK), pf: pf(r), wr: wr(r), dd: dd(r), isN, oosN, folds: f, green });
    }
  }
  // book-imb coverage per coin (sanity — must be >0.5 in-window to trust the gate)
  const covLine = [...cache.entries()].map(([s, cm]) => `${s.replace('USDT', '')}:${cm.cov}`).join(' ');
  console.log(`book_imb coverage in window: ${covLine}\n`);
  writeFileSync('data/liqvacuum-imb-results.json', JSON.stringify(rows, null, 2));

  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(5)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(6)} +cost ${String(r.net2).padStart(6)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% DD-${String(r.dd).padStart(5)} f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  const greensOf = (core: string, g: number | null) => rows.filter((r) => r.core === core && r.g === g && r.green).map((r) => r.coin).sort();

  // ── PRE-REGISTERED A/B VERDICT ──────────────────────────────────────────
  const cores = [...new Set(CFGS.map((c) => c.core))];
  console.log('===== A/B: baseline (g=null) vs gated, green-incl-+cost coins per core config =====');
  type Win = { core: string; g: number; gated: string[]; base: string[]; added: string[] };
  const wins: Win[] = [];
  for (const core of cores) {
    const base = greensOf(core, null);
    const parts = [`base{${base.join(',') || '—'}}`];
    for (const g of [0.15, 0.30]) {
      const gated = greensOf(core, g);
      const added = gated.filter((c) => !base.includes(c));
      parts.push(`g${g}{${gated.join(',') || '—'}}${added.length ? ` +[${added.join(',')}]` : ''}`);
      // PASS condition: gated robust >=4, adds >=1 coin baseline missed, not BNB-only
      if (gated.length >= 4 && added.length >= 1 && !(gated.length === 1 && gated[0] === 'BNB')) wins.push({ core, g, gated, base, added });
    }
    console.log(`  ${core.padEnd(22)} ${parts.join('  |  ')}`);
  }
  console.log('\n===== VERDICT =====');
  if (!wins.length) {
    const anyGated4 = cores.some((core) => [0.15, 0.30].some((g) => greensOf(core, g).length >= 4));
    console.log(`  ✗ KILL — no (core,g) is green-incl-+cost on >=4 coins AND adds a coin the baseline missed.`);
    console.log(`  (some gated config reached >=4 green: ${anyGated4} — if true but added no new coin, the gate re-selects the already-green set = generalizes nothing.)`);
  } else {
    console.log(`  ✓ CANDIDATE PASS (this window) — ${wins.length} (core,g) lift survivors to >=4 AND add a baseline-missed coin:`);
    for (const w of wins.sort((a, b) => b.gated.length - a.gated.length)) console.log(`    ${w.core} g${w.g}: gated{${w.gated.join(',')}} added[${w.added.join(',')}]  (base was {${w.base.join(',') || '—'}})`);
    console.log(`  → must ALSO pass on the second window (run 60d AND ~150d) before believing it.`);
  }
  // detail: every green row grouped
  console.log('\n===== green rows (detail) =====');
  for (const core of cores) for (const g of G_VALUES) { const gr = rows.filter((r) => r.core === core && r.g === g && r.green); if (gr.length) { console.log(`\n  ◆ ${core} g${g ?? 'NONE'} → ${gr.length} green`); console.log(gr.sort((a, b) => b.net - a.net).map(line).join('\n')); } }
  console.log('\n(+cost = survives an EXTRA maker+taker RT = adverse-selection cushion.) Full → data/liqvacuum-imb-results.json');
})().catch((e) => { console.error(e); process.exit(1); });
