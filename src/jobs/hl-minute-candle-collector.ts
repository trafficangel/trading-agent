/**
 * HL MINUTE CANDLE COLLECTOR — 1m native/derived candles for Momentum Follow.
 *
 * The hot path does not add extra Hyperliquid API pressure: Momentum already
 * polls allMids every 2s, and upsertHlMinuteCandlesFromMids turns that stream
 * into the current 1m OHLC. A slow REST repair pass runs every 15 minutes to
 * backfill closed bars and real volume.
 */
import cron from 'node-cron';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { metaAndAssetCtxs } from '../exchange/hyperliquid.js';
import { WF_CONFIG } from './wick-fade-runner.js';

const FUNDING_FLIP_COINS = ['ETH', 'ADA', 'XRP', 'AVAX'];
const MAJORS_CONTROLS = ['BTC', 'ETH', 'SOL', 'LINK'];
const FALLBACK_COINS = [...new Set([...WF_CONFIG.coins, ...FUNDING_FLIP_COINS, ...MAJORS_CONTROLS])];
const INTERVAL = '1m';
const STEP_MS = 60_000;
const FIRST_RUN_LOOKBACK_MS = 72 * 60 * 60_000; // 4320 bars, under HL's ~5000-bar serving cap
const RETENTION_MS = 7 * 86_400_000;

type HlKline = { t: number; T: number; o: string; h: string; l: string; c: string; v: string };
type Stmts = {
  lastT: (coin: string) => number | null;
  insMany: (coin: string, rows: HlKline[]) => void;
  upsertMids: (rows: Array<{ coin: string; t: number; px: number }>) => void;
  prune: (cutoff: number) => void;
};

let stmts: Stmts | null = null;
function ensureStmts(): Stmts {
  if (!stmts) {
    const last = db.prepare<[string], { t: number | null }>(`SELECT MAX(t) AS t FROM hl_candles_1m WHERE coin = ?`);
    const ins = db.prepare(`
      INSERT INTO hl_candles_1m (coin,t,o,h,l,c,v,source)
      VALUES (?,?,?,?,?,?,?,'rest')
      ON CONFLICT(coin,t) DO UPDATE SET
        o = excluded.o,
        h = excluded.h,
        l = excluded.l,
        c = excluded.c,
        v = excluded.v,
        source = 'rest'
    `);
    const upsertMid = db.prepare(`
      INSERT INTO hl_candles_1m (coin,t,o,h,l,c,v,source)
      VALUES (?,?,?,?,?,?,0,'mids')
      ON CONFLICT(coin,t) DO UPDATE SET
        h = max(h, excluded.h),
        l = min(l, excluded.l),
        c = excluded.c
    `);
    const pruneStmt = db.prepare<[number], void>(`DELETE FROM hl_candles_1m WHERE t < ?`);
    const insTx = db.transaction((coin: string, rows: HlKline[]) => {
      for (const k of rows) ins.run(coin, k.t, +k.o, +k.h, +k.l, +k.c, +k.v);
    });
    const midsTx = db.transaction((rows: Array<{ coin: string; t: number; px: number }>) => {
      for (const r of rows) upsertMid.run(r.coin, r.t, r.px, r.px, r.px, r.px);
    });
    stmts = {
      lastT: (coin) => last.get(coin)?.t ?? null,
      insMany: (coin, rows) => { insTx(coin, rows); },
      upsertMids: (rows) => { if (rows.length) midsTx(rows); },
      prune: (cutoff) => { pruneStmt.run(cutoff); },
    };
  }
  return stmts;
}

function minuteBucket(ms: number): number {
  return Math.floor(ms / STEP_MS) * STEP_MS;
}

const finite = (k: HlKline): boolean => k.t > 0 && [k.o, k.h, k.l, k.c, k.v].every((x) => Number.isFinite(+x));

function restRepairEnabled(): boolean {
  const row = db.prepare<[string], { value: string }>('SELECT value FROM runtime_config WHERE key = ?').get('hl_minute_candle_rest_repair_enabled');
  return Number(row?.value ?? 0) >= 0.5;
}

async function fetchCandles(coin: string, startMs: number, endMs: number): Promise<HlKline[] | null> {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: INTERVAL, startTime: startMs, endTime: endMs } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const arr = (await res.json()) as HlKline[];
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

async function coinUniverse(): Promise<string[]> {
  try {
    const [meta] = await metaAndAssetCtxs();
    const coins = meta.universe.map((u) => u.name).filter((c) => /^[A-Za-z0-9]+$/.test(c));
    return coins.length ? coins : FALLBACK_COINS;
  } catch (err) {
    logger.warn({ err: (err as Error).message, fallback: FALLBACK_COINS.length }, 'hl-minute-candle-collector: meta read failed - fallback universe');
    return FALLBACK_COINS;
  }
}

export function upsertHlMinuteCandlesFromMids(mids: Map<string, number>, now = Date.now()): void {
  try {
    const t = minuteBucket(now);
    const rows: Array<{ coin: string; t: number; px: number }> = [];
    for (const [coin, px] of mids) {
      if (/^[A-Za-z0-9]+$/.test(coin) && px > 0 && Number.isFinite(px)) rows.push({ coin, t, px });
    }
    ensureStmts().upsertMids(rows);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'hl-minute-candle-collector: mids upsert failed');
  }
}

let running = false;
async function repairTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const s = ensureStmts();
    const now = Date.now();
    const end = minuteBucket(now);
    const coins = await coinUniverse();
    let stored = 0, failed = 0;
    for (const coin of coins) {
      const last = s.lastT(coin);
      const start = last != null ? last : end - FIRST_RUN_LOOKBACK_MS;
      const arr = await fetchCandles(coin, start, end);
      if (!arr) { failed++; continue; }
      const rows = arr.filter((k) => finite(k) && Number(k.T) <= end);
      if (last != null && rows.length && rows[0]!.t - last > STEP_MS) {
        logger.warn({ coin, gapFromMs: last, gapToMs: rows[0]!.t, gapBars: Math.round((rows[0]!.t - last) / STEP_MS) - 1 }, 'hl-minute-candle-collector: gap repaired from REST window');
      }
      if (rows.length) { s.insMany(coin, rows); stored += rows.length; }
      await new Promise((r) => setTimeout(r, 500));
    }
    s.prune(now - RETENTION_MS);
    logger.info({ stored, failed, coins: coins.length }, 'hl-minute-candle-collector: repair tick done');
    if (failed) logger.warn({ stored, failed, coins: coins.length }, 'hl-minute-candle-collector: repair tick had failures');
  } catch (err) {
    logger.error({ err }, 'hl-minute-candle-collector: repair tick failed (missing migration 046? run pnpm migrate)');
  } finally {
    running = false;
  }
}

export function startHlMinuteCandleCollector(): void {
  if (!restRepairEnabled()) {
    logger.info({ fallbackCoins: FALLBACK_COINS.length, interval: INTERVAL }, 'hl-minute-candle-collector scheduled (mids hot path only; REST repair disabled)');
    return;
  }
  cron.schedule('2,17,32,47 * * * *', () => { void repairTick(); });
  setTimeout(() => { void repairTick(); }, 30_000);
  logger.info({ fallbackCoins: FALLBACK_COINS.length, interval: INTERVAL }, 'hl-minute-candle-collector scheduled (1m repair every 15m + mids hot path)');
}
