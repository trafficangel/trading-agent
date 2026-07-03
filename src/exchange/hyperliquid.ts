/**
 * Hyperliquid public API client (read-only, no key). HL is NOT geo-blocked
 * (unlike api.bybit.com), so this works from the VPS and locally.
 *   - hlInfo: the POST /info JSON-RPC-ish endpoint (one shape per `type`).
 *   - metaAndAssetCtxs: per-coin snapshot (funding, OI, mark/oracle/mid, premium).
 *   - l2Book: orderbook snapshot (20 levels/side, {px,sz,n}).
 *   - fundingHistory: hourly funding with HISTORY (backfillable).
 * The WS trade tape (for CVD) is consumed directly in jobs/hl-collector.ts.
 */

import { request } from 'undici';

export const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws';

/** Our coin universe on HL — bare names (index-aligned with metaAndAssetCtxs).
 *  Original 10 liquid majors + (Jul 2 2026) the wick-fade alt book: the order-flow layer (CVD/OI/liquidations
 *  per minute) had collected 200d / 71k liq events on MAJORS only — but our edges live on THIN alts, which
 *  weren't collected. Forward-collect them now → in 2-4 weeks liquidation-flow research can run on the coins
 *  we actually trade (the honest path to a frequent edge; candle proxies failed twice — controls-catch-artifacts). */
export const HL_COINS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'LTC', 'LINK', 'DOGE', 'AVAX',
  'ICP', 'NEAR', 'ATOM', 'TON', 'CRV', 'ENA', 'TIA', 'kPEPE', 'RENDER', 'POPCAT',
  'JUP', 'AR', 'BLUR', 'EIGEN', 'MANTA', 'JTO', 'ALT', 'PNUT',
] as const;

export async function hlInfo<T>(body: Record<string, unknown>): Promise<T> {
  const res = await request(HL_INFO_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (res.statusCode >= 300) {
    const t = await res.body.text();
    throw new Error(`HL info ${res.statusCode}: ${t.slice(0, 160)}`);
  }
  return (await res.body.json()) as T;
}

export type HlAssetCtx = {
  funding: string;
  openInterest: string;
  markPx: string;
  oraclePx: string;
  premium: string;
  midPx: string;
};
export type HlMetaCtxs = [{ universe: { name: string }[] }, HlAssetCtx[]];
export function metaAndAssetCtxs(): Promise<HlMetaCtxs> {
  return hlInfo<HlMetaCtxs>({ type: 'metaAndAssetCtxs' });
}

export type HlLevel = { px: string; sz: string; n: number };
export type HlL2 = { coin: string; time: number; levels: [HlLevel[], HlLevel[]] };
export function l2Book(coin: string): Promise<HlL2> {
  return hlInfo<HlL2>({ type: 'l2Book', coin });
}

export type HlFunding = { coin: string; fundingRate: string; premium: string; time: number };
export function fundingHistory(coin: string, startTime: number): Promise<HlFunding[]> {
  return hlInfo<HlFunding[]>({ type: 'fundingHistory', coin, startTime });
}
