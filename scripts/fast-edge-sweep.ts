/**
 * FAST-EDGE SWEEP — search for a NEW fast-market strategy family through the HONEST battery (post-audit:
 * corrected Math.imul null, one-position lock, no look-ahead, real taker costs). Two data-grounded families:
 *
 * F1. FLUSH-MOMENTUM — follow a high-volume dislocation instead of fading it. Grounded in OUR OWN gated-fade
 *     result: fading volume-spike dislocations was catastrophic (Kelly to −7) → the counterparty (the follower)
 *     was earning. Entry: bar |ret| ≥ T (with/without vol-z≥2 gate) → enter at NEXT bar's OPEN in the move's
 *     direction (taker, no look-ahead). Exit: 2% stop or close of H bars.
 * F2. LEAD-LAG BTC→alt — a BTC 5m shock (rolling z ≥ Z) → enter the alt in the same direction next bar open,
 *     stop 2%, exit close of H bars. Dead on majors for years; thin retail alts may still lag.
 *
 * Costs: taker+taker RT = 0.09% base (HL 0.045×2), stress 0.15%. Pooled ACROSS the 21 live alts per config
 * (family-level evidence first — a real family shows up broadly, not on one coin); majors pooled as reference.
 * MULTIPLE TESTING: 16 configs total → demand pooled p≤0.005-ish + meaningful effect size before any per-coin
 * digging (per [[kill-lens-recalibrated]]: count vs chance expectation). Bybit cache (RUN ON VPS).
 *   pnpm tsx scripts/fast-edge-sweep.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const ALTS = ['DOGE', 'ICP', 'NEAR', 'ATOM', 'TON', 'CRV', 'ENA', 'TIA', '1000PEPE', 'RENDER', 'POPCAT', 'JUP', 'AR', 'BLUR', 'LTC', 'EIGEN', 'MANTA', 'XRP', 'JTO', 'ALT', 'PNUT'];
const MAJORS = ['ETH', 'SOL', 'LINK'];
const TF = String(process.argv[2] ?? '5');
const WIN_DAYS = 180, WINDOWS = [0, 180, 360], K = 200;
const VOL_W = 96, STOPP = 0.02;
const COST = 0.09; // taker entry + taker exit at HL base tier (0.045×2); stress column at 0.15

const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const kelly = (a: number[]) => { const m = mean(a) / 100, s = sd(a) / 100; return s > 0 ? Math.round(m / (s * s) * 100) / 100 : 0; };
function pFixed(g: number[], cost: number): number {
  const real = g.reduce((s, x) => s + x - cost, 0);
  let ge = 0;
  for (let s = 0; s < K; s++) {
    let st = (Math.imul(2654435761, s + 1) >>> 4) & 0x7fffffff, acc = 0;
    for (const x of g) { st = (Math.imul(st, 1103515245) + 12345) & 0x7fffffff; acc += ((st / 0x7fffffff) < 0.5 ? -x : x) - cost; }
    if (acc >= real) ge++;
  }
  return ge / K;
}

function volZ(c: Candle[], i: number): number {
  if (i < VOL_W) return -99;
  let s = 0, ss = 0; for (let j = i - VOL_W; j < i; j++) { const v = c[j]!.v; s += v; ss += v * v; }
  const m = s / VOL_W, sdv = Math.sqrt(Math.max(0, ss / VOL_W - m * m));
  return sdv > 0 ? (c[i]!.v - m) / sdv : 0;
}

/** F1: follow a |ret|≥T bar (optionally vol-gated). Entry NEXT bar open; stop 2% intrabar; exit close of H. */
function momentum(c: Candle[], T: number, vz: number, H: number): number[] {
  const n = c.length; const out: number[] = []; let guard = -1;
  for (let i = VOL_W + 1; i < n - H - 2; i++) {
    if (i <= guard) continue;
    const ret = c[i]!.c / c[i - 1]!.c - 1;
    if (Math.abs(ret) < T) continue;
    if (vz > 0 && volZ(c, i) < vz) continue;
    const dir = ret > 0 ? 1 : -1;
    const entry = c[i + 1]!.o; if (!(entry > 0)) continue;
    const stopPx = dir === 1 ? entry * (1 - STOPP) : entry * (1 + STOPP);
    let exit = c[i + 1 + H]!.c, exitBar = i + 1 + H;
    for (let j = i + 1; j <= i + 1 + H; j++) {
      if (dir === 1 ? c[j]!.l <= stopPx : c[j]!.h >= stopPx) { exit = stopPx; exitBar = j; break; }
    }
    out.push(dir * (exit / entry - 1) * 100);
    guard = exitBar;
  }
  return out;
}

