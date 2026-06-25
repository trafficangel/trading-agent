/**
 * ABSORPTION-FAIL — verification harness for the design-sweep's lone survivor.
 * The engine sweep found absorptionFailRetest cross-symbol robust (4/10) at TAKER on
 * the vk4 (extreme-climax) plateau, strongest on LTC + AVAX/SOL/BNB. This harness
 * pressure-tests the two open questions the engine can't answer:
 *   (1) MAKER vs TAKER (A/B): the synth's thesis is the net edge lives in the maker leg —
 *       rest a limit INTO the retest of the absorbed extreme (better fill + maker fee) vs
 *       chasing the confirmation close. Maker is conservative-filled (touch + an EXTRA
 *       maker+taker RT cushion = the adverse-selection guard that killed mark-pull/5m-maker).
 *   (2) SECOND WINDOW (OOS regime): re-run an EARLIER window (endOffset arg) to refute the
 *       recent-regime overfit (SOL's IS/OOS was 17.3/0.1 — most edge in-sample).
 *
 * Signal is re-implemented inline IDENTICALLY to absorptionFailRetest (vol-climax at k=i-1
 * with a rejection wick + poor IBS, confirmed by no-new-extreme + adverse close on bar i).
 * Causal: every read is candles[0..i]. Run on the VPS. pnpm tsx scripts/backtest-absorption.ts [days] [endOffsetDays]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { sma, type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const DAYS = Number(process.argv[2] ?? 400);
const END_OFFSET = Number(process.argv[3] ?? 0);
const NOW = Date.now() - END_OFFSET * 86_400_000;
const TF = '15';
const TK = 0.035, MK = 0.02; // per side: HL taker 0.07% RT / maker 0.04% RT

type Cfg = { sig: string; core: string; volK: number; volLook: number; wickFrac: number; ibsLo: number; ibsHi: number; hold: number; d: number; ttl: number; maker: boolean };
const CFGS: Cfg[] = [];
// focus the vk4 plateau the engine found; sweep maker offset d + ttl; A/B maker on/off
for (const volK of [3, 4]) for (const volLook of [20, 30]) for (const wickFrac of [0.5, 0.6]) for (const ib of [[0.35, 0.65], [0.45, 0.55]] as const) for (const hold of [6, 8]) for (const maker of [false, true]) {
  const dgrid = maker ? [0.001, 0.002, 0.003] : [0];
  for (const d of dgrid) {
    const core = `vk${volK}vl${volLook}w${Math.round(wickFrac * 100)}i${Math.round(ib[0] * 100)}h${hold}`;
    CFGS.push({ sig: `${core}${maker ? `m${Math.round(d * 1000)}` : 'TK'}`, core, volK, volLook, wickFrac, ibsLo: ib[0], ibsHi: ib[1], hold, d, ttl: 5, maker });
  }
}

type Sig = { i: number; side: 1 | -1; refExtreme: number };
/** detect absorption-fail signals — IDENTICAL logic to the factory, returns (bar, side). */
function signals(c: Candle[], vSma: number[], cfg: Cfg): Sig[] {
  const out: Sig[] = []; const n = c.length;
  for (let i = cfg.volLook + 3; i < n - 1; i++) {
    const k = i - 1; const kb = c[k]!; const b = c[i]!;
    if (!(vSma[k - 1]! > 0) || kb.v < cfg.volK * vSma[k - 1]!) continue;
    const rng = kb.h - kb.l; if (!(rng > 0)) continue;
    const ibsK = (kb.c - kb.l) / rng;
    const upperWick = (kb.h - Math.max(kb.o, kb.c)) / rng;
    const lowerWick = (Math.min(kb.o, kb.c) - kb.l) / rng;
    if (upperWick >= cfg.wickFrac && ibsK <= cfg.ibsLo && b.h < kb.h && b.c < kb.c) out.push({ i, side: -1, refExtreme: kb.h });
    else if (lowerWick >= cfg.wickFrac && ibsK >= cfg.ibsHi && b.l > kb.l && b.c > kb.c) out.push({ i, side: 1, refExtreme: kb.l });
  }
  return out;
}

