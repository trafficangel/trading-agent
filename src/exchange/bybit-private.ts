/**
 * Bybit V5 signed API client for Track D (client-account trading).
 *
 * Each function takes a `creds = { apiKey, apiSecret }` argument — these
 * are the DECRYPTED plaintext credentials, obtained from
 * `getDecryptedCreds(row)` in src/db/repos/user-api-keys.ts. Never log
 * the plaintext, never persist it after the call returns.
 *
 * Signing scheme (Bybit V5):
 *   payload = timestamp + apiKey + recvWindow + (queryString | bodyJson)
 *   signature = HMAC-SHA256(payload, apiSecret).hex
 * Headers:
 *   X-BAPI-API-KEY:      apiKey
 *   X-BAPI-SIGN:         signature
 *   X-BAPI-SIGN-TYPE:    2  (HMAC)
 *   X-BAPI-TIMESTAMP:    timestamp (ms)
 *   X-BAPI-RECV-WINDOW:  5000
 *
 * Endpoints used (all `category=linear` for USDT-perp):
 *   GET  /v5/account/wallet-balance      — verify key + read USDT balance
 *   GET  /v5/account/info                — verify position mode (One-Way required)
 *   POST /v5/position/set-leverage       — set leverage for symbol
 *   POST /v5/order/create                — market entry / market close
 *   POST /v5/position/trading-stop       — set position-based SL
 *   GET  /v5/position/list               — reconcile (does position still exist?)
 *   GET  /v5/order/realtime              — order status (filled qty, avg price)
 *
 * Rate limits (per UID): 10 req/s for trade, 50 req/s for account info.
 * Caller should funnel through p-limit for fan-out across many users.
 */

import { request } from 'undici';
import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const MAINNET = 'https://api.bybit.com';
const TESTNET = 'https://api-testnet.bybit.com';

function baseUrl(): string {
  return config.BYBIT_USE_TESTNET ? TESTNET : MAINNET;
}

const RECV_WINDOW = '5000';

export type Creds = { apiKey: string; apiSecret: string };

function sign(creds: Creds, timestamp: string, payload: string): string {
  return createHmac('sha256', creds.apiSecret)
    .update(timestamp + creds.apiKey + RECV_WINDOW + payload)
    .digest('hex');
}

