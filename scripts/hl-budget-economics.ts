/**
 * HL ACTION-BUDGET ECONOMICS — is the wick-fade quote book SELF-SUSTAINING on HL's action budget, or does
 * it structurally out-consume its earned allowance? HL grants 10k base + $1 of budget per $1 CUMULATIVE
 * volume traded, with NO time reset; every order/cancel (INCLUDING rejected ones) spends 1 action. Only
 * FILLS generate volume (→ budget); re-anchoring a resting quote spends actions for nothing.
 *
 * This measures, per (quote CADENCE × requote DRIFT threshold), across the live 21-coin book:
 *   - re-anchor EVENTS/day (each = cancel+replace ALL of that coin's resting rungs = 2×orders actions)
 *   - FILLS/day (→ earned budget = fills × notional × 2 round-trip ≈ fills × 27 actions)
 *   - net actions/day, and DAYS a one-time 14.4k unlock lasts before the book re-blocks.
 * Answers "must I keep paying $15 to unblock?" with real numbers, and finds the self-sustaining config.
 * RUN ON VPS (Bybit kline cache).
 *   pnpm tsx scripts/hl-budget-economics.ts [tf=5] [days=45]
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
const TF = Number(process.argv[2] ?? 5);
const DAYS = Number(process.argv[3] ?? 45);
const NOTIONAL = 13.3, HOLD_BARS = 6; // $13.3 per rung; 30-min hold = 6 bars @5m
const EARN_PER_FILL = NOTIONAL * 2; // $ volume per round-trip ≈ actions earned
const FILL_ACTIONS = 3;             // place exchange stop + exit order + tidy ~= 3 actions per fill
const UNLOCK = 14_400;              // a ~$15 BTC round-trip buys ~14.4k actions

const ordersOf = (r: Row) => r.sides.length * (r.deep != null ? 2 : 1); // base + deep rung per enabled side

/** Count re-anchor events & fills for one coin at a given quote cadence (in bars) and drift threshold.
 *  Fills are checked EVERY bar (a resting limit fills whenever price touches it); re-anchor is decided
 *  only at cadence marks (the runner re-quotes on its tick). After a fill the coin is busy for HOLD_BARS
 *  (position open → quotes pulled) then re-quotes fresh. */
function count(c: Candle[], r: Row, cadenceBars: number, drift: number): { events: number; fills: number; days: number } {
  const n = c.length; let anchor = 0, events = 0, fills = 0, busyUntil = -1;
  for (let i = 1; i < n; i++) {
    if (i <= busyUntil) continue;
    if (anchor <= 0) anchor = c[i - 1]!.c;
    const bar = c[i]!;
    let filled = false;
    for (const side of r.sides) {
      const depths = r.deep != null ? [r.x, r.deep] : [r.x];
      for (const d of depths) {
        const limit = side === 1 ? anchor * (1 - d) : anchor * (1 + d);
        if (side === 1 ? bar.l <= limit : bar.h >= limit) filled = true;
      }
    }
    if (filled) { fills++; busyUntil = i + HOLD_BARS; anchor = 0; continue; }
    if (i % cadenceBars === 0 && Math.abs(bar.c - anchor) / anchor > drift) { anchor = bar.c; events++; }
  }
  const days = (n * TF) / 1440;
  return { events, fills, days };
}

