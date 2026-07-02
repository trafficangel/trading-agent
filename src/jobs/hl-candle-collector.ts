/**
 * HL CANDLE COLLECTOR — forward-archive NATIVE Hyperliquid 5m candles into hl_candles. HL serves only the
 * most recent ~5000 bars (~17d of 5m; older ranges return EMPTY, not paginable), so re-validating the
 * wick-fade coins on the venue we actually trade needs our own archive — after a month+ this closes the
 * Bybit-proxy gap honestly. Coins = the live wick-fade book (derived from WF_CONFIG — universe changes
 * often, a stale copy would leave silent 17d-capped holes) + funding-flip set + efficient majors (CONTROLS
 * for the artifact check — a gate that lights up majors is fake, see [[controls-catch-artifacts]]).
 *
 * Mechanics: every 15 min (offset :07 — off the 1-min trading loop's hot second and the info-API burst),
 * per coin, fetch from the last stored bar (inclusive startTime re-fetches it → finalizes a then-partial
 * candle; INSERT OR REPLACE dedupes) and store CLOSED bars only (k.T ≤ now — the in-progress bucket never
 * lands in the archive). First run backfills the full ~17d HL still serves. Public MAINNET market data via
 * plain fetch (no auth/SDK; independent of HL_USE_TESTNET). Per-coin failures are non-fatal and the next
 * tick self-heals; a gap wider than one bar after downtime is LOGGED (backtests must know the hole exists).
 * Statements are prepared LAZILY so a missing migration degrades to a logged error, never a boot crash.
 */
import cron from 'node-cron';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { WF_CONFIG } from './wick-fade-runner.js';

const FUNDING_FLIP_COINS = ['ETH', 'ADA', 'XRP', 'AVAX'];
const MAJORS_CONTROLS = ['BTC', 'ETH', 'SOL', 'LINK'];
const COINS = [...new Set([...WF_CONFIG.coins, ...FUNDING_FLIP_COINS, ...MAJORS_CONTROLS])];
const INTERVAL = '5m';
const STEP_MS = 5 * 60_000;
const FIRST_RUN_LOOKBACK_MS = 17 * 86_400_000; // ~4896 bars — under HL's ~5000-bar serving cap

type Stmts = { lastT: (coin: string) => number | null; insMany: (coin: string, rows: HlKline[]) => void };
let stmts: Stmts | null = null;
function ensureStmts(): Stmts {
  if (!stmts) {
    const last = db.prepare<[string], { t: number | null }>(`SELECT MAX(t) AS t FROM hl_candles WHERE coin = ?`);
    const ins = db.prepare(`INSERT OR REPLACE INTO hl_candles (coin,t,o,h,l,c,v) VALUES (?,?,?,?,?,?,?)`);
    const tx = db.transaction((coin: string, rows: HlKline[]) => { for (const k of rows) ins.run(coin, k.t, +k.o, +k.h, +k.l, +k.c, +k.v); });
    stmts = { lastT: (coin) => last.get(coin)?.t ?? null, insMany: (coin, rows) => { tx(coin, rows); } };
  }
  return stmts;
}

type HlKline = { t: number; T: number; o: string; h: string; l: string; c: string; v: string };
async function fetchCandles(coin: string, startMs: number, endMs: number): Promise<HlKline[] | null> {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: INTERVAL, startTime: startMs, endTime: endMs } }),
      signal: AbortSignal.timeout(10_000), // a black-holed connection must not wedge the sequential loop
    });
    if (!res.ok) return null;
    const arr = (await res.json()) as HlKline[];
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

const finite = (k: HlKline): boolean => k.t > 0 && [k.o, k.h, k.l, k.c, k.v].every((x) => Number.isFinite(+x));

let running = false;
async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const s = ensureStmts();
    const now = Date.now();
    let stored = 0, failed = 0;
    for (const coin of COINS) {
      const last = s.lastT(coin);
      const start = last != null ? last : now - FIRST_RUN_LOOKBACK_MS; // inclusive → re-fetches the last bar, finalizing it
      const arr = await fetchCandles(coin, start, now);
      if (!arr) { failed++; continue; }
      // CLOSED bars only (T = bar close time): the in-progress bucket never enters the archive
      const rows = arr.filter((k) => finite(k) && Number(k.T) <= now);
      if (last != null && rows.length && rows[0]!.t - last > STEP_MS) {
        logger.warn({ coin, gapFromMs: last, gapToMs: rows[0]!.t, gapBars: Math.round((rows[0]!.t - last) / STEP_MS) - 1 }, 'hl-candle-collector: GAP in archive (downtime exceeded HL serving window?) — hole is permanent, note for backtests');
      }
      if (rows.length) { s.insMany(coin, rows); stored += rows.length; }
      await new Promise((r) => setTimeout(r, 500)); // gentle on the shared-IP info API (~32 req / 15 min)
    }
    if (failed) logger.warn({ stored, failed, coins: COINS.length }, 'hl-candle-collector: tick done with failures (next tick self-heals)');
  } catch (err) {
    logger.error({ err }, 'hl-candle-collector: tick failed (missing migration 039? run pnpm migrate)'); // never an unhandled rejection — the trading process must not die for an archive
  } finally { running = false; }
}

export function startHlCandleCollector(): void {
  cron.schedule('7,22,37,52 * * * *', () => { void tick(); }); // offset :07 — away from the :00 trading-loop burst
  setTimeout(() => { void tick(); }, 20_000); // first pass shortly after boot (backfills ~17d per coin once)
  logger.info({ coins: COINS.length, interval: INTERVAL }, 'hl-candle-collector scheduled (every 15m → hl_candles; native-venue archive for re-validation)');
}
