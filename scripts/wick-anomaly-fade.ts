/**
 * WICK / FLASH-ANOMALY FADE — the one anomaly-capture method that needs NO speed: rest a deep limit
 * X% from price; a wick / flash-dislocation fills it; fade back toward the pre-wick level. The order is
 * already resting, so reaction latency is irrelevant — exactly the retail-accessible anomaly play.
 *
 * THE HARD PART (classification): a wick is EITHER a temporary dislocation (liquidation flush → reverts,
 * a WIN) OR the start of a REAL move (no revert → a loss). The deeper X, the more likely it's a forced
 * flush that reverts — but the rarer the fill. We measure the honest net across BOTH outcomes.
 *
 * Sim: rest bid at close[i]*(1-X) and ask at close[i]*(1+X) for Hfill bars. Wick fills it (maker). Exit:
 * revert to close[i] (win) OR time-stop exitH OR catastrophe stop at entry*(1∓stop). Cost ~0.05% RT
 * (maker entry + taker exit). 3 independent 180d windows (anomaly edges must persist, not be one flush).
 * Run on the VPS: pnpm tsx scripts/wick-anomaly-fade.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT'];
const TF = String(process.argv[2] ?? '5');
const WIN_DAYS = 180, WINDOWS = [0, 180, 360];
const RT = 0.05;          // maker entry + taker exit
const Hfill = 6;          // bars the deep limit rests
const exitH = 12;         // time-stop after fill
const STOP = 0.03;        // catastrophe stop beyond entry (real move, not a wick)
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

/** returns {n, net, win} for resting a deep limit X from price, fading wicks back to mid. */
function run(c: Candle[], X: number): { n: number; net: number; win: number; tail: number } {
  const n = c.length; const rets: number[] = []; let wins = 0; let guard = -1; let worst = 0;
  for (let i = 50; i < n - exitH - Hfill - 1; i++) {
    if (i <= guard) continue;
    const mid = c[i]!.c;
    for (const side of [1, -1] as const) {
      const limit = side === 1 ? mid * (1 - X) : mid * (1 + X);
      let fb = -1;
      for (let j = i + 1; j <= i + Hfill; j++) { if (side === 1 ? c[j]!.l <= limit : c[j]!.h >= limit) { fb = j; break; } }
      if (fb < 0) continue;
      const target = mid; const stopPx = side === 1 ? limit * (1 - STOP) : limit * (1 + STOP);
      let exit = c[Math.min(n - 1, fb + exitH)]!.c; let won = false;
      for (let j = fb + 1; j <= Math.min(n - 1, fb + exitH); j++) {
        if (side === 1 ? c[j]!.l <= stopPx : c[j]!.h >= stopPx) { exit = stopPx; break; }      // real move → cut
        if (side === 1 ? c[j]!.h >= target : c[j]!.l <= target) { exit = target; won = true; break; } // reverted → win
      }
      const r = (side === 1 ? (exit - limit) / limit : (limit - exit) / limit) * 100 - RT;
      rets.push(r); if (won) wins++; worst = Math.min(worst, r);
      guard = fb + 1;
    }
  }
  return { n: rets.length, net: Math.round(mean(rets) * rets.length * 10) / 10, win: rets.length ? Math.round(wins / rets.length * 100) : 0, tail: Math.round(worst * 10) / 10 };
}

(async () => {
  console.log(`WICK/FLASH-ANOMALY FADE · ${TF}m · rest deep limit, fade back to mid · 3×${WIN_DAYS}d · RT ${RT}% · stop ${STOP * 100}%\n`);
  console.log('coin   X       W0(n/net/win%)        W1(net/win)      W2(net/win)     | persistent?');
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    const wins: Candle[][] = [];
    for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { wins.push(await getKlines(sym, TF, end - WIN_DAYS * 86_400_000, end)); } catch { wins.push([]); } }
    if (wins.some((w) => w.length < 800)) continue;
    for (const X of [0.005, 0.01, 0.02]) {
      const r = wins.map((c) => run(c, X));
      if (r[0]!.n < 20) continue;
      const allPos = r.every((x) => x.net > 0 && x.n >= 15);
      console.log(`${coin.padEnd(5)} ${(X * 100).toFixed(1)}%   n${String(r[0]!.n).padStart(4)} net ${String(r[0]!.net).padStart(6)} win${String(r[0]!.win).padStart(3)}%   ${String(r[1]!.net).padStart(6)}/${r[1]!.win}%      ${String(r[2]!.net).padStart(6)}/${r[2]!.win}%    | ${allPos ? '✅ all 3 +' : (r.filter((x) => x.net > 0).length) + '/3 +'}  tail ${r[0]!.tail}%`);
    }
  }
  console.log('\nREAD: a wick fade WINS when the dislocation reverts, LOSES big when it was a real move (tail = worst single trade %).');
  console.log('  Net>0 on all 3 windows = a persistent anomaly edge. Net<0 = the real-move losses outweigh the reverts (classification fails).');
})().catch((e) => { console.error(e); process.exit(1); });
