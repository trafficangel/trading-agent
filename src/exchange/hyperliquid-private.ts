/**
 * Hyperliquid PRIVATE (trading) client for the lab→live bridge. Bybit blocks
 * derivatives for the operator's region (code 10024); HL is permissionless and
 * not geo-blocked, and the lab is already priced at HL fees.
 *
 * Signs with an HL agent/API wallet (config.HL_API_WALLET_KEY) via viem + the
 * @nktkas/hyperliquid SDK (handles EIP-712 correctly — far safer than hand-rolling).
 * Reads attribute to HL_ACCOUNT_ADDRESS (the main account; defaults to the signer's
 * own address for a non-agent key). Endpoint follows HL_USE_TESTNET.
 *
 * Mirrors the bybit-private shape ({ok}|{ok:false,msg}) so lab-live swaps cleanly.
 * "Market" order = aggressive IOC limit (HL has no true market). SL = a reduceOnly
 * trigger order attached via grouping 'normalTpsl'. Sizes/prices formatted to HL's
 * tick/lot rules via the SDK's formatPrice/formatSize.
 */
import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid';
import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config.js';

export type HlResult<T = unknown> = { ok: true; data: T } | { ok: false; msg: string };
export type HlPosition = { coin: string; side: 'long' | 'short'; size: number; entryPx: number };

// readUser = whose positions/orders to query (the VAULT if trading one, else the main account).
// vopts = order-execution options carrying vaultAddress (so writes act ON BEHALF OF the vault); undefined
// for main-account trading. When HL_VAULT_ADDRESS is unset, both collapse to the legacy main-account path.
type Clients = { ex: ExchangeClient; info: InfoClient; addr: `0x${string}`; readUser: `0x${string}`; vopts: { vaultAddress: `0x${string}` } | undefined };
let _clients: Clients | null = null;
let _meta: { universe: { name: string; szDecimals: number }[] } | null = null;

function clients(): Clients | null {
  if (!config.HL_API_WALLET_KEY) return null;
  if (!_clients) {
    const wallet = privateKeyToAccount(config.HL_API_WALLET_KEY as `0x${string}`);
    const transport = new HttpTransport({ isTestnet: config.HL_USE_TESTNET });
    const ex = new ExchangeClient({ transport, wallet });
    const info = new InfoClient({ transport });
    const addr = (config.HL_ACCOUNT_ADDRESS ?? wallet.address) as `0x${string}`;
    const vault = config.HL_VAULT_ADDRESS as `0x${string}` | undefined;
    _clients = { ex, info, addr, readUser: vault ?? addr, vopts: vault ? { vaultAddress: vault } : undefined };
  }
  return _clients;
}

async function assetMeta(info: InfoClient, coin: string): Promise<{ idx: number; szDecimals: number } | null> {
  if (!_meta) _meta = await info.meta();
  const idx = _meta.universe.findIndex((u) => u.name === coin);
  if (idx < 0) return null;
  return { idx, szDecimals: _meta.universe[idx]!.szDecimals };
}

export function hlConfigured(): boolean {
  return !!config.HL_API_WALLET_KEY;
}