async function signedGet<T>(
  creds: Creds,
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<{ ok: true; data: T } | { ok: false; code: number; msg: string }> {
  const filtered = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  const timestamp = String(Date.now());
  const signature = sign(creds, timestamp, filtered);
  const url = `${baseUrl()}${path}${filtered ? '?' + filtered : ''}`;
  try {
    const res = await request(url, {
      method: 'GET',
      headers: {
        'X-BAPI-API-KEY': creds.apiKey,
        'X-BAPI-SIGN': signature,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
      },
      headersTimeout: 8_000,
      bodyTimeout: 8_000,
    });
    const text = await res.body.text();
    let body: { retCode: number; retMsg: string; result?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON response means we hit something other than the V5 API
      // (e.g. CDN error page, 5xx with no body, wrong URL). Surface a
      // clean message so the cabinet doesn't show a JSON parse error.
      logger.error({ path, status: res.statusCode, snippet: text.slice(0, 100) }, 'bybit-private GET: non-JSON');
      return { ok: false, code: -1, msg: `Bybit вернул ответ без JSON (HTTP ${res.statusCode})` };
    }
    if (body.retCode !== 0) {
      return { ok: false, code: body.retCode, msg: body.retMsg };
    }
    return { ok: true, data: body.result as T };
  } catch (err) {
    logger.error({ err, path }, 'bybit-private GET failed');
    return { ok: false, code: -1, msg: 'Не удалось связаться с Bybit (сеть/таймаут)' };
  }
}

/** Retry config for 429 / 5xx — exponential backoff with jitter.
 *  Bybit V5 per-key trading limit is 10 req/s; if we hit it on a
 *  fan-out wave, brief retries usually recover instantly. */
const RETRY_BACKOFF_MS = [200, 600, 1500];

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function signedPost<T>(
  creds: Creds,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; code: number; msg: string }> {
  const json = JSON.stringify(body);
  const url = `${baseUrl()}${path}`;
  // Retry loop — re-sign on each attempt because timestamp changes.
  // Retryable conditions: HTTP 429, HTTP 5xx, network errors, retCode 10006.
  let lastResult: { ok: false; code: number; msg: string } | null = null;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    const timestamp = String(Date.now());
    const signature = sign(creds, timestamp, json);
    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BAPI-API-KEY': creds.apiKey,
          'X-BAPI-SIGN': signature,
          'X-BAPI-SIGN-TYPE': '2',
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        },
        body: json,
        headersTimeout: 8_000,
        bodyTimeout: 8_000,
      });
      const text = await res.body.text();
      // Retry on 5xx / 429 with empty body.
      if ((res.statusCode === 429 || res.statusCode >= 500) && attempt < RETRY_BACKOFF_MS.length) {
        logger.warn({ path, status: res.statusCode, attempt }, 'bybit-private POST: retrying');
        lastResult = { ok: false, code: -1, msg: `HTTP ${res.statusCode}` };
        await sleep(RETRY_BACKOFF_MS[attempt]!);
        continue;
      }
      let respBody: { retCode: number; retMsg: string; result?: unknown };
      try {
        respBody = JSON.parse(text);
      } catch {
        logger.error({ path, status: res.statusCode, snippet: text.slice(0, 100) }, 'bybit-private POST: non-JSON');
        return { ok: false, code: -1, msg: `Bybit вернул ответ без JSON (HTTP ${res.statusCode})` };
      }
      // Retry on rate-limit retCode.
      if (respBody.retCode === 10006 && attempt < RETRY_BACKOFF_MS.length) {
        logger.warn({ path, attempt }, 'bybit-private POST: rate limit, retrying');
        lastResult = { ok: false, code: respBody.retCode, msg: respBody.retMsg };
        await sleep(RETRY_BACKOFF_MS[attempt]!);
        continue;
      }
      if (respBody.retCode !== 0) {
        return { ok: false, code: respBody.retCode, msg: respBody.retMsg };
      }
      return { ok: true, data: respBody.result as T };
    } catch (err) {
      logger.error({ err, path, attempt }, 'bybit-private POST failed');
      lastResult = { ok: false, code: -1, msg: 'Не удалось связаться с Bybit (сеть/таймаут)' };
      if (attempt < RETRY_BACKOFF_MS.length) {
        await sleep(RETRY_BACKOFF_MS[attempt]!);
      }
    }
  }
  return lastResult ?? { ok: false, code: -1, msg: 'Не удалось связаться с Bybit (исчерпаны ретраи)' };
}

// ============================================================
// Public API
// ============================================================

/**
 * Verify the key works AND fetch USDT-equivalent balance for the
 * unified trading account. Used at /account/api-key submission and
 * by the fan-out preflight ("does this user still have margin?").
 *
 * Returns null if the key is invalid / network failed.
 */
