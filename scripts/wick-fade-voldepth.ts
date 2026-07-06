/**
 * WICK-FADE VOL-SCALED DEPTH TEST — should the entry depth be DYNAMIC (∝ current volatility) instead of a
 * fixed per-coin %? Fair A/B: for each coin, compare FIXED depth (live COIN_X) vs VOL-SCALED depth
 * d_t = m · rollingVol_t, where m is calibrated PER COIN so the MEAN depth equals the fixed depth — so we
 * isolate "does ADAPTING to vol help" holding average aggressiveness constant, not "deeper vs shallower".
 * Honest requote sim (trailing anchor, same-bar stop-through, 0.25% slip), verdict at real 0.05% RT,
 * K200 permutation null, 3×180d. INCLUDES efficient-major CONTROLS (BTC/ETH/SOL/LINK) — if vol-scaling makes
 * THEM light up, it's a volatility-fitting artifact (per [[controls-catch-artifacts]]). Bybit cache (RUN ON VPS).
 *   pnpm tsx scripts/wick-fade-voldepth.ts [tf] [volWindowBars]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

type Row = { coin: string; sym: string; x: number; sides: (1 | -1)[]; ctrl?: boolean };
const BOTH: (1 | -1)[] = [1, -1], LONG: (1 | -1)[] = [1], SHORT: (1 | -1)[] = [-1];
const LIVE: Row[] = [
  { coin: 'DOGE', sym: 'DOGE', x: 0.025, sides: BOTH }, { coin: 'ICP', sym: 'ICP', x: 0.035, sides: BOTH },
  { coin: 'NEAR', sym: 'NEAR', x: 0.025, sides: BOTH }, { coin: 'ATOM', sym: 'ATOM', x: 0.03, sides: LONG },
  { coin: 'TON', sym: 'TON', x: 0.02, sides: BOTH }, { coin: 'CRV', sym: 'CRV', x: 0.03, sides: BOTH },
  { coin: 'ENA', sym: 'ENA', x: 0.025, sides: BOTH }, { coin: 'TIA', sym: 'TIA', x: 0.025, sides: BOTH },
  { coin: 'kPEPE', sym: '1000PEPE', x: 0.03, sides: BOTH }, { coin: 'RENDER', sym: 'RENDER', x: 0.03, sides: BOTH },
  { coin: 'POPCAT', sym: 'POPCAT', x: 0.025, sides: BOTH }, { coin: 'JUP', sym: 'JUP', x: 0.025, sides: BOTH },
  { coin: 'AR', sym: 'AR', x: 0.03, sides: BOTH }, { coin: 'BLUR', sym: 'BLUR', x: 0.025, sides: BOTH },
  { coin: 'LTC', sym: 'LTC', x: 0.03, sides: LONG }, { coin: 'EIGEN', sym: 'EIGEN', x: 0.03, sides: BOTH },
  { coin: 'MANTA', sym: 'MANTA', x: 0.03, sides: BOTH }, { coin: 'XRP', sym: 'XRP', x: 0.02, sides: BOTH },
  { coin: 'JTO', sym: 'JTO', x: 0.03, sides: BOTH }, { coin: 'ALT', sym: 'ALT', x: 0.03, sides: SHORT },
  { coin: 'PNUT', sym: 'PNUT', x: 0.03, sides: BOTH },
];
const CONTROLS: Row[] = [ // efficient majors — the artifact detector. A REAL edge stays dead here.
  { coin: 'BTC', sym: 'BTC', x: 0.03, sides: BOTH, ctrl: true }, { coin: 'ETH', sym: 'ETH', x: 0.03, sides: BOTH, ctrl: true },
  { coin: 'SOL', sym: 'SOL', x: 0.03, sides: BOTH, ctrl: true }, { coin: 'LINK', sym: 'LINK', x: 0.03, sides: BOTH, ctrl: true },
];
const ALL = [...LIVE, ...CONTROLS];
const TF = String(process.argv[2] ?? '5');
const VOL_W = Number(process.argv[3] ?? 48); // rolling-vol window in bars (48×5m = 4h)
const WIN_DAYS = 180, WINDOWS = [0, 180, 360], K = 200;
const SLIP = 0.0025, COST = 0.05, DRIFT = 0.01, STOP = 0.04, EXITH = 6, CD_BARS = 6;
const DMIN = 0.008, DMAX = 0.06; // clamp dynamic depth to a sane band

const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const kelly = (a: number[]) => { const m = mean(a) / 100, s = sd(a) / 100; return s > 0 ? Math.round(m / (s * s) * 100) / 100 : 0; };
function pFixed(g: number[], cost: number): number {
  const real = g.reduce((s, x) => s + x - cost, 0); let ge = 0;
  for (let s = 0; s < K; s++) { let st = (Math.imul(2654435761, s + 1) >>> 4) & 0x7fffffff, acc = 0; for (const x of g) { st = (Math.imul(st, 1103515245) + 12345) & 0x7fffffff; acc += ((st / 0x7fffffff) < 0.5 ? -x : x) - cost; } if (acc >= real) ge++; }
  return ge / K;
}
/** rolling std of 1-bar log returns (a per-bar % vol proxy) */
function volArr(c: Candle[], W: number): number[] {
  const r = c.map((k, i) => (i > 0 && c[i - 1]!.c > 0) ? Math.log(k.c / c[i - 1]!.c) : 0);
  const out = new Array(c.length).fill(0);
  for (let i = W; i < c.length; i++) { let m = 0; for (let j = i - W + 1; j <= i; j++) m += r[j]!; m /= W; let v = 0; for (let j = i - W + 1; j <= i; j++) { const d = r[j]! - m; v += d * d; } out[i] = Math.sqrt(v / (W - 1)); }
  return out;
}

