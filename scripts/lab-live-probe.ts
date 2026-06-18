/**
 * LAB-LIVE TESTNET PROBE — validates the order plumbing end-to-end in ~30s,
 * so we don't wait days for a natural 4h signal. Places a TINY (~$50) BTC long
 * with an atomic safety SL on Bybit TESTNET, reads the position back (confirms
 * the SL attached), then closes it reduceOnly and confirms flat.
 *
 * HARD GUARD: refuses to run unless BYBIT_USE_TESTNET=true — it must NEVER touch
 * mainnet. Reuses the exact functions the lab-live bridge uses.
 *   pnpm tsx scripts/lab-live-probe.ts      (run on the VPS, after the testnet key is in .env)
 */
import { config } from '../src/config.js';
import { placeMarketOrder, setLeverage, fetchPosition, type Creds } from '../src/exchange/bybit-private.js';
import { roundQtyToStep, getInstrumentInfo, getLastPrice } from '../src/exchange/bybit-public.js';

(async () => {
  if (!config.BYBIT_USE_TESTNET) {
    console.error('🛑 REFUSING: BYBIT_USE_TESTNET=false (mainnet). This probe is testnet-only — set BYBIT_USE_TESTNET=true in .env first.');
    process.exit(1);
  }
  const apiKey = config.BYBIT_OPERATOR_API_KEY, apiSecret = config.BYBIT_OPERATOR_API_SECRET;
  if (!apiKey || !apiSecret) { console.error('🛑 BYBIT_OPERATOR_API_KEY/SECRET missing in .env'); process.exit(1); }
  const creds: Creds = { apiKey, apiSecret };
  const symbol = 'BTCUSDT';

  const px = await getLastPrice(symbol);
  if (!px) { console.error('no price'); process.exit(1); }
  const info = await getInstrumentInfo(symbol);
  const qty = await roundQtyToStep(Math.max(info?.minOrderQty ?? 0.001, 50 / px), symbol);
  console.log(`Probe BTCUSDT @ ${px} · qty ${qty} (~$${(qty * px).toFixed(0)}) · testnet=${config.BYBIT_USE_TESTNET}`);

  console.log('1) setLeverage 2x →', await setLeverage(creds, symbol, 2));
  const slPx = Number((px * 0.95).toPrecision(6));
  const open = await placeMarketOrder(creds, { symbol, side: 'long', qty, stopLoss: slPx, clientOrderId: `probe-${px}` });
  console.log('2) OPEN long + SL', slPx, '→', open);
  const pos = await fetchPosition(creds, symbol);
  console.log('3) position (expect size>0, stopLoss set) →', pos.ok ? pos.position : pos);

  const close = await placeMarketOrder(creds, { symbol, side: 'short', qty, reduceOnly: true, clientOrderId: `probe-x-${px}` });
  console.log('4) CLOSE reduceOnly →', close);
  const flat = await fetchPosition(creds, symbol);
  console.log('5) after close (expect null) →', flat.ok ? flat.position : flat);

  const ok = open.ok && pos.ok && !!pos.position && pos.position.stopLoss > 0 && close.ok && flat.ok && !flat.position;
  console.log(ok ? '\n✅ PLUMBING OK — order/SL/position/close all verified on testnet.' : '\n⚠ Something off — inspect the steps above before going further.');
})().catch((e) => { console.error(e); process.exit(1); });
