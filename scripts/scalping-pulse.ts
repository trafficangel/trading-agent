/**
 * SCALPING PULSE — measure whether order-book scalping has "breath" on OUR market (HL perps), with
 * numbers instead of assertions. For a TAKER scalper the question is: (1) how big is the per-minute
 * wiggle, (2) is it PREDICTABLE (can you direct it) or a random walk (you can only provide liquidity),
 * (3) does the capturable move beat the round-trip cost. The pulse = magnitude × predictability ÷ cost.
 *
 * Stats per coin (1m klines): median & p90 of the 1m range (high-low)/close; median 1m body |c-o|/o;
 * lag-1 autocorrelation of 1m close-to-close returns (≈0 = efficient/random walk = no taker edge;
 * <0 = MR but usually just the bid-ask bounce you can't capture); variance-ratio VR(5). Cost: HL taker
 * 0.07% RT vs maker ~0.025% RT. Run on the VPS: pnpm tsx scripts/scalping-pulse.ts [tf] [days]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const TF = String(process.argv[2] ?? '1');
const DAYS = Number(process.argv[3] ?? 90);
const NOW = Date.now();
const TAKER_RT = 0.07, MAKER_RT = 0.025;

const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const pct = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

function autocorr1(r: number[]): number {
  const n = r.length; if (n < 3) return 0; const m = mean(r);
  let num = 0, den = 0;
  for (let i = 1; i < n; i++) num += (r[i]! - m) * (r[i - 1]! - m);
  for (let i = 0; i < n; i++) den += (r[i]! - m) * (r[i]! - m);
  return den > 0 ? num / den : 0;
}
function varRatio(r: number[], q: number): number { // VR(q) = var(q-sum)/(q*var(1)); <1 MR, >1 trend
  const n = r.length; if (n < q * 3) return 1;
  const v1 = mean(r.map((x) => x * x)) - mean(r) ** 2;
  const agg: number[] = []; for (let i = 0; i + q <= n; i += q) { let s = 0; for (let j = i; j < i + q; j++) s += r[j]!; agg.push(s); }
  const vq = mean(agg.map((x) => x * x)) - mean(agg) ** 2;
  return v1 > 0 ? vq / (q * v1) : 1;
}

(async () => {
  console.log(`SCALPING PULSE · ${TF}m · ${DAYS}d · HL perps · taker RT ${TAKER_RT}% / maker RT ${MAKER_RT}%\n`);
  console.log('coin   medRange%  p90Range%  medBody%   autocorr1   VR(5)   | medRange vs cost');
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    let c: Candle[]; try { c = await getKlines(sym, TF, NOW - DAYS * 86_400_000, NOW); } catch { continue; }
    if (c.length < 1000) continue;
    const range = c.map((k) => (k.h - k.l) / k.c * 100);
    const body = c.map((k) => Math.abs(k.c - k.o) / k.o * 100);
    const ret: number[] = []; for (let i = 1; i < c.length; i++) ret.push((c[i]!.c - c[i - 1]!.c) / c[i - 1]!.c * 100);
    const mr = median(range), ac = autocorr1(ret), vr = varRatio(ret, 5);
    // capturable ≈ ~40% of the median range (a realistic scalp grabs a fraction, not the whole wiggle)
    const cap = mr * 0.4;
    const verdict = cap > TAKER_RT ? 'taker air' : cap > MAKER_RT ? 'maker-only' : 'suffocated';
    console.log(`${coin.padEnd(5)} ${mr.toFixed(3).padStart(8)}  ${pct(range, 0.9).toFixed(3).padStart(8)}  ${median(body).toFixed(3).padStart(7)}  ${(ac >= 0 ? '+' : '') + ac.toFixed(3)}      ${vr.toFixed(2)}    | cap~${cap.toFixed(3)}% ${verdict}`);
  }
  console.log('\nREAD: medRange = the per-minute wiggle (the "breath"). cap~ = ~40% of it a scalp could realistically grab.');
  console.log('  autocorr1 ≈ 0 → 1m moves are a RANDOM WALK = no taker edge (you can only market-make the spread).');
  console.log('  autocorr1 < 0 → mean-reverting, but usually just the bid-ask BOUNCE you cannot capture as a taker.');
  console.log('  VR(5) < 1 → sub-5min mean-reversion; > 1 → momentum. cost wall: taker 0.07% / maker 0.025% RT.');
})().catch((e) => { console.error(e); process.exit(1); });
