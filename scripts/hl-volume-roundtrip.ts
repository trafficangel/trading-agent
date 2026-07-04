/**
 * HL VOLUME ROUND-TRIP — regain address ACTION BUDGET (10k + $1-volume each) by trading volume with ~zero
 * market risk: taker BUY then immediate reduceOnly taker SELL on a deep major (BTC: spread ~0.001%). Exposure
 * lasts ~1-2s; cost = taker fees (0.045%×2 of notional) + spread. HL's own error message prescribes exactly
 * this ("Place taker orders to free up 1 request per USDC traded"). OPERATOR-APPROVED Jul 4 (~$2 for a $1000
 * round). Sets high leverage on the coin first so the margin footprint stays tiny under the resting book.
 *   pnpm tsx scripts/hl-volume-roundtrip.ts [notionalUsd=1000] [coin=BTC]
 */
import { hlSetLeverage, hlMarketOrder, hlFetchPosition, hlClosePosition, hlMid } from '../src/exchange/hyperliquid-private.js';

// When over the action budget HL still allows a TRICKLE (~1 action / 10s) — retry with 11s spacing to catch
// free slots between the runner's own quote-tick attempts.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function withRetries<T extends { ok: boolean }>(label: string, fn: () => Promise<T>, tries = 15): Promise<T> {
  let last: T;
  for (let k = 1; k <= tries; k++) {
    last = await fn();
    if (last.ok) return last;
    console.log(`${label}: attempt ${k}/${tries} rejected — waiting 11s for a trickle slot`);
    await sleep(11_000);
  }
  return last!;
}

const NOTIONAL = Number(process.argv[2] ?? 1000);
const COIN = String(process.argv[3] ?? 'BTC');

(async () => {
  const lev = await withRetries('setLeverage', () => hlSetLeverage(COIN, 20)); // tiny margin footprint (~$50 for $1000) under the resting book
  if (!lev.ok) { console.error('setLeverage failed:', lev.msg); process.exit(1); }
  const mid = await hlMid(COIN);
  if (!mid) { console.error('no mid'); process.exit(1); }
  const qty = NOTIONAL / mid;
  console.log(`round-trip ${COIN}: ~$${NOTIONAL} (qty ${qty.toFixed(6)} @ ~${mid})`);
  const buy = await withRetries('BUY', () => hlMarketOrder({ coin: COIN, side: 'long', qty }));
  if (!buy.ok) { console.error('BUY failed:', buy.msg); process.exit(1); }
  const pos = await hlFetchPosition(COIN);
  if (!pos.ok || !pos.data) { console.error('no position after buy — check manually!', pos.ok ? 'flat' : pos.msg); process.exit(1); }
  console.log(`bought ${pos.data.size} @ ${pos.data.entryPx}`);
  await sleep(11_000); // let the trickle slot refill before the close action
  const close = await withRetries('CLOSE', () => hlClosePosition(COIN), 30);
  if (!close.ok) { console.error('CLOSE failed — POSITION OPEN, close manually:', close.msg); process.exit(1); }
  const flat = await hlFetchPosition(COIN);
  if (flat.ok && flat.data) { console.error(`STILL HOLDING ${flat.data.size} — close manually!`); process.exit(1); }
  const exit = close.data.avgPx ?? mid;
  const slipUsd = (exit - pos.data.entryPx) * pos.data.size;
  console.log(`closed @ ${exit} | volume ≈ $${(NOTIONAL * 2).toFixed(0)} → +${Math.round(NOTIONAL * 2)} actions | fees ≈ $${(NOTIONAL * 2 * 0.00045).toFixed(2)} | px-slip $${slipUsd.toFixed(2)}`);
})().catch((e) => { console.error(e); process.exit(1); });
