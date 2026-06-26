/**
 * BOOK-IMBALANCE FLIP — the verified funding-flip MECHANISM applied to the DENSE order-book
 * imbalance data (hl_micro.book_imb, ~6mo per-minute, all coins). The last principled fast-HL
 * angle on data we have. book_imb = top-5 L2 imbalance in [-1,1]; when it is EXTREME one-sided
 * (z-score) and then FLIPS sign, the lop-sided book just cleared/reversed → trade the move.
 * A/B on direction (fade the flushed side = snapback, vs follow) because book-flip direction is
 * not a-priori obvious (unlike funding where fading the crowd is clear). PLACEBO control wired
 * (shuffle imb → edge MUST die) — the same falsifier that confirmed funding-flip was real.
 *
 * Fast (5m/15m bars, minutes-to-hours hold) → launchable in HL test mode if it survives. Causal:
 * imb[<=i], enter at close[i], time-stop. Run on the VPS. pnpm tsx scripts/sweep-bookflip.ts [tf] [days]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const TF = process.argv[2] ?? '5';
const DAYS = Number(process.argv[3] ?? 170);
const HL_TAKER = 0.07;
const PLACEBO = process.env.PLACEBO === '1';

function rollMeanStd(a: (number | null)[], i: number, W: number) {
  let s = 0, ss = 0, n = 0;
  for (let j = Math.max(0, i - W + 1); j <= i; j++) { const v = a[j]; if (v != null) { s += v; ss += v * v; n++; } }
  if (n < W / 2) return { m: 0, sd: 0 };
  const m = s / n; return { m, sd: Math.sqrt(Math.max(0, ss / n - m * m)) };
}

type Cfg = { sig: string; core: string; W: number; zThr: number; fw: number; hold: number; follow: boolean };
const CFGS: Cfg[] = [];
for (const W of [120, 240]) for (const zThr of [1.5, 2, 2.5]) for (const fw of [3, 6]) for (const hold of [6, 12]) for (const follow of [false, true]) {
  const core = `W${W}z${zThr}fw${fw}h${hold}`;
  CFGS.push({ sig: `${core}${follow ? '_F' : '_R'}`, core, W, zThr, fw, hold, follow });
}

/** book_imb extreme then sign-flip → trade. follow=continue, !follow=fade(snapback). NET % per trade. */
function run(c: Candle[], imb: (number | null)[], cfg: Cfg): number[] {
  const out: number[] = []; const n = c.length; let guard = -1;
  for (let i = cfg.W; i < n - 1; i++) {
    if (i <= guard) continue;
    const { m, sd } = rollMeanStd(imb, i, cfg.W);
    if (!(sd > 0)) continue;
    const prevWin = imb.slice(Math.max(0, i - cfg.fw - 1), i);
    const wasPos = prevWin.some((v) => v != null && (v - m) / sd >= cfg.zThr);
    const wasNeg = prevWin.some((v) => v != null && (v - m) / sd <= -cfg.zThr);
    const now = imb[i]; const prev = imb[i - 1];
    if (now == null || prev == null) continue;
    let flip: 1 | -1 | 0 = 0; // +1 = was bid-heavy(pos) flipped to ask(neg); -1 = opposite
    if (wasPos && prev - m > 0 && now - m <= 0) flip = 1;
    else if (wasNeg && prev - m < 0 && now - m >= 0) flip = -1;
    if (flip === 0) continue;
    // fade(snapback): bid-pressure flushed (flip=1) -> price likely fell, fade = long. follow = opposite.
    const fadeSide: 1 | -1 = flip === 1 ? 1 : -1;
    const side: 1 | -1 = cfg.follow ? (fadeSide === 1 ? -1 : 1) : fadeSide;
    const entry = c[i]!.c; const kmax = Math.min(n - 1, i + cfg.hold);
    const exit = c[kmax]!.c;
    const gross = side === 1 ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
    out.push(gross - HL_TAKER);
    guard = kmax;
  }
  return out;
}

