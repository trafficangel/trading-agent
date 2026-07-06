/**
 * WICK-FADE FAST INTRADAY BREAKER TEST — does flattening OPEN positions on a daily-loss threshold HELP
 * (cut the continuing-cascade tail) or WHIPSAW (kill reverting cascades that trough deep before bouncing)?
 *
 * The live −5% daily kill only pulls quotes + blocks NEW entries; OPEN positions ride to their natural exit,
 * so a continuing flush drags equity BELOW −5% (operator's exact worry). This tests a stronger breaker:
 * track intraday equity = realized-this-day + UNREALISED open-position MTM vs start-of-day; when it drops
 * ≤ −X% of the $249 account → FLATTEN ALL open positions at the current bar + no new entries the rest of the
 * UTC day. For every force-closed position we compute the COUNTERFACTUAL natural exit (target/time-stop/4%-stop
 * simulated forward) → winnersKilled (natural would've been better) vs losersSaved (natural would've been worse).
 * Joint 21-coin book, requote anchor, honest rules, real 0.05% cost, 3×180d. Bybit cache (RUN ON VPS).
 *   pnpm tsx scripts/wick-fade-breaker.ts [tf]
 */
import { getKlines } from '../src/backtest/klines.js';
import { type Candle } from '../src/backtest/indicators.js';

type Row = { coin: string; sym: string; x: number; sides: (1 | -1)[]; deep?: number };
const BOTH: (1 | -1)[] = [1, -1], LONG: (1 | -1)[] = [1], SHORT: (1 | -1)[] = [-1];
const LIVE: Row[] = [
  { coin: 'DOGE', sym: 'DOGE', x: 0.025, sides: BOTH, deep: 0.035 }, { coin: 'ICP', sym: 'ICP', x: 0.035, sides: BOTH },
  { coin: 'NEAR', sym: 'NEAR', x: 0.025, sides: BOTH }, { coin: 'ATOM', sym: 'ATOM', x: 0.03, sides: LONG, deep: 0.035 },
  { coin: 'TON', sym: 'TON', x: 0.02, sides: BOTH }, { coin: 'CRV', sym: 'CRV', x: 0.03, sides: BOTH },
  { coin: 'ENA', sym: 'ENA', x: 0.025, sides: BOTH }, { coin: 'TIA', sym: 'TIA', x: 0.025, sides: BOTH },
  { coin: 'kPEPE', sym: '1000PEPE', x: 0.03, sides: BOTH }, { coin: 'RENDER', sym: 'RENDER', x: 0.03, sides: BOTH },
  { coin: 'POPCAT', sym: 'POPCAT', x: 0.025, sides: BOTH }, { coin: 'JUP', sym: 'JUP', x: 0.025, sides: BOTH },
  { coin: 'AR', sym: 'AR', x: 0.03, sides: BOTH }, { coin: 'BLUR', sym: 'BLUR', x: 0.025, sides: BOTH },
  { coin: 'LTC', sym: 'LTC', x: 0.03, sides: LONG }, { coin: 'EIGEN', sym: 'EIGEN', x: 0.03, sides: BOTH },
  { coin: 'MANTA', sym: 'MANTA', x: 0.03, sides: BOTH }, { coin: 'XRP', sym: 'XRP', x: 0.02, sides: BOTH },
  { coin: 'JTO', sym: 'JTO', x: 0.03, sides: BOTH }, { coin: 'ALT', sym: 'ALT', x: 0.03, sides: SHORT },
  { coin: 'PNUT', sym: 'PNUT', x: 0.03, sides: BOTH },
];
const TF = String(process.argv[2] ?? '5');
const WIN_DAYS = 180, WINDOWS = [0, 180, 360];
const EXITH = 6, STOP = 0.04, SLIP = 0.0025, CD_BARS = 6;
const NOTIONAL = 13.3, EQUITY0 = 249, FEE_RT = 0.05, DRIFT = 0.01;
const STEP = Number(TF) * 60_000;
const BREAKERS: (number | null)[] = [null, 3, 4, 5, 6]; // null = baseline (no position-flatten, current behavior)

type Pos = { side: 1 | -1; entry: number; anchorMid: number; entryBar: number };
type CoinState = { pos: Pos | null; cdUntil: number; anchor: number };
const grossPct = (side: 1 | -1, entry: number, exit: number) => (side === 1 ? (exit - entry) / entry : (entry - exit) / entry) * 100;

/** Counterfactual: what a still-open position WOULD realize at its natural exit (stop→target→time), simulated
 *  forward from bar `fromBar` in this coin's candles. Mirrors simPortfolio's exit priority exactly. */