type T = { g: number };
/** honest requote sim with a per-bar depth function (dynamic or constant). */
function sim(c: Candle[], sides: (1 | -1)[], depthAt: (i: number) => number): T[] {
  const n = c.length; const out: T[] = [];
  let anchor = 0, cdUntil = -1;
  let pos: { side: 1 | -1; entry: number; anchorMid: number; entryBar: number } | null = null;
  for (let i = 1; i < n; i++) {
    const bar = c[i]!;
    if (pos) {
      const target = pos.anchorMid;
      const stopPx = pos.side === 1 ? pos.entry * (1 - STOP) : pos.entry * (1 + STOP);
      const stopFill = pos.side === 1 ? stopPx * (1 - SLIP) : stopPx * (1 + SLIP);
      let exit: number | null = null;
      if (pos.side === 1 ? bar.l <= stopPx : bar.h >= stopPx) { exit = stopFill; }
      else if (pos.side === 1 ? bar.h >= target : bar.l <= target) { exit = target; }
      else if (i - pos.entryBar >= EXITH) { exit = bar.c; }
      if (exit != null) { out.push({ g: (pos.side === 1 ? (exit - pos.entry) / pos.entry : (pos.entry - exit) / pos.entry) * 100 }); if (exit === stopFill) cdUntil = i + CD_BARS; pos = null; anchor = 0; }
      continue;
    }
    if (i <= cdUntil) continue;
    if (anchor <= 0) anchor = c[i - 1]!.c;
    const d = depthAt(i);
    let filled: { side: 1 | -1; entry: number } | null = null;
    for (const side of sides) { const limit = side === 1 ? anchor * (1 - d) : anchor * (1 + d); if (side === 1 ? bar.l <= limit : bar.h >= limit) { if (!filled || (side === 1 ? limit > filled.entry : limit < filled.entry)) filled = { side, entry: limit }; } }
    if (filled) {
      const stopPx = filled.side === 1 ? filled.entry * (1 - STOP) : filled.entry * (1 + STOP);
      if (filled.side === 1 ? bar.l <= stopPx : bar.h >= stopPx) { const sf = filled.side === 1 ? stopPx * (1 - SLIP) : stopPx * (1 + SLIP); out.push({ g: (filled.side === 1 ? (sf - filled.entry) / filled.entry : (filled.entry - sf) / filled.entry) * 100 }); cdUntil = i + CD_BARS; anchor = 0; }
      else { pos = { side: filled.side, entry: filled.entry, anchorMid: anchor, entryBar: i }; anchor = 0; }
      continue;
    }
    if (Math.abs(bar.c - anchor) / anchor > DRIFT) anchor = bar.c;
  }
  return out;
}

