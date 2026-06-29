/**
 * MAKER-SCALP SIM — test whether the "maker gap" (capturable ~0.03% > maker cost 0.025%) is REAL or a
 * mirage of the symmetric-fill assumption. A passive maker does NOT get filled randomly: a resting BID
 * only fills when price DROPS to it (sellers hitting you) — i.e. you systematically fill right before
 * further downside. That's ADVERSE SELECTION: you get the bad fills, miss the good ones.
 *
 * Sim: at bar i post a passive bid at close[i]*(1-s). If any of the next H bars' LOW ≤ bid → fill long
 * at bid (you only fill because price came DOWN to you). Target = sell back at close[i] (the mid you
 * bought below = capture s); time-stop at fill+exitH. Net per fill = move − maker RT (0.025%). If the
 * gap were real, post-fill price reverts to mid more often than it continues down. Run on the VPS:
 *   pnpm tsx scripts/maker-scalp-sim.ts [tf] [days]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const TF = String(process.argv[2] ?? '1');
const DAYS = Number(process.argv[3] ?? 90);
const NOW = Date.now();
const MAKER_RT = 0.025; // HL retail maker round-trip ~0.0125%/side
const Hfill = 3;        // bars the quote rests
const exitH = 10;       // time-stop bars after fill
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

(async () => {
  console.log(`MAKER-SCALP SIM · ${TF}m · ${DAYS}d · post bid s below mid, target = mid, time-stop ${exitH} · maker RT ${MAKER_RT}%\n`);
  console.log('coin   s(half)  fills   fill%   net/fill   Σnet   | revert%(win)  continue%(loss)  postFillDrift');
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    let c: Candle[]; try { c = await getKlines(sym, TF, NOW - DAYS * 86_400_000, NOW); } catch { continue; }
    if (c.length < 1000) continue;
    const n = c.length;
    for (const s of [0.0002, 0.0004]) { // half-spread offsets: 0.02%, 0.04%
      const rets: number[] = []; let posted = 0, filled = 0, reverted = 0; const drifts: number[] = [];
      let guard = -1;
      for (let i = 50; i < n - exitH - Hfill - 1; i++) {
        if (i <= guard) continue;
        posted++;
        const bid = c[i]!.c * (1 - s);
        // does a resting bid fill within Hfill bars?
        let fillBar = -1;
        for (let j = i + 1; j <= i + Hfill; j++) { if (c[j]!.l <= bid) { fillBar = j; break; } }
        if (fillBar < 0) continue;
        filled++;
        const target = c[i]!.c; // sell back at the mid we bought below
        // from fillBar, exit at target (revert win) or time-stop at fillBar+exitH
        let exit = c[Math.min(n - 1, fillBar + exitH)]!.c; let hitTarget = false;
        for (let j = fillBar + 1; j <= Math.min(n - 1, fillBar + exitH); j++) { if (c[j]!.h >= target) { exit = target; hitTarget = true; break; } }
        if (hitTarget) reverted++;
        drifts.push((c[Math.min(n - 1, fillBar + exitH)]!.c - bid) / bid * 100); // raw post-fill drift over the window
        rets.push((exit - bid) / bid * 100 - MAKER_RT);
        guard = fillBar + 1;
      }
      if (filled < 30) continue;
      const net = mean(rets) * rets.length;
      console.log(`${coin.padEnd(5)} ${(s * 100).toFixed(2)}%   ${String(filled).padStart(5)}  ${(filled / posted * 100).toFixed(0).padStart(3)}%   ${mean(rets).toFixed(4).padStart(8)}  ${String(Math.round(net * 10) / 10).padStart(6)}  | ${(reverted / filled * 100).toFixed(0).padStart(3)}%        ${(100 - reverted / filled * 100).toFixed(0).padStart(3)}%          ${(mean(drifts) >= 0 ? '+' : '') + mean(drifts).toFixed(4)}%`);
    }
  }
  console.log('\nREAD: net/fill = realized net% per filled scalp AFTER maker cost. revert% = filled trades that reached the mid (win).');
  console.log('  postFillDrift = avg raw price move from fill over the exit window. If adverse selection rules, it is NEGATIVE');
  console.log('  (price keeps dropping after it filled your bid) — the symmetric "capture the spread" assumption is false.');
})().catch((e) => { console.error(e); process.exit(1); });
