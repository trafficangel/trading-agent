/**
 * ILLIQUIDITY-GATED VOL-JUMP FADE (workflow rank-3, the INVERSE of VPIN) — fade a realized-vol JUMP
 * that happened on abnormally LOW dollar-volume (Amihud illiquidity = a liquidity vacuum, an
 * UN-informed move with no flow defending the new price → snaps back). VPIN inferred toxicity FROM
 * volume and decayed; this explicitly fades un-informed (low-volume) moves, so it shouldn't share
 * VPIN's decay mechanism.
 *
 * GATE ABLATION (the skeptic's kill condition): "fade a big-range bar" is the dead failure mode
 * (cascadeFade/printvacuum). The low-volume Amihud gate must BEAT the UNGATED big-range fade across
 * windows — both are run side-by-side. Cross-window lens: 3×180d, KEEP/window = N≥30 · net>0 @0.07%
 * (+2× stress) · perm-null p<0.05 · Kelly>0; ROBUST = ≥2/3. Causal (all from bars ≤ i, enter close[i]).
 * Run on the VPS: pnpm tsx scripts/illiq-voljump-fade.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const COINS = ['SOL', 'XRP', 'DOGE', 'ADA', 'LTC', 'LINK', 'AVAX', 'BNB'];
const TF = String(process.argv[2] ?? '5');
const WIN_DAYS = 180, WINDOWS = [0, 180, 360], K = 20, COST = 0.07;
const mean = (r: number[]) => r.length ? r.reduce((s, x) => s + x, 0) / r.length : 0;
const sd = (r: number[]) => { if (r.length < 2) return 0; const m = mean(r); return Math.sqrt(r.reduce((s, x) => s + (x - m) * (x - m), 0) / (r.length - 1)); };
const kelly = (r: number[]) => { const m = mean(r) / 100, s = sd(r) / 100; return s > 0 ? m / (s * s) : 0; };
function median(a: number[]): number { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; }

type Cfg = { N: number; K: number; G: number; H: number; gated: boolean };
const CFGS: Cfg[] = [];
for (const N of [50, 100]) for (const Kj of [2.5, 3.0]) for (const G of [1.5, 2.0]) for (const H of [3, 5, 8]) for (const gated of [true, false])
  CFGS.push({ N, K: Kj, G, H, gated });

/** trades net%: detect a low-volume vol-jump bar, fade its body, time-stop H. shift = circular-shift the gate (Amihud) for null. */
function run(c: Candle[], cfg: Cfg, cost: number): number[] {
  const n = c.length; const out: number[] = []; let guard = -1;
  const RR = c.map((k) => (k.h - k.l) / k.c);
  const A = c.map((k) => (k.v * k.c > 0 ? Math.abs(k.c - k.o) / k.c / (k.v * k.c) : 0));
  const dvol = c.map((k) => k.v * k.c);
  for (let i = cfg.N; i < n - 1; i++) {
    if (i <= guard) continue;
    const rvWin = RR.slice(i - cfg.N, i); const aWin = A.slice(i - cfg.N, i); const dWin = dvol.slice(i - cfg.N, i);
    const rv = median(rvWin); if (!(rv > 0)) continue;
    if (!(RR[i]! >= cfg.K * rv)) continue;                                   // vol jump
    if (cfg.gated) {
      if (!(A[i]! >= cfg.G * median(aWin))) continue;                        // low-dollar-volume (Amihud) gate
      const dSort = [...dWin].sort((x, y) => x - y); const q75 = dSort[Math.floor(dSort.length * 0.75)]!;
      if (dvol[i]! >= q75) continue;                                         // skip well-funded (informed) moves
    }
    const up = c[i]!.c > c[i]!.o; const side: 1 | -1 = up ? -1 : 1;          // fade the body
    const entry = c[i]!.c; const exit = c[Math.min(n - 1, i + cfg.H)]!.c;    // time-stop
    out.push((side === 1 ? (exit - entry) / entry : (entry - exit) / entry) * 100 - cost);
    guard = i + cfg.H;
  }
  return out;
}