function naturalExitGross(c: Candle[], p: Pos, fromBar: number): number {
  const target = p.anchorMid;
  const stopPx = p.side === 1 ? p.entry * (1 - STOP) : p.entry * (1 + STOP);
  const stopFill = p.side === 1 ? stopPx * (1 - SLIP) : stopPx * (1 + SLIP);
  for (let j = fromBar; j < c.length; j++) {
    const bar = c[j]!;
    if (p.side === 1 ? bar.l <= stopPx : bar.h >= stopPx) return grossPct(p.side, p.entry, stopFill);
    if (p.side === 1 ? bar.h >= target : bar.l <= target) return grossPct(p.side, p.entry, target);
    if (j - p.entryBar >= EXITH) return grossPct(p.side, p.entry, bar.c);
  }
  return grossPct(p.side, p.entry, c[c.length - 1]!.c);
}

type Sim = { daily: Map<number, number>; trades: number; flattens: number; winnersKilled: number; losersSaved: number; flattenImpact: number };
function sim(candles: Map<string, Candle[]>, rows: Row[], breakerPct: number | null): Sim {
  const idx = new Map<string, Map<number, number>>();
  let t0 = Infinity, t1 = -Infinity;
  for (const [coin, c] of candles) { const m = new Map<number, number>(); c.forEach((k, i) => m.set(k.t, i)); idx.set(coin, m); if (c.length) { t0 = Math.min(t0, c[0]!.t); t1 = Math.max(t1, c[c.length - 1]!.t); } }
  const st = new Map<string, CoinState>();
  for (const r of rows) st.set(r.coin, { pos: null, cdUntil: -1, anchor: 0 });
  const daily = new Map<number, number>();
  const addPnl = (ts: number, usd: number) => { const d = Math.floor(ts / 86_400_000); daily.set(d, (daily.get(d) ?? 0) + usd); };
  let trades = 0, flattens = 0, winnersKilled = 0, losersSaved = 0, flattenImpact = 0;
  let curDay = -1, dayRealized = 0, breakerKilledDay = -1;

  for (let ts = t0; ts <= t1; ts += STEP) {
    const day = Math.floor(ts / 86_400_000);
    if (day !== curDay) { curDay = day; dayRealized = 0; } // new UTC day → reset intraday realized + breaker latch clears
    const barOf = (coin: string): Candle | null => { const i = idx.get(coin)!.get(ts); return i == null ? candles.get(coin)![i as number] ?? null : candles.get(coin)![i]!; };

    // ── BREAKER: intraday equity = realized-this-day + unrealised open MTM; trip once/day ──
    if (breakerPct != null && breakerKilledDay !== day) {
      let unreal = 0;
      for (const r of rows) { const s = st.get(r.coin)!; if (!s.pos) continue; const b = barOf(r.coin); if (!b) continue; unreal += NOTIONAL * grossPct(s.pos.side, s.pos.entry, b.c) / 100; }
      if (dayRealized + unreal <= -(breakerPct / 100) * EQUITY0) {
        // FLATTEN all open positions at the current bar close + book the counterfactual
        for (const r of rows) {
          const s = st.get(r.coin)!; if (!s.pos) continue;
          const c = candles.get(r.coin)!; const i = idx.get(r.coin)!.get(ts); if (i == null) continue;
          const bGross = grossPct(s.pos.side, s.pos.entry, c[i]!.c);
          const nGross = naturalExitGross(c, s.pos, i);
          const bPnl = NOTIONAL * (bGross - FEE_RT) / 100, nPnl = NOTIONAL * (nGross - FEE_RT) / 100;
          addPnl(ts, bPnl); dayRealized += bPnl; trades++; flattens++;
          flattenImpact += bPnl - nPnl; // >0 = breaker did better than letting it ride
          if (nPnl > bPnl + 1e-9) winnersKilled++; else if (nPnl < bPnl - 1e-9) losersSaved++;
          s.pos = null; s.anchor = 0;
        }
        breakerKilledDay = day;
      }
    }

    for (const r of rows) {
      const s = st.get(r.coin)!; const c = candles.get(r.coin)!; const i = idx.get(r.coin)!.get(ts);
      if (i == null) continue;
      const bar = c[i]!;
      if (s.pos) {
        const p = s.pos, target = p.anchorMid;
        const stopPx = p.side === 1 ? p.entry * (1 - STOP) : p.entry * (1 + STOP);
        const stopFill = p.side === 1 ? stopPx * (1 - SLIP) : stopPx * (1 + SLIP);
        let exit: number | null = null; let cat = false;
        if (p.side === 1 ? bar.l <= stopPx : bar.h >= stopPx) { exit = stopFill; cat = true; }
        else if (p.side === 1 ? bar.h >= target : bar.l <= target) { exit = target; }
        else if (i - p.entryBar >= EXITH) { exit = bar.c; }
        if (exit != null) { const pnl = NOTIONAL * (grossPct(p.side, p.entry, exit) - FEE_RT) / 100; addPnl(ts, pnl); dayRealized += pnl; trades++; s.pos = null; if (cat) s.cdUntil = ts + CD_BARS * STEP; }
        continue;
      }
      if (breakerKilledDay === day) continue; // no new entries the rest of the day after a breaker trip
      if (ts < s.cdUntil) continue;
      if (i < 1) continue;
      if (s.anchor <= 0) s.anchor = c[i - 1]!.c;
      const anchor = s.anchor;
      let filled: { side: 1 | -1; entry: number } | null = null;
      for (const side of r.sides) {
        const depths = r.deep != null ? [r.x, r.deep] : [r.x];
        for (const d of depths) { const limit = side === 1 ? anchor * (1 - d) : anchor * (1 + d); if (side === 1 ? bar.l <= limit : bar.h >= limit) { if (!filled || (side === 1 ? limit > filled.entry : limit < filled.entry)) filled = { side, entry: limit }; } }
      }
      if (Math.abs(bar.c - anchor) / anchor > DRIFT) s.anchor = bar.c;
      if (filled) {
        s.anchor = 0;
        const stopPx = filled.side === 1 ? filled.entry * (1 - STOP) : filled.entry * (1 + STOP);
        if (filled.side === 1 ? bar.l <= stopPx : bar.h >= stopPx) {
          const stopFill = filled.side === 1 ? stopPx * (1 - SLIP) : stopPx * (1 + SLIP);
          const pnl = NOTIONAL * (grossPct(filled.side, filled.entry, stopFill) - FEE_RT) / 100; addPnl(ts, pnl); dayRealized += pnl; trades++; s.cdUntil = ts + CD_BARS * STEP;
        } else { s.pos = { side: filled.side, entry: filled.entry, anchorMid: anchor, entryBar: i }; }
      }
    }
  }
  return { daily, trades, flattens, winnersKilled, losersSaved, flattenImpact };
}

