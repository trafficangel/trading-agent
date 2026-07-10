/**
 * Live Hyperliquid <-> Bybit basis-arbitrage pilot.
 *
 * Safety model:
 * - one pair at a time, one completed trade by default;
 * - durable intent before either leg;
 * - fresh >=1% net basis confirmation immediately before entry;
 * - simultaneous capped IOC legs and mandatory position reconciliation;
 * - immediate unwind when only one leg lands;
 * - 1x leverage, $20 per leg, pair-level profit/stop/time exits;
 * - active-position lease synced to the main VPS ownership auditor;
 * - Telegram only for confirmed entries, exits, and execution incidents.
 */

/* eslint-disable no-console -- systemd operator process emits structured logs */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';
import { privateKeyToAccount } from 'viem/accounts';
import {
  evaluateArbMarket,
  scanArbitrage,
  vwap,
  type ArbOpportunity,
} from './scan-hl-bybit-arb.js';
import {
  arbExitReason,
  estimatedBasisNetFromFills,
  estimatedPairNetPnlPct,
  quantizeToStep,
  sidesForBasisDirection,
  underlyingDeltaMismatchPct,
  type ArbLegSide,
} from '../src/lib/hl-bybit-arb-execution.js';

const BYBIT_API = 'https://api.bybit.com';
const RECV_WINDOW = '5000';
const NOTIONAL_USD = envNumber('ARB_NOTIONAL_USD', 20, 10, 100);
const MIN_NET_PCT = envNumber('ARB_MIN_NET_PCT', 1, 1, 10);
const LEVERAGE = 1;
const TAKE_PROFIT_PCT = envNumber('ARB_TAKE_PROFIT_PCT', 0.50, 0.10, 5);
const STOP_LOSS_PCT = envNumber('ARB_STOP_LOSS_PCT', -0.75, -5, -0.10);
const MAX_HOLD_MS = envNumber('ARB_MAX_HOLD_HOURS', 24, 1, 72) * 60 * 60_000;
const MAX_COMPLETED_TRADES = Math.floor(envNumber('ARB_MAX_COMPLETED_TRADES', 1, 1, 10));
const MAX_DELTA_MISMATCH_PCT = envNumber('ARB_MAX_DELTA_MISMATCH_PCT', 2, 0.1, 5);
// Scanner already reserves 0.08% for execution/collateral uncertainty. Cap each
// IOC leg at 0.04% deterioration so the pair cannot spend more than that reserve.
const ENTRY_CAP_PCT = 0.0004;
const ACTIVE_POLL_MS = 5_000;
const IDLE_SCAN_MS = 60_000;
const LEASE_MS = 20_000;
const LIVE = /^(1|true|yes|on)$/i.test(process.env.ARB_LIVE ?? 'false');
const ONCE = process.argv.includes('--once');
const STATE_PATH = process.env.ARB_STATE_PATH ?? './data/hl-bybit-arb-executor.json';
const AUDIT_PATH = process.env.ARB_AUDIT_PATH ?? './data/hl-bybit-arb-trades.ndjson';
const TELEGRAM_PATH = process.env.ARB_TELEGRAM_PATH ?? '../telegram.conf';

type Phase = 'idle' | 'disarmed' | 'entering' | 'open' | 'closing' | 'unwinding';

type StateBase = {
  version: 1;
  phase: Phase;
  live: boolean;
  updatedAt: number;
  leaseExpiresAt: number;
  completedTrades: number;
  lastScanAt?: number;
  lastBest?: { asset: string; netPct: number; direction: string } | null;
  lastError?: string | null;
};

type ActiveState = StateBase & {
  phase: 'entering' | 'open' | 'closing' | 'unwinding';
  intentId: string;
  asset: string;
  coin: string;
  bybitSymbol: string;
  hlUnit: number;
  bybitUnit: number;
  hlSide: ArbLegSide;
  bybitSide: ArbLegSide;
  hlQtyRequested: number;
  bybitQtyRequested: number;
  entryEstimateNetPct: number;
  entryGrossBasisPct: number;
  detectedAt: number;
  openedAt?: number;
  hlEntryPx?: number;
  bybitEntryPx?: number;
  hlQty?: number;
  bybitQty?: number;
  hadExecution?: boolean;
  lastNetPnlPct?: number;
  closeReason?: string;
};

type ExecutorState = StateBase | ActiveState;

type BybitEnvelope<T> = { retCode: number; retMsg: string; result?: T };
type BybitPosition = { symbol: string; side: ArbLegSide; size: number; avgPrice: number };
type HlPosition = { coin: string; side: ArbLegSide; size: number; entryPx: number };
type BybitInstrument = {
  symbol: string;
  priceFilter: { tickSize: string };
  lotSizeFilter: {
    qtyStep: string;
    minOrderQty: string;
    minNotionalValue?: string;
  };
};
type TelegramConfig = { token: string; chat_id: string | number };

