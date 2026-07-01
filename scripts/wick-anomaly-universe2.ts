/**
 * WICK-ANOMALY UNIVERSE SCAN — BATCH 2. Extend the deep-dislocation fade to a WIDER net of retail/meme
 * alts NOT covered by batch-1 (scripts/wick-anomaly-universe.ts). Same hardened lens: rest deep limit X%
 * → fade to mid; realistic cost ladder; direction-null (K30 sign-flip); cross-window persistence (≥2 of 3
 * 180d windows). Mechanism (forced retail-leverage flushes over-extend on thin/manipulable books → revert)
 * should be STRONGER on smaller memers — but many are too NEW for ≥2 windows and get skipped (revisit later).
 * Anchors DOGE/XRP (expect ROBUST) + controls BTC/ETH/SOL (expect kill) prove the pipeline still discriminates.
 * Bybit data (RUN ON VPS — api.bybit geo-blocked locally). Winners → filter to HL-listed for the runner.
 *   pnpm tsx scripts/wick-anomaly-universe2.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

// Bybit linear-perp symbols. Coins not on Bybit simply fail getKlines → skipped (broad net, self-filters).
const COINS = [
  'DOGE', 'XRP',                                  // anchors (expect ROBUST — sanity the lens didn't drift)
  'BTC', 'ETH', 'SOL',                            // controls (expect kill — efficient majors)
  // established mid/small alts (retail-driven, ≥360d history → cross-window testable)
  'LTC', 'BCH', 'ETC', 'XLM', 'ALGO', 'VET', 'GRT', 'RUNE', 'KAVA', 'JASMY', 'PEOPLE', 'EOS', 'IOTA',
  'DYDX', 'GMX', 'BLUR', 'IMX', 'MANA', 'AXS', 'APE', 'RENDER', 'AR', 'KAS', 'THETA', 'FLOW', 'EGLD',
  'CHZ', 'ZIL', 'ROSE', 'ONE', 'ANKR', 'SKL', 'STORJ', 'CELO', 'SUSHI', '1INCH', 'COMP', 'SNX', 'MKR',
  'JUP', 'JTO', 'PYTH', 'W', 'STRK', 'ONDO', 'ENS', 'EIGEN', 'ETHFI', 'ZRO', 'NOT', 'DYM', 'ALT', 'MANTA',
  // 2024 memers (many too new for ≥2 windows → skipped; caught if they have enough history)
  'MEW', 'POPCAT', 'PNUT', 'GOAT', 'MOODENG', 'TURBO', 'NEIRO', 'BRETT', 'MOG', 'PONKE',
];
const TF = String(process.argv[2] ?? '5');
const WIN_DAYS = 180, WINDOWS = [0, 180, 360], K = 30;
const Hfill = 6, exitH = 12, STOP = 0.03;
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const kelly = (a: number[]) => { const m = mean(a) / 100, s = sd(a) / 100; return s > 0 ? Math.round(m / (s * s) * 100) / 100 : 0; };

function trades(c: Candle[], X: number): number[] {
  const n = c.length; const out: number[] = []; let guard = -1;
  for (let i = 50; i < n - exitH - Hfill - 1; i++) {
    if (i <= guard) continue;
    const mid = c[i]!.c;
    for (const side of [1, -1] as const) {
      const limit = side === 1 ? mid * (1 - X) : mid * (1 + X);
      let fb = -1; for (let j = i + 1; j <= i + Hfill; j++) { if (side === 1 ? c[j]!.l <= limit : c[j]!.h >= limit) { fb = j; break; } }
      if (fb < 0) continue;
      const target = mid; const stopPx = side === 1 ? limit * (1 - STOP) : limit * (1 + STOP);
      let exit = c[Math.min(n - 1, fb + exitH)]!.c;
      for (let j = fb + 1; j <= Math.min(n - 1, fb + exitH); j++) {
        if (side === 1 ? c[j]!.l <= stopPx : c[j]!.h >= stopPx) { exit = stopPx; break; }
        if (side === 1 ? c[j]!.h >= target : c[j]!.l <= target) { exit = target; break; }
      }
      out.push((side === 1 ? (exit - limit) / limit : (limit - exit) / limit) * 100);
      guard = fb + 1;
    }
  }
  return out;
}

(async () => {
  console.log(`WICK-ANOMALY UNIVERSE · BATCH 2 · ${TF}m · fade deep limit→mid · up to 3×${WIN_DAYS}d · realistic 0.10% RT · null K${K}\n`);
  type Row = { coin: string; X: number; valid: number; n: number; net10: number; net15: number; kelly: number; persist: number; nullP: number; robust: boolean };
  const rows: Row[] = [];
  for (const coin of COINS) {
    const wins: Candle[][] = [];
    for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { const c = await getKlines(`${coin}USDT`, TF, end - WIN_DAYS * 86_400_000, end); wins.push(c.length >= 800 ? c : []); } catch { wins.push([]); } }
    const valid = wins.filter((w) => w.length > 0).length;
    if (valid < 2) { process.stderr.write(`  ${coin}: only ${valid} valid window(s) — skip\n`); continue; }
    for (const X of [0.02, 0.03]) {
      const perWin = wins.map((c) => c.length ? trades(c, X) : []);
      const allG = perWin.flat();
      if (allG.length < 30) continue;
      const C = 0.10;
      const netW = (g: number[], cost: number) => Math.round((mean(g) - cost) * g.length * 10) / 10;
      const netReal = allG.map((x) => x - C);
      const persist = perWin.filter((g) => g.length >= 10 && netW(g, C) > 0).length;
      let ge = 0; const real = mean(netReal) * netReal.length;
      for (let s = 0; s < K; s++) { let acc = 0; let st = (104729 * (s + 1)) & 0x7fffffff; for (const g of allG) { st = (st * 1103515245 + 12345) & 0x7fffffff; acc += ((st / 0x7fffffff) < 0.5 ? -g : g) - C; } ge += (acc >= real ? 1 : 0); }
      const nullP = ge / K;
      const robust = persist >= 2 && netW(allG, C) > 0 && nullP < 0.05;
      rows.push({ coin, X, valid, n: allG.length, net10: netW(allG, 0.10), net15: netW(allG, 0.15), kelly: kelly(netReal), persist, nullP, robust });
    }
    process.stderr.write(`  ${coin} done (${valid}w)\n`);
  }
  rows.sort((a, b) => (b.robust ? 1 : 0) - (a.robust ? 1 : 0) || b.kelly - a.kelly);
  console.log('coin       X     win   n     net@.10  @.15   Kelly   persist/valid  nullP  verdict');
  for (const r of rows) console.log(`${r.coin.padEnd(10)} ${(r.X * 100).toFixed(0)}%  ${String(r.valid)}w  ${String(r.n).padStart(5)}  ${String(r.net10).padStart(6)} ${String(r.net15).padStart(6)}  ${String(r.kelly).padStart(5)}   ${r.persist}/${r.valid}          ${r.nullP.toFixed(2)}   ${r.robust ? '✅ ROBUST' : 'kill'}`);
  const robustCoins = [...new Set(rows.filter((r) => r.robust).map((r) => r.coin))];
  console.log(`\n✅ ROBUST coins (persist≥2 + net>0@0.10 + beat null): ${robustCoins.length ? robustCoins.join(', ') : 'none'}`);
  console.log('  (survive conservative 0.15% too = strongest. Filter these to HL-listed, exclude already-live, before the runner.)');
})().catch((e) => { console.error(e); process.exit(1); });