function verdict(label: string, perWin: number[][]): { net: number; fills: number } {
  const g = perWin.flat();
  if (g.length < 20) { console.log(`${label.padEnd(20)} n=${g.length} — too few`); return { net: 0, fills: g.length }; }
  const net = Math.round((mean(g) - COST) * g.length * 10) / 10;
  const wNets = perWin.map((w) => w.length ? Math.round((mean(w) - COST) * w.length * 10) / 10 : NaN);
  const persist = perWin.filter((w) => w.length >= 8 && (mean(w) - COST) * w.length > 0).length;
  const p = pFixed(g, COST); const kel = kelly(g.map((x) => x - COST));
  const keep = net > 0 && p < 0.05 && kel > 0 && persist >= 2;
  console.log(`${label.padEnd(20)} ${String(g.length).padStart(5)}  ${mean(g).toFixed(3).padStart(7)} ${String(net).padStart(8)}  ${wNets.map((x) => Number.isNaN(x) ? '—' : String(x)).join('/').padEnd(20)} ${String(kel).padStart(6)} ${persist}/3 ${p.toFixed(2)}  ${keep ? '✅' : '❌'}`);
  return { net, fills: g.length };
}

(async () => {
  console.log(`VOL-DEPTH A/B · ${TF}m · rollingVol W=${VOL_W} · fixed vs vol-scaled (mean-matched) · verdict@${COST} · K${K}\n`);
  const data: { row: Row; wins: Candle[][] }[] = [];
  for (const row of ALL) {
    const wins: Candle[][] = [];
    for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { const c = await getKlines(`${row.sym}USDT`, TF, end - WIN_DAYS * 86_400_000, end); wins.push(c.length >= 3000 ? c : []); } catch { wins.push([]); } }
    data.push({ row, wins }); process.stderr.write(`  ${row.coin}${row.ctrl ? ' [ctrl]' : ''}\n`);
  }

  console.log('coin/group           n      avg%     net@.05  w0/w1/w2             Kelly  per  p   keep');
  const poolFixLive: number[][] = [[], [], []], poolVolLive: number[][] = [[], [], []];
  const poolFixCtrl: number[][] = [[], [], []], poolVolCtrl: number[][] = [[], [], []];
  for (const { row, wins } of data) {
    const fixW: number[][] = [[], [], []], volW: number[][] = [[], [], []];
    wins.forEach((c, wi) => {
      if (!c.length) return;
      const vol = volArr(c, VOL_W);
      // CAUSAL calibration (no in-sample look-ahead): depth_t = fixedX × vol_t / EWMA(vol)_t — the depth is the
      // fixed % scaled by how CURRENT vol compares to its own TRAILING mean (α=0.01 ≈ 100-bar memory). Uses only
      // PAST vol, so it's exactly what live could do. Warmup (vol not yet defined) → fixed x.
      const ew = new Array(c.length).fill(0); let e = 0, seed = false;
      for (let k = 0; k < c.length; k++) { const v = vol[k]!; if (v > 0) { if (!seed) { e = v; seed = true; } else { e = e + 0.01 * (v - e); } } ew[k] = e; }
      const fixT = sim(c, row.sides, () => row.x);
      const volT = sim(c, row.sides, (i) => { const v = vol[i]!, b = ew[i]!; return (v > 0 && b > 0) ? Math.min(DMAX, Math.max(DMIN, row.x * v / b)) : row.x; });
      fixW[wi]!.push(...fixT.map((t) => t.g)); volW[wi]!.push(...volT.map((t) => t.g));
      (row.ctrl ? poolFixCtrl : poolFixLive).forEach((p, k) => p.push(...(k === wi ? fixT.map((t) => t.g) : [])));
      (row.ctrl ? poolVolCtrl : poolVolLive).forEach((p, k) => p.push(...(k === wi ? volT.map((t) => t.g) : [])));
    });
    if (!row.ctrl) { verdict(`${row.coin} fix`, fixW); verdict(`${row.coin} VOL`, volW); }
  }
  console.log('\n── POOLED (the decision) ──');
  const fL = verdict('LIVE fixed', poolFixLive); const vL = verdict('LIVE vol-scaled', poolVolLive);
  console.log('── CONTROLS (must stay ❌ / near-zero — else vol-scaling is a fitting artifact) ──');
  verdict('CTRL fixed', poolFixCtrl); verdict('CTRL vol-scaled', poolVolCtrl);
  console.log(`\nDECISION: vol-scaling wins only if LIVE vol-scaled net (${vL.net}) clearly BEATS LIVE fixed (${fL.net}) AND passes the null AND controls stay dead. Fill counts: fixed ${fL.fills} vs vol ${vL.fills} (a big gap = different aggressiveness, not just adaptation).`);
})().catch((e) => { console.error(e); process.exit(1); });
