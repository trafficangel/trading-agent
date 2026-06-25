/**
 * MARK-PULL — fast (≈1-15m) MAKER reversion on the HL book-mid's dislocation from
 * the oracle. Mechanism: HL mark = oracle + book-EMA; when the book mid runs ahead/
 * behind the CEX-anchored oracle, mark-pull + arb drag it back on a ~150s timescale.
 * Rest a passive limit on the RICH side of a premium z-spike, exit as premium decays
 * to zero. Market-neutral-ish, maker (survives fees), short holds → fits 5/15m.
 *
 * Reads mid/oracle per-minute straight from hl_micro (NO klines). The mid IS the price
 * path. premium = (mid − oracle)/oracle; z = premium / rollingStd(premium, N).
 * CONSERVATIVE fill = touch + an EXTRA maker+taker RT cushion (+cost col) — the same
 * adverse-selection guard the liq-vacuum used (the 5m maker book died on optimistic fills).
 *
 * DATA CAVEAT: only ~9 days of mid/oracle so far → this is a PRELIMINARY cross-symbol
 * read, NOT a robust verdict. Kill if no edge; if promising, forward-collect + re-run.
 * Run on the VPS. pnpm tsx scripts/backtest-markpull.ts
 */
import { db } from '../src/db/client.js';

const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'LTC', 'LINK', 'DOGE', 'AVAX'];
const MK = 0.02, TK = 0.045; // HL maker / taker per side %

type Row = { ts: number; mid: number | null; oracle: number | null };
const loadStmt = db.prepare<[string], Row>(
  `SELECT ts, mid, oracle FROM hl_micro WHERE coin = ? AND mid IS NOT NULL AND oracle IS NOT NULL ORDER BY ts ASC`,
);

function rollStd(a: number[], W: number): number[] {
  const out = new Array<number>(a.length); let s = 0, ss = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i]!; ss += a[i]! * a[i]!;
    if (i >= W) { s -= a[i - W]!; ss -= a[i - W]! * a[i - W]!; }
    const n = Math.min(i + 1, W); const mean = s / n; const v = Math.max(0, ss / n - mean * mean);
    out[i] = Math.sqrt(v);
  }
  return out;
}

type Cfg = { sig: string; N: number; entryZ: number; exitZ: number; d: number; ttl: number; hold: number; sl: number };
const CFGS: Cfg[] = [];
for (const N of [60, 120]) for (const entryZ of [2, 2.5, 3]) for (const exitZ of [0.25, 0.5]) for (const d of [0.0005, 0.001])
  CFGS.push({ sig: `N${N}z${entryZ}x${exitZ}d${d}`, N, entryZ, exitZ, d, ttl: 5, hold: 30, sl: 0.01 });

/** realized NET % per trade (maker reversion on the premium dislocation). */
function run(mid: number[], prem: number[], cfg: Cfg): number[] {
  const std = rollStd(prem, cfg.N);
  const out: number[] = []; const n = mid.length;
  let i = cfg.N;
  while (i < n - 1) {
    const sd = std[i]!;
    if (!(sd > 0)) { i++; continue; }
    const z = prem[i]! / sd;
    let side: 1 | -1 | 0 = 0;            // +1 long (cheap, premium<0), -1 short (rich, premium>0)
    if (z >= cfg.entryZ) side = -1; else if (z <= -cfg.entryZ) side = 1;
    if (side === 0) { i++; continue; }
    const limit = side === -1 ? mid[i]! * (1 + cfg.d) : mid[i]! * (1 - cfg.d); // rest on the rich/cheap side
    let fi = -1;
    for (let j = i + 1; j <= Math.min(n - 1, i + cfg.ttl); j++) { if (side === -1 ? mid[j]! >= limit : mid[j]! <= limit) { fi = j; break; } }
    if (fi < 0) { i++; continue; }
    const entry = limit;
    const slPx = side === -1 ? entry * (1 + cfg.sl) : entry * (1 - cfg.sl);
    let exit = 0; let exitFee = TK;
    let k = fi + 1; const kmax = Math.min(n - 1, fi + cfg.hold);
    for (; k <= kmax; k++) {
      if (side === -1 ? mid[k]! >= slPx : mid[k]! <= slPx) { exit = slPx; exitFee = TK; break; } // catastrophe
      const zk = std[k]! > 0 ? prem[k]! / std[k]! : 0;
      if (Math.abs(zk) <= cfg.exitZ) { exit = mid[k]!; exitFee = MK; break; }                    // premium reverted (maker exit)
    }
    if (exit === 0) { exit = mid[kmax]!; exitFee = TK; }                                          // time exit
    const gross = side === -1 ? (entry - exit) / entry * 100 : (exit - entry) / entry * 100;
    out.push(gross - MK - exitFee);
    i = k + 1;
  }
  return out;
}

