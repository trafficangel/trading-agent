/**
 * GATE-IMPACT — do the new live gates (Codex, Jul 7) cut too many ENTRIES, and are the cut entries
 * net-POSITIVE (bad = over-cutting the edge) or net-NEGATIVE (good = removing losers)? Replays each gate
 * over NATIVE hl_candles / hl_micro and cross-references the honest wick-fade fill sim (identical mechanics
 * to hlnative-voldepth-revalidate.ts). Fixed-depth sim (gates suppress fills independent of depth model).
 *   pnpm tsx scripts/gate-impact.ts        (RUN ON VPS — native data lives in data/trading.sqlite)
 */
import { db } from '../src/db/client.js';

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type Row = { coin: string; x: number; sides: (1 | -1)[] };
const BOTH: (1 | -1)[] = [1, -1], LONG: (1 | -1)[] = [1], SHORT: (1 | -1)[] = [-1];
const LIVE: Row[] = [
  { coin: 'DOGE', x: 0.025, sides: BOTH }, { coin: 'ICP', x: 0.035, sides: BOTH },
  { coin: 'NEAR', x: 0.025, sides: BOTH }, { coin: 'ATOM', x: 0.03, sides: LONG },
  { coin: 'CRV', x: 0.03, sides: BOTH }, { coin: 'ENA', x: 0.025, sides: BOTH },
  { coin: 'TIA', x: 0.025, sides: BOTH }, { coin: 'kPEPE', x: 0.03, sides: BOTH },
  { coin: 'RENDER', x: 0.03, sides: BOTH }, { coin: 'POPCAT', x: 0.025, sides: BOTH },
  { coin: 'JUP', x: 0.025, sides: BOTH }, { coin: 'AR', x: 0.03, sides: BOTH },
  { coin: 'LTC', x: 0.03, sides: LONG }, { coin: 'EIGEN', x: 0.03, sides: BOTH },
  { coin: 'MANTA', x: 0.03, sides: BOTH }, { coin: 'XRP', x: 0.02, sides: BOTH },
  { coin: 'JTO', x: 0.03, sides: BOTH }, { coin: 'ALT', x: 0.03, sides: SHORT },
  { coin: 'PNUT', x: 0.03, sides: BOTH },
];
const SLIP = 0.0025, STOP = 0.04, EXITH = 6, CD_BARS = 6, DRIFT = 0.01, COST = 0.05;
// cascade gate (wick-fade-runner)
const CAS_BARS = 3, CAS_MOVE = 1.5, CAS_MINCOINS = 8, CAS_MINSAMPLE = 12;
const MIN_TOP5_NOTIONAL = 150; // liquidity gate depth arm ($); the spread arm (>0.35%) is NOT stored in hl_micro

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const net = (a: number[]) => Math.round((mean(a) - COST) * a.length * 10) / 10;
const loadCandles = (coin: string): Candle[] => db.prepare('SELECT t,o,h,l,c,v FROM hl_candles WHERE coin=? ORDER BY t').all(coin) as Candle[];

