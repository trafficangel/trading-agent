/**
 * FUNDING-AS-SIGNAL sweep — the last genuinely-distinct untested signal (NOT funding carry,
 * which the operator rejected). Funding rate as a CROWDING / positioning gauge:
 *   (A) fundingCrowdingDivergence — funding extreme (z) AND persistent (K bars one side) AND
 *       price has STOPPED confirming (no new high/low over K) => the crowded, over-levered cohort
 *       is fragile; fade it. Exit time-stop or funding reverts inside the band.
 *   (B) fundingFlipCapitulation — funding was extreme then FLIPS SIGN within a short window =>
 *       the crowd just got flushed; trade the snap-back AWAY from the wiped side, short hold.
 *
 * Funding history pulled live from the HL info API (NOT geo-blocked), hourly, aligned 1:1 to 1h
 * klines. Full kill-battery: cross-symbol >=4/10 green + 4-fold WF + cost-stress x2/x3 at HL taker
 * 0.07%. Causal (funding[<=i], price[<=i]; enter at close[i]). Run on the VPS.
 * pnpm tsx scripts/sweep-funding.ts [days]
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'AVAXUSDT'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 320);
const HL_TAKER = 0.07;
const INFO = 'https://api.hyperliquid.xyz/info';

async function fundingHistory(coin: string, startMs: number, endMs: number): Promise<{ t: number; f: number }[]> {
  const out: { t: number; f: number }[] = [];
  let cursor = startMs; let guard = 0;
  while (cursor < endMs && guard++ < 200) {
    const res = await fetch(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'fundingHistory', coin, startTime: cursor, endTime: endMs }) });
    if (!res.ok) throw new Error(`HL funding ${coin}: ${res.status}`);
    const arr = (await res.json()) as { time: number; fundingRate: string }[];
    if (!arr.length) break;
    for (const r of arr) out.push({ t: r.time, f: Number(r.fundingRate) });
    const last = arr[arr.length - 1]!.time;
    if (last <= cursor) break;
    cursor = last + 1;
    if (arr.length < 400) break; // last page
  }
  return out;
}

/** Build funding aligned to candles: forward-fill the latest hourly funding onto each bar. */
function alignFunding(candles: Candle[], fh: { t: number; f: number }[]): (number | null)[] {
  const out = new Array<number | null>(candles.length).fill(null);
  let j = 0; let cur: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    while (j < fh.length && fh[j]!.t <= candles[i]!.t) { cur = fh[j]!.f; j++; }
    out[i] = cur;
  }
  return out;
}

function rollMeanStd(a: (number | null)[], i: number, W: number): { m: number; sd: number; n: number } {
  let s = 0, ss = 0, n = 0;
  for (let j = Math.max(0, i - W + 1); j <= i; j++) { const v = a[j]; if (v != null) { s += v; ss += v * v; n++; } }
  if (n < W / 2) return { m: 0, sd: 0, n };
  const m = s / n; return { m, sd: Math.sqrt(Math.max(0, ss / n - m * m)), n };
}

type Cfg = { strat: 'crowd' | 'flip'; sig: string; W: number; zThr: number; K: number; hold: number };
const CFGS: Cfg[] = [];
for (const W of [180, 360]) for (const zThr of [1.5, 2, 2.5]) for (const K of [6, 12]) for (const hold of [24, 48])
  CFGS.push({ strat: 'crowd', sig: `W${W}z${zThr}K${K}h${hold}`, W, zThr, K, hold });
for (const W of [180, 360]) for (const zThr of [1.5, 2] /*extreme pctile via z*/) for (const K of [3, 6] /*flip window*/) for (const hold of [12, 24])
  CFGS.push({ strat: 'flip', sig: `W${W}z${zThr}fw${K}h${hold}`, W, zThr, K, hold });

/** realized NET % per trade, taker both sides. */
function run(c: Candle[], fund: (number | null)[], cfg: Cfg): number[] {
  const out: number[] = []; const n = c.length; let guard = -1;
  for (let i = cfg.W; i < n - 1; i++) {
    if (i <= guard) continue;
    const { m, sd } = rollMeanStd(fund, i, cfg.W);
    if (!(sd > 0)) continue;
    const fz = fund[i] != null ? (fund[i]! - m) / sd : 0;
    let side: 1 | -1 | 0 = 0;
    if (cfg.strat === 'crowd') {
      // funding extreme + persistent K bars same side + price not confirming
      if (Math.abs(fz) < cfg.zThr) continue;
      let persist = true;
      for (let j = i - cfg.K + 1; j <= i; j++) { const fv = fund[j]; if (fv == null || Math.sign(fv - m) !== Math.sign(fz)) { persist = false; break; } }
      if (!persist) continue;
      const ref = c[i - cfg.K]; if (!ref) continue;
      if (fz > 0) { if (c[i]!.c <= ref.c) side = -1; }      // crowd long, price not making highs -> fade short
      else { if (c[i]!.c >= ref.c) side = 1; }              // crowd short, price not making lows -> fade long
    } else {
      // flip: funding was extreme over [i-fw.. ] then crosses sign by bar i
      const prevWindow = fund.slice(Math.max(0, i - cfg.K - 1), i); // last few funding values before flip
      const wasPos = prevWindow.some((v) => v != null && (v - m) / (sd || 1) >= cfg.zThr);
      const wasNeg = prevWindow.some((v) => v != null && (v - m) / (sd || 1) <= -cfg.zThr);
      const now = fund[i]; const prev = fund[i - 1];
      if (now == null || prev == null) continue;
      if (wasPos && prev > 0 && now <= 0) side = 1;   // long crowd capitulated (funding flipped neg) -> long snapback
      else if (wasNeg && prev < 0 && now >= 0) side = -1; // short crowd capitulated -> short snapback
    }
    if (side === 0) continue;
    const entry = c[i]!.c;
    const kmax = Math.min(n - 1, i + cfg.hold);
    const exit = c[kmax]!.c; // time-stop
    const gross = side === 1 ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
    out.push(gross - HL_TAKER); // net of one taker round-trip (HL_TAKER=0.07% RT); net()/netStress add x2/x3
    guard = kmax;
  }
  return out;
}

