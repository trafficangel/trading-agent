/**
 * Verify the cross-symbol-broad new-family low-TF candidates at MAKER fees:
 * cross-symbol transfer × 4-fold walk-forward × ×2-fee, to separate a real
 * broad intraday edge from in-sample-heavy luck (the green set had thin OOS).
 * Run on the VPS. Usage: pnpm tsx scripts/verify-newfam.ts
 */

import { getKlines } from '../src/backtest/klines.js';
import { runBacktest } from '../src/backtest/engine.js';
import type { Candle } from '../src/backtest/indicators.js';
import type { CustomStrategy } from '../src/backtest/strategy.js';
import { keltnerMr, zscoreMr, rsi2, consecMr } from '../src/backtest/strategies/families-lowtf.js';

const MAKER = 0.02;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const WINDOW_DAYS: Record<string, number> = { '5': 180, '15': 400 };

const CONFIGS: { label: string; tf: string; build: (s: string) => CustomStrategy }[] = [
  { label: 'keltner20/10/2 +EMA200 @5m', tf: '5', build: (s) => keltnerMr(s, '5', 20, 10, 2, 200) },
  { label: 'z-score(50) +EMA200 @5m', tf: '5', build: (s) => zscoreMr(s, '5', 50, 2, 200) },
  { label: 'keltner20/10/2 +EMA200 @15m', tf: '15', build: (s) => keltnerMr(s, '15', 20, 10, 2, 200) },
  { label: 'rsi2 5/95 +EMA200 @15m', tf: '15', build: (s) => rsi2(s, '15', 5, 95, 200) },
  { label: 'consec4 +EMA200 @15m', tf: '15', build: (s) => consecMr(s, '15', 4, 200) },
];

function netAt(r: number[], fee: number): number { let g = 0, l = 0; for (const x of r) { const v = x - fee; if (v >= 0) g += v; else l += -v; } return Math.round((g - l) * 10) / 10; }
function maxDd(r: number[], fee: number): number { let c = 0, p = 0, d = 0; for (const x of r) { c += x - fee; if (c > p) p = c; if (p - c > d) d = p - c; } return Math.round(d * 10) / 10; }
function foldsPos(r: number[], fee: number, k = 4): number { if (r.length < k * 4) return -1; const sz = Math.floor(r.length / k); let pos = 0; for (let f = 0; f < k; f++) { const sl = r.slice(f * sz, f === k - 1 ? undefined : (f + 1) * sz); if (netAt(sl, fee) > 0) pos++; } return pos; }

const cache = new Map<string, Candle[]>();
async function candles(sym: string, tf: string, now: number): Promise<Candle[]> {
  const key = `${sym}-${tf}`; if (cache.has(key)) return cache.get(key)!;
  let c: Candle[] = []; try { c = await getKlines(sym, tf, now - (WINDOW_DAYS[tf] ?? 180) * 86_400_000, now); } catch (e) { process.stderr.write(`  ${key}: ${(e as Error).message}\n`); }
  cache.set(key, c); return c;
}

(async () => {
  const now = Date.now();
  console.log('New-family low-TF verification · MAKER fee · cross-symbol × walk-forward × ×2\n');
  for (const cfg of CONFIGS) {
    const per: { sym: string; n: number; net1: number; net2: number; dd: number; folds: number; surv: boolean }[] = [];
    for (const sym of SYMBOLS) {
      const c = await candles(sym, cfg.tf, now); const strat = cfg.build(sym);
      if (c.length < strat.warmup + 40) continue;
      const r = runBacktest(strat, c).tradesLog.map((t) => t.realizedPct);
      if (r.length < 10) continue;
      const folds = foldsPos(r, MAKER); const net2 = netAt(r, MAKER * 2);
      per.push({ sym, n: r.length, net1: netAt(r, MAKER), net2, dd: maxDd(r, MAKER), folds, surv: r.length >= 30 && net2 > 0 && folds >= 3 });
    }
    const elig = per.filter((p) => p.n >= 30);
    const pos = elig.filter((p) => p.net1 > 0).length;
    const surv = elig.filter((p) => p.surv).length;
    const med = elig.map((p) => p.net1).sort((a, b) => a - b)[Math.floor(elig.length / 2)] ?? 0;
    console.log(`\n■ ${cfg.label}`);
    console.log(`  eligible ${elig.length}/10 · net>0 ${pos}/${elig.length} · SURVIVES ${surv}/${elig.length} · median net ${med}%`);
    for (const p of per.sort((a, b) => b.net1 - a.net1)) {
      console.log(`    ${p.sym.padEnd(9)} N${String(p.n).padStart(5)} net ${String(p.net1).padStart(6)}% net×2 ${String(p.net2).padStart(6)}% DD-${String(p.dd).padStart(5)} folds ${p.folds < 0 ? 'n/a' : p.folds + '/4'} ${p.surv ? '✅' : ''}`);
    }
  }
  console.log('\nSURVIVES on a MAJORITY = real broad intraday edge (maker-executed); few = data-mined.');
})().catch((e) => { console.error(e); process.exit(1); });
