/**
 * MOMENTUM-ROCKET TEST — the operator's idea (Jul 6, JTO chart): detect a VOLUME-SURGE breakout ("ракета"),
 * jump IN long, exit on a small pullback/target. The OPPOSITE of the wick-fade (which FADES these spikes).
 * This tests whether CHASING the breakout beats real costs — honestly, because a 5m-bar entry (bar close) is
 * the FASTEST we could realistically react (the live runner polls minutely; it is not HFT), and a taker chase
 * pays fee + slippage. Signal: vol[i] > VMULT×avg(volW) AND price up SURGE% over SURGE_BARS → LONG at close +
 * slip. Exits swept: trailing-pullback / fixed-target+stop. Cost = taker RT 0.09% + SLIP each side. 3×180d,
 * K200 permutation null, + efficient-major CONTROLS (BTC/ETH/SOL/LINK). Bybit cache (RUN ON VPS).
 *   pnpm tsx scripts/momentum-rocket.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const ALTS = ['DOGE', 'ICP', 'NEAR', 'ATOM', 'CRV', 'ENA', 'TIA', '1000PEPE', 'RENDER', 'POPCAT', 'JUP', 'AR', 'LTC', 'EIGEN', 'MANTA', 'XRP', 'JTO', 'PNUT'];
const CONTROLS = ['BTC', 'ETH', 'SOL', 'LINK'];
const TF = String(process.argv[2] ?? '5');
const WIN_DAYS = 180, WINDOWS = [0, 180, 360], K = 200;
const VOL_W = 48;                 // avg-volume window
const TAKER_RT = 0.09;            // taker round-trip fee %
const SLIP = 0.05;                // entry/exit slippage % each side (chasing a fast move — generous/optimistic)
const MAXHOLD = 12;               // bars

const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const kelly = (a: number[]) => { const m = mean(a) / 100, s = sd(a) / 100; return s > 0 ? Math.round(m / (s * s) * 100) / 100 : 0; };
function pFixed(g: number[]): number {
  const real = g.reduce((s, x) => s + x, 0); let ge = 0;
  for (let s = 0; s < K; s++) { let st = (Math.imul(2654435761, s + 1) >>> 4) & 0x7fffffff, acc = 0; for (const x of g) { st = (Math.imul(st, 1103515245) + 12345) & 0x7fffffff; acc += (st / 0x7fffffff) < 0.5 ? -x : x; } if (acc >= real) ge++; }
  return ge / K;
}

type Cfg = { vmult: number; surgeBars: number; surgePct: number; exit: 'trail' | 'target'; p: number; stop: number };
/** returns NET %/trade array (fees+slip already subtracted). */
function sim(c: Candle[], cfg: Cfg): number[] {
  const n = c.length; const out: number[] = []; let guard = -1;
  const avgVol = (i: number): number => { let s = 0; for (let j = i - VOL_W; j < i; j++) s += c[j]!.v; return s / VOL_W; };
  for (let i = VOL_W + cfg.surgeBars; i < n - MAXHOLD - 1; i++) {
    if (i <= guard) continue;
    const surged = c[i]!.v > cfg.vmult * avgVol(i) && (c[i]!.c / c[i - cfg.surgeBars]!.c - 1) * 100 > cfg.surgePct;
    if (!surged) continue;
    const entry = c[i]!.c * (1 + SLIP / 100); // taker chase — fill above close
    let peak = c[i]!.c, exit = c[Math.min(n - 1, i + MAXHOLD)]!.c, exitBar = Math.min(n - 1, i + MAXHOLD);
    const stopPx = entry * (1 - cfg.stop / 100), tgtPx = entry * (1 + cfg.p / 100);
    for (let j = i + 1; j <= Math.min(n - 1, i + MAXHOLD); j++) {
      if (c[j]!.l <= stopPx) { exit = stopPx; exitBar = j; break; }
      if (cfg.exit === 'target' && c[j]!.h >= tgtPx) { exit = tgtPx; exitBar = j; break; }
      if (cfg.exit === 'trail') { peak = Math.max(peak, c[j]!.h); if (c[j]!.l <= peak * (1 - cfg.p / 100)) { exit = peak * (1 - cfg.p / 100); exitBar = j; break; } }
    }
    const exitFill = exit * (1 - SLIP / 100);
    out.push((exitFill - entry) / entry * 100 - TAKER_RT);
    guard = exitBar;
  }
  return out;
}