function net(r: number[], extra = 0) { return Math.round(r.reduce((s, x) => s + x - extra, 0) * 10) / 10; }
function pf(r: number[]) { let gp = 0, gl = 0; for (const x of r) { if (x >= 0) gp += x; else gl += -x; } return gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100; }
function wr(r: number[]) { return r.length ? Math.round(r.filter((x) => x > 0).length / r.length * 100) : 0; }
function folds(r: number[]) { const k = Math.floor(r.length / 4); if (k < 3) return -1; let pos = 0; for (let f = 0; f < 4; f++) { const sl = r.slice(f * k, f === 3 ? r.length : (f + 1) * k); if (sl.reduce((s, x) => s + x, 0) > 0) pos++; } return pos; }

type Row = { strat: string; sig: string; coin: string; n: number; net: number; net2: number; net3: number; pf: number; wr: number; isN: number; oosN: number; folds: number; green: boolean };

(async () => {
  console.log(`FUNDING-as-signal sweep · 1h · ${SYMBOLS.length} coins · ${CFGS.length} cfgs (crowd-divergence + flip-capitulation) · ${DAYS}d · HL taker ${HL_TAKER}%\n`);
  const data = new Map<string, { c: Candle[]; f: (number | null)[]; cov: number }>();
  for (const sym of SYMBOLS) {
    const coin = sym.replace('USDT', '');
    try {
      const c = await getKlines(sym, '60', NOW - DAYS * 86_400_000, NOW);
      const fh = await fundingHistory(coin, NOW - DAYS * 86_400_000, NOW);
      const f = alignFunding(c, fh);
      const cov = Math.round((f.filter((x) => x != null).length / c.length) * 100);
      data.set(sym, { c, f, cov });
      process.stderr.write(`  ${coin}: ${c.length} bars, ${fh.length} funding pts, cov ${cov}%\n`);
    } catch (e) { process.stderr.write(`${sym}: ${(e as Error).message}\n`); }
  }
  console.log('funding coverage: ' + [...data.entries()].map(([s, d]) => `${s.replace('USDT', '')}:${d.cov}`).join(' ') + '\n');

  const rows: Row[] = [];
  for (const cfg of CFGS) for (const [sym, d] of data) {
    if (d.c.length < 500) continue;
    const r = run(d.c, d.f, cfg);
    if (r.length < 12) continue;
    const cut = Math.floor(r.length * 0.7);
    const isN = net(r.slice(0, cut)), oosN = net(r.slice(cut)), f = folds(r);
    const n1 = net(r), n2 = net(r, HL_TAKER), n3 = net(r, 2 * HL_TAKER);
    const green = r.length >= 15 && n1 > 0 && pf(r) > 1.25 && isN > 0 && oosN > 0 && n2 > 0 && (r.length >= 16 ? f >= 3 : true);
    rows.push({ strat: cfg.strat, sig: cfg.sig, coin: sym.replace('USDT', ''), n: r.length, net: n1, net2: n2, net3: n3, pf: pf(r), wr: wr(r), isN, oosN, folds: f, green });
  }
  writeFileSync('data/funding-results.json', JSON.stringify(rows, null, 2));

  const line = (r: Row) => `${r.green ? '✅' : '  '} ${r.coin.padEnd(5)} ${r.sig.padEnd(16)} N${String(r.n).padStart(4)} net ${String(r.net).padStart(6)} +cost ${String(r.net2).padStart(6)} x3 ${String(r.net3).padStart(6)} PF ${String(r.pf).padStart(5)} WR ${String(r.wr).padStart(2)}% f${r.folds}/4 IS/OOS ${r.isN}/${r.oosN}`;
  for (const strat of ['crowd', 'flip']) {
    const fr = rows.filter((r) => r.strat === strat);
    const bySig = new Map<string, string[]>();
    for (const r of fr.filter((x) => x.green)) { const a = bySig.get(r.sig) ?? []; a.push(r.coin); bySig.set(r.sig, a); }
    const robust = [...bySig.entries()].map(([sig, coins]) => ({ sig, coins: coins.sort() })).filter((x) => x.coins.length >= 4).sort((a, b) => b.coins.length - a.coins.length);
    console.log(`===== ${strat.toUpperCase()} — ROBUST (green incl. +cost on >=4/10) =====`);
    console.log(robust.length ? robust.map((x) => `  ◆ ${x.sig} -> ${x.coins.length}/10 {${x.coins.join(',')}}`).join('\n') : '  — none robust —');
    console.log(`  ${fr.filter((r) => r.green).length} green rows / ${fr.length}. Top:`);
    console.log(fr.filter((r) => r.green).sort((a, b) => b.net2 - a.net2).slice(0, 6).map(line).join('\n') || '  — none green —');
    console.log('');
  }
  console.log('Full -> data/funding-results.json');
})().catch((e) => { console.error(e); process.exit(1); });
