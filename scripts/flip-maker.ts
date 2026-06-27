/**
 * FUNDING-FLIP MAKER-ENTRY A/B — harden lever #3. Rest a passive limit at the flip-bar close instead
 * of a taker market: saves ~half the round-trip cost (maker entry + taker time-stop exit ≈ 0.035% vs
 * 0.07% taker/taker) — BUT a snap-back entry only fills when price first comes BACK to the limit
 * (adverse selection: you fill the weaker snapbacks, miss the ones that run immediately).
 *
 * Conservative fill model: limit AT close[i]; fills within the next F bars iff price trades through it
 * (long: some low ≤ limit; short: some high ≥ limit). Exit = close[i+hold] (same time-stop). Gated set
 * (oiRoc>0, the deployed entry). Run on the VPS:  pnpm tsx scripts/flip-maker.ts [days] [F]
 */
import { getKlines } from '../src/backtest/klines.js';
import { loadMicroAligned, loadBybitAligned } from '../src/backtest/micro.js';
import { type Candle } from '../src/backtest/indicators.js';

const KEEPERS = ['ETH', 'ADA', 'XRP', 'AVAX']; // BTC dropped (weak gated)
const DAYS = Number(process.argv[2] ?? 395);
const F = Number(process.argv[3] ?? 3); // fill window (bars)
const NOW = Date.now();
const TAKER_RT = 0.07;   // taker entry + taker exit
const MAKER_RT = 0.035;  // maker entry + taker exit (≈ half)
const FLIP = { W: 360, zThr: 2, fw: 6, hold: 24 };

function rollMeanStd(a: (number | null)[], i: number, W: number) {
  let s = 0, ss = 0, n = 0;
  for (let j = Math.max(0, i - W + 1); j <= i; j++) { const v = a[j]; if (v != null) { s += v; ss += v * v; n++; } }
  if (n < W / 2) return { m: 0, sd: 0 };
  const m = s / n; return { m, sd: Math.sqrt(Math.max(0, ss / n - m * m)) };
}
const relChange = (a: (number | null)[], i: number, k: number) => { const v = a[i], p = a[i - k]; return v == null || p == null || p === 0 ? null : (v - p) / Math.abs(p); };
const mean = (r: number[]) => r.length ? r.reduce((s, x) => s + x, 0) / r.length : 0;

(async () => {
  console.log(`FUNDING-FLIP MAKER-ENTRY A/B · flip W${FLIP.W}z${FLIP.zThr}fw${FLIP.fw}h${FLIP.hold} · gated oiRoc>0 · fill-window ${F} bars · ${DAYS}d · ${KEEPERS.join(',')}\n`);
  let takAll: number[] = [], makAll: number[] = [], makFillAll = 0, makTotAll = 0;
  console.log('coin   flips  TAKER exp(Σ)        MAKER exp(Σ) fill%');
  for (const coin of KEEPERS) {
    const c = await getKlines(`${coin}USDT`, '60', NOW - DAYS * 86_400_000, NOW);
    const hlF = loadMicroAligned(coin, '60', c).funding;
    const oi = loadBybitAligned(coin, '60', c).oi;
    const n = c.length; let guard = -1; const tak: number[] = [], mak: number[] = []; let fill = 0, tot = 0;
    for (let i = FLIP.W; i < n - 1; i++) {
      if (i <= guard) continue;
      const { m, sd } = rollMeanStd(hlF, i, FLIP.W); if (!(sd > 0)) continue;
      const prevWin = hlF.slice(Math.max(0, i - FLIP.fw - 1), i);
      const wasPos = prevWin.some((v) => v != null && (v - m) / sd >= FLIP.zThr);
      const wasNeg = prevWin.some((v) => v != null && (v - m) / sd <= -FLIP.zThr);
      const now = hlF[i], prev = hlF[i - 1]; if (now == null || prev == null) continue;
      let side: 1 | -1 | 0 = 0;
      if (wasPos && prev > 0 && now <= 0) side = 1; else if (wasNeg && prev < 0 && now >= 0) side = -1;
      if (side === 0) continue;
      const roc = relChange(oi, i, 12); if (roc == null || roc <= 0) continue; // gated
      guard = i + FLIP.hold;
      const limit = c[i]!.c; const exit = c[Math.min(n - 1, i + FLIP.hold)]!.c;
      tak.push((side === 1 ? (exit - limit) / limit : (limit - exit) / limit) * 100 - TAKER_RT);
      // maker fill: does price trade through the limit within F bars?
      tot++; let filled = false;
      for (let j = i + 1; j <= Math.min(n - 1, i + F); j++) { if (side === 1 ? c[j]!.l <= limit : c[j]!.h >= limit) { filled = true; break; } }
      if (filled) { fill++; mak.push((side === 1 ? (exit - limit) / limit : (limit - exit) / limit) * 100 - MAKER_RT); }
    }
    takAll = takAll.concat(tak); makAll = makAll.concat(mak); makFillAll += fill; makTotAll += tot;
    console.log(`  ${coin.padEnd(5)} ${String(tot).padStart(4)}   exp ${mean(tak).toFixed(3)} (Σ${Math.round(mean(tak) * tak.length)})   exp ${mean(mak).toFixed(3)} (Σ${Math.round(mean(mak) * mak.length)})  ${Math.round(fill / Math.max(1, tot) * 100)}%`);
  }
  console.log('');
  console.log(`POOLED  taker: n=${takAll.length} exp=${mean(takAll).toFixed(3)} Σ=${Math.round(mean(takAll) * takAll.length)}`);
  console.log(`        maker: n=${makAll.length} exp=${mean(makAll).toFixed(3)} Σ=${Math.round(mean(makAll) * makAll.length)} · fill ${Math.round(makFillAll / Math.max(1, makTotAll) * 100)}%`);
  const takSigma = Math.round(mean(takAll) * takAll.length), makSigma = Math.round(mean(makAll) * makAll.length);
  console.log(`\nVERDICT: ${makSigma > takSigma ? 'MAKER wins total $ (cost-saving > adverse-selection loss)' : 'TAKER wins — maker loses more from unfilled snapbacks than it saves on cost'} (taker Σ${takSigma} vs maker Σ${makSigma}); maker also forfeits ${takAll.length - makAll.length} unfilled flips.`);
})().catch((e) => { console.error(e); process.exit(1); });
