/**
 * ADVERSARIAL VERIFICATION — try to KILL the sweep's apparent winners.
 *
 * The sweep tested 538 configs; ~5% pass an OOS gate by chance alone
 * (data-mining bias). This battery subjects a shortlist of the strongest
 * patterns to three independent kill-tests:
 *
 *  1. CROSS-SYMBOL transfer — run the SAME config on all 10 symbols. A real
 *     edge generalizes; a curve-fit works on its one lucky coin. (Strongest
 *     anti-data-mining test.)
 *  2. WALK-FORWARD (4 contiguous folds) — does the edge persist across time,
 *     not just in one regime? Robust = ≥3/4 folds net-positive.
 *  3. COST STRESS (commission ×1/×2/×3) — does it survive real slippage/fees,
 *     or is the "edge" thinner than costs?
 *
 * A config "SURVIVES" on a symbol only if: net>0 at ×2 cost AND ≥3/4 folds
 * positive AND N>=15. We then judge each config by how broadly it survives.
 *
 * Run on the VPS (Bybit klines). Usage: pnpm tsx scripts/verify-candidate.ts
 */

import { getKlines } from '../src/backtest/klines.js';
import { runBacktest } from '../src/backtest/engine.js';
import type { Candle } from '../src/backtest/indicators.js';
import type { CustomStrategy } from '../src/backtest/strategy.js';
import { smaTrend, emaCross, donchianFlip, momentumRoc, bollMr } from '../src/backtest/strategies/families.js';
import { TRACK_C_COMMISSION_RT_PCT } from '../src/strategies/track-c-config.js';

const COMM = TRACK_C_COMMISSION_RT_PCT;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const WINDOW_DAYS: Record<string, number> = { '15': 270, '60': 400, '240': 720, D: 1600 };

// Shortlist = the cross-consistent patterns from the sweep.
const CONFIGS: { label: string; tf: string; build: (s: string) => CustomStrategy }[] = [
  { label: 'boll20/2 +EMA200 @240 (mean-rev, trend-filtered)', tf: '240', build: (s) => bollMr(s, '240', 20, 2, 200) },
  { label: 'donch40 @240 (breakout)', tf: '240', build: (s) => donchianFlip(s, '240', 40) },
  { label: 'donch40 @60 (breakout)', tf: '60', build: (s) => donchianFlip(s, '60', 40) },
  { label: 'sma50 @D (trend)', tf: 'D', build: (s) => smaTrend(s, 'D', 50) },
  { label: 'sma100 @D (trend)', tf: 'D', build: (s) => smaTrend(s, 'D', 100) },
  { label: 'mom50 @D (momentum)', tf: 'D', build: (s) => momentumRoc(s, 'D', 50) },
  { label: 'ema10x30 @D (trend)', tf: 'D', build: (s) => emaCross(s, 'D', 10, 30) },
];

function netAt(realized: number[], mult: number): number {
  let gp = 0, gl = 0;
  for (const r of realized) { const x = r - COMM * mult; if (x >= 0) gp += x; else gl += -x; }
  return Math.round((gp - gl) * 10) / 10;
}
function maxDd(realized: number[]): number {
  let cum = 0, peak = 0, dd = 0;
  for (const r of realized) { cum += r - COMM; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; }
  return Math.round(dd * 10) / 10;
}
function foldsPositive(realized: number[], k = 4): number {
  if (realized.length < k * 4) return -1; // too few trades to fold meaningfully
  const sz = Math.floor(realized.length / k);
  let pos = 0;
  for (let f = 0; f < k; f++) {
    const slice = realized.slice(f * sz, f === k - 1 ? undefined : (f + 1) * sz);
    if (netAt(slice, 1) > 0) pos++;
  }
  return pos;
}

const klineCache = new Map<string, Candle[]>();
async function candles(symbol: string, tf: string, now: number): Promise<Candle[]> {
  const key = `${symbol}-${tf}`;
  if (klineCache.has(key)) return klineCache.get(key)!;
  const from = now - (WINDOW_DAYS[tf] ?? 365) * 86_400_000;
  let c: Candle[] = [];
  try { c = await getKlines(symbol, tf, from, now); } catch (e) { process.stderr.write(`  ${key}: ${(e as Error).message}\n`); }
  klineCache.set(key, c);
  return c;
}

(async () => {
  const now = Date.now();
  console.log(`Adversarial verification · cross-symbol × walk-forward × cost-stress · base comm ${COMM}%/trade\n`);

  for (const cfg of CONFIGS) {
    const perSym: { sym: string; n: number; net1: number; net2: number; net3: number; dd: number; folds: number; survives: boolean }[] = [];
    for (const sym of SYMBOLS) {
      const c = await candles(sym, cfg.tf, now);
      const strat = cfg.build(sym);
      if (c.length < strat.warmup + 40) continue;
      const realized = runBacktest(strat, c).tradesLog.map((t) => t.realizedPct);
      if (realized.length < 10) continue;
      const folds = foldsPositive(realized);
      const net2 = netAt(realized, 2);
      const survives = realized.length >= 15 && net2 > 0 && folds >= 3;
      perSym.push({ sym, n: realized.length, net1: netAt(realized, 1), net2, net3: netAt(realized, 3), dd: maxDd(realized), folds, survives });
    }
    const elig = perSym.filter((p) => p.n >= 15);
    const posN = elig.filter((p) => p.net1 > 0).length;
    const surv = elig.filter((p) => p.survives).length;
    const nets = elig.map((p) => p.net1).sort((a, b) => a - b);
    const median = nets.length ? nets[Math.floor(nets.length / 2)]! : 0;
    const medDd = elig.map((p) => p.dd).sort((a, b) => a - b)[Math.floor(elig.length / 2)] ?? 0;

    console.log(`\n■ ${cfg.label}`);
    console.log(`  symbols eligible (N≥15): ${elig.length}/${SYMBOLS.length}  ·  net>0: ${posN}/${elig.length}  ·  SURVIVES (×2 cost & ≥3/4 folds): ${surv}/${elig.length}  ·  median net ${median}%  ·  median DD −${medDd}%`);
    console.log('    sym        N   net×1    net×2    net×3   DD     folds  survive');
    for (const p of perSym.sort((a, b) => b.net1 - a.net1)) {
      console.log(`    ${p.sym.padEnd(9)} ${String(p.n).padStart(3)}  ${String(p.net1).padStart(6)}%  ${String(p.net2).padStart(6)}%  ${String(p.net3).padStart(6)}%  -${String(p.dd).padStart(5)}  ${p.folds < 0 ? ' n/a' : p.folds + '/4'}   ${p.survives ? '✅' : ''}`);
    }
  }
  console.log('\nSURVIVES = generalises (works cross-symbol), persists (≥3/4 time folds), and beats DOUBLE costs.');
  console.log('A config that survives on a MAJORITY of symbols is a real edge; one-symbol survival = likely data-mined.');
})().catch((e) => { console.error(e); process.exit(1); });
