/**
 * Equity sim for the funding-flip edge — turns the per-trade % series into a real compounded
 * $ equity curve (the sweep only summed percents). Reports trades/month, win%, monthly $ on a
 * given capital, and max EQUITY drawdown — the numbers that actually matter for "how much money".
 *
 * Uses the robust config (W360 z2 fw6 hold24) on a chosen coin set. Sizes each trade at a fixed
 * fraction f of current equity (f=0.2 ≈ 1x gross with ~5 concurrent positions; f=0.4 ≈ 2x).
 * Funding read from hl_micro (backfilled). Run on the VPS. pnpm tsx scripts/funding-equity.ts [days] [endOffset]
 */
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const NOW = Date.now() - Number(process.argv[3] ?? 0) * 86_400_000;
const DAYS = Number(process.argv[2] ?? 320);
const HL_TAKER = 0.07;
const CFG = { W: 360, zThr: 2, fw: 6, hold: 24 }; // the cross-symbol-robust flip config
const SETS: Record<string, string[]> = {
  '5coin': ['ADA', 'DOGE', 'ETH', 'LTC', 'XRP'],
  'core': ['ETH', 'ADA'],
};

function rollMeanStd(a: (number | null)[], i: number, W: number) {
  let s = 0, ss = 0, n = 0;
  for (let j = Math.max(0, i - W + 1); j <= i; j++) { const v = a[j]; if (v != null) { s += v; ss += v * v; n++; } }
  if (n < W / 2) return { m: 0, sd: 0 };
  const m = s / n; return { m, sd: Math.sqrt(Math.max(0, ss / n - m * m)) };
}

function flipTrades(c: Candle[], fund: (number | null)[]): { t: number; pct: number }[] {
  const out: { t: number; pct: number }[] = []; const n = c.length; let guard = -1;
  for (let i = CFG.W; i < n - 1; i++) {
    if (i <= guard) continue;
    const { m, sd } = rollMeanStd(fund, i, CFG.W);
    if (!(sd > 0)) continue;
    const prevWindow = fund.slice(Math.max(0, i - CFG.fw - 1), i);
    const wasPos = prevWindow.some((v) => v != null && (v - m) / sd >= CFG.zThr);
    const wasNeg = prevWindow.some((v) => v != null && (v - m) / sd <= -CFG.zThr);
    const now = fund[i]; const prev = fund[i - 1];
    if (now == null || prev == null) continue;
    let side: 1 | -1 | 0 = 0;
    if (wasPos && prev > 0 && now <= 0) side = 1;
    else if (wasNeg && prev < 0 && now >= 0) side = -1;
    if (side === 0) continue;
    const entry = c[i]!.c; const kmax = Math.min(n - 1, i + CFG.hold); const exit = c[kmax]!.c;
    const gross = side === 1 ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
    out.push({ t: c[i]!.t, pct: gross - HL_TAKER });
    guard = kmax;
  }
  return out;
}

function simEquity(trades: { t: number; pct: number }[], f: number, cap0: number) {
  let eq = cap0, peak = cap0, maxdd = 0;
  for (const tr of trades) { eq += eq * f * tr.pct / 100; peak = Math.max(peak, eq); maxdd = Math.max(maxdd, (peak - eq) / peak); }
  return { end: eq, maxdd };
}

(async () => {
  console.log(`FUNDING-FLIP equity sim · config W${CFG.W}z${CFG.zThr}fw${CFG.fw}h${CFG.hold} · ${DAYS}d ending ${Number(process.argv[3] ?? 0)}d ago\n`);
  const fundByCoin = new Map<string, { c: Candle[]; f: (number | null)[] }>();
  const allCoins = [...new Set(Object.values(SETS).flat())];
  for (const coin of allCoins) {
    const c = await getKlines(`${coin}USDT`, '60', NOW - DAYS * 86_400_000, NOW);
    fundByCoin.set(coin, { c, f: loadMicroAligned(coin, '60', c).funding });
  }
  for (const [name, coins] of Object.entries(SETS)) {
    let trades: { t: number; pct: number }[] = [];
    for (const coin of coins) { const d = fundByCoin.get(coin)!; trades = trades.concat(flipTrades(d.c, d.f)); }
    trades.sort((a, b) => a.t - b.t);
    if (trades.length < 5) { console.log(`[${name}] too few trades`); continue; }
    const months = (trades[trades.length - 1]!.t - trades[0]!.t) / (30 * 86_400_000);
    const wins = trades.filter((t) => t.pct > 0).length;
    const meanPct = trades.reduce((s, t) => s + t.pct, 0) / trades.length;
    console.log(`========== ${name.toUpperCase()} {${coins.join(',')}} ==========`);
    console.log(`  trades ${trades.length} over ${months.toFixed(1)}mo (${(trades.length / months).toFixed(1)}/mo) · win ${Math.round(wins / trades.length * 100)}% · mean net ${meanPct.toFixed(2)}%/trade`);
    for (const f of [0.2, 0.4]) {
      const lev = f === 0.2 ? '~1x' : '~2x';
      for (const cap of [1000, 3000]) {
        const { end, maxdd } = simEquity(trades, f, cap);
        const totalRet = (end / cap - 1) * 100;
        const perMo = (end - cap) / months;
        const moRate = (Math.pow(end / cap, 1 / months) - 1) * 100;
        console.log(`  f=${f} (${lev}) cap $${cap} -> end $${end.toFixed(0)} | total ${totalRet.toFixed(0)}% | ~$${perMo.toFixed(0)}/mo (${moRate.toFixed(1)}%/mo compounded) | maxDD ${(maxdd * 100).toFixed(0)}%`);
      }
    }
    console.log('');
  }
  console.log('(BACKTEST numbers — forward is typically lower; f=0.2≈1x gross at ~5 concurrent, f=0.4≈2x. maxDD is on the equity curve.)');
})().catch((e) => { console.error(e); process.exit(1); });