/** realized NET % per trade. Taker: enter at confirm close. Maker: rest a limit toward the
 *  absorbed extreme (retest), fill on touch within ttl, else skip. Both exit at time-stop (taker). */
function run(c: Candle[], vSma: number[], cfg: Cfg): number[] {
  const out: number[] = []; const n = c.length;
  const slPct = 0.08;
  let guard = -1; // don't overlap trades
  for (const s of signals(c, vSma, cfg)) {
    if (s.i <= guard) continue;
    let entry: number, ei: number, entryFee: number;
    if (!cfg.maker) {
      entry = c[s.i]!.c; ei = s.i; entryFee = TK;
    } else {
      // rest a limit toward the rejected extreme: short → above the close (retest up), long → below
      const limit = s.side === -1 ? c[s.i]!.c * (1 + cfg.d) : c[s.i]!.c * (1 - cfg.d);
      let fi = -1;
      for (let j = s.i + 1; j <= Math.min(n - 1, s.i + cfg.ttl); j++) {
        if (s.side === -1 ? c[j]!.h >= limit : c[j]!.l <= limit) { fi = j; break; }
      }
      if (fi < 0) continue; // never retested → no fill
      entry = limit; ei = fi; entryFee = MK;
    }
    const slPx = s.side === -1 ? entry * (1 + slPct) : entry * (1 - slPct);
    let exit = 0; let exitFee = TK;
    const kmax = Math.min(n - 1, ei + cfg.hold);
    let k = ei + 1;
    for (; k <= kmax; k++) {
      if (s.side === -1 ? c[k]!.h >= slPx : c[k]!.l <= slPx) { exit = slPx; break; } // safety stop
    }
    if (exit === 0) exit = c[kmax]!.c; // time-stop
    const gross = s.side === -1 ? (entry - exit) / entry * 100 : (exit - entry) / entry * 100;
    out.push(gross - entryFee - exitFee);
    guard = kmax;
  }
  return out;
}

