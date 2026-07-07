/**
 * WF MARGIN CHECK — one-off ops diagnostic. Reads the LIVE Hyperliquid account and reports
 * the REAL reserved margin vs equity (the true buffer), from actual resting orders — not a
 * theoretical formula. Run on the VPS: pnpm tsx scripts/wf-margin-check.ts
 */
import { config } from '../src/config.js';
import { privateKeyToAccount } from 'viem/accounts';

const INFO = 'https://api.hyperliquid.xyz/info';
const post = async (body: unknown): Promise<any> => {
  const r = await fetch(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};

(async () => {
  const addr = (config.HL_ACCOUNT_ADDRESS
    ?? privateKeyToAccount(config.HL_API_WALLET_KEY as `0x${string}`).address).toLowerCase();
  console.log('account:', addr);

  const [clh, spot, oo] = await Promise.all([
    post({ type: 'clearinghouseState', user: addr }),
    post({ type: 'spotClearinghouseState', user: addr }),
    post({ type: 'openOrders', user: addr }),
  ]);

  const perp = Number(clh?.marginSummary?.accountValue ?? 0);
  const marginUsed = Number(clh?.marginSummary?.totalMarginUsed ?? 0);
  const ntlPos = Number(clh?.marginSummary?.totalNtlPos ?? 0);
  const withdrawable = Number(clh?.withdrawable ?? 0);
  const positions = (clh?.assetPositions ?? []).length;

  const usdc = (spot?.balances ?? []).find((b: any) => b.coin === 'USDC') ?? {};
  const spotTotal = Number(usdc.total ?? 0);
  const spotHold = Number(usdc.hold ?? 0);
  const freeSpot = Math.max(0, spotTotal - spotHold);
  const equity = perp + freeSpot; // unified-account true equity (hlAccountValue semantics)

  const orders: any[] = Array.isArray(oo) ? oo : [];
  const per: Record<string, { B: number; A: number; bN: number; aN: number }> = {};
  for (const o of orders) {
    const c = o.coin as string;
    const n = Number(o.limitPx) * Number(o.sz);
    per[c] ??= { B: 0, A: 0, bN: 0, aN: 0 };
    if (o.side === 'B') { per[c].B += n; per[c].bN += 1; } else { per[c].A += n; per[c].aN += 1; }
  }
  const grossNotl = Object.values(per).reduce((s, v) => s + v.B + v.A, 0);
  const nettedNotl = Object.values(per).reduce((s, v) => s + Math.max(v.B, v.A), 0);
  const lev = 2; // WF_CONFIG.leverage
  const grossReserve = grossNotl / lev;   // if HL reserved every rung independently
  const nettedReserve = nettedNotl / lev; // HL nets opposing same-coin rungs

  console.log('\n── EQUITY ─────────────────────────────');
  console.log(`perp accountValue : $${perp.toFixed(2)}`);
  console.log(`free spot USDC    : $${freeSpot.toFixed(2)}  (total ${spotTotal.toFixed(2)}, hold ${spotHold.toFixed(2)})`);
  console.log(`TRUE equity       : $${equity.toFixed(2)}`);
  console.log(`open positions    : ${positions}`);

  console.log('\n── HL-REPORTED MARGIN ─────────────────');
  console.log(`totalMarginUsed   : $${marginUsed.toFixed(2)}`);
  console.log(`totalNtlPos       : $${ntlPos.toFixed(2)}`);
  console.log(`withdrawable      : $${withdrawable.toFixed(2)}  → HL free = ${equity > 0 ? (100 * withdrawable / equity).toFixed(0) : '—'}% of equity`);

  console.log('\n── RESTING ORDERS (the real book) ─────');
  console.log(`open orders       : ${orders.length}  across ${Object.keys(per).length} coins`);
  console.log(`gross notional    : $${grossNotl.toFixed(2)}  → reserve @${lev}x = $${grossReserve.toFixed(2)} (${(100 * grossReserve / equity).toFixed(0)}% of equity)`);
  console.log(`netted notional   : $${nettedNotl.toFixed(2)}  → reserve @${lev}x = $${nettedReserve.toFixed(2)} (${(100 * nettedReserve / equity).toFixed(0)}% of equity)`);
  console.log(`buffer (netted)   : $${(equity - nettedReserve).toFixed(2)} (${(100 * (equity - nettedReserve) / equity).toFixed(0)}%)`);

  console.log('\n── per coin (B=bid/long, A=ask/short) ──');
  for (const c of Object.keys(per).sort()) {
    const v = per[c]!;
    console.log(`  ${c.padEnd(8)} B:${v.bN}×$${v.B.toFixed(1).padStart(6)}  A:${v.aN}×$${v.A.toFixed(1).padStart(6)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