/** honest fill sim, per-fill {g = net%, t = ENTRY-bar timestamp}. Identical mechanics to the validated sim. */
function sim(c: Candle[], sides: (1 | -1)[], x: number): { g: number; t: number }[] {
  const n = c.length; const out: { g: number; t: number }[] = [];
  let anchor = 0, cdUntil = -1;
  let pos: { side: 1 | -1; entry: number; anchorMid: number; entryBar: number; t: number } | null = null;
  for (let i = 1; i < n; i++) {
    const bar = c[i]!;
    if (pos) {
      const target = pos.anchorMid;
      const stopPx = pos.side === 1 ? pos.entry * (1 - STOP) : pos.entry * (1 + STOP);
      const stopFill = pos.side === 1 ? stopPx * (1 - SLIP) : stopPx * (1 + SLIP);
      let exit: number | null = null;
      if (pos.side === 1 ? bar.l <= stopPx : bar.h >= stopPx) exit = stopFill;
      else if (pos.side === 1 ? bar.h >= target : bar.l <= target) exit = target;
      else if (i - pos.entryBar >= EXITH) exit = bar.c;
      if (exit != null) { out.push({ g: (pos.side === 1 ? (exit - pos.entry) / pos.entry : (pos.entry - exit) / pos.entry) * 100, t: pos.t }); if (exit === stopFill) cdUntil = i + CD_BARS; pos = null; anchor = 0; }
      continue;
    }
    if (i <= cdUntil) continue;
    if (anchor <= 0) anchor = c[i - 1]!.c;
    let filled: { side: 1 | -1; entry: number } | null = null;
    for (const side of sides) { const limit = side === 1 ? anchor * (1 - x) : anchor * (1 + x); if (side === 1 ? bar.l <= limit : bar.h >= limit) { if (!filled || (side === 1 ? limit > filled.entry : limit < filled.entry)) filled = { side, entry: limit }; } }
    if (filled) {
      const stopPx = filled.side === 1 ? filled.entry * (1 - STOP) : filled.entry * (1 + STOP);
      if (filled.side === 1 ? bar.l <= stopPx : bar.h >= stopPx) { const sf = filled.side === 1 ? stopPx * (1 - SLIP) : stopPx * (1 + SLIP); out.push({ g: (filled.side === 1 ? (sf - filled.entry) / filled.entry : (filled.entry - sf) / filled.entry) * 100, t: bar.t }); cdUntil = i + CD_BARS; anchor = 0; }
      else { pos = { side: filled.side, entry: filled.entry, anchorMid: anchor, entryBar: i, t: bar.t }; anchor = 0; }
      continue;
    }
    if (Math.abs(bar.c - anchor) / anchor > DRIFT) anchor = bar.c;
  }
  return out;
}

