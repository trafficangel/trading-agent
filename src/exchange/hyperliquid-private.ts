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

type Clients = { ex: ExchangeClient; info: InfoClient; addr: `0x${string}` };
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
    _clients = { ex, info, addr };
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
    await c.ex.updateLeverage({ asset: m.idx, isCross: true, leverage: Math.max(1, Math.floor(leverage)) });
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
    const limitPx = isBuy ? mid * 1.05 : mid * 0.95; // 5% slippage ceiling so the IOC crosses
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
    const res = await c.ex.order({ orders, grouping });
    // HL can return a per-order {error} inside an otherwise-ok response — check defensively.
    const statuses = (res?.response?.data?.statuses ?? []) as unknown[];
    const errStatus = statuses.find((st) => st !== null && typeof st === 'object' && 'error' in st && typeof (st as { error: unknown }).error === 'string');
    if (errStatus) return { ok: false, msg: (errStatus as { error: string }).error };
    return { ok: true, data: res };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}

export async function hlFetchPosition(coin: string): Promise<HlResult<HlPosition | null>> {
  const c = clients();
  if (!c) return { ok: false, msg: 'HL_API_WALLET_KEY not set' };
  try {
    const cs = await c.info.clearinghouseState({ user: c.addr });
    const ap = cs.assetPositions.find((a) => a.position.coin === coin);
    const szi = ap ? Number(ap.position.szi) : 0;
    if (!ap || szi === 0) return { ok: true, data: null };
    return { ok: true, data: { coin, side: szi > 0 ? 'long' : 'short', size: Math.abs(szi), entryPx: Number(ap.position.entryPx) } };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}

export async function hlClosePosition(coin: string): Promise<HlResult> {
  const p = await hlFetchPosition(coin);
  if (!p.ok) return p;
  if (!p.data) return { ok: true, data: 'flat' };
  return hlMarketOrder({ coin, side: p.data.side === 'long' ? 'short' : 'long', qty: p.data.size, reduceOnly: true });
}

export async function hlMid(coin: string): Promise<number | null> {
  const c = clients();
  if (!c) return null;
  try { const mids = await c.info.allMids(); const m = Number(mids[coin]); return m > 0 ? m : null; }
  catch { return null; }
}

export async function hlAccountValue(): Promise<HlResult<number>> {
  const c = clients();
  if (!c) return { ok: false, msg: 'HL_API_WALLET_KEY not set' };
  try {
    const cs = await c.info.clearinghouseState({ user: c.addr });
    return { ok: true, data: Number(cs.marginSummary.accountValue) };
  } catch (e) { return { ok: false, msg: (e as Error).message }; }
}
