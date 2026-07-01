/**
 * WICK-ANOMALY HL-DATA CONFIRMATION — re-run the deep-limit fade test on Hyperliquid's OWN candles (the
 * venue we actually trade), for the ROBUST winners found on Bybit (wick-anomaly-universe*.ts). HL history
 * is SHORT (younger venue) → often only 1 window; this is a FAITHFULNESS check on the real book, closing
 * the cross-venue gap that Bybit-based discovery leaves. Same lens + cost ladder; CONFIRMED = net>0@0.10%
 * AND beats the K30 direction-null (persist shown for info; cross-window rigor already done on Bybit).
 * HL info API is NOT geo-blocked (runs locally or on VPS).
 *
 * ⚠ FINDING (Jul 1 2026): HL candleSnapshot caps at ~5000 candles AND serves ONLY the recent window —
 * requesting a range older than that returns EMPTY. So 5m gives just ~17 DAYS of history (5000×5m); older
 * windows are unavailable, NOT paginable. 1h gives ~208d but the 60-min-hold edge doesn't map to 1h bars.
 * ⇒ this is a WEAK ~17-day recent-sanity signal only (small n, underpowered null) — NOT a real backtest.
 * The true HL validator is the LIVE run. For deep HL history later, forward-COLLECT 5m candles over weeks.
 *   pnpm tsx scripts/wick-anomaly-hl-confirm.ts DOGE,CRV,ICP [tf]
 */
import { type Candle } from '../src/backtest/indicators.js';

const COINS = (process.argv[2] ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
const TF = String(process.argv[3] ?? '5');
const INTERVAL = `${TF}m`;
const STEP_MS = Number(TF) * 60_000;
const WIN_DAYS = 180, K = 30, Hfill = 6, exitH = 12, STOP = 0.03;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const kelly = (a: number[]) => { const m = mean(a) / 100, s = sd(a) / 100; return s > 0 ? Math.round(m / (s * s) * 100) / 100 : 0; };

function trades(c: Candle[], X: number): number[] {
  const n = c.length; const out: number[] = []; let guard = -1;
  for (let i = 50; i < n - exitH - Hfill - 1; i++) {
    if (i <= guard) continue;
    const mid = c[i]!.c;
    for (const side of [1, -1] as const) {
      const limit = side === 1 ? mid * (1 - X) : mid * (1 + X);
      let fb = -1; for (let j = i + 1; j <= i + Hfill; j++) { if (side === 1 ? c[j]!.l <= limit : c[j]!.h >= limit) { fb = j; break; } }
      if (fb < 0) continue;
      const target = mid; const stopPx = side === 1 ? limit * (1 - STOP) : limit * (1 + STOP);
      let exit = c[Math.min(n - 1, fb + exitH)]!.c;
      for (let j = fb + 1; j <= Math.min(n - 1, fb + exitH); j++) {
        if (side === 1 ? c[j]!.l <= stopPx : c[j]!.h >= stopPx) { exit = stopPx; break; }
        if (side === 1 ? c[j]!.h >= target : c[j]!.l <= target) { exit = target; break; }
      }
      out.push((side === 1 ? (exit - limit) / limit : (limit - exit) / limit) * 100);
      guard = fb + 1;
    }
  }
  return out;
}

type HlKline = { t: number; o: string; h: string; l: string; c: string; v: string };
async function hlCandles(coin: string, startMs: number, endMs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  const chunk = 4500 * STEP_MS; // HL candleSnapshot caps ~5000 candles/req → chunk under it
  let cur = startMs, guardEmpty = 0;
  while (cur < endMs) {
    const to = Math.min(endMs, cur + chunk);
    let arr: HlKline[] = [];
    try {
      const res = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: INTERVAL, startTime: cur, endTime: to } }) });
      if (res.ok) arr = (await res.json()) as HlKline[];
    } catch { /* transient → advance past this chunk below */ }
    if (Array.isArray(arr) && arr.length) {
      for (const k of arr) out.push({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v });
      cur = out[out.length - 1]!.t + STEP_MS; guardEmpty = 0;
    } else { cur = to + STEP_MS; if (++guardEmpty > 30) break; }
    await sleep(90);
  }
  const seen = new Set<number>();
  return out.filter((k) => k.t > 0 && !seen.has(k.t) && seen.add(k.t)).sort((a, b) => a.t - b.t);
}

(async () => {
  if (!COINS.length) { console.error('usage: pnpm tsx scripts/wick-anomaly-hl-confirm.ts DOGE,CRV,ICP [tf]'); process.exit(1); }
  console.log(`WICK-ANOMALY HL-CONFIRM · ${INTERVAL} · fade deep limit→mid · Hyperliquid's OWN candles · real 0.10% RT · null K${K}\n`);
  console.log('coin      X    span/win   n     net@.10  @.15   Kelly  persist  nullP  verdict');
  const now = Date.now();
  for (const coin of COINS) {
    const all = await hlCandles(coin, now - 2 * WIN_DAYS * 86_400_000, now);
    if (all.length < 800) { console.log(`${coin.padEnd(9)} — only ${all.length} HL candles (too new / not on HL) — skip`); continue; }
    const w0 = all.filter((k) => k.t >= now - WIN_DAYS * 86_400_000);
    const w1 = all.filter((k) => k.t < now - WIN_DAYS * 86_400_000);
    const wins = [w0, w1].filter((w) => w.length >= 800);
    const spanDays = Math.round((now - all[0]!.t) / 86_400_000);
    for (const X of [0.02, 0.03]) {
      const perWin = wins.map((c) => trades(c, X));
      const allG = perWin.flat();
      if (allG.length < 20) { console.log(`${coin.padEnd(9)} ${(X * 100).toFixed(0)}%   ${spanDays}d/${wins.length}w   n=${allG.length} — too few — skip`); continue; }
      const C = 0.10;
      const netW = (g: number[], cost: number) => Math.round((mean(g) - cost) * g.length * 10) / 10;
      const netReal = allG.map((x) => x - C);
      const persist = perWin.filter((g) => g.length >= 10 && netW(g, C) > 0).length;
      let ge = 0; const real = mean(netReal) * netReal.length;
      for (let s = 0; s < K; s++) { let acc = 0; let st = (104729 * (s + 1)) & 0x7fffffff; for (const g of allG) { st = (st * 1103515245 + 12345) & 0x7fffffff; acc += ((st / 0x7fffffff) < 0.5 ? -g : g) - C; } ge += (acc >= real ? 1 : 0); }
      const nullP = ge / K;
      const conf = netW(allG, C) > 0 && nullP < 0.05;
      console.log(`${coin.padEnd(9)} ${(X * 100).toFixed(0)}%  ${String(spanDays).padStart(3)}d/${wins.length}w  ${String(allG.length).padStart(5)}  ${String(netW(allG, 0.10)).padStart(6)} ${String(netW(allG, 0.15)).padStart(6)}  ${String(kelly(netReal)).padStart(5)}   ${persist}/${wins.length}    ${nullP.toFixed(2)}   ${conf ? '✅ CONFIRMED' : '—'}`);
    }
  }
  console.log('\n(CONFIRMED = net>0 at 0.10% AND beats K30 null on HL data. HL history is short → treat as a faithfulness check on top of Bybit cross-window, not a replacement.)');
})().catch((e) => { console.error(e); process.exit(1); });