function net(r: number[]) { return Math.round(r.reduce((s, x) => s + x, 0) * 10) / 10; }
function netStress(r: number[], e: number) { return Math.round(r.reduce((s, x) => s + x - e, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let p = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) p++; } return p; }

type R = { sig: string; coin: string; n: number; net: number; net2: number; pf: number; wr: number; isN: number; oosN: number; folds: number; green: boolean };

(() => {
  console.log(`MARK-PULL maker reversion · 1m mid/oracle · ${COINS.length} coins · ${CFGS.length} cfgs · maker ${MK}/taker ${TK}% · ⚠ ~9d window (preliminary)\n`);
  const data = new Map<string, { mid: number[]; prem: number[] }>();
  for (const coin of COINS) {
    const rows = loadStmt.all(coin);
    if (rows.length < 500) continue;
    const mid: number[] = [], prem: number[] = [];
    for (const r of rows) { mid.push(r.mid!); prem.push((r.mid! - r.oracle!) / r.oracle!); }
    data.set(coin, { mid, prem });
  }
  const rows: R[] = [];
  for (const cfg of CFGS) for (const [coin, d] of data) {
    const r = run(d.mid, d.prem, cfg);
    if (r.length < 25) continue;
    const cut = Math.floor(r.length * 0.7);
    const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
    const green = r.length >= 30 && net(r) > 0 && pf(r) > 1.3 && isN > 0 && oosN > 0 && netStress(r, MK + TK) > 0 && f >= 3;
    rows.push({ sig: cfg.sig, coin, n: r.length, net: net(r), net2: netStress(r, MK + TK), pf: pf(r), wr: wr(r), isN, oosN, folds: f, green });
  }
  const bySig = new Map<string, R[]>();
  for (const r of rows) { const a = bySig.get(r.sig) ?? []; a.push(r); bySig.set(r.sig, a); }
  const robust = [...bySig.entries()].map(([sig, rs]) => ({ sig, g: rs.filter((r) => r.green).map((r) => r.coin).sort() })).filter((x) => x.g.length >= 4).sort((a, b) => b.g.length - a.g.length);
  const line = (r: R) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(5)} ${r.sig.padEnd(16)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(6)} +cost ${String(r.net2).padStart(6)} PF ${String(r.pf).padStart(5)} WR ${r.wr}% f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  console.log(`===== ROBUST (green-incl-+cost on ≥4/${COINS.length}) =====`);
  if (!robust.length) console.log('  — none robust —');
  for (const x of robust.slice(0, 5)) console.log(`  ◆ ${x.sig} → ${x.g.length}/10 {${x.g.join(',')}}`);
  console.log(`\nGreen rows: ${rows.filter((r) => r.green).length}. Top by +cost:`);
  console.log(rows.sort((a, b) => b.net2 - a.net2).slice(0, 12).map(line).join('\n') || '  — none —');
  console.log(`\n===== VERDICT =====`);
  console.log(robust.length ? `  ✓ PRELIMINARY edge — ${robust[0]!.sig} robust on ${robust[0]!.g.length}/10 {${robust[0]!.g.join(',')}}. Forward-collect more mid/oracle + re-run before trusting.` : `  ✗ No cross-symbol edge on this 9d window. Mark-pull as-specified does not clear the bar (yet / at all).`);
  console.log('\n(+cost = survives an EXTRA maker+taker RT.)');
})();