(async () => {
  console.log(`ILLIQ VOL-JUMP FADE (inverse-VPIN) · ${TF}m · 3×${WIN_DAYS}d · cross-window · gated(Amihud) vs ungated A/B · real ${COST}% (+2×)\n`);
  type Wr = { net: number; net2: number; n: number; nullP: number; keep: boolean };
  type Res = { coin: string; cfg: string; gated: boolean; w: Wr[]; persist: number; tot: number };
  const results: Res[] = [];
  for (const coin of COINS) {
    const wins: Candle[][] = [];
    for (const off of WINDOWS) { const end = Date.now() - off * 86_400_000; try { wins.push(await getKlines(`${coin}USDT`, TF, end - WIN_DAYS * 86_400_000, end)); } catch { wins.push([]); } }
    if (wins.some((w) => w.length < 600)) { process.stderr.write(`${coin}: short window — skip\n`); continue; }
    for (const cfg of CFGS) {
      const w: Wr[] = [];
      for (const c of wins) {
        const r = run(c, cfg, COST);
        if (r.length < 30) { w.push({ net: 0, net2: 0, n: r.length, nullP: 1, keep: false }); continue; }
        const realNet = mean(r) * r.length; const r2 = run(c, cfg, 2 * COST);
        // null = randomly flip each trade's direction (destroys the body-fade signal) → real must beat it
        let nullP = 1;
        if (realNet > 0 && kelly(r) > 0) {
          let ge = 0;
          for (let s = 0; s < K; s++) { let acc = 0; let st = (7919 * (s + 1)) & 0x7fffffff; for (const x of r) { st = (st * 1103515245 + 12345) & 0x7fffffff; acc += x * ((st / 0x7fffffff) < 0.5 ? -1 : 1); } ge += (acc >= realNet) ? 1 : 0; }
          nullP = ge / K;
        }
        const keep = r.length >= 30 && realNet > 0 && mean(r2) * r2.length > 0 && nullP < 0.05 && kelly(r) > 0;
        w.push({ net: Math.round(realNet * 10) / 10, net2: Math.round(mean(r2) * r2.length * 10) / 10, n: r.length, nullP, keep });
      }
      const persist = w.filter((x) => x.keep).length;
      results.push({ coin, cfg: `N${cfg.N}K${cfg.K}G${cfg.G}H${cfg.H}${cfg.gated ? '·gate' : '·UN'}`, gated: cfg.gated, w, persist, tot: w.reduce((s, x) => s + x.net, 0) });
    }
    process.stderr.write(`  ${coin} done\n`);
  }
  results.sort((a, b) => b.persist - a.persist || b.tot - a.tot);
  const fmt = (r: Res) => `${r.persist}/3 ${r.coin.padEnd(5)} ${r.cfg.padEnd(20)} W0[net ${String(r.w[0]!.net).padStart(6)} +2x ${String(r.w[0]!.net2).padStart(6)} N${r.w[0]!.n} p${r.w[0]!.nullP.toFixed(2)}] W1[${String(r.w[1]!.net).padStart(6)} p${r.w[1]!.nullP.toFixed(2)}] W2[${String(r.w[2]!.net).padStart(6)} p${r.w[2]!.nullP.toFixed(2)}]`;
  const robust = results.filter((r) => r.persist >= 2);
  console.log(`===== ROBUST: KEEP ≥2/3 windows — ${robust.length} (gated ${robust.filter((r) => r.gated).length} / ungated ${robust.filter((r) => !r.gated).length}) =====`);
  console.log(robust.length ? robust.slice(0, 20).map(fmt).join('\n') : '  — none persist across windows —');
  console.log(`\nGATE ABLATION — best gated vs best ungated (gate must BEAT ungated to be load-bearing):`);
  const bestG = results.filter((r) => r.gated).slice(0, 3); const bestU = results.filter((r) => !r.gated).slice(0, 3);
  console.log('GATED:\n' + bestG.map(fmt).join('\n') + '\nUNGATED:\n' + bestU.map(fmt).join('\n'));
})().catch((e) => { console.error(e); process.exit(1); });
