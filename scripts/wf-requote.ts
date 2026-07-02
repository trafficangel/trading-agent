/**
 * WF-REQUOTE — one-off ops: cancel the resting wick-fade quotes for the given coins so the runner re-places
 * them at the CURRENT desired depth on its next 1-min tick. Needed after a COIN_X depth change: the re-quote
 * logic only moves a quote when it drifts >1% off desired, and a 3%→2.5% change is only ~0.5% — without this
 * the old-depth quotes would linger for hours. SAFE: touches resting LIMIT orders only (never positions,
 * never trigger stops — those live in frontendOpenOrders, invisible to hlOpenOrders). Run on the VPS.
 *   pnpm tsx scripts/wf-requote.ts DOGE,ICP,NEAR,ENA,TIA,POPCAT,JUP,BLUR
 */
import { hlOpenOrders, hlCancelOrder } from '../src/exchange/hyperliquid-private.js';

const coins = (process.argv[2] ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
if (!coins.length) { console.error('usage: pnpm tsx scripts/wf-requote.ts DOGE,ICP,...'); process.exit(1); }

for (const coin of coins) {
  const oo = await hlOpenOrders(coin);
  if (!oo.ok) { console.log(`${coin}: openOrders read failed — ${oo.msg}`); continue; }
  if (!oo.data.length) { console.log(`${coin}: no resting orders`); continue; }
  for (const o of oo.data) {
    const r = await hlCancelOrder(coin, o.oid);
    console.log(`${coin} oid=${o.oid} @${o.px}: ${r.ok ? 'cancelled' : `FAILED — ${r.msg}`}`);
  }
}
console.log('done — the runner re-quotes at the new depth on its next 1-min tick');