function verdict(label: string, perWin: number[][]): void {
  const g = perWin.flat();
  if (g.length < 20) { console.log(`${label.padEnd(26)} n=${g.length} — too few`); return; }
  const net = Math.round(mean(g) * g.length * 10) / 10;
  const wNets = perWin.map((w) => w.length ? Math.round(mean(w) * w.length * 10) / 10 : NaN);
  const persist = perWin.filter((w) => w.length >= 8 && mean(w) * w.length > 0).length;
  const p = pFixed(g); const wr = g.filter((x) => x > 0).length / g.length;
  const keep = net > 0 && p < 0.05 && kelly(g) > 0 && persist >= 2;
  console.log(`${label.padEnd(26)} ${String(g.length).padStart(5)} ${(wr * 100).toFixed(0).padStart(3)}%  ${mean(g).toFixed(3).padStart(7)} ${String(net).padStart(8)}  ${wNets.map((x) => Number.isNaN(x) ? '—' : String(x)).join('/').padEnd(20)} ${String(kelly(g)).padStart(6)} ${persist}/3 ${p.toFixed(2)}  ${keep ? '✅ KEEP' : '❌'}`);
}

(async () => {
  console.log(`MOMENTUM-ROCKET · ${TF}m · CHASE the volume-surge breakout · taker ${TAKER_RT}% + slip ${SLIP}%×2 · K${K}\n`);
  const load = async (syms: string[]) => { const d: Candle[][][] = []; for (const s of syms) { const wins: Candle[][] = []; for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { const c = await getKlines(`${s}USDT`, TF, end - WIN_DAYS * 86_400_000, end); wins.push(c.length >= 3000 ? c : []); } catch { wins.push([]); } } d.push(wins); process.stderr.write(`  ${s}\n`); } return d; };
  const altData = await load(ALTS); const ctrlData = await load(CONTROLS);
  const cfgs: [string, Cfg][] = [
    ['3×vol +1.5% trail0.3', { vmult: 3, surgeBars: 3, surgePct: 1.5, exit: 'trail', p: 0.3, stop: 1 }],
    ['3×vol +1.5% trail0.5', { vmult: 3, surgeBars: 3, surgePct: 1.5, exit: 'trail', p: 0.5, stop: 1 }],
    ['3×vol +1.5% tgt0.3', { vmult: 3, surgeBars: 3, surgePct: 1.5, exit: 'target', p: 0.3, stop: 1 }],
    ['4×vol +2.5% tgt0.5', { vmult: 4, surgeBars: 3, surgePct: 2.5, exit: 'target', p: 0.5, stop: 1.5 }],
    ['2×vol +1% trail0.3', { vmult: 2, surgeBars: 2, surgePct: 1, exit: 'trail', p: 0.3, stop: 1 }],
  ];
  console.log('config                       n   wr    avg%    net@cost  w0/w1/w2             Kelly per  p   verdict');
  for (const [label, cfg] of cfgs) {
    const alt: number[][] = [[], [], []], ctl: number[][] = [[], [], []];
    altData.forEach((wins) => wins.forEach((c, wi) => { if (c.length) alt[wi]!.push(...sim(c, cfg)); }));
    ctrlData.forEach((wins) => wins.forEach((c, wi) => { if (c.length) ctl[wi]!.push(...sim(c, cfg)); }));
    verdict(`ALT  ${label}`, alt);
    verdict(`CTRL ${label}`, ctl);
  }
  console.log('\nDECISION: chasing wins only if an ALT config is net>0 at cost, passes the null, persists, AND controls stay dead.');
})().catch((e) => { console.error(e); process.exit(1); });