class BybitApiError extends Error {
  constructor(readonly code: number, message: string) {
    super(`Bybit ${code}: ${message}`);
  }
}

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const BYBIT_KEY = required('BYBIT_API_KEY');
const BYBIT_SECRET = required('BYBIT_API_SECRET');
const HL_ACCOUNT = required('HL_ACCOUNT_ADDRESS').toLowerCase() as `0x${string}`;
const HL_WALLET = privateKeyToAccount(required('HL_API_WALLET_KEY') as `0x${string}`);
const hlTransport = new HttpTransport({ isTestnet: false });
const hlInfo = new InfoClient({ transport: hlTransport });
const hlExchange = new ExchangeClient({ transport: hlTransport, wallet: HL_WALLET });
let hlMetaCache: Awaited<ReturnType<InfoClient['meta']>> | null = null;
let state: ExecutorState;
let stopping = false;
let telegramCache: TelegramConfig | null | undefined;
let lastIncidentSignature = '';

function isActive(value: ExecutorState): value is ActiveState {
  return ['entering', 'open', 'closing', 'unwinding'].includes(value.phase);
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

async function audit(event: string, fields: Record<string, unknown> = {}): Promise<void> {
  await mkdir(dirname(AUDIT_PATH), { recursive: true });
  await appendFile(AUDIT_PATH, `${JSON.stringify({ ts: Date.now(), event, ...fields })}\n`, { mode: 0o600 });
}

async function loadState(): Promise<ExecutorState> {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, 'utf8')) as ExecutorState;
    if (parsed?.version === 1 && typeof parsed.phase === 'string') return parsed;
  } catch { /* first boot */ }
  const now = Date.now();
  return {
    version: 1,
    phase: 'idle',
    live: LIVE,
    updatedAt: now,
    leaseExpiresAt: 0,
    completedTrades: 0,
  };
}

async function saveState(next: ExecutorState): Promise<void> {
  const now = Date.now();
  state = {
    ...next,
    live: LIVE,
    updatedAt: now,
    leaseExpiresAt: isActive(next) ? now + LEASE_MS : 0,
  } as ExecutorState;
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const temp = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temp, STATE_PATH);
}

async function idleState(fields: Partial<StateBase> = {}): Promise<void> {
  const completedTrades = fields.completedTrades ?? state.completedTrades;
  await saveState({
    version: 1,
    phase: completedTrades >= MAX_COMPLETED_TRADES ? 'disarmed' : 'idle',
    live: LIVE,
    updatedAt: Date.now(),
    leaseExpiresAt: 0,
    completedTrades,
    lastScanAt: fields.lastScanAt ?? state.lastScanAt,
    lastBest: fields.lastBest ?? state.lastBest,
    lastError: fields.lastError ?? null,
  });
}

async function telegramConfig(): Promise<TelegramConfig | null> {
  if (telegramCache !== undefined) return telegramCache;
  try {
    const parsed = JSON.parse(await readFile(TELEGRAM_PATH, 'utf8')) as Partial<TelegramConfig>;
    telegramCache = parsed.token && parsed.chat_id != null
      ? { token: parsed.token, chat_id: parsed.chat_id }
      : null;
  } catch { telegramCache = null; }
  return telegramCache;
}

async function notify(text: string): Promise<void> {
  const cfg = await telegramConfig();
  if (!cfg) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    log('telegram-failed', { message: (error as Error).message });
  }
}

async function notifyIncident(signature: string, text: string): Promise<void> {
  if (signature === lastIncidentSignature) return;
  lastIncidentSignature = signature;
  await notify(text);
}

function signedHeaders(payload: string): Record<string, string> {
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', BYBIT_SECRET)
    .update(timestamp + BYBIT_KEY + RECV_WINDOW + payload)
    .digest('hex');
  return {
    'X-BAPI-API-KEY': BYBIT_KEY,
    'X-BAPI-SIGN': signature,
    'X-BAPI-SIGN-TYPE': '2',
    'X-BAPI-TIMESTAMP': timestamp,
    'X-BAPI-RECV-WINDOW': RECV_WINDOW,
  };
}

async function bybitGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const query = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  const response = await fetch(`${BYBIT_API}${path}${query ? `?${query}` : ''}`, {
    headers: signedHeaders(query),
    signal: AbortSignal.timeout(8_000),
  });
  const body = await response.json() as BybitEnvelope<T>;
  if (!response.ok || body.retCode !== 0) throw new BybitApiError(body.retCode, body.retMsg);
  return body.result as T;
}