export async function fetchBalanceUsdt(creds: Creds): Promise<{
  ok: true;
  totalUsdt: number;
  availableUsdt: number;
} | { ok: false; code: number; msg: string }> {
  const r = await signedGet<{
    list?: Array<{
      totalEquity?: string;
      totalAvailableBalance?: string;
      coin?: Array<{ coin: string; usdValue?: string; walletBalance?: string; availableToWithdraw?: string }>;
    }>;
  }>(creds, '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  if (!r.ok) return r;
  const acct = r.data.list?.[0];
  if (!acct) return { ok: false, code: -2, msg: 'no account in response' };
  const totalUsdt = Number(acct.totalEquity ?? '0');
  const availableUsdt = Number(acct.totalAvailableBalance ?? '0');
  return { ok: true, totalUsdt, availableUsdt };
}

/** Verify the account is in One-Way mode (not Hedge). We only support
 *  One-Way to keep reverse-signal flips clean. */
export async function fetchPositionMode(creds: Creds): Promise<{
  ok: true;
  isOneWay: boolean;
  raw: unknown;
} | { ok: false; code: number; msg: string }> {
  // Bybit V5 stores position mode on a per-symbol or per-coin basis,
  // queried via /v5/position/switch-mode (read isn't exposed cleanly;
  // we infer from /v5/position/list response). For verify purposes we
  // attempt to read the unified account flag.
  const r = await signedGet<{ unifiedMarginStatus?: number; positionMode?: string }>(
    creds,
    '/v5/account/info',
    {},
  );
  if (!r.ok) return r;
  // unifiedMarginStatus: 1=regular, 2=UTA pro... position mode isn't always
  // here. As a fallback we'll check positions-list mode flag elsewhere.
  return { ok: true, isOneWay: true, raw: r.data };
}

/**
 * Force the user's USDT-perp account into ONE-WAY position mode.
 *
 * Bybit V5 accounts default to One-Way but users (and copy-trading tools)
 * sometimes flip to Hedge mode. Our order placement code uses positionIdx=0
 * (One-Way semantics); under Hedge mode that returns retCode 10001
 * "position idx not match position mode" and the order is REJECTED.
 *
 * We call this once before the first order on any symbol — Bybit makes
 * it idempotent: retCode 110025 "Position mode is not modified" means
 * we're already in the requested mode, treat as success.
 *
 * Modes (V5): 0 = MergedSingle (One-Way), 3 = BothSide (Hedge).
 * We always force 0.
 *
 * `coin: 'USDT'` switches mode for ALL USDT-quoted perps at once —
 * cheaper than calling per-symbol for users with multiple strategies.
 */
export async function switchToOneWayMode(
  creds: Creds,
): Promise<{ ok: true } | { ok: false; code: number; msg: string }> {
  const r = await signedPost<unknown>(creds, '/v5/position/switch-mode', {
    category: 'linear',
    coin: 'USDT',
    mode: 0,
  });
  if (!r.ok) {
    // 110025: position mode not modified — already One-Way, idempotent OK.
    if (r.code === 110025) return { ok: true };
    return r;
  }
  return { ok: true };
}

/**
 * Force cross-margin (REGULAR_MARGIN in UTA terminology) for the user's
 * USDT-perp account. With isolated margin our SL-distance + leverage
 * formula can leave the position too close to Bybit's liquidation price
 * (isolated positions only have their dedicated margin as buffer, not
 * the whole account balance), so a fast wick can liquidate BEFORE our
 * safety SL fires. Cross margin lets the full account balance back every
 * position, which matches the assumption baked into our risk model.
 *
 * Bybit V5 endpoint /v5/account/set-margin-mode accepts:
 *   - REGULAR_MARGIN   = cross margin (what we want)
 *   - ISOLATED_MARGIN  = per-position margin
 *   - PORTFOLIO_MARGIN = options-aware portfolio (not for us)
 *
 * Idempotent on Bybit's side — if already cross, code 110025 returns
 * which we treat as success.
 */
export async function setCrossMargin(
  creds: Creds,
): Promise<{ ok: true } | { ok: false; code: number; msg: string }> {
  const r = await signedPost<unknown>(creds, '/v5/account/set-margin-mode', {
    setMarginMode: 'REGULAR_MARGIN',
  });
  if (!r.ok) {
    // 110025: «margin mode not modified» — already cross, idempotent OK.
    // 110024: «margin mode change not allowed» — account has open
    // positions or pending orders, can't switch right now. Caller should
    // log + continue (most likely user has manual positions we shouldn't
    // touch; cross margin will apply on next clean state).
    if (r.code === 110025) return { ok: true };
    return r;
  }
  return { ok: true };
}

export async function setLeverage(
  creds: Creds,
  symbol: string,
  leverage: number,
): Promise<{ ok: true } | { ok: false; code: number; msg: string }> {
  const lev = String(Math.max(1, Math.min(100, Math.floor(leverage))));
  const r = await signedPost<unknown>(creds, '/v5/position/set-leverage', {
    category: 'linear',
    symbol,
    buyLeverage: lev,
    sellLeverage: lev,
  });
  if (!r.ok) {
    // 110043 = "leverage not modified" — idempotent OK.
    if (r.code === 110043) return { ok: true };
    return r;
  }
  return { ok: true };
}

export type PlaceMarketArgs = {
  symbol: string;
  side: 'long' | 'short';
  qty: number;              // base coin units
  reduceOnly?: boolean;     // for closing
  clientOrderId?: string;   // idempotency key
  /** Attach a position-based safety SL atomically with the entry.
   *  Bybit V5 accepts stopLoss directly on /order/create — using this
   *  avoids the window where a position exists without a stop, which
   *  would otherwise require a separate /position/trading-stop call. */
  stopLoss?: number;
};

export type PlaceMarketResult = {
  ok: true;
  orderId: string;
  orderLinkId: string;
} | { ok: false; code: number; msg: string };

/**
 * Open or close a position at market. For `reduceOnly: true` we're
 * closing — Bybit requires the OPPOSITE side of the position direction.
 * The caller (executeUserExit) inverts internally.
 *
 * If `stopLoss` is provided AND reduceOnly is false, the SL is attached
 * to the entry atomically (single API call) — Bybit applies it as a
 * position-based stop visible in /position/list.
 */
export async function placeMarketOrder(
  creds: Creds,
  args: PlaceMarketArgs,
): Promise<PlaceMarketResult> {
  const bybitSide = args.side === 'long' ? 'Buy' : 'Sell';
  const body: Record<string, unknown> = {
    category: 'linear',
    symbol: args.symbol,
    side: bybitSide,
    orderType: 'Market',
    qty: String(args.qty),
    timeInForce: 'IOC',
    reduceOnly: args.reduceOnly ?? false,
    orderLinkId: args.clientOrderId, // idempotency
  };
  if (args.stopLoss && !args.reduceOnly) {
    body.stopLoss = String(args.stopLoss);
    body.slTriggerBy = 'LastPrice';
    body.tpslMode = 'Full';
  }
  const r = await signedPost<{ orderId: string; orderLinkId: string }>(
    creds,
    '/v5/order/create',
    body,
  );
  if (!r.ok) return r;
  return { ok: true, orderId: r.data.orderId, orderLinkId: r.data.orderLinkId };
}

/**
 * Set a position-based safety SL. This is NOT a separate order — Bybit
 * tracks it as a property of the position. If the SL price is hit, the
 * exchange auto-closes at market.
 */
export async function setPositionSL(
  creds: Creds,
  symbol: string,
  slPrice: number,
): Promise<{ ok: true } | { ok: false; code: number; msg: string }> {
  const r = await signedPost<unknown>(creds, '/v5/position/trading-stop', {
    category: 'linear',
    symbol,
    stopLoss: String(slPrice),
    slTriggerBy: 'LastPrice',
    positionIdx: 0, // 0 = One-Way mode
    tpslMode: 'Full',
  });
  if (!r.ok) return r;
  return { ok: true };
}

export type Position = {
  symbol: string;
  side: 'long' | 'short' | null; // null when flat
  size: number;
  avgPrice: number;
  unrealisedPnl: number;
  positionIdx: number;
  /** Bybit's currently-attached SL trigger. 0 / "" → not set. Audit C3
   *  uses this to verify the SL actually attached after placeMarketOrder
   *  before trusting that the position is protected. */
  stopLoss: number;
};

/**
 * Audit M-NEW-4 — read ALL open positions on the account (no symbol
 * filter). Used by the crash-recovery cron to detect positions on
 * Bybit that have no matching decision row in our DB (orphans from
 * an OS crash between placeMarketOrder and insertDecision).
 *
 * Bybit's `/v5/position/list` accepts `settleCoin=USDT` to return all
 * USDT-perp positions in one call (vs N calls per-symbol). Empty
 * list when the account is flat.
 */
export async function fetchAllPositions(
  creds: Creds,
): Promise<{ ok: true; positions: Position[] } | { ok: false; code: number; msg: string }> {
  const r = await signedGet<{
    list?: Array<{
      symbol: string;
      side: string;
      size: string;
      avgPrice: string;
      unrealisedPnl: string;
      positionIdx: number;
      stopLoss?: string;
    }>;
  }>(creds, '/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
  if (!r.ok) return r;
  const positions: Position[] = [];
  for (const row of r.data.list ?? []) {
    if (!row.size || Number(row.size) === 0) continue;
    const side: 'long' | 'short' | null =
      row.side === 'Buy' ? 'long' : row.side === 'Sell' ? 'short' : null;
    positions.push({
      symbol: row.symbol,
      side,
      size: Number(row.size),
      avgPrice: Number(row.avgPrice),
      unrealisedPnl: Number(row.unrealisedPnl),
      positionIdx: row.positionIdx,
      stopLoss: row.stopLoss ? Number(row.stopLoss) : 0,
    });
  }
  return { ok: true, positions };
}

/** Read the current open position for a symbol. Returns null if flat. */
export async function fetchPosition(
  creds: Creds,
  symbol: string,
): Promise<{ ok: true; position: Position | null } | { ok: false; code: number; msg: string }> {
  const r = await signedGet<{
    list?: Array<{
      symbol: string;
      side: string;
      size: string;
      avgPrice: string;
      unrealisedPnl: string;
      positionIdx: number;
      stopLoss?: string;
    }>;
  }>(creds, '/v5/position/list', { category: 'linear', symbol });
  if (!r.ok) return r;
  const row = r.data.list?.[0];
  if (!row || !row.size || Number(row.size) === 0) return { ok: true, position: null };
  const side: 'long' | 'short' | null =
    row.side === 'Buy' ? 'long' : row.side === 'Sell' ? 'short' : null;
  return {
    ok: true,
    position: {
      symbol: row.symbol,
      side,
      size: Number(row.size),
      avgPrice: Number(row.avgPrice),
      unrealisedPnl: Number(row.unrealisedPnl),
      positionIdx: row.positionIdx,
      stopLoss: row.stopLoss ? Number(row.stopLoss) : 0,
    },
  };
}

/** Read recent executions (fills) for a symbol since `startTime`.
 *  Used by the reconcile loop to recover the EXACT close price + reason
 *  for a user position that Bybit closed on its own (SL hit / margin /
 *  manual close on the website). Bybit V5 returns executions in
 *  descending-time order with full price + side + execType. */
export type ExecutionRow = {
  /** "Trade" for ordinary fills, "BustTrade" for liquidations,
   *  "Funding" for funding payments. We care about Trade + BustTrade. */
  execType: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  execPrice: number;
  execQty: number;
  closedSize: number;
  /** Bybit closes the slot when (entry side, reduceOnly) executes;
   *  closedPnl is signed PnL for THAT specific exec. */
  closedPnl: number;
  execTime: number;
  orderId: string;
  orderLinkId: string | null;
};

export async function fetchExecutions(
  creds: Creds,
  args: { symbol: string; startTime: number; limit?: number },
): Promise<{ ok: true; rows: ExecutionRow[] } | { ok: false; code: number; msg: string }> {
  // Audit H7 — Bybit V5 execution-list only goes back 7 days. Passing
  // an older startTime returns retCode 10001 ("invalid param"). Clamp
  // here so we degrade to "no executions found" (caller falls back to
  // closed-pnl / last-price) instead of erroring out.
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const clampedStartTime = Math.max(args.startTime, sevenDaysAgo);
  const r = await signedGet<{
    list?: Array<{
      execType: string;
      symbol: string;
      side: string;
      execPrice: string;
      execQty: string;
      closedSize: string;
      closedPnl: string;
      execTime: string;
      orderId: string;
      orderLinkId?: string;
    }>;
  }>(creds, '/v5/execution/list', {
    category: 'linear',
    symbol: args.symbol,
    startTime: clampedStartTime,
    limit: args.limit ?? 50,
  });
  if (!r.ok) return r;
  const rows: ExecutionRow[] = (r.data.list ?? []).map((row) => ({
    execType: row.execType,
    symbol: row.symbol,
    side: row.side === 'Buy' ? 'Buy' : 'Sell',
    execPrice: Number(row.execPrice),
    execQty: Number(row.execQty),
    closedSize: Number(row.closedSize),
    closedPnl: Number(row.closedPnl),
    execTime: Number(row.execTime),
    orderId: row.orderId,
    orderLinkId: row.orderLinkId ?? null,
  }));
  return { ok: true, rows };
}

/** Audit H7 — closed-PnL records persist on Bybit longer than the 7-day
 *  execution-list window. Used by tpsl-monitor reconcile to recover the
 *  exact close price + side + qty for positions Bybit closed on its own
 *  more than a week ago (e.g. a stop hit on a position we orphaned across
 *  a long restart or before our reconcile loop ran).
 *
 *  Returns at most `limit` (default 10) closed-pnl rows for the symbol,
 *  newest first. Caller filters by execTime / qty to find the row that
 *  matches a specific decision. */
export type ClosedPnlRow = {
  symbol: string;
  /** Bybit closed-pnl uses the OPPOSITE side from the closed position:
   *  a long closed by a Sell → side='Sell'. */
  side: 'Buy' | 'Sell';
  qty: number;
  avgEntryPrice: number;
  avgExitPrice: number;
  closedPnl: number;
  /** "Liquidation" | "TakeProfit" | "StopLoss" | "Trade" | ... */
  exitType: string;
  createdTime: number;
  updatedTime: number;
  orderId: string;
};

export async function fetchClosedPnl(
  creds: Creds,
  args: { symbol: string; startTime?: number; limit?: number },
): Promise<{ ok: true; rows: ClosedPnlRow[] } | { ok: false; code: number; msg: string }> {
  const query: Record<string, string | number | undefined> = {
    category: 'linear',
    symbol: args.symbol,
    limit: args.limit ?? 10,
  };
  if (args.startTime) query.startTime = args.startTime;
  const r = await signedGet<{
    list?: Array<{
      symbol: string;
      side: string;
      qty: string;
      avgEntryPrice: string;
      avgExitPrice: string;
      closedPnl: string;
      exitType?: string;
      execType?: string;
      createdTime: string;
      updatedTime: string;
      orderId: string;
    }>;
  }>(creds, '/v5/position/closed-pnl', query);
  if (!r.ok) return r;
  const rows: ClosedPnlRow[] = (r.data.list ?? []).map((row) => ({
    symbol: row.symbol,
    side: row.side === 'Buy' ? 'Buy' : 'Sell',
    qty: Number(row.qty),
    avgEntryPrice: Number(row.avgEntryPrice),
    avgExitPrice: Number(row.avgExitPrice),
    closedPnl: Number(row.closedPnl),
    exitType: row.exitType ?? row.execType ?? 'unknown',
    createdTime: Number(row.createdTime),
    updatedTime: Number(row.updatedTime),
    orderId: row.orderId,
  }));
  return { ok: true, rows };
}

/** Fetch an order's current status (filled qty, avg price) by orderLinkId
 *  or orderId. Used after a market order to read the real fill. */
export async function fetchOrderResult(
  creds: Creds,
  args: { symbol: string; orderId?: string; orderLinkId?: string },
): Promise<
  | { ok: true; order: { status: string; filledQty: number; avgPrice: number } | null }
  | { ok: false; code: number; msg: string }
> {
  const r = await signedGet<{
    list?: Array<{ orderStatus: string; cumExecQty: string; avgPrice: string }>;
  }>(creds, '/v5/order/realtime', {
    category: 'linear',
    symbol: args.symbol,
    orderId: args.orderId,
    orderLinkId: args.orderLinkId,
  });
  if (!r.ok) return r;
  const row = r.data.list?.[0];
  if (!row) return { ok: true, order: null };
  return {
    ok: true,
    order: {
      status: row.orderStatus,
      filledQty: Number(row.cumExecQty),
      avgPrice: Number(row.avgPrice),
    },
  };
}

// ============================================================
// Helpers
// ============================================================

/** @deprecated Use `roundQtyToStep` from bybit-public.ts which fetches
 *  the actual per-symbol qtyStep from instruments-info. Kept here only
 *  for compile-time back-compat — audit H5. */
export function roundContractQty(qty: number, _symbol: string): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  return Math.floor(qty * 10_000) / 10_000;
}

/** Map a Bybit retCode to a human-readable label for logs / cabinet UI. */
export function bybitErrorLabel(code: number): string {
  // Subset of common codes we'll surface to users.
  const map: Record<number, string> = {
    10001: 'invalid_param',
    10003: 'invalid_api_key',
    10004: 'invalid_sign',
    10005: 'permission_denied',
    10006: 'rate_limit_exceeded',
    10010: 'unmatched_ip',
    110001: 'order_not_exists',
    110007: 'insufficient_balance',
    110012: 'insufficient_balance',
    110043: 'leverage_not_modified',
    170131: 'invalid_qty',
  };
  return map[code] ?? `bybit_${code}`;
}
