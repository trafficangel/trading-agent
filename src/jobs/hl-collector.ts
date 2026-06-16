/**
 * HYPERLIQUID MICROSTRUCTURE COLLECTOR — the data layer for the order-flow /
 * OI / funding / book-imbalance strategies that OHLCV can't express. Runs 24/7
 * inside the trading-agent process, fully isolated (own table hl_micro, no
 * orders, no Telegram). HL has NO REST history for these, so we accumulate
 * FORWARD: every day collected = a day we can later backtest.
 *
 *   - WS `trades`: aggressor-classified (side 'B'=buy/'A'=sell) → per-minute
 *     buy/sell volume + CVD delta + trade count. Auto-reconnect + keepalive ping.
 *   - per-minute poll: metaAndAssetCtxs (OI, funding, mark/oracle/mid, premium,
 *     ONE call for all coins) + l2Book per coin (top-5 depth imbalance).
 *   - both writers UPSERT the same (coin, minute) row in hl_micro.
 *
 * VPS-only in practice (needs a stable 24/7 connection); no-ops harmlessly if
 * the WS can't connect (keeps retrying). Never throws into the main loop.
 */

import cron from 'node-cron';
import { WebSocket } from 'undici';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { HL_WS_URL, HL_COINS, metaAndAssetCtxs, l2Book } from '../exchange/hyperliquid.js';

const MIN = 60_000;
const PING_MS = 30_000;
const RECONNECT_MS = 5_000;

type Acc = { buy: number; sell: number; trades: number; liq: number };
/** minuteTs → (coin → accumulator). Flushed once the minute completes. */
const buckets = new Map<number, Map<string, Acc>>();
function accFor(mt: number, coin: string): Acc {
  let m = buckets.get(mt);
  if (!m) { m = new Map(); buckets.set(mt, m); }
  let a = m.get(coin);
  if (!a) { a = { buy: 0, sell: 0, trades: 0, liq: 0 }; m.set(coin, a); }
  return a;
}

const num = (x: unknown): number | null => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

const upsertFlow = db.prepare(`
  INSERT INTO hl_micro (coin, ts, buy_vol, sell_vol, cvd_delta, trades, liq_vol)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(coin, ts) DO UPDATE SET
    buy_vol = excluded.buy_vol, sell_vol = excluded.sell_vol,
    cvd_delta = excluded.cvd_delta, trades = excluded.trades, liq_vol = excluded.liq_vol`);
const upsertSnap = db.prepare(`
  INSERT INTO hl_micro (coin, ts, oi, funding, mark, oracle, premium, mid, book_bid, book_ask, book_imb)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(coin, ts) DO UPDATE SET
    oi = excluded.oi, funding = excluded.funding, mark = excluded.mark, oracle = excluded.oracle,
    premium = excluded.premium, mid = excluded.mid,
    book_bid = excluded.book_bid, book_ask = excluded.book_ask, book_imb = excluded.book_imb`);

// ── WS trade tape ──────────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const COINSET = new Set<string>(HL_COINS);

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_MS);
}

function connect(): void {
  try {
    ws = new WebSocket(HL_WS_URL);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'hl-collector: WS construct failed');
    scheduleReconnect();
    return;
  }
  ws.addEventListener('open', () => {
    for (const coin of HL_COINS) ws?.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { ws?.send(JSON.stringify({ method: 'ping' })); } catch { /* ignore */ } }, PING_MS);
    logger.info({ coins: HL_COINS.length }, 'hl-collector: WS open, subscribed trades');
  });
  ws.addEventListener('message', (e) => {
    try {
      const raw = (e as { data: unknown }).data;
      const m = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as { channel?: string; data?: unknown };
      if (m.channel !== 'trades' || !Array.isArray(m.data)) return;
      for (const t of m.data as { coin: string; side: string; sz: string; time: number }[]) {
        if (!COINSET.has(t.coin)) continue;
        const sz = Number(t.sz);
        if (!(sz > 0)) continue;
        const a = accFor(Math.floor(t.time / MIN) * MIN, t.coin);
        if (t.side === 'B') a.buy += sz; else a.sell += sz; // 'B' = aggressor bought, 'A' = sold
        a.trades++;
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'hl-collector: msg parse');
    }
  });
  ws.addEventListener('close', () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    logger.warn('hl-collector: WS closed → reconnect');
    scheduleReconnect();
  });
  ws.addEventListener('error', (e) => {
    logger.warn({ err: String((e as { message?: string }).message ?? 'ws error') }, 'hl-collector: WS error');
  });
}

// ── per-minute flush + snapshot poll ────────────────────────────────────────
function flushCompleted(cutoff: number): void {
  for (const [mt, m] of [...buckets.entries()]) {
    if (mt >= cutoff) continue;
    const tx = db.transaction(() => {
      for (const [coin, a] of m) upsertFlow.run(coin, mt, a.buy, a.sell, a.buy - a.sell, a.trades, a.liq);
    });
    tx();
    buckets.delete(mt);
  }
}

async function pollSnapshot(snapTs: number): Promise<void> {
  const [meta, ctxs] = await metaAndAssetCtxs();
  const idx = new Map(meta.universe.map((u, i) => [u.name, i]));
  for (const coin of HL_COINS) {
    const i = idx.get(coin);
    if (i == null) continue;
    const c = ctxs[i];
    if (!c) continue;
    let bb: number | null = null, ba: number | null = null, imb: number | null = null;
    try {
      const b = await l2Book(coin);
      const sum = (lv: { sz: string }[]) => lv.slice(0, 5).reduce((s, x) => s + Number(x.sz), 0);
      bb = sum(b.levels[0]); ba = sum(b.levels[1]);
      imb = bb + ba > 0 ? Math.round(((bb - ba) / (bb + ba)) * 1e4) / 1e4 : null;
    } catch { /* book optional — keep snapshot without it */ }
    upsertSnap.run(coin, snapTs, num(c.openInterest), num(c.funding), num(c.markPx), num(c.oraclePx), num(c.premium), num(c.midPx), bb, ba, imb);
  }
}

let polling = false;
async function tick(): Promise<void> {
  const cutoff = Math.floor(Date.now() / MIN) * MIN; // current (incomplete) minute
  flushCompleted(cutoff);
  if (polling) return;
  polling = true;
  try {
    await pollSnapshot(cutoff - MIN); // attribute the snapshot to the just-completed minute
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'hl-collector: snapshot poll failed');
  } finally {
    polling = false;
  }
}

export function startHlCollector(): void {
  connect();
  cron.schedule('* * * * *', () => { void tick(); });
  logger.info({ coins: HL_COINS.length }, 'hl-collector started (WS trades→CVD + per-min OI/funding/book → hl_micro)');
}