/** F2: BTC z-shock → same-direction alt entry next bar open; stop 2%; exit close of H. btc aligned by ts. */
function leadlag(c: Candle[], btcZ: Map<number, number>, Z: number, H: number): number[] {
  const n = c.length; const out: number[] = []; let guard = -1;
  for (let i = 1; i < n - H - 2; i++) {
    if (i <= guard) continue;
    const z = btcZ.get(c[i]!.t); if (z == null || Math.abs(z) < Z) continue;
    const dir = z > 0 ? 1 : -1;
    const entry = c[i + 1]!.o; if (!(entry > 0)) continue;
    const stopPx = dir === 1 ? entry * (1 - STOPP) : entry * (1 + STOPP);
    let exit = c[i + 1 + H]!.c, exitBar = i + 1 + H;
    for (let j = i + 1; j <= i + 1 + H; j++) {
      if (dir === 1 ? c[j]!.l <= stopPx : c[j]!.h >= stopPx) { exit = stopPx; exitBar = j; break; }
    }
    out.push(dir * (exit / entry - 1) * 100);
    guard = exitBar;
  }
  return out;
}

function btcZSeries(btc: Candle[]): Map<number, number> {
  const m = new Map<number, number>(); const W = 288;
  const rets: number[] = [0];
  for (let i = 1; i < btc.length; i++) rets.push(btc[i]!.c / btc[i - 1]!.c - 1);
  let s = 0, ss = 0;
  for (let i = 1; i < btc.length; i++) {
    s += rets[i]!; ss += rets[i]! * rets[i]!;
    if (i > W) { s -= rets[i - W]!; ss -= rets[i - W]! * rets[i - W]!; }
    if (i >= W) { const mu = s / W, sdv = Math.sqrt(Math.max(0, ss / W - mu * mu)); if (sdv > 0) m.set(btc[i]!.t, (rets[i]! - mu) / sdv); }
  }
  return m;
}

function report(label: string, g: number[]): void {
  if (g.length < 50) { console.log(`${label.padEnd(34)} n=${g.length} — too few`); return; }
  const net = (cost: number) => Math.round((mean(g) - cost) * g.length * 10) / 10;
  const p = pFixed(g, COST);
  const ok = net(COST) > 0 && p < 0.005; // family-level bar (16 configs → Bonferroni-ish)
  console.log(`${label.padEnd(34)} ${String(g.length).padStart(6)}  avg ${mean(g).toFixed(3).padStart(7)}  net@.09 ${String(net(COST)).padStart(8)}  @.15 ${String(net(0.15)).padStart(8)}  K ${String(kelly(g.map((x) => x - COST))).padStart(6)}  p ${p.toFixed(3)}  ${ok ? '⭐ CANDIDATE' : ''}`);
}

(async () => {
  console.log(`FAST-EDGE SWEEP · ${TF}m · honest framework (next-bar-open entry, taker RT ${COST}%, fixed null K${K}, lock) · 3×${WIN_DAYS}d\n`);
  // load everything once
  const data = new Map<string, Candle[][]>();
  for (const coin of [...ALTS, ...MAJORS, 'BTC']) {
    const wins: Candle[][] = [];
    for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { const c = await getKlines(`${coin}USDT`, TF, end - WIN_DAYS * 86_400_000, end); wins.push(c.length >= 3000 ? c : []); } catch { wins.push([]); } }
    data.set(coin, wins);
    process.stderr.write(`  ${coin} loaded\n`);
  }
  const btcZ = (data.get('BTC') ?? []).map((w) => w.length ? btcZSeries(w) : new Map<number, number>());

  console.log('── F1 FLUSH-MOMENTUM (follow the dislocation) — pooled ALTS ──');
  for (const T of [0.015, 0.02, 0.03]) for (const vz of [0, 2]) for (const H of [6, 12]) {
    const g: number[] = [];
    for (const coin of ALTS) (data.get(coin) ?? []).forEach((w) => { if (w.length) g.push(...momentum(w, T, vz, H)); });
    report(`F1 T=${(T * 100).toFixed(1)}% volz${vz} H=${H}`, g);
  }
  console.log('── F1 reference: pooled MAJORS (efficient) ──');
  for (const T of [0.015, 0.02]) for (const H of [6, 12]) {
    const g: number[] = [];
    for (const coin of MAJORS) (data.get(coin) ?? []).forEach((w) => { if (w.length) g.push(...momentum(w, T, 2, H)); });
    report(`F1ref T=${(T * 100).toFixed(1)}% volz2 H=${H}`, g);
  }
  console.log('── F2 LEAD-LAG BTC→alt — pooled ALTS ──');
  for (const Z of [2.5, 3.5]) for (const H of [6, 12]) {
    const g: number[] = [];
    for (const coin of ALTS) (data.get(coin) ?? []).forEach((w, wi) => { if (w.length && btcZ[wi]) g.push(...leadlag(w, btcZ[wi]!, Z, H)); });
    report(`F2 Z=${Z} H=${H}`, g);
  }
  console.log('\n⭐ = pooled net>0 at real taker cost AND p<0.005 (16-config multiple-testing bar). A real family is BROAD; only then dig per-coin + cross-window.');
})().catch((e) => { console.error(e); process.exit(1); });
