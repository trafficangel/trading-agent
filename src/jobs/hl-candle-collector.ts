/**
 * HL CANDLE COLLECTOR — forward-archive NATIVE Hyperliquid 5m candles into hl_candles. HL serves only the
 * most recent ~5000 bars (~17d of 5m; older ranges return EMPTY, not paginable), so re-validating the
 * wick-fade/momentum coins on the venue we actually trade needs our own archive. Coins = the full current
 * Hyperliquid perp universe from metaAndAssetCtxs, with a small fallback set if the public meta read fails.
 *
 * Mechanics: a continuous weighted queue fetches each active coin from the last stored bar (inclusive
 * startTime re-fetches it → finalizes a then-partial
 * candle; INSERT OR REPLACE dedupes) and store CLOSED bars only (k.T ≤ now — the in-progress bucket never
 * lands in the archive). First run backfills the full ~17d HL still serves. Public MAINNET market data via
 * plain fetch (no auth/SDK; independent of HL_USE_TESTNET). Per-coin failures are non-fatal and the next
 * tick self-heals; a gap wider than one bar after downtime is LOGGED (backtests must know the hole exists).
 * Statements are prepared LAZILY so a missing migration degrades to a logged error, never a boot crash.
 */
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import {
  activePerpCoinNames,
  knownActivePerpCoins,
  metaAndAssetCtxs,
} from '../exchange/hyperliquid.js';
import { hlCandleArchiveDelayMs } from '../lib/hl-rate-budget.js';
import { WF_CONFIG } from './wick-fade-runner.js';

const FUNDING_FLIP_COINS = ['ETH', 'ADA', 'XRP', 'AVAX'];
const MAJORS_CONTROLS = ['BTC', 'ETH', 'SOL', 'LINK'];
const FALLBACK_COINS = [...new Set([...WF_CONFIG.coins, ...FUNDING_FLIP_COINS, ...MAJORS_CONTROLS])];
const INTERVAL = '5m';
const STEP_MS = 5 * 60_000;
const FIRST_RUN_LOOKBACK_MS = 17 * 86_400_000; // ~4896 bars — under HL's ~5000-bar serving cap
const RATE_LIMIT_BACKOFF_MS = 30_000;
const CYCLE_PAUSE_MS = 5_000;

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
type CandleFetchResult =
  | { ok: true; rows: HlKline[] }
  | { ok: false; status: number | null };

async function fetchCandles(coin: string, startMs: number, endMs: number): Promise<CandleFetchResult> {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: INTERVAL, startTime: startMs, endTime: endMs } }),
      signal: AbortSignal.timeout(10_000), // a black-holed connection must not wedge the sequential loop
    });
    if (!res.ok) return { ok: false, status: res.status };
    const arr = (await res.json()) as HlKline[];
    return Array.isArray(arr) ? { ok: true, rows: arr } : { ok: false, status: res.status };
  } catch { return { ok: false, status: null }; }
}

const finite = (k: HlKline): boolean => k.t > 0 && [k.o, k.h, k.l, k.c, k.v].every((x) => Number.isFinite(+x));

async function coinUniverse(): Promise<string[]> {
  try {
    const [meta] = await metaAndAssetCtxs();
    const coins = activePerpCoinNames(meta.universe);
    return coins.length ? coins : FALLBACK_COINS;
  } catch (err) {
    const known = knownActivePerpCoins();
    const fallback = known ? FALLBACK_COINS.filter((coin) => known.has(coin)) : FALLBACK_COINS;
    logger.warn({ err: (err as Error).message, fallback: fallback.length }, 'hl-candle-collector: meta read failed — fallback universe');
    return fallback;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick(): Promise<void> {
  const cycleStartedAt = Date.now();
  try {
    const s = ensureStmts();
    const coins = await coinUniverse();
    const work = coins
      .map((coin) => ({ coin, last: s.lastT(coin) }))
      .sort((a, b) => (a.last ?? 0) - (b.last ?? 0));
    const failureStatuses = new Map<string, number>();
    let stored = 0, failed = 0, rateLimited = 0;
    for (const { coin, last } of work) {
      const now = Date.now();
      const start = last != null ? last : now - FIRST_RUN_LOOKBACK_MS; // inclusive → re-fetches the last bar, finalizing it
      const result = await fetchCandles(coin, start, now);
      if (!result.ok) {
        failed++;
        const status = result.status == null ? 'network' : String(result.status);
        failureStatuses.set(status, (failureStatuses.get(status) ?? 0) + 1);
        if (result.status === 429) rateLimited++;
        await sleep(result.status === 429 ? RATE_LIMIT_BACKOFF_MS : hlCandleArchiveDelayMs(0));
        continue;
      }
      const arr = result.rows;
      // CLOSED bars only (T = bar close time): the in-progress bucket never enters the archive
      const rows = arr.filter((k) => finite(k) && Number(k.T) <= now);
      if (last != null && rows.length && rows[0]!.t - last > STEP_MS) {
        logger.warn({ coin, gapFromMs: last, gapToMs: rows[0]!.t, gapBars: Math.round((rows[0]!.t - last) / STEP_MS) - 1 }, 'hl-candle-collector: GAP in archive (downtime exceeded HL serving window?) — hole is permanent, note for backtests');
      }
      if (rows.length) { s.insMany(coin, rows); stored += rows.length; }
      await sleep(hlCandleArchiveDelayMs(arr.length));
    }
    const details = {
      stored,
      failed,
      rateLimited,
      coins: coins.length,
      durationSec: Math.round((Date.now() - cycleStartedAt) / 1000),
      failureStatuses: Object.fromEntries(failureStatuses),
    };
    logger.info(details, 'hl-candle-collector: weighted archive cycle done');
    if (failed) logger.warn(details, 'hl-candle-collector: cycle had failures (next cycle self-heals)');
  } catch (err) {
    logger.error({ err }, 'hl-candle-collector: tick failed (missing migration 039? run pnpm migrate)'); // never an unhandled rejection — the trading process must not die for an archive
  }
}

async function runLoop(): Promise<void> {
  for (;;) {
    await tick();
    await sleep(CYCLE_PAUSE_MS);
  }
}

let started = false;
export function startHlCandleCollector(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void runLoop(); }, 20_000).unref();
  logger.info({ fallbackCoins: FALLBACK_COINS.length, interval: INTERVAL }, 'hl-candle-collector scheduled (continuous weighted active-market archive → hl_candles)');
}
