/**
 * Adversarial verification of the maker/HL 30m–1h candidates — same kill-
 * battery as verify-candidate.ts but with realistic Hyperliquid fees
 * (maker 0.02% RT for mean-reversion, taker 0.07% RT for breakout) on 30m/1h.
 *
 * For each candidate CONFIG run the SAME rule on all 10 symbols:
 *   - CROSS-SYMBOL: does it generalise, or is it one lucky coin (e.g. LTC)?
 *   - WALK-FORWARD (4 folds): persists across time?
 *   - COST STRESS ×2 fee: survives fill-risk / fee uncertainty?
 * SURVIVES on a symbol = N>=30 AND net>0 at ×2 fee AND ≥3/4 folds positive.
 *
 * Run on the VPS. Usage: pnpm tsx scripts/verify-maker.ts
 */

import { getKlines } from '../src/backtest/klines.js';
import { runBacktest } from '../src/backtest/engine.js';
import type { Candle } from '../src/backtest/indicators.js';
import type { CustomStrategy } from '../src/backtest/strategy.js';
import { donchianFlip, rsiMr, bollMr } from '../src/backtest/strategies/families.js';

const HL_MAKER_RT = 0.02;
const HL_TAKER_RT = 0.07;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const WINDOW_DAYS: Record<string, number> = { '30': 300, '60': 450 };

const CONFIGS: { label: string; tf: string; fee: number; build: (s: string) => CustomStrategy }[] = [
  { label: 'donch40 @1h (taker)', tf: '60', fee: HL_TAKER_RT, build: (s) => donchianFlip(s, '60', 40) },
  { label: 'donch40 @30m (taker)', tf: '30', fee: HL_TAKER_RT, build: (s) => donchianFlip(s, '30', 40) },
  { label: 'rsi30/70 no-filter @1h (maker)', tf: '60', fee: HL_MAKER_RT, build: (s) => rsiMr(s, '60', 30, 70, 0) },
  { label: 'rsi30/70 no-filter @30m (maker)', tf: '30', fee: HL_MAKER_RT, build: (s) => rsiMr(s, '30', 30, 70, 0) },
  { label: 'boll20/2.5 +EMA200 @30m (maker)', tf: '30', fee: HL_MAKER_RT, build: (s) => bollMr(s, '30', 20, 2.5, 200) },
  { label: 'boll20/2 +EMA200 @1h (maker)', tf: '60', fee: HL_MAKER_RT, build: (s) => bollMr(s, '60', 20, 2, 200) },
];

function netAt(r: number[], fee: number): number { let g = 0, l = 0; for (const x of r) { const v = x - fee; if (v >= 0) g += v; else l += -v; } return Math.round((g - l) * 10) / 10; }
function maxDd(r: number[], fee: number): number { let c = 0, p = 0, d = 0; for (const x of r) { c += x - fee; if (c > p) p = c; if (p - c > d) d = p - c; } return Math.round(d * 10) / 10; }
function foldsPos(r: number[], fee: number, k = 4): number { if (r.length < k * 4) return -1; const sz = Math.floor(r.length / k); let pos = 0; for (let f = 0; f < k; f++) { const sl = r.slice(f * sz, f === k - 1 ? undefined : (f + 1) * sz); if (netAt(sl, fee) > 0) pos++; } return pos; }

const cache = new Map<string, Candle[]>();
async function candles(sym: string, tf: string, now: number): Promise<Candle[]> {
  const key = `${sym}-${tf}`;
  if (cache.has(key)) return cache.get(key)!;
  let c: Candle[] = [];
  try { c = await getKlines(sym, tf, now - (WINDOW_DAYS[tf] ?? 300) * 86_400_000, now); } catch (e) { process.stderr.write(`  ${key}: ${(e as Error).message}\n`); }
  cache.set(key, c); return c;
}

(async () => {
  const now = Date.now();
  console.log('Maker/HL candidate verification · cross-symbol × walk-forward × ×2-fee\n');
  for (const cfg of CONFIGS) {
    const per: { sym: string; n: number; net1: number; net2: number; dd: number; folds: number; surv: boolean }[] = [];
    for (const sym of SYMBOLS) {
      const c = await candles(sym, cfg.tf, now);
      const strat = cfg.build(sym);
      if (c.length < strat.warmup + 40) continue;
      const r = runBacktest(strat, c).tradesLog.map((t) => t.realizedPct);
      if (r.length < 10) continue;
      const folds = foldsPos(r, cfg.fee);
      const net2 = netAt(r, cfg.fee * 2);
      per.push({ sym, n: r.length, net1: netAt(r, cfg.fee), net2, dd: maxDd(r, cfg.fee), folds, surv: r.length >= 30 && net2 > 0 && folds >= 3 });
    }
    const elig = per.filter((p) => p.n >= 30);
    const pos = elig.filter((p) => p.net1 > 0).length;
    const surv = elig.filter((p) => p.surv).length;
    const med = elig.map((p) => p.net1).sort((a, b) => a - b)[Math.floor(elig.length / 2)] ?? 0;
    console.log(`\n■ ${cfg.label}`);
    console.log(`  eligible ${elig.length}/10 · net>0 ${pos}/${elig.length} · SURVIVES ${surv}/${elig.length} · median net ${med}%`);
    for (const p of per.sort((a, b) => b.net1 - a.net1)) {
      console.log(`    ${p.sym.padEnd(9)} N${String(p.n).padStart(4)} net ${String(p.net1).padStart(6)}% net×2 ${String(p.net2).padStart(6)}% DD-${String(p.dd).padStart(5)} folds ${p.folds < 0 ? 'n/a' : p.folds + '/4'} ${p.surv ? '✅' : ''}`);
    }
  }
  console.log('\nSURVIVES on a MAJORITY of symbols = real edge; one/two symbols = likely coin-specific data-mining.');
})().catch((e) => { console.error(e); process.exit(1); });