function net(r: number[], e = 0) { return Math.round(r.reduce((s, x) => s + x - e, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }

type Row = { sig: string; core: string; follow: boolean; coin: string; n: number; net: number; net2: number; pf: number; wr: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  console.log(`BOOK-IMB FLIP · ${TF}m · ${SYMBOLS.length} coins · ${CFGS.length} cfgs (follow/fade A/B) · ${DAYS}d · HL taker ${HL_TAKER}%${PLACEBO ? ' · PLACEBO' : ''}\n`);
  const data = new Map<string, { c: Candle[]; imb: (number | null)[]; cov: number }>();
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    try {
      const c = await getKlines(sym, TF, NOW - DAYS * 86_400_000, NOW);
      let imb = loadMicroAligned(coin, TF, c).imb;
      if (PLACEBO) { const sh = Math.floor(imb.length / 2) + 137; imb = imb.map((_, i) => imb[(i + sh) % imb.length]!); }
      const cov = Math.round((imb.filter((x) => x != null).length / c.length) * 100);
      data.set(sym, { c, imb, cov });
    } catch (e) { process.stderr.write(`${sym}: ${(e as Error).message}\n`); }
  }
  console.log('book_imb coverage: ' + [...data.entries()].map(([s, d]) => `${s.replace('USDT', '')}:${d.cov}`).join(' ') + '\n');

  const rows: Row[] = [];
  for (const cfg of CFGS) for (const [sym, d] of data) {
    if (d.c.length < 500 || d.cov < 30) continue;
    const r = run(d.c, d.imb, cfg);
    if (r.length < 15) continue;
    const cut = Math.floor(r.length * 0.7);
    const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
    const green = r.length >= 20 && net(r) > 0 && pf(r) > 1.2 && isN > 0 && oosN > 0 && net(r, HL_TAKER) > 0 && (r.length >= 16 ? f >= 3 : true);
    rows.push({ sig: cfg.sig, core: cfg.core, follow: cfg.follow, coin: sym.replace('USDT', ''), n: r.length, net: net(r), net2: net(r, HL_TAKER), pf: pf(r), wr: wr(r), isN, oosN, folds: f, green });
  }
  writeFileSync('data/bookflip-results.json', JSON.stringify(rows, null, 2));

  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(5)} ${r.sig.padEnd(18)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(6)} +cost ${String(r.net2).padStart(6)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  const robust = (follow: boolean) => { const m = new Map<string, string[]>(); for (const r of rows.filter((x) => x.follow === follow && x.green)) { const a = m.get(r.core) ?? []; a.push(r.coin); m.set(r.core, a); } return [...m.entries()].map(([core, coins]) => ({ core, coins: coins.sort() })).filter((x) => x.coins.length >= 4).sort((a, b) => b.coins.length - a.coins.length); };
  const fO = robust(true), fA = robust(false);
  console.log('===== A/B: FOLLOW vs FADE(snapback) · cross-symbol robust >=4/10 =====');
  console.log(`  FADE  : ${fA.length ? fA.map((x) => `${x.core}{${x.coins.join(',')}}`).join('  ') : '— none robust —'}`);
  console.log(`  FOLLOW: ${fO.length ? fO.map((x) => `${x.core}{${x.coins.join(',')}}`).join('  ') : '— none robust —'}`);
  console.log('\n===== VERDICT =====');
  const b = Math.max(fO[0]?.coins.length ?? 0, fA[0]?.coins.length ?? 0);
  console.log(b >= 4 ? `  ✓ CANDIDATE — robust ${b}/10. NEXT: run PLACEBO=1 (must collapse) + 2nd window before any test-mode deploy.` : `  ✗ KILL — best robust ${b}/10 (<4). No cross-symbol book-flip edge on this window.`);
  console.log('\n===== green rows (top by +cost) =====');
  const gr = rows.filter((r) => r.green); console.log(gr.length ? gr.sort((a, b) => b.net2 - a.net2).slice(0, 14).map(line).join('\n') : '  — none green —');
  console.log('\nFull → data/bookflip-results.json');
})().catch((e) => { console.error(e); process.exit(1); });