function stats(daily: Map<number, number>): { net: number; maxDD: number; worstDay: number } {
  const days = [...daily.keys()].sort((a, b) => a - b);
  let eq = 0, peak = 0, maxDD = 0, worstDay = 0;
  for (const d of days) { const v = daily.get(d)!; eq += v; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); worstDay = Math.min(worstDay, v); }
  return { net: eq, maxDD, worstDay };
}

(async () => {
  console.log(`WICK-FADE BREAKER TEST · ${TF}m · flatten OPEN positions at intraday −X% · vs baseline · $${NOTIONAL}/rung on $${EQUITY0}\n`);
  const perWin: Map<string, Candle[]>[] = [];
  for (const off of WINDOWS) {
    const end = Date.now() - off * 86_400_000; const m = new Map<string, Candle[]>();
    for (const r of LIVE) { try { const c = await getKlines(`${r.sym}USDT`, TF, end - WIN_DAYS * 86_400_000, end); if (c.length >= 3000) m.set(r.coin, c); } catch { /* skip */ } }
    perWin.push(m); process.stderr.write(`  window -${off}d (${m.size} coins)\n`);
  }
  console.log('breaker   NET$   maxDD$ (%eq)  worstDay$   flattens  winKilled  loserSaved  flattenΔ$   verdict');
  for (const bp of BREAKERS) {
    const all = new Map<number, number>(); let trades = 0, fl = 0, wk = 0, ls = 0, fi = 0;
    for (const m of perWin) { const r = sim(m, LIVE.filter((x) => m.has(x.coin)), bp); trades += r.trades; fl += r.flattens; wk += r.winnersKilled; ls += r.losersSaved; fi += r.flattenImpact; for (const [d, v] of r.daily) all.set(d, (all.get(d) ?? 0) + v); }
    const s = stats(all);
    const label = bp == null ? 'baseline' : `−${bp}%`;
    const verdict = bp == null ? '(current: positions ride to exit)' : (fi > 0 ? `✅ +$${fi.toFixed(1)} on flattens` : `❌ −$${(-fi).toFixed(1)} (whipsaw: killed>saved)`);
    console.log(`${label.padEnd(8)} ${s.net.toFixed(0).padStart(6)}  ${s.maxDD.toFixed(1).padStart(6)} (${(s.maxDD / EQUITY0 * 100).toFixed(1)}%)  ${s.worstDay.toFixed(2).padStart(8)}  ${String(fl).padStart(7)}  ${String(wk).padStart(8)}  ${String(ls).padStart(9)}  ${fi.toFixed(1).padStart(8)}   ${verdict}`);
  }
  console.log('\nRead: flattenΔ$ = $ the breaker ADDED by force-closing (bookedExit − would-be natural exit), summed.');
  console.log('winKilled = positions whose natural exit beat the flatten (reverters cut early); loserSaved = flatten beat natural (continuers cut before worse).');
  console.log('If maxDD/worstDay improve AND flattenΔ ≥ ~0 → real protection. If flattenΔ deeply negative (winKilled ≫ loserSaved) → whipsaw, reject.');
})().catch((e) => { console.error(e); process.exit(1); });