async function bybitPost<T>(path: string, requestBody: Record<string, unknown>): Promise<T> {
  const json = JSON.stringify(requestBody);
  const response = await fetch(`${BYBIT_API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signedHeaders(json) },
    body: json,
    signal: AbortSignal.timeout(8_000),
  });
  const body = await response.json() as BybitEnvelope<T>;
  if (!response.ok || body.retCode !== 0) throw new BybitApiError(body.retCode, body.retMsg);
  return body.result as T;
}

async function publicJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return await response.json() as T;
}

async function bybitBalance(): Promise<{ total: number; available: number }> {
  const result = await bybitGet<{
    list?: Array<{ totalEquity?: string; totalAvailableBalance?: string }>;
  }>('/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  const account = result.list?.[0];
  return { total: Number(account?.totalEquity ?? 0), available: Number(account?.totalAvailableBalance ?? 0) };
}

async function bybitPositions(symbol?: string): Promise<BybitPosition[]> {
  const params: Record<string, string> = symbol
    ? { category: 'linear', symbol }
    : { category: 'linear', settleCoin: 'USDT' };
  const result = await bybitGet<{
    list?: Array<{ symbol: string; side: string; size: string; avgPrice: string }>;
  }>('/v5/position/list', params);
  return (result.list ?? []).flatMap((row) => {
    const size = Number(row.size);
    const side = row.side === 'Buy' ? 'long' : row.side === 'Sell' ? 'short' : null;
    return size > 0 && side ? [{ symbol: row.symbol, side, size, avgPrice: Number(row.avgPrice) }] : [];
  });
}

async function bybitInstrument(symbol: string): Promise<BybitInstrument> {
  const body = await publicJson<BybitEnvelope<{ list?: BybitInstrument[] }>>(
    `${BYBIT_API}/v5/market/instruments-info?category=linear&symbol=${encodeURIComponent(symbol)}`,
  );
  if (body.retCode !== 0 || !body.result?.list?.[0]) throw new Error(`Bybit instrument ${symbol}: ${body.retMsg}`);
  return body.result.list[0];
}

async function ensureBybitOneWay(): Promise<void> {
  try {
    await bybitPost('/v5/position/switch-mode', { category: 'linear', coin: 'USDT', mode: 0 });
  } catch (error) {
    if (!(error instanceof BybitApiError) || error.code !== 110025) throw error;
  }
}

async function setBybitLeverage(symbol: string): Promise<void> {
  try {
    await bybitPost('/v5/position/set-leverage', {
      category: 'linear', symbol, buyLeverage: String(LEVERAGE), sellLeverage: String(LEVERAGE),
    });
  } catch (error) {
    if (!(error instanceof BybitApiError) || error.code !== 110043) throw error;
  }
}

async function placeBybitOrder(args: {
  symbol: string;
  orderSide: ArbLegSide;
  qty: number;
  instrument: BybitInstrument;
  reduceOnly: boolean;
  limitPx?: number;
  clientOrderId: string;
}): Promise<{ orderId: string }> {
  const side = args.orderSide === 'long' ? 'Buy' : 'Sell';
  const body: Record<string, unknown> = {
    category: 'linear',
    symbol: args.symbol,
    side,
    qty: String(args.qty),
    positionIdx: 0,
    reduceOnly: args.reduceOnly,
    orderLinkId: args.clientOrderId.slice(0, 36),
  };
  if (args.limitPx != null) {
    body.orderType = 'Limit';
    body.timeInForce = 'IOC';
    body.price = String(quantizeToStep(
      args.limitPx,
      args.instrument.priceFilter.tickSize,
      side === 'Buy' ? 'ceil' : 'floor',
    ));
  } else {
    body.orderType = 'Market';
    body.timeInForce = 'IOC';
  }
  return bybitPost<{ orderId: string }>('/v5/order/create', body);
}

async function hlAsset(coin: string): Promise<{ index: number; szDecimals: number }> {
  hlMetaCache ??= await hlInfo.meta();
  const index = hlMetaCache.universe.findIndex((asset) => asset.name === coin);
  if (index < 0) throw new Error(`Unknown Hyperliquid coin ${coin}`);
  return { index, szDecimals: hlMetaCache.universe[index]!.szDecimals };
}

async function hlPositions(): Promise<HlPosition[]> {
  const clearing = await hlInfo.clearinghouseState({ user: HL_ACCOUNT });
  return clearing.assetPositions.flatMap((row) => {
    const signedSize = Number(row.position.szi);
    if (signedSize === 0) return [];
    return [{
      coin: row.position.coin,
      side: signedSize > 0 ? 'long' as const : 'short' as const,
      size: Math.abs(signedSize),
      entryPx: Number(row.position.entryPx),
    }];
  });
}

async function hlPosition(coin: string): Promise<HlPosition | null> {
  return (await hlPositions()).find((position) => position.coin === coin) ?? null;
}

async function hlEquity(): Promise<number> {
  const [clearing, spot] = await Promise.all([
    hlInfo.clearinghouseState({ user: HL_ACCOUNT }),
    hlInfo.spotClearinghouseState({ user: HL_ACCOUNT }).catch(() => null),
  ]);
  const usdc = spot?.balances.find((balance) => balance.coin === 'USDC');
  return Number(clearing.marginSummary.accountValue)
    + (usdc ? Math.max(0, Number(usdc.total) - Number(usdc.hold)) : 0);
}

async function setHlLeverage(coin: string): Promise<void> {
  const asset = await hlAsset(coin);
  await hlExchange.updateLeverage({ asset: asset.index, isCross: true, leverage: LEVERAGE });
}

async function placeHlIoc(args: {
  coin: string;
  orderSide: ArbLegSide;
  qty: number;
  limitPx: number;
  reduceOnly: boolean;
}): Promise<{ filledQty: number; avgPx: number | null }> {
  const asset = await hlAsset(args.coin);
  const size = formatSize(args.qty, asset.szDecimals);
  const price = formatPrice(args.limitPx, asset.szDecimals, 'perp');
  const orders: Parameters<ExchangeClient['order']>[0]['orders'] = [{
    a: asset.index,
    b: args.orderSide === 'long',
    p: price,
    s: size,
    r: args.reduceOnly,
    t: { limit: { tif: 'Ioc' } },
  }];
  const result = await hlExchange.order({ orders, grouping: 'na' });
  const status = ((result.response?.data?.statuses ?? []) as unknown[])[0] as Record<string, unknown> | undefined;
  if (status && 'error' in status) throw new Error(`Hyperliquid: ${String(status.error)}`);
  if (status && 'filled' in status) {
    const fill = status.filled as { totalSz?: string; avgPx?: string };
    return { filledQty: Number(fill.totalSz ?? size), avgPx: fill.avgPx ? Number(fill.avgPx) : null };
  }
  return { filledQty: 0, avgPx: null };
}

async function bybitBook(symbol: string): Promise<{
  ts: number; bids: Array<{ price: number; qty: number }>; asks: Array<{ price: number; qty: number }>;
}> {
  const body = await publicJson<BybitEnvelope<{ ts: number; b: [string, string][]; a: [string, string][] }>>(
    `${BYBIT_API}/v5/market/orderbook?category=linear&symbol=${encodeURIComponent(symbol)}&limit=50`,
  );
  if (body.retCode !== 0 || !body.result) throw new Error(`Bybit book ${symbol}: ${body.retMsg}`);
  return {
    ts: body.result.ts,
    bids: body.result.b.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
    asks: body.result.a.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
  };
}

async function executableExit(active: ActiveState, hl: HlPosition, bybit: BybitPosition): Promise<{
  hlExitPx: number; bybitExitPx: number; netPnlPct: number; bookSkewMs: number;
}> {
  const [hlBook, byBook] = await Promise.all([hlInfo.l2Book({ coin: active.coin }), bybitBook(active.bybitSymbol)]);
  if (!hlBook) throw new Error(`No Hyperliquid book for ${active.coin}`);
  const bookSkewMs = Math.abs(hlBook.time - byBook.ts);
  if (bookSkewMs > 2_000) throw new Error(`Book skew ${bookSkewMs}ms`);
  const hlBids = hlBook.levels[0].map((level) => ({ price: Number(level.px), qty: Number(level.sz) }));
  const hlAsks = hlBook.levels[1].map((level) => ({ price: Number(level.px), qty: Number(level.sz) }));
  const hlExitPx = vwap(hl.side === 'long' ? hlBids : hlAsks, hl.size);
  const bybitExitPx = vwap(bybit.side === 'long' ? byBook.bids : byBook.asks, bybit.size);
  if (hlExitPx == null || bybitExitPx == null) throw new Error('Insufficient close depth');
  return {
    hlExitPx,
    bybitExitPx,
    bookSkewMs,
    netPnlPct: estimatedPairNetPnlPct({
      hlSide: active.hlSide,
      hlEntryPx: active.hlEntryPx!,
      hlExitPx,
      bybitSide: active.bybitSide,
      bybitEntryPx: active.bybitEntryPx!,
      bybitExitPx,
    }),
  };
}

async function closeHlPosition(position: HlPosition, slippagePct: number): Promise<void> {
  const book = await hlInfo.l2Book({ coin: position.coin });
  if (!book) throw new Error(`No Hyperliquid close book ${position.coin}`);
  const orderSide: ArbLegSide = position.side === 'long' ? 'short' : 'long';
  const top = Number(book.levels[orderSide === 'long' ? 1 : 0][0]?.px ?? 0);
  if (!(top > 0)) throw new Error(`Empty Hyperliquid close book ${position.coin}`);
  const limitPx = orderSide === 'long' ? top * (1 + slippagePct) : top * (1 - slippagePct);
  await placeHlIoc({ coin: position.coin, orderSide, qty: position.size, limitPx, reduceOnly: true });
}

async function closeBybitPosition(
  position: BybitPosition,
  instrument: BybitInstrument,
  slippagePct: number,
  market: boolean,
): Promise<void> {
  const orderSide: ArbLegSide = position.side === 'long' ? 'short' : 'long';
  let limitPx: number | undefined;
  if (!market) {
    const book = await bybitBook(position.symbol);
    const top = orderSide === 'long' ? book.asks[0]?.price : book.bids[0]?.price;
    if (!(top && top > 0)) throw new Error(`Empty Bybit close book ${position.symbol}`);
    limitPx = orderSide === 'long' ? top * (1 + slippagePct) : top * (1 - slippagePct);
  }
  await placeBybitOrder({
    symbol: position.symbol,
    orderSide,
    qty: position.size,
    instrument,
    reduceOnly: true,
    limitPx,
    clientOrderId: `arbc${Date.now()}${Math.floor(Math.random() * 1e5)}`,
  });
}

async function reconcilePositions(active: ActiveState): Promise<{ hl: HlPosition | null; bybit: BybitPosition | null }> {
  const [hl, bybit] = await Promise.all([
    hlPosition(active.coin),
    bybitPositions(active.bybitSymbol).then((positions) => positions[0] ?? null),
  ]);
  return { hl, bybit };
}

async function waitForPositions(active: ActiveState): Promise<{ hl: HlPosition | null; bybit: BybitPosition | null }> {
  let positions = await reconcilePositions(active);
  for (let attempt = 0; attempt < 5 && (!positions.hl || !positions.bybit); attempt += 1) {
    await sleep(350);
    positions = await reconcilePositions(active);
  }
  return positions;
}

async function unwind(active: ActiveState, incident: string): Promise<boolean> {
  await saveState({ ...active, phase: 'unwinding', closeReason: incident });
  const instrument = await bybitInstrument(active.bybitSymbol);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const positions = await reconcilePositions(active);
    if (!positions.hl && !positions.bybit) {
      await sleep(750);
      const confirmation = await reconcilePositions(active);
      if (!confirmation.hl && !confirmation.bybit) return true;
    }
    const tasks: Promise<unknown>[] = [];
    if (positions.hl) tasks.push(closeHlPosition(positions.hl, attempt < 2 ? 0.01 : 0.03));
    if (positions.bybit) tasks.push(closeBybitPosition(positions.bybit, instrument, 0.01, attempt === 2));
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === 'rejected') log('unwind-leg-failed', { intentId: active.intentId, message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
    }
    await sleep(750);
  }
  await sleep(1_000);
  const remaining = await reconcilePositions(active);
  return !remaining.hl && !remaining.bybit;
}

async function finishActive(active: ActiveState, reason: string): Promise<void> {
  const completedTrades = state.completedTrades + (active.openedAt || active.hadExecution ? 1 : 0);
  await audit('closed', {
    intentId: active.intentId,
    asset: active.asset,
    reason,
    openedAt: active.openedAt ?? null,
    closedAt: Date.now(),
    estimatedNetPnlPct: active.lastNetPnlPct ?? null,
  });
  if (active.openedAt) {
    const heldMinutes = Math.max(0, Math.round((Date.now() - active.openedAt) / 60_000));
    const pnl = active.lastNetPnlPct == null ? 'n/a' : `${active.lastNetPnlPct >= 0 ? '+' : ''}${active.lastNetPnlPct.toFixed(3)}%`;
    await notify(
      `✅ <b>АРБИТРАЖ ЗАКРЫТ</b>\n${active.asset} · ${reason}\nОценка net: <b>${pnl}</b> · удержание ${heldMinutes} мин\nОбе площадки подтверждены flat.`,
    );
  }
  await idleState({ completedTrades, lastError: null });
}

function preparedQty(opportunity: ArbOpportunity, instrument: BybitInstrument, szDecimals: number): {
  hlQty: number; bybitQty: number; mismatchPct: number;
} {
  const hlQty = Number(formatSize(opportunity.targetUnderlyingQty / opportunity.hlUnit, szDecimals));
  const bybitQty = quantizeToStep(
    opportunity.targetUnderlyingQty / opportunity.bybitUnit,
    instrument.lotSizeFilter.qtyStep,
  );
  const mismatchPct = underlyingDeltaMismatchPct(hlQty, opportunity.hlUnit, bybitQty, opportunity.bybitUnit);
  const minQty = Number(instrument.lotSizeFilter.minOrderQty);
  const bybitEntryPx = opportunity.basisDirection === 'LONG HL / SHORT BY'
    ? opportunity.bybitSellPx
    : opportunity.bybitBuyPx;
  const minNotional = Number(instrument.lotSizeFilter.minNotionalValue ?? 5);
  if (!(hlQty > 0) || bybitQty < minQty || bybitQty * bybitEntryPx < minNotional) {
    throw new Error(`Order below exchange minimum for ${opportunity.asset}`);
  }
  if (mismatchPct > MAX_DELTA_MISMATCH_PCT) {
    throw new Error(`Delta mismatch ${mismatchPct.toFixed(3)}% > ${MAX_DELTA_MISMATCH_PCT}%`);
  }
  return { hlQty, bybitQty, mismatchPct };
}

async function attemptEntry(candidate: ArbOpportunity): Promise<void> {
  const sides = sidesForBasisDirection(candidate.basisDirection);
  const [instrument, asset, byBalance, hyperliquidEquity, byOpen, hlOpen] = await Promise.all([
    bybitInstrument(candidate.bybitSymbol),
    hlAsset(candidate.hlCoin),
    bybitBalance(),
    hlEquity(),
    bybitPositions(),
    hlPositions(),
  ]);
  if (byBalance.available < NOTIONAL_USD + 5) throw new Error(`Bybit available $${byBalance.available.toFixed(2)} is too low`);
  if (hyperliquidEquity < NOTIONAL_USD + 5) throw new Error(`Hyperliquid equity $${hyperliquidEquity.toFixed(2)} is too low`);
  if (byOpen.length) throw new Error(`Bybit account already has ${byOpen.length} position(s)`);
  if (hlOpen.some((position) => position.coin === candidate.hlCoin)) throw new Error(`${candidate.hlCoin} already open on Hyperliquid`);
  const qty = preparedQty(candidate, instrument, asset.szDecimals);
  const now = Date.now();
  let active: ActiveState = {
    version: 1,
    phase: 'entering',
    live: LIVE,
    updatedAt: now,
    leaseExpiresAt: now + LEASE_MS,
    completedTrades: state.completedTrades,
    lastScanAt: state.lastScanAt,
    lastBest: state.lastBest,
    lastError: null,
    intentId: randomUUID(),
    asset: candidate.asset,
    coin: candidate.hlCoin,
    bybitSymbol: candidate.bybitSymbol,
    hlUnit: candidate.hlUnit,
    bybitUnit: candidate.bybitUnit,
    hlSide: sides.hl,
    bybitSide: sides.bybit,
    hlQtyRequested: qty.hlQty,
    bybitQtyRequested: qty.bybitQty,
    entryEstimateNetPct: candidate.basisNetPct,
    entryGrossBasisPct: candidate.grossBasisPct,
    detectedAt: now,
  };
  await saveState(active);
  await audit('intent-created', {
    intentId: active.intentId,
    asset: active.asset,
    direction: candidate.basisDirection,
    estimatedNetPct: candidate.basisNetPct,
    notionalUsd: NOTIONAL_USD,
    mismatchPct: qty.mismatchPct,
  });

  // Give the protected rsync lease enough time to reach the main account owner before any order.
  await sleep(1_500);
  const refreshed = await evaluateArbMarket(candidate, NOTIONAL_USD);
  if (!refreshed || refreshed.basisNetPct < MIN_NET_PCT || refreshed.basisDirection !== candidate.basisDirection) {
    await audit('intent-cancelled', { intentId: active.intentId, reason: 'fresh edge confirmation failed' });
    await idleState({ lastError: null });
    return;
  }
  const freshQty = preparedQty(refreshed, instrument, asset.szDecimals);
  active = {
    ...active,
    hlQtyRequested: freshQty.hlQty,
    bybitQtyRequested: freshQty.bybitQty,
    entryEstimateNetPct: refreshed.basisNetPct,
    entryGrossBasisPct: refreshed.grossBasisPct,
  };
  await saveState(active);

  const before = await reconcilePositions(active);
  if (before.hl || before.bybit) throw new Error('Position appeared during entry lease');
  await Promise.all([setHlLeverage(active.coin), setBybitLeverage(active.bybitSymbol)]);

  const hlReference = active.hlSide === 'long' ? refreshed.hlBuyPx : refreshed.hlSellPx;
  const bybitReference = active.bybitSide === 'long' ? refreshed.bybitBuyPx : refreshed.bybitSellPx;
  const hlLimit = active.hlSide === 'long' ? hlReference * (1 + ENTRY_CAP_PCT) : hlReference * (1 - ENTRY_CAP_PCT);
  const bybitLimit = active.bybitSide === 'long' ? bybitReference * (1 + ENTRY_CAP_PCT) : bybitReference * (1 - ENTRY_CAP_PCT);
  const orderTag = active.intentId.replaceAll('-', '').slice(0, 20);
  const submissions = await Promise.allSettled([
    placeHlIoc({ coin: active.coin, orderSide: active.hlSide, qty: active.hlQtyRequested, limitPx: hlLimit, reduceOnly: false }),
    placeBybitOrder({
      symbol: active.bybitSymbol,
      orderSide: active.bybitSide,
      qty: active.bybitQtyRequested,
      instrument,
      reduceOnly: false,
      limitPx: bybitLimit,
      clientOrderId: `arbe${orderTag}`,
    }),
  ]);
  await audit('orders-submitted', {
    intentId: active.intentId,
    hlAccepted: submissions[0]?.status === 'fulfilled',
    bybitAccepted: submissions[1]?.status === 'fulfilled',
  });

  const positions = await waitForPositions(active);
  const bothCorrect = positions.hl && positions.bybit
    && positions.hl.side === active.hlSide
    && positions.bybit.side === active.bybitSide
    && underlyingDeltaMismatchPct(positions.hl.size, active.hlUnit, positions.bybit.size, active.bybitUnit) <= MAX_DELTA_MISMATCH_PCT;

  if (bothCorrect && positions.hl && positions.bybit) {
    const openedAt = Date.now();
    const actualNetPct = estimatedBasisNetFromFills({
      direction: refreshed.basisDirection,
      hlEntryPx: positions.hl.entryPx,
      hlUnit: active.hlUnit,
      bybitEntryPx: positions.bybit.avgPrice,
      bybitUnit: active.bybitUnit,
      totalCostPct: refreshed.basisTotalCostPct,
    });
    active = {
      ...active,
      phase: 'open',
      openedAt,
      hlEntryPx: positions.hl.entryPx,
      bybitEntryPx: positions.bybit.avgPrice,
      hlQty: positions.hl.size,
      bybitQty: positions.bybit.size,
      hadExecution: true,
      entryEstimateNetPct: actualNetPct,
    };
    await saveState(active);
    if (actualNetPct < MIN_NET_PCT) {
      await audit('post-fill-edge-failed', {
        intentId: active.intentId,
        asset: active.asset,
        actualNetPct,
        thresholdPct: MIN_NET_PCT,
      });
      await notifyIncident(
        `${active.intentId}:post-fill-edge`,
        `⚠️ <b>АРБИТРАЖ: EDGE УХУДШИЛСЯ НА FILL</b>\n${active.asset}: ${actualNetPct.toFixed(3)}% < ${MIN_NET_PCT.toFixed(2)}%\nОбе ноги закрываются немедленно.`,
      );
      const flat = await unwind(active, 'post-fill-edge-below-threshold');
      if (flat) await finishActive(active, 'post-fill-edge-below-threshold');
      return;
    }
    await audit('opened', {
      intentId: active.intentId,
      asset: active.asset,
      hlSide: active.hlSide,
      bybitSide: active.bybitSide,
      hlEntryPx: active.hlEntryPx,
      bybitEntryPx: active.bybitEntryPx,
      estimatedNetPct: active.entryEstimateNetPct,
      notionalUsd: NOTIONAL_USD,
    });
    await notify(
      `🟢 <b>АРБИТРАЖ ОТКРЫТ</b>\n${active.asset}: ${candidate.basisDirection}\nПо <b>$${NOTIONAL_USD.toFixed(0)}</b> на ногу · 1x\nРасчётный net на входе: <b>+${active.entryEstimateNetPct.toFixed(3)}%</b>\nОбе позиции подтверждены на биржах.`,
    );
    log('opened', { intentId: active.intentId, asset: active.asset, netPct: active.entryEstimateNetPct });
    return;
  }

  if (!positions.hl && !positions.bybit) {
    await sleep(750);
    const late = await reconcilePositions(active);
    if (late.hl || late.bybit) {
      active = { ...active, hadExecution: true };
      await saveState(active);
      await notifyIncident(
        `${active.intentId}:late-fill`,
        `🔴 <b>АРБИТРАЖ: ПОЗДНИЙ FILL</b>\n${active.asset} · позиция появилась после первичного no-fill и немедленно закрывается.`,
      );
      const flat = await unwind(active, 'late-fill');
      if (flat) await finishActive(active, 'late-fill');
      return;
    }
    await audit('entry-no-fill', {
      intentId: active.intentId,
      hlAccepted: submissions[0]?.status === 'fulfilled',
      bybitAccepted: submissions[1]?.status === 'fulfilled',
    });
    await idleState({ lastError: null });
    return;
  }

  const oneLeg = !!positions.hl !== !!positions.bybit;
  active = { ...active, hadExecution: true };
  await saveState(active);
  const incident = oneLeg ? 'single-leg-entry' : 'entry-reconciliation-failed';
  await notifyIncident(
    `${active.intentId}:${incident}`,
    `🔴 <b>АРБИТРАЖ: АВАРИЙНЫЙ UNWIND</b>\n${active.asset} · ${incident}\nИсполнитель немедленно закрывает любую появившуюся ногу.`,
  );
  const flat = await unwind(active, incident);
  if (flat) await finishActive(active, incident);
  else await notifyIncident(`${active.intentId}:unwind-stuck`, `🚨 <b>АРБИТРАЖ НЕ СТАЛ FLAT</b>\n${active.asset} · нужна ручная проверка обеих бирж.`);
}

async function monitorActive(active: ActiveState): Promise<void> {
  await saveState(active); // heartbeat the cross-server ownership lease first
  const positions = await reconcilePositions(active);

  if (active.phase === 'entering') {
    if (!positions.hl && !positions.bybit) {
      await audit('recovered-no-fill', { intentId: active.intentId });
      await idleState();
      return;
    }
    if (positions.hl && positions.bybit
      && positions.hl.side === active.hlSide
      && positions.bybit.side === active.bybitSide) {
      const adopted: ActiveState = {
        ...active,
        phase: 'open',
        openedAt: active.openedAt ?? Date.now(),
        hlEntryPx: positions.hl.entryPx,
        bybitEntryPx: positions.bybit.avgPrice,
        hlQty: positions.hl.size,
        bybitQty: positions.bybit.size,
      };
      await saveState(adopted);
      await notifyIncident(`${active.intentId}:recovered`, `⚠️ <b>АРБИТРАЖ ВОССТАНОВЛЕН</b>\n${active.asset}: обе ноги найдены после рестарта, управление продолжено.`);
      return;
    }
    const recovered = { ...active, hadExecution: true };
    await saveState(recovered);
    const flat = await unwind(recovered, 'crash-recovery-single-leg');
    if (flat) await finishActive(recovered, 'crash-recovery-single-leg');
    return;
  }

  if (active.phase === 'closing' || active.phase === 'unwinding') {
    if (!positions.hl && !positions.bybit) {
      await finishActive(active, active.closeReason ?? active.phase);
      return;
    }
    const flat = await unwind(active, active.closeReason ?? active.phase);
    if (flat) await finishActive(active, active.closeReason ?? active.phase);
    else await notifyIncident(`${active.intentId}:close-stuck`, `🚨 <b>АРБИТРАЖ: ЗАКРЫТИЕ НЕ ПОДТВЕРЖДЕНО</b>\n${active.asset} · повторяю unwind автоматически.`);
    return;
  }

  if (!positions.hl || !positions.bybit) {
    const incident = !positions.hl && !positions.bybit ? 'both-legs-missing' : 'open-pair-lost-leg';
    await notifyIncident(`${active.intentId}:${incident}`, `🔴 <b>АРБИТРАЖ ПОТЕРЯЛ НОГУ</b>\n${active.asset} · ${incident}\nОставшаяся позиция закрывается немедленно.`);
    const flat = await unwind(active, incident);
    if (flat) await finishActive(active, incident);
    return;
  }
  if (positions.hl.side !== active.hlSide || positions.bybit.side !== active.bybitSide) {
    const flat = await unwind(active, 'side-mismatch');
    if (flat) await finishActive(active, 'side-mismatch');
    return;
  }
  if (!(active.openedAt && active.hlEntryPx && active.bybitEntryPx)) {
    throw new Error(`Open state ${active.intentId} lacks confirmed fills`);
  }
  const openedAt = active.openedAt;

  const exit = await executableExit(active, positions.hl, positions.bybit);
  active = { ...active, lastNetPnlPct: exit.netPnlPct };
  await saveState(active);
  const reason = arbExitReason({
    netPnlPct: exit.netPnlPct,
    openedAt,
    nowMs: Date.now(),
    takeProfitPct: TAKE_PROFIT_PCT,
    stopLossPct: STOP_LOSS_PCT,
    maxHoldMs: MAX_HOLD_MS,
  });
  log('position-monitor', { intentId: active.intentId, asset: active.asset, netPnlPct: Number(exit.netPnlPct.toFixed(4)), reason });
  if (!reason) return;
  active = { ...active, phase: 'closing', closeReason: reason };
  await saveState(active);
  await audit('close-intent', { intentId: active.intentId, asset: active.asset, reason, estimatedNetPnlPct: exit.netPnlPct });
  const flat = await unwind(active, reason);
  if (flat) await finishActive(active, reason);
}

async function scanIdle(): Promise<void> {
  if (state.completedTrades >= MAX_COMPLETED_TRADES) {
    if (state.phase !== 'disarmed') await idleState();
    return;
  }
  const scan = await scanArbitrage(NOTIONAL_USD, MIN_NET_PCT);
  const best = scan.basis[0];
  await saveState({
    ...state,
    phase: 'idle',
    lastScanAt: scan.ts,
    lastBest: best ? { asset: best.asset, netPct: best.basisNetPct, direction: best.basisDirection } : null,
    lastError: null,
  });
  log('scan', {
    matched: scan.matchedMarkets,
    checked: scan.checkedBooks,
    bestAsset: best?.asset ?? null,
    bestNetPct: best ? Number(best.basisNetPct.toFixed(4)) : null,
    qualifiedBasis: scan.qualifiedBasis.length,
    live: LIVE,
  });
  const candidate = scan.qualifiedBasis[0];
  if (!candidate) return;
  if (!LIVE) {
    await audit('dry-run-qualified', { asset: candidate.asset, netPct: candidate.basisNetPct, direction: candidate.basisDirection });
    return;
  }
  await attemptEntry(candidate);
}

async function preflight(): Promise<void> {
  const [role, balance, hlAccountEquity, byOpen] = await Promise.all([
    hlInfo.userRole({ user: HL_WALLET.address }),
    bybitBalance(),
    hlEquity(),
    bybitPositions(),
  ]);
  if (role.role !== 'agent' || role.data.user.toLowerCase() !== HL_ACCOUNT) {
    throw new Error('Hyperliquid signer is not an agent for configured account');
  }
  if (balance.available < NOTIONAL_USD + 5) throw new Error(`Bybit available $${balance.available.toFixed(2)} below pilot reserve`);
  if (hlAccountEquity < NOTIONAL_USD + 5) throw new Error(`Hyperliquid equity $${hlAccountEquity.toFixed(2)} below pilot reserve`);
  if (!isActive(state) && byOpen.length) throw new Error(`Idle executor found ${byOpen.length} Bybit position(s)`);
  if (LIVE && !isActive(state)) await ensureBybitOneWay();
  log('preflight-ok', {
    live: LIVE,
    phase: state.phase,
    bybitAvailableUsd: Number(balance.available.toFixed(2)),
    hlEquityUsd: Number(hlAccountEquity.toFixed(2)),
    completedTrades: state.completedTrades,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  state = await loadState();
  await saveState(state);
  await preflight();
  do {
    try {
      if (isActive(state)) await monitorActive(state);
      else await scanIdle();
    } catch (error) {
      const message = (error as Error).message;
      log('loop-error', { phase: state.phase, message });
      await audit('loop-error', { phase: state.phase, message });
      if (isActive(state)) {
        await saveState({ ...state, lastError: message });
        await notifyIncident(`${state.intentId}:${message}`, `⚠️ <b>АРБИТРАЖ: ОШИБКА КОНТРОЛЯ</b>\n${state.asset} · ${message}\nПозиции остаются под автоматическим reconcile.`);
      } else {
        await idleState({ lastError: message });
      }
    }
    if (ONCE || stopping) break;
    await sleep(isActive(state) ? ACTIVE_POLL_MS : IDLE_SCAN_MS);
  } while (!stopping);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { stopping = true; });
}

await run();
