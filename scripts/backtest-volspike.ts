/**
 * VOLUME-BURST — sharp volume spikes vs the average, the UNTESTED variants (operator's idea). The
 * FADE direction is already a graveyard (cascadeFade / absorptionFailRetest / large-print all KILLED).
 * This tests the parts NOT yet run: (A) FOLLOW — a volume burst = ignition/momentum, ride the bar's
 * direction; (B) range-context — split bursts into IGNITION (burst + big range = move starting) vs
 * ABSORPTION (burst + SMALL range = volume without price = battle at a level), since they may resolve
 * differently. A/B follow vs fade × range-mode, full kill-battery (cross-symbol >=4/10, 4-fold WF,
 * cost x2/x3 at HL taker). Run on the VPS. pnpm tsx scripts/backtest-volspike.ts [days]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { sma, type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 320);
const TK = 0.07;

type Cfg = { sig: string; core: string; tf: string; volK: number; rangeMode: 'all' | 'low' | 'high'; follow: boolean; hold: number; tgt: number; sl: number };
const CFGS: Cfg[] = [];
for (const tf of ['5', '15']) for (const volK of [3, 5]) for (const rangeMode of ['all', 'low', 'high'] as const) for (const follow of [false, true]) for (const hold of [6, 12]) {
  const core = `${tf}vK${volK}${rangeMode}h${hold}`;
  CFGS.push({ sig: `${core}${follow ? '_F' : '_R'}`, core, tf, volK, rangeMode, follow, hold, tgt: 0.006, sl: 0.012 });
}

function rollMean(a: number[], W: number): number[] { const o = new Array<number>(a.length); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]!; if (i >= W) s -= a[i - W]!; o[i] = s / Math.min(i + 1, W); } return o; }

/** NET % per trade. volume burst (v>=volK*avgVol), range-context gate, follow/fade the bar's direction. */
function run(c: Candle[], cfg: Cfg): number[] {
  const n = c.length; const vSma = sma(c.map((x) => x.v), 50);
  const rng = c.map((x) => (x.c > 0 ? (x.h - x.l) / x.c : 0)); const rngAvg = rollMean(rng, 50);
  const out: number[] = []; let guard = -1;
  for (let i = 60; i < n - 1; i++) {
    if (i <= guard) continue;
    if (!(vSma[i - 1]! > 0) || c[i]!.v < cfg.volK * vSma[i - 1]!) continue;     // volume burst vs average
    if (cfg.rangeMode === 'low' && !(rng[i]! < rngAvg[i - 1]!)) continue;       // absorption: burst on a SMALL-range bar
    if (cfg.rangeMode === 'high' && !(rng[i]! > rngAvg[i - 1]!)) continue;      // ignition: burst on a BIG-range bar
    const dir: 1 | -1 | 0 = c[i]!.c > c[i]!.o ? 1 : c[i]!.c < c[i]!.o ? -1 : 0;
    if (dir === 0) continue;
    const side: 1 | -1 = cfg.follow ? dir : (dir === 1 ? -1 : 1);
    const entry = c[i]!.c;
    const tgtPx = side === 1 ? entry * (1 + cfg.tgt) : entry * (1 - cfg.tgt);
    const slPx = side === 1 ? entry * (1 - cfg.sl) : entry * (1 + cfg.sl);
    let exit = 0; const kmax = Math.min(n - 1, i + cfg.hold); let k = i + 1;
    for (; k <= kmax; k++) {
      if (side === 1 ? c[k]!.l <= slPx : c[k]!.h >= slPx) { exit = slPx; break; }
      if (side === 1 ? c[k]!.h >= tgtPx : c[k]!.l <= tgtPx) { exit = tgtPx; break; }
    }
    if (exit === 0) exit = c[kmax]!.c;
    const gross = side === 1 ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
    out.push(gross - TK);
    guard = kmax;
  }
  return out;
}

function net(r: number[], e = 0) { return Math.round(r.reduce((s, x) => s + x - e, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }

type Row = { sig: string; core: string; follow: boolean; coin: string; n: number; net: number; net2: number; net3: number; pf: number; wr: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  const rows: Row[] = [];
  const cache = new Map<string, Candle[]>();
  console.log(`VOLUME-BURST · 5m/15m · ${SYMBOLS.length} coins · ${CFGS.length} cfgs (follow/fade × all/low/high range) · ${DAYS}d · HL taker ${TK}%\n`);
  for (const cfg of CFGS) {
    for (const sym of SYMBOLS) {
      const ck = `${sym}-${cfg.tf}`;
      let c = cache.get(ck);
      if (!c) { try { c = await getKlines(sym, cfg.tf, NOW - DAYS * 86_400_000, NOW); cache.set(ck, c); } catch { continue; } }
      if (c.length < 500) continue;
      const r = run(c, cfg);
      if (r.length < 20) continue;
      const cut = Math.floor(r.length * 0.7);
      const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
      const green = r.length >= 25 && net(r) > 0 && pf(r) > 1.2 && isN > 0 && oosN > 0 && net(r, TK) > 0 && f >= 3;
      rows.push({ sig: cfg.sig, core: cfg.core, follow: cfg.follow, coin: sym.replace('USDT', ''), n: r.length, net: net(r), net2: net(r, TK), net3: net(r, 2 * TK), pf: pf(r), wr: wr(r), isN, oosN, folds: f, green });
    }
  }
  writeFileSync('data/volspike-results.json', JSON.stringify(rows, null, 2));
  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(5)} ${r.sig.padEnd(16)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(6)} +cost ${String(r.net2).padStart(6)} x3 ${String(r.net3).padStart(6)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  const robust = (m: Map<string, string[]>) => [...m.entries()].map(([core, coins]) => ({ core, coins: coins.sort() })).filter((x) => x.coins.length >= 4).sort((a, b) => b.coins.length - a.coins.length);
  for (const [name, fl] of [['FOLLOW (ride burst)', true], ['FADE (reverse burst)', false]] as const) {
    const m = new Map<string, string[]>();
    for (const r of rows.filter((x) => x.follow === fl && x.green)) { const a = m.get(r.core) ?? []; a.push(r.coin); m.set(r.core, a); }
    const rob = robust(m);
    console.log(`===== ${name} — ROBUST (green >=4/10) =====`);
    console.log(rob.length ? rob.map((x) => `  ◆ ${x.core} → ${x.coins.length}/10 {${x.coins.join(',')}}`).join('\n') : '  — none robust —');
  }
  console.log('\n===== green rows (top by +cost) =====');
  const gr = rows.filter((r) => r.green); console.log(gr.length ? gr.sort((a, b) => b.net2 - a.net2).slice(0, 14).map(line).join('\n') : '  — none green —');
  console.log('\nFull → data/volspike-results.json');
})().catch((e) => { console.error(e); process.exit(1); });