export async function hlSetLeverage(coin: string, leverage: number): Promise<HlResult> {
  const c = clients();
  if (!c) return { ok: false, msg: 'HL_API_WALLET_KEY not set' };
  try {
    const m = await assetMeta(c.info, coin);
    if (!m) return { ok: false, msg: `unknown HL coin ${coin}` };
    await c.ex.updateLeverage({ asset: m.idx, isCross: true, leverage: Math.max(1, Math.floor(leverage)) }, c.vopts);
    return { ok: true, data: null };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}

/** Aggressive IOC limit = "market". Optional reduceOnly close. Optional safety SL
 *  (reduceOnly trigger, attached via grouping 'normalTpsl'). qty in base coin units. */
export async function hlMarketOrder(args: { coin: string; side: 'long' | 'short'; qty: number; reduceOnly?: boolean; stopLoss?: number }): Promise<HlResult> {
  const c = clients();
  if (!c) return { ok: false, msg: 'HL_API_WALLET_KEY not set' };
  try {
    const m = await assetMeta(c.info, args.coin);
    if (!m) return { ok: false, msg: `unknown HL coin ${args.coin}` };
    const mids = await c.info.allMids();
    const mid = Number(mids[args.coin]);
    if (!(mid > 0)) return { ok: false, msg: `no mid for ${args.coin}` };
    const isBuy = args.side === 'long';
    // slippage ceiling so the IOC crosses. reduceOnly CLOSES get a WIDE (20%) ceiling — during a flush the
    // book can gap far past 5% and a tight ceiling would MISS, leaving the position riding unprotected; when
    // exiting (esp. a catastrophe stop) getting flat matters more than price. Entries keep the tight 5%.
    const cap = args.reduceOnly ? 0.20 : 0.05;
    const limitPx = isBuy ? mid * (1 + cap) : mid * (1 - cap);
    const p = formatPrice(limitPx, m.szDecimals, 'perp');
    const s = formatSize(args.qty, m.szDecimals);
    if (Number(s) <= 0) return { ok: false, msg: `size rounds to 0 (qty ${args.qty}, szDecimals ${m.szDecimals})` };
    const orders: Parameters<ExchangeClient['order']>[0]['orders'] = [
      { a: m.idx, b: isBuy, p, s, r: args.reduceOnly ?? false, t: { limit: { tif: 'Ioc' } } },
    ];
    let grouping: 'na' | 'normalTpsl' = 'na';
    if (args.stopLoss && !args.reduceOnly) {
      const slPx = formatPrice(args.stopLoss, m.szDecimals, 'perp');
      orders.push({ a: m.idx, b: !isBuy, p: slPx, s, r: true, t: { trigger: { isMarket: true, triggerPx: slPx, tpsl: 'sl' } } });
      grouping = 'normalTpsl';
    }
    const res = await c.ex.order({ orders, grouping }, c.vopts);
    // HL can return a per-order {error} inside an otherwise-ok response — check defensively.
    const statuses = (res?.response?.data?.statuses ?? []) as unknown[];
    const errStatus = statuses.find((st) => st !== null && typeof st === 'object' && 'error' in st && typeof (st as { error: unknown }).error === 'string');
    if (errStatus) return { ok: false, msg: (errStatus as { error: string }).error };
    return { ok: true, data: res };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}

/** RESTING limit order for the wick-fade runner. Default tif 'Alo' = post-only (add-liquidity-only):
 *  guarantees MAKER and HL REJECTS it if it would cross the book — so a deep limit can never
 *  accidentally take. Returns the resting oid (to track/cancel), or filled=true if it somehow took. */
export async function hlLimitOrder(args: { coin: string; side: 'long' | 'short'; qty: number; price: number; reduceOnly?: boolean; gtc?: boolean }): Promise<HlResult<{ oid: number | null; filled: boolean }>> {
  const c = clients();
  if (!c) return { ok: false, msg: 'HL_API_WALLET_KEY not set' };
  try {
    const m = await assetMeta(c.info, args.coin);
    if (!m) return { ok: false, msg: `unknown HL coin ${args.coin}` };
    const isBuy = args.side === 'long';
    const p = formatPrice(args.price, m.szDecimals, 'perp');
    const s = formatSize(args.qty, m.szDecimals);
    if (Number(s) <= 0) return { ok: false, msg: `size rounds to 0 (qty ${args.qty}, szDecimals ${m.szDecimals})` };
    const tif: 'Alo' | 'Gtc' = args.gtc ? 'Gtc' : 'Alo';
    const res = await c.ex.order({ orders: [{ a: m.idx, b: isBuy, p, s, r: args.reduceOnly ?? false, t: { limit: { tif } } }], grouping: 'na' }, c.vopts);
    const st = ((res?.response?.data?.statuses ?? []) as unknown[])[0] as Record<string, unknown> | undefined;
    if (st && typeof st === 'object' && 'error' in st) return { ok: false, msg: String((st as { error: unknown }).error) };
    const resting = st && 'resting' in st ? (st as { resting: { oid: number } }).resting : null;
    return { ok: true, data: { oid: resting ? resting.oid : null, filled: !!(st && 'filled' in st) } };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}

/** Cancel a resting order by oid (idempotent-ish: a stale oid just errors, caller treats as gone). */
export async function hlCancelOrder(coin: string, oid: number): Promise<HlResult> {
  const c = clients();
  if (!c) return { ok: false, msg: 'HL_API_WALLET_KEY not set' };
  try {
    const m = await assetMeta(c.info, coin);
    if (!m) return { ok: false, msg: `unknown HL coin ${coin}` };
    await c.ex.cancel({ cancels: [{ a: m.idx, o: oid }] }, c.vopts);
    return { ok: true, data: null };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}

export type HlOpenOrder = { coin: string; oid: number; side: 'long' | 'short'; px: number; sz: number };
/** Resting (open) orders, optionally filtered to one coin. side normalized B/A → long/short. */
export async function hlOpenOrders(coin?: string): Promise<HlResult<HlOpenOrder[]>> {
  const c = clients();
  if (!c) return { ok: false, msg: 'HL_API_WALLET_KEY not set' };
  try {
    const oo = await c.info.openOrders({ user: c.readUser });
    const list = oo
      .filter((o) => !coin || o.coin === coin)
      .map((o) => ({ coin: o.coin, oid: o.oid, side: (o.side === 'B' ? 'long' : 'short') as 'long' | 'short', px: Number(o.limitPx), sz: Number(o.sz) }));
    return { ok: true, data: list };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}

export async function hlFetchPosition(coin: string): Promise<HlResult<HlPosition | null>> {
  const c = clients();
  if (!c) return { ok: false, msg: 'HL_API_WALLET_KEY not set' };
  try {
    const cs = await c.info.clearinghouseState({ user: c.readUser });
    const ap = cs.assetPositions.find((a) => a.position.coin === coin);
    const szi = ap ? Number(ap.position.szi) : 0;
    if (!ap || szi === 0) return { ok: true, data: null };
    return { ok: true, data: { coin, side: szi > 0 ? 'long' : 'short', size: Math.abs(szi), entryPx: Number(ap.position.entryPx) } };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}

/** Close via reduceOnly IOC. Returns the REAL exit fill avgPx (for honest live PnL booking, not mid). */
export async function hlClosePosition(coin: string): Promise<HlResult<{ avgPx: number | null }>> {
  const p = await hlFetchPosition(coin);
  if (!p.ok) return p;
  if (!p.data) return { ok: true, data: { avgPx: null } };
  const res = await hlMarketOrder({ coin, side: p.data.side === 'long' ? 'short' : 'long', qty: p.data.size, reduceOnly: true });
  if (!res.ok) return res;
  const statuses = ((res.data as { response?: { data?: { statuses?: unknown[] } } })?.response?.data?.statuses ?? []);
  let avgPx: number | null = null;
  for (const st of statuses) { if (st && typeof st === 'object' && 'filled' in st) { const v = Number((st as { filled: { avgPx: string } }).filled.avgPx); if (Number.isFinite(v)) avgPx = v; } }
  return { ok: true, data: { avgPx } };
}

export async function hlMid(coin: string): Promise<number | null> {
  const c = clients();
  if (!c) return null;
  try { const mids = await c.info.allMids(); const m = Number(mids[coin]); return m > 0 ? m : null; }
  catch { return null; }
}

/** TRUE account equity. With a UNIFIED account (spot+perp share ONE collateral pool — HL's default now) the
 *  perp clearinghouse `accountValue` reflects only the perp-allocated SLICE; the free spot USDC (total − hold)
 *  also backs trading and absorbs PnL. So real equity = perp accountValue + free spot USDC — which equals the
 *  UI's "Total Equity", and algebraically = spot_USDC_total + perp_uPnL (the `hold` term cancels, so it's robust
 *  to how HL computes it). For a non-unified / all-perp account spot USDC ≈ 0 and this collapses to the perp
 *  value. The spot read is best-effort: on any failure we fall back to perp-only (never throws on the addend). */
export async function hlAccountValue(): Promise<HlResult<number>> {
  const c = clients();
  if (!c) return { ok: false, msg: 'HL_API_WALLET_KEY not set' };
  try {
    const cs = await c.info.clearinghouseState({ user: c.readUser });
    const perp = Number(cs.marginSummary.accountValue);
    let spotFree = 0;
    try {
      const ss = await c.info.spotClearinghouseState({ user: c.readUser });
      const usdc = ss.balances.find((b) => b.coin === 'USDC');
      if (usdc) spotFree = Math.max(0, Number(usdc.total) - Number(usdc.hold));
    } catch { /* best-effort: fall back to perp-only equity */ }
    return { ok: true, data: perp + spotFree };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}

/** Place a reduceOnly STOP-MARKET trigger to guard an OPEN position ON THE EXCHANGE — it survives process
 *  downtime / restarts (unlike a poll-based stop). posSide = the side currently HELD; the stop closes it at
 *  market when mark crosses triggerPx. It's a TRIGGER order → lives in frontendOpenOrders, NOT in openOrders
 *  (so hlOpenOrders/cancelAll never touch it while we hold). */
export async function hlPlaceStop(args: { coin: string; posSide: 'long' | 'short'; qty: number; triggerPx: number }): Promise<HlResult<{ oid: number | null }>> {
  const c = clients();
  if (!c) return { ok: false, msg: 'HL_API_WALLET_KEY not set' };
  try {
    const m = await assetMeta(c.info, args.coin);
    if (!m) return { ok: false, msg: `unknown HL coin ${args.coin}` };
    const isBuy = args.posSide === 'short'; // closing a short buys; closing a long sells
    const px = formatPrice(args.triggerPx, m.szDecimals, 'perp');
    const s = formatSize(args.qty, m.szDecimals);
    if (Number(s) <= 0) return { ok: false, msg: `size rounds to 0 (qty ${args.qty})` };
    const res = await c.ex.order({ orders: [{ a: m.idx, b: isBuy, p: px, s, r: true, t: { trigger: { isMarket: true, triggerPx: px, tpsl: 'sl' } } }], grouping: 'na' }, c.vopts);
    const st = ((res?.response?.data?.statuses ?? []) as unknown[])[0] as Record<string, unknown> | undefined;
    if (st && typeof st === 'object' && 'error' in st) return { ok: false, msg: String((st as { error: unknown }).error) };
    const resting = st && 'resting' in st ? (st as { resting: { oid: number } }).resting : null;
    return { ok: true, data: { oid: resting ? resting.oid : null } };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}

/** Cancel any resting TRIGGER (stop/tp) orders for a coin — protective stops live in frontendOpenOrders,
 *  invisible to hlOpenOrders. Best-effort; returns the count cancelled. Call on close / reconcile-flat. */
export async function hlCancelTriggers(coin: string): Promise<HlResult<number>> {
  const c = clients();
  if (!c) return { ok: false, msg: 'HL_API_WALLET_KEY not set' };
  try {
    const m = await assetMeta(c.info, coin);
    if (!m) return { ok: false, msg: `unknown HL coin ${coin}` };
    const fo = await c.info.frontendOpenOrders({ user: c.readUser });
    const trigs = fo.filter((o) => o.coin === coin && o.isTrigger);
    for (const o of trigs) { try { await c.ex.cancel({ cancels: [{ a: m.idx, o: o.oid }] }, c.vopts); } catch { /* stale oid → already gone */ } }
    return { ok: true, data: trigs.length };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}

/** When did the CURRENT position start? Scans userFills newest→oldest for the fill that opened it from FLAT
 *  (startPosition ≈ 0 + an 'Open' dir). Used at adopt so the time-stop clock measures from the REAL fill, not
 *  from the adopt tick — otherwise every restart resets the 60-min clock and a position can be held open-ended
 *  across a restart-churny day (EOD-audit finding #3). Returns null if not found (caller falls back to now). */
export async function hlPositionStartTime(coin: string): Promise<HlResult<{ timeMs: number | null }>> {
  const c = clients();
  if (!c) return { ok: false, msg: 'HL_API_WALLET_KEY not set' };
  try {
    const fills = await c.info.userFills({ user: c.readUser });
    for (const f of fills) { // userFills returns newest-first
      if (f.coin !== coin) continue;
      if (Math.abs(Number(f.startPosition)) < 1e-12 && String(f.dir).toLowerCase().includes('open')) {
        return { ok: true, data: { timeMs: Number(f.time) } };
      }
    }
    return { ok: true, data: { timeMs: null } };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}

/** Size-weighted average EXIT price for a coin from userFills since `sinceMs` (closing fills only). Used to
 *  recover honest PnL when a position closed OUT OF BAND (e.g. the exchange stop fired between polls) instead
 *  of booking NULL. Returns avgPx=null if no closing fills are found in the recent window. */
export async function hlExitAvgSince(coin: string, sinceMs: number): Promise<HlResult<{ avgPx: number | null }>> {
  const c = clients();
  if (!c) return { ok: false, msg: 'HL_API_WALLET_KEY not set' };
  try {
    const fills = await c.info.userFills({ user: c.readUser });
    let notional = 0, qty = 0;
    for (const f of fills) {
      if (f.coin !== coin || Number(f.time) < sinceMs) continue;
      if (!String(f.dir).toLowerCase().includes('close')) continue; // only the closing side, not the entry
      const px = Number(f.px), sz = Number(f.sz);
      if (px > 0 && sz > 0) { notional += px * sz; qty += sz; }
    }
    return { ok: true, data: { avgPx: qty > 0 ? notional / qty : null } };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}