function net(r: number[]) { return Math.round(r.reduce((s, x) => s + x, 0) * 10) / 10; }
function netStress(r: number[], e: number) { return Math.round(r.reduce((s, x) => s + x - e, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function dd(r: number[]) { let c = 0, p = 0, d = 0; for (const x of r) { c += x; if (c > p) p = c; if (p - c > d) d = p - c; } return Math.round(d * 10) / 10; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }

type Row = { sig: string; core: string; maker: boolean; coin: string; n: number; net: number; net2: number; pf: number; wr: number; dd: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  const wlabel = END_OFFSET ? `window: ${DAYS}d ending ${END_OFFSET}d ago (OOS regime)` : `window: recent ${DAYS}d`;
  console.log(`ABSORPTION-FAIL verify · 15m · ${SYMBOLS.length} coins · ${CFGS.length} cfgs (maker/taker A/B) · ${wlabel} · taker ${TK * 2}/maker ${MK * 2}% RT\n`);
  const data = new Map<string, { c: Candle[]; vSma20: number[]; vSma30: number[] }>();
  for (const sym of SYMBOLS) {
    try { const c = await getKlines(sym, TF, NOW - DAYS * 86_400_000, NOW); data.set(sym, { c, vSma20: sma(c.map((x) => x.v), 20), vSma30: sma(c.map((x) => x.v), 30) }); }
    catch (e) { process.stderr.write(`${sym}: ${(e as Error).message}\n`); }
  }
  const rows: Row[] = [];
  for (const cfg of CFGS) for (const [sym, d] of data) {
    if (d.c.length < 500) continue;
    const vSma = cfg.volLook === 20 ? d.vSma20 : d.vSma30;
    const r = run(d.c, vSma, cfg);
    if (r.length < 20) continue;
    const cut = Math.floor(r.length * 0.7);
    const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
    const green = r.length >= 25 && net(r) > 0 && pf(r) > 1.25 && isN > 0 && oosN > 0 && netStress(r, TK + MK) > 0 && (r.length >= 16 ? f >= 3 : true);
    rows.push({ sig: cfg.sig, core: cfg.core, maker: cfg.maker, coin: sym.replace('USDT', ''), n: r.length, net: net(r), net2: netStress(r, TK + MK), pf: pf(r), wr: wr(r), dd: dd(r), isN, oosN, folds: f, green });
  }
  writeFileSync('data/absorption-results.json', JSON.stringify(rows, null, 2));

  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(5)} ${r.sig.padEnd(20)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(6)} +cost ${String(r.net2).padStart(6)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% DD-${String(r.dd).padStart(5)} f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  const robust = (maker: boolean) => { const m = new Map<string, string[]>(); for (const r of rows.filter((x) => x.maker === maker && x.green)) { const a = m.get(r.sig) ?? []; a.push(r.coin); m.set(r.sig, a); } return [...m.entries()].map(([sig, coins]) => ({ sig, coins: coins.sort() })).filter((x) => x.coins.length >= 4).sort((a, b) => b.coins.length - a.coins.length); };
  const tk = robust(false), mk = robust(true);
  console.log('===== A/B: MAKER vs TAKER · cross-symbol robust ≥4 =====');
  console.log(`  TAKER: ${tk.length ? tk.map((x) => `${x.sig}{${x.coins.join(',')}}`).join('  ') : '— none robust —'}`);
  console.log(`  MAKER: ${mk.length ? mk.map((x) => `${x.sig}{${x.coins.join(',')}}`).join('  ') : '— none robust —'}`);
  console.log('\n===== VERDICT =====');
  const tkB = tk[0]?.coins.length ?? 0, mkB = mk[0]?.coins.length ?? 0;
  if (mkB >= 4 && mkB >= tkB) console.log(`  ✓ MAKER robust ${mkB}/10 {${mk[0]!.coins.join(',')}} (>=taker ${tkB}) — the maker leg holds incl. adverse-selection cushion. Forward-validate.`);
  else if (tkB >= 4) console.log(`  ~ TAKER robust ${tkB}/10 {${tk[0]!.coins.join(',')}} but maker ${mkB}/10 — maker doesn't beat taker here (adverse selection eats the retest). Taker is the candidate.`);
  else console.log(`  ✗ Neither robust ${End(END_OFFSET)} — taker ${tkB}/10, maker ${mkB}/10.`);

  console.log('\n===== green rows (top by +cost) =====');
  const gr = rows.filter((r) => r.green); console.log(gr.length ? gr.sort((a, b) => b.net2 - a.net2).slice(0, 16).map(line).join('\n') : '  — none green —');

  // PORTFOLIO: pool ALL coins per config (the honest deployable metric — a rotating edge is
  // traded as an all-coins basket, not cherry-picked). Equal-weight: sum per-coin net across coins.
  console.log('\n===== ALL-COINS PORTFOLIO per config (top by pooled +cost; nCoins = coins with >=20 trades) =====');
  const byCfg = new Map<string, Row[]>();
  for (const r of rows) { const a = byCfg.get(r.sig) ?? []; a.push(r); byCfg.set(r.sig, a); }
  const port = [...byCfg.entries()].map(([sig, rs]) => {
    const pooledNet = Math.round(rs.reduce((s, r) => s + r.net, 0) * 10) / 10;
    const pooledCost = Math.round(rs.reduce((s, r) => s + r.net2, 0) * 10) / 10;
    const posCoins = rs.filter((r) => r.net2 > 0).length;
    return { sig, maker: rs[0]!.maker, nCoins: rs.length, posCoins, pooledNet, pooledCost };
  }).filter((p) => p.maker && p.nCoins >= 6).sort((a, b) => b.pooledCost - a.pooledCost);
  for (const p of port.slice(0, 10)) console.log(`  ${p.sig.padEnd(20)} ${p.nCoins} coins, ${p.posCoins} +cost-pos · pooled net ${String(p.pooledNet).padStart(7)} +cost ${String(p.pooledCost).padStart(7)}`);
  console.log('\n(+cost = survives an EXTRA maker+taker RT = adverse-selection cushion.) Full → data/absorption-results.json');
})().catch((e) => { console.error(e); process.exit(1); });

function End(o: number) { return o ? `on the OOS window (${o}d ago)` : 'on the recent window'; }
