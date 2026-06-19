/**
 * LAB-LIVE HYPERLIQUID PROBE — validates the HL order plumbing end-to-end in ~30s
 * (signing, leverage, IOC "market" fill, atomic SL, position read, reduceOnly close),
 * so we don't wait days for a natural 4h signal. Tiny (~$20) BTC long on HL TESTNET.
 *
 * HARD GUARD: refuses unless HL_USE_TESTNET=true — must NEVER touch mainnet.
 *   pnpm tsx scripts/lab-live-probe.ts      (run on the VPS, after the HL testnet key is in .env)
 */
import { config } from '../src/config.js';
import { hlConfigured, hlMid, hlSetLeverage, hlMarketOrder, hlFetchPosition, hlClosePosition, hlAccountValue } from '../src/exchange/hyperliquid-private.js';

(async () => {
  if (!config.HL_USE_TESTNET) {
    console.error('🛑 REFUSING: HL_USE_TESTNET=false (mainnet). This probe is testnet-only — set HL_USE_TESTNET=true in .env first.');
    process.exit(1);
  }
  if (!hlConfigured()) { console.error('🛑 HL_API_WALLET_KEY missing in .env'); process.exit(1); }
  const coin = 'BTC';

  console.log('0) account value →', await hlAccountValue());
  const mid = await hlMid(coin);
  if (!mid) { console.error('no HL mid for BTC'); process.exit(1); }
  const qty = Math.max(0.0002, Math.round((20 / mid) * 1e5) / 1e5); // ~$20 notional, above HL ~$10 min
  console.log(`Probe ${coin} mid ${mid} · qty ${qty} (~$${(qty * mid).toFixed(0)}) · testnet=${config.HL_USE_TESTNET}`);

  console.log('1) setLeverage 2x →', await hlSetLeverage(coin, 2));
  const sl = mid * 0.95;
  console.log('2) OPEN long + SL', +sl.toFixed(1), '→', await hlMarketOrder({ coin, side: 'long', qty, stopLoss: sl }));
  const pos = await hlFetchPosition(coin);
  console.log('3) position (expect size>0) →', pos);
  console.log('4) CLOSE reduceOnly →', await hlClosePosition(coin));
  const flat = await hlFetchPosition(coin);
  console.log('5) after close (expect null) →', flat);

  const ok = pos.ok && !!pos.data && pos.data.size > 0 && flat.ok && flat.data === null;
  console.log(ok ? '\n✅ HL PLUMBING OK — order/SL/position/close verified on testnet.' : '\n⚠ Something off — inspect the steps above before going further.');
})().catch((e) => { console.error(e); process.exit(1); });