(() => {
  const data = LIVE.map((r) => ({ r, c: loadCandles(r.coin) })).filter((d) => d.c.length >= 200);
  console.log(`GATE-IMPACT · native hl_candles · ${data.length}/20 coins with data · fixed-depth honest sim · verdict@${COST}%\n`);

  // ── 1. CASCADE GATE: build per-timestamp cascade state (index-based 3-bar move, matching the runner) ──
  const cascadeAt = new Map<number, { up: number; down: number; seen: number }>();
  for (const { c } of data) {
    for (let i = CAS_BARS; i < c.length; i++) {
      const base = c[i - CAS_BARS]!; if (!(base.c > 0)) continue;
      const ret = ((c[i]!.c - base.c) / base.c) * 100;
      const e = cascadeAt.get(c[i]!.t) ?? { up: 0, down: 0, seen: 0 };
      if (ret >= CAS_MOVE) e.up++; else if (ret <= -CAS_MOVE) e.down++;
      e.seen++; cascadeAt.set(c[i]!.t, e);
    }
  }
  const isCascade = (t: number): boolean => { const e = cascadeAt.get(t); return !!e && e.seen >= CAS_MINSAMPLE && Math.max(e.up, e.down) >= CAS_MINCOINS; };
  const evalTs = [...cascadeAt.values()].filter((e) => e.seen >= CAS_MINSAMPLE);
  const casActive = evalTs.filter((e) => Math.max(e.up, e.down) >= CAS_MINCOINS).length;
  console.log('── CASCADE GATE ──');
  console.log(`timestamps with ≥${CAS_MINSAMPLE} coins: ${evalTs.length} · cascade-active: ${casActive} (${(100 * casActive / Math.max(1, evalTs.length)).toFixed(1)}% of the time)`);

  // fills, tagged by cascade-at-entry
  const sup: number[] = [], kept: number[] = [];
  for (const { r, c } of data) for (const f of sim(c, r.sides, r.x)) (isCascade(f.t) ? sup : kept).push(f.g);
  const all = [...sup, ...kept];
  console.log(`fills total: ${all.length} · suppressed by cascade gate: ${sup.length} (${(100 * sup.length / Math.max(1, all.length)).toFixed(1)}%)`);
  console.log(`  SUPPRESSED fills:  avg ${mean(sup).toFixed(3)}%  net@cost ${net(sup)}  (n=${sup.length})`);
  console.log(`  KEPT fills:        avg ${mean(kept).toFixed(3)}%  net@cost ${net(kept)}  (n=${kept.length})`);
  console.log(`  ALL fills (no gate): avg ${mean(all).toFixed(3)}%  net@cost ${net(all)}`);
  const verdict = net(sup) < 0 ? '✅ suppressed fills are net-NEGATIVE → the cascade gate removes LOSERS (helps)'
    : net(sup) > 0 ? '⚠️ suppressed fills are net-POSITIVE → the cascade gate is CUTTING GOOD ENTRIES (over-gating)'
    : '≈ neutral';
  console.log(`  → ${verdict}\n`);

  // ── 2. LIQUIDITY GATE (depth arm only; spread arm not stored) ──
  console.log('── LIQUIDITY GATE (depth proxy: top5-size × mid < $' + MIN_TOP5_NOTIONAL + '; spread arm >0.35% NOT replayable) ──');
  const liq = db.prepare(`SELECT coin, COUNT(*) total, SUM(CASE WHEN mid>0 AND MIN(book_bid,book_ask)*mid < ? THEN 1 ELSE 0 END) gated
                          FROM hl_micro WHERE book_bid IS NOT NULL AND book_ask IS NOT NULL GROUP BY coin`).all(MIN_TOP5_NOTIONAL) as { coin: string; total: number; gated: number }[];
  const liveCoins = new Set(LIVE.map((r) => r.coin));
  const liqLive = liq.filter((l) => liveCoins.has(l.coin)).sort((a, b) => (b.gated / b.total) - (a.gated / a.total));
  for (const l of liqLive) console.log(`  ${l.coin.padEnd(8)} depth-gated ${(100 * l.gated / Math.max(1, l.total)).toFixed(1)}%  (${l.gated}/${l.total} min)`);
  const totG = liqLive.reduce((s, l) => s + l.gated, 0), totT = liqLive.reduce((s, l) => s + l.total, 0);
  console.log(`  POOLED depth-gated: ${(100 * totG / Math.max(1, totT)).toFixed(1)}% of coin-minutes (lower bound — spread arm adds more)\n`);

  // ── 3. LIVE-QUARANTINE current state (last 7d of real trades) ──
  console.log('── LIVE-QUARANTINE (current 7d state) ──');
  const since = Date.now() - 7 * 24 * 3600_000;
  const coinCat = db.prepare(`SELECT coin, COUNT(*) n FROM wick_fade_log WHERE mode='live' AND closed_at IS NOT NULL AND closed_at>=?
    AND (close_reason='catastrophe' OR (close_reason='reconciled-flat' AND (pnl_pct<=-2 OR pnl_pct IS NULL))) GROUP BY coin HAVING n>=2`).all(since) as { coin: string; n: number }[];
  const sideQ = db.prepare(`SELECT coin, side, COUNT(*) n, ROUND(SUM(pnl_pct),2) sm FROM wick_fade_log WHERE mode='live' AND closed_at IS NOT NULL AND closed_at>=?
    GROUP BY coin, side HAVING n>=5 AND SUM(pnl_pct)<=-2`).all(since) as { coin: string; side: string; n: number; sm: number }[];
  const closed7d = db.prepare(`SELECT COUNT(*) n FROM wick_fade_log WHERE mode='live' AND closed_at IS NOT NULL AND closed_at>=?`).get(since) as { n: number };
  console.log(`closed live trades in last 7d: ${closed7d.n}`);
  console.log(`coins quarantined (≥2 catastrophe-like/7d): ${coinCat.length ? coinCat.map((c) => `${c.coin}(${c.n})`).join(', ') : 'none'}`);
  console.log(`sides quarantined (≥5 trades & Σpnl≤−2%/7d): ${sideQ.length ? sideQ.map((s) => `${s.coin}-${s.side}(${s.n}/${s.sm}%)`).join(', ') : 'none'}`);
})();
