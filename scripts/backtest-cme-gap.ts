/**
 * CME WEEKEND GAP-FILL — the one real "gap" in 24/7 crypto. CME BTC/ETH futures halt Fri ~21:00 UTC
 * and reopen Sun ~22:00 UTC; over the weekend the 24/7 (Bybit) price moves, leaving a GAP at reopen.
 * The folk pattern: price tends to revisit ("fill") the Friday-close level. We test it honestly:
 * at the Sun reopen, if |gap| >= gapThr, bet the FILL direction (toward the Friday close), target =
 * the Friday close, SL = slPct, time-stop = holdDays. Net per trade after HL taker. SLOW (weekly,
 * days-to-fill) — NOT a fast strategy, but a genuinely untested mechanism, testable on klines we have.
 *
 * Approximates the CME gap with Bybit's 24/7 price at the CME close/open timestamps (CME ~= spot there).
 * Reports fill rate + net + IS/OOS + folds, and a PLACEBO (random anchor level) to check the FRIDAY-CLOSE
 * level specifically matters (vs generic mean-reversion). Run on the VPS. pnpm tsx scripts/backtest-cme-gap.ts [days]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 700);
const TK = 0.07; // HL taker RT %
const PLACEBO = process.env.PLACEBO === '1';

type Cfg = { sig: string; gapThr: number; slPct: number; holdDays: number };
const CFGS: Cfg[] = [];
for (const gapThr of [0.003, 0.005, 0.01]) for (const slPct of [0.02, 0.04]) for (const holdDays of [3, 5, 7])
  CFGS.push({ sig: `g${gapThr * 1000}sl${slPct * 100}h${holdDays}`, gapThr, slPct, holdDays });

const HR = 3_600_000;
function nearest(map: Map<number, number>, ts: number): number | null {
  for (let d = 0; d <= 3; d++) { if (map.has(ts + d * HR)) return map.get(ts + d * HR)!; if (map.has(ts - d * HR)) return map.get(ts - d * HR)!; }
  return null;
}

/** Each weekend: anchor = Fri 21:00 UTC close, reopen = Sun 22:00 UTC close. Bet the gap-fill. NET % per trade. */
function run(c: Candle[], cfg: Cfg): { r: number[]; gaps: number; filled: number } {
  const map = new Map<number, number>();
  for (const k of c) map.set(k.t - (k.t % HR), k.c); // hour-bucket → close
  const tsArr = c.map((k) => k.t - (k.t % HR)).sort((a, b) => a - b);
  const r: number[] = []; let gaps = 0, filled = 0; let placeboSeed = 12345;
  for (const k of c) {
    const dt = new Date(k.t);
    if (dt.getUTCDay() !== 5 || dt.getUTCHours() !== 21) continue;     // Friday 21:00 UTC = CME close
    const friTs = k.t - (k.t % HR);
    const sunTs = friTs + 49 * HR;                                     // Sun 22:00 UTC reopen (~49h later)
    let anchor = nearest(map, friTs);                                  // Friday close (the gap-fill target)
    const reopen = nearest(map, sunTs);
    if (anchor == null || reopen == null) continue;
    if (PLACEBO) { placeboSeed = (placeboSeed * 1103515245 + 12345) & 0x7fffffff; anchor = reopen * (1 + ((placeboSeed / 0x7fffffff) - 0.5) * 0.04); } // random anchor ±2% — should kill a real gap edge
    const gap = (reopen - anchor) / anchor;
    if (Math.abs(gap) < cfg.gapThr) continue;
    gaps++;
    const side: 1 | -1 = reopen > anchor ? -1 : 1;                     // gapped up → short to fill down; gapped down → long
    const entry = reopen; const target = anchor;
    const slPx = side === 1 ? entry * (1 - cfg.slPct) : entry * (1 + cfg.slPct);
    const endTs = sunTs + cfg.holdDays * 24 * HR;
    let exit = 0; let hit = false;
    for (let t = sunTs + HR; t <= endTs; t += HR) {
      const px = map.get(t); if (px == null) continue;
      if (side === 1 ? px <= slPx : px >= slPx) { exit = slPx; break; }       // catastrophe stop
      if (side === 1 ? px >= target : px <= target) { exit = target; hit = true; break; } // gap filled
    }
    if (exit === 0) { exit = nearest(map, endTs) ?? entry; }                   // time-stop
    if (hit) filled++;
    const gross = side === 1 ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
    r.push(gross - TK);
    void tsArr;
  }
  return { r, gaps, filled };
}

function net(r: number[], e = 0) { return Math.round(r.reduce((s, x) => s + x - e, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }

(async () => {
  console.log(`CME WEEKEND GAP-FILL · BTC+ETH · ${DAYS}d (~${Math.round(DAYS / 7)} weekends) · HL taker ${TK}%${PLACEBO ? ' · PLACEBO(random anchor)' : ''}\n`);
  for (const sym of SYMBOLS) {
    const c = await getKlines(sym, '60', NOW - DAYS * 86_400_000, NOW);
    console.log(`===== ${sym.replace('USDT', '')} (${c.length} 1h bars) =====`);
    const rowsOut: string[] = [];
    for (const cfg of CFGS) {
      const { r, gaps, filled } = run(c, cfg);
      if (r.length < 10) continue;
      const cut = Math.floor(r.length * 0.7);
      const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
      const n1 = net(r), n2 = net(r, TK);
      const green = r.length >= 12 && n1 > 0 && pf(r) > 1.2 && isN > 0 && oosN > 0 && n2 > 0;
      rowsOut.push(`${green ? '✅' : '  '} ${cfg.sig.padEnd(12)} N${String(r.length).padStart(3)} fill ${gaps ? Math.round(filled / gaps * 100) : 0}% net ${String(n1).padStart(6)} +cost ${String(n2).padStart(6)} PF ${String(pf(r)).padStart(5)} WR ${String(wr(r)).padStart(2)}% f${f}/4 IS/OOS ${isN}/${oosN}`);
    }
    console.log(rowsOut.join('\n') || '  — too few gaps —');
    console.log('');
  }
  console.log('VERDICT: a real gap edge = green configs (net>0 after cost, IS/OOS+, folds) that DIE under PLACEBO=1 (random anchor).');
})().catch((e) => { console.error(e); process.exit(1); });