(async () => {
  console.log(`HL BUDGET ECONOMICS · ${TF}m klines · ~${DAYS}d · notional $${NOTIONAL} · earn ${EARN_PER_FILL}/fill · unlock ${UNLOCK}\n`);
  const data: { row: Row; c: Candle[] }[] = [];
  for (const row of LIVE) {
    try { const c = await getKlines(`${row.sym}USDT`, String(TF), Date.now() - DAYS * 86_400_000, Date.now()); if (c.length >= 500) data.push({ row, c }); else process.stderr.write(`  skip ${row.coin} (n=${c.length})\n`); }
    catch { process.stderr.write(`  skip ${row.coin} (fetch)\n`); }
  }
  process.stderr.write(`  ${data.length}/${LIVE.length} coins loaded\n`);

  const cadences: [string, number][] = [['1-min', Math.max(1, Math.round(1 / TF))], ['5-min', 1], ['15-min', 3], ['30-min', 6], ['60-min', 12]];
  // NB: at 5m klines the finest resolvable cadence is 5-min; '1-min' collapses to per-bar (a LOWER bound on
  // 1-min events — true 1-min re-anchors more, since it sees intra-bar round-trips 5m data hides).
  const drifts = [0.01, 0.02, 0.03, 0.04];

  console.log('POOLED across the whole 21-coin book (actions/day):');
  console.log('cadence   drift   reanchor/d  quoteAct/d  fills/d  earn/d   fillCost/d   NET/d    verdict         unlock lasts');
  for (const [cLbl, cadB] of cadences) {
    if (cadB < 1) continue;
    for (const drift of drifts) {
      let reEv = 0, quoteAct = 0, fills = 0, dsum = 0;
      for (const { row, c } of data) {
        const { events, fills: f, days } = count(c, row, cadB, drift);
        const perDay = days > 0 ? 1 / days : 0;
        reEv += events * perDay;
        quoteAct += events * 2 * ordersOf(row) * perDay; // cancel+replace all this coin's rungs
        fills += f * perDay;
        dsum = Math.max(dsum, days);
      }
      const earn = fills * EARN_PER_FILL;
      const fillCost = fills * FILL_ACTIONS;
      const net = earn - quoteAct - fillCost;
      const ok = net >= 0;
      const lasts = net >= 0 ? '∞ (self-funds)' : `${(UNLOCK / -net).toFixed(1)} days`;
      console.log(
        `${cLbl.padEnd(9)} ${(drift * 100).toFixed(0).padStart(2)}%    ${reEv.toFixed(0).padStart(9)}  ${quoteAct.toFixed(0).padStart(9)}   ${fills.toFixed(1).padStart(6)}  ${earn.toFixed(0).padStart(6)}  ${fillCost.toFixed(0).padStart(9)}   ${net.toFixed(0).padStart(6)}   ${(ok ? '✅ sustainable' : '❌ bleeds').padEnd(15)} ${lasts}`,
      );
    }
    console.log('');
  }

  // Per-coin action hogs at the current live config (1-min-ish cadence, 1% drift) — who to cut if we must.
  console.log('PER-COIN action cost at 5-min cadence / 1% drift (the hogs — candidates to drop first):');
  console.log('coin        orders  reanchor/d  quoteAct/d  fills/d  earn/d   NET/d');
  const rows: { coin: string; q: number; net: number }[] = [];
  for (const { row, c } of data) {
    const { events, fills, days } = count(c, row, 1, 0.01);
    const perDay = days > 0 ? 1 / days : 0;
    const q = events * 2 * ordersOf(row) * perDay;
    const earn = fills * perDay * EARN_PER_FILL;
    const net = earn - q - fills * perDay * FILL_ACTIONS;
    rows.push({ coin: row.coin, q, net });
    console.log(`${row.coin.padEnd(11)} ${String(ordersOf(row)).padStart(5)}   ${(events * perDay).toFixed(0).padStart(9)}  ${q.toFixed(0).padStart(9)}   ${(fills * perDay).toFixed(1).padStart(6)}  ${earn.toFixed(0).padStart(6)}  ${net.toFixed(0).padStart(6)}`);
  }
  console.log('\ncut order (worst NET first):', rows.sort((a, b) => a.net - b.net).slice(0, 8).map((r) => `${r.coin}(${r.net.toFixed(0)})`).join(' '));
  console.log('\nREADING: a config is only viable if NET/d ≥ 0 (earned volume ≥ actions burned). Otherwise the unlock');
  console.log('is a RECURRING cost every "unlock lasts" days — the structural fix is wider drift / fewer coins / more capital.');
})().catch((e) => { console.error(e); process.exit(1); });
