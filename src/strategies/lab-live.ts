/**
 * LAB → LIVE execution bridge (STAGE 1: off / dry-run only).
 *
 * The lab runners trade PAPER (track='lab'). For a curated DEPLOYED SUBSET this
 * also mirrors each entry/exit as a REAL order on the operator's own Bybit
 * account — the project's first real-money use of the kill-battery-proven book.
 *
 * SAFE BY DESIGN — staged rollout via LAB_LIVE.mode (a const, NOT env → flipping
 * it is a deliberate code change + deploy, never an accidental toggle):
 *   'off'     — does nothing.
 *   'dryrun'  — computes + LOGS the intended order (notional, qty, SL). Places NOTHING.
 *   'testnet' — Bybit TESTNET orders (fake money). [wired in stage 2]
 *   'live'    — MAINNET, real money. [wired in stage 2, only after testnet is clean]
 * testnet/live THROW here on purpose: untested order code must not run until stage 2.
 *
 * Sizing: per-strategy notional = capital × weight × leverage; weights = risk-parity
 * (1/DD) + cluster cap (allocatePortfolio — the lab's own allocator). Deployed v1 =
 * the 4h Bollinger-MR cluster (L01-L05, L10): 6 DISTINCT coins, market orders,
 * kill-battery survivors, no One-Way symbol collision. Other clusters (maker-1h,
 * trend) add in a later stage once hedge-mode handles same-symbol collisions.
 * Leverage 2x is the conservative START (portfolio-sim safe ceiling ~3x @ DD≤20%).
 */
import { logger } from '../lib/logger.js';
import { allocatePortfolio } from '../lib/portfolio.js';
import { BT_MAXDD_PCT, type LabStrategy } from './lab-registry.js';
import { hlSetLeverage, hlMarketOrder, hlClosePosition, hlConfigured } from '../exchange/hyperliquid-private.js';

/** Lab symbols are 'ETHUSDT' etc.; HL uses bare coin names. */
const hlCoin = (symbol: string): string => symbol.replace('USDT', '');

export type LabLiveMode = 'off' | 'dryrun' | 'testnet' | 'live';

export const LAB_LIVE: { mode: LabLiveMode; capitalUsd: number; leverage: number; deployed: string[] } = {
  mode: 'dryrun',
  capitalUsd: 2000,
  // Conservative forward-test start = 1.0x (NO leverage). portfolio-sim cross-window:
  // 540d safe ≤3x but recent 180d had a NEGATIVE walk-forward fold (safe <1x) — the edge
  // is thin/regime-dependent, so prove the book UNLEVERED live first, raise only if it holds.
  leverage: 1.0,
  deployed: ['L01', 'L02', 'L03', 'L04', 'L05', 'L10'], // 4h Bollinger-MR cluster
};

const clusterOf = (code: string): string =>
  /^M/i.test(code) ? 'mr-1h-maker' : (['L06', 'L07', 'L08', 'L09'].includes(code) ? 'trend' : 'mr-4h');

const _alloc = allocatePortfolio(
  LAB_LIVE.deployed.map((c) => ({ id: c, cluster: clusterOf(c), riskPct: BT_MAXDD_PCT[c] ?? 20 })),
  { clusterCap: 0.5 },
);
// Per-strategy cap: risk-parity (1/DD) over-concentrates on the lowest-DD leg
// (BNB's DD=5 grabs ~38%) — a possibly-underestimated DD shouldn't dominate the book.
// Clamp each ≤ MAX_PER_STRAT and waterfill the excess to the rest, then it's renormalized.
const MAX_PER_STRAT = 0.20;
const WEIGHT = new Map(_alloc.map((a) => [a.id, a.weight]));
for (let iter = 0; iter < 8; iter++) {
  const over = [...WEIGHT].filter(([, w]) => w > MAX_PER_STRAT + 1e-9);
  if (!over.length) break;
  let excess = 0;
  for (const [id, w] of over) { excess += w - MAX_PER_STRAT; WEIGHT.set(id, MAX_PER_STRAT); }
  const under = [...WEIGHT].filter(([, w]) => w < MAX_PER_STRAT - 1e-9);
  const underSum = under.reduce((a, [, w]) => a + w, 0) || 1;
  for (const [id, w] of under) WEIGHT.set(id, w + excess * (w / underSum));
}

export function isLabLive(code: string): boolean {
  return LAB_LIVE.mode !== 'off' && LAB_LIVE.deployed.includes(code);
}

function sizeFor(code: string, price: number): { notional: number; qty: number; weight: number } {
  const weight = WEIGHT.get(code) ?? 0;
  const notional = LAB_LIVE.capitalUsd * weight * LAB_LIVE.leverage;
  return { notional, qty: notional / price, weight };
}

export async function labLiveOnOpen(s: LabStrategy, side: 'long' | 'short', entry: number, barTime: number): Promise<void> {
  if (!isLabLive(s.code)) return;
  const { notional, qty: rawQty, weight } = sizeFor(s.code, entry);
  const sl = side === 'long' ? entry * (1 - s.slPct) : entry * (1 + s.slPct);
  if (LAB_LIVE.mode === 'dryrun') {
    logger.warn(
      { code: s.code, symbol: s.symbol, side, entry: +entry.toFixed(6), sl: +sl.toFixed(6), notional: +notional.toFixed(2), qty: +rawQty.toFixed(6), weight: +weight.toFixed(3), lev: LAB_LIVE.leverage },
      'LAB-LIVE [dryrun] WOULD OPEN — no order placed',
    );
    return;
  }
  // testnet/live — place a REAL order on HYPERLIQUID (Bybit blocks our region) with
  // the safety SL attached atomically (grouping normalTpsl). Size formatted by the SDK.
  void barTime;
  if (!hlConfigured()) { logger.error({ code: s.code }, '🛑 LAB-LIVE: HL_API_WALLET_KEY missing — cannot place order'); return; }
  const coin = hlCoin(s.symbol);
  const lev = await hlSetLeverage(coin, LAB_LIVE.leverage);
  if (!lev.ok) logger.warn({ code: s.code, msg: lev.msg }, 'LAB-LIVE: HL setLeverage failed (continuing with account default)');
  const res = await hlMarketOrder({ coin, side, qty: rawQty, stopLoss: sl });
  if (!res.ok) { logger.error({ code: s.code, coin, side, qty: +rawQty.toFixed(6), msg: res.msg }, '🛑 LAB-LIVE: HL OPEN order FAILED'); return; }
  logger.warn({ code: s.code, coin, side, qty: +rawQty.toFixed(6), sl: +sl.toFixed(6), notional: +notional.toFixed(0), mode: LAB_LIVE.mode }, '✅ LAB-LIVE: HL OPENED real order');
}

export async function labLiveOnClose(s: LabStrategy, exitPrice: number, barTime: number): Promise<void> {
  if (!isLabLive(s.code)) return;
  void barTime;
  if (LAB_LIVE.mode === 'dryrun') {
    logger.warn({ code: s.code, symbol: s.symbol, exit: +exitPrice.toFixed(6) }, 'LAB-LIVE [dryrun] WOULD CLOSE — no order placed');
    return;
  }
  if (!hlConfigured()) { logger.error({ code: s.code }, '🛑 LAB-LIVE: HL_API_WALLET_KEY missing — cannot close'); return; }
  const coin = hlCoin(s.symbol);
  const res = await hlClosePosition(coin);
  if (!res.ok) { logger.error({ code: s.code, coin, msg: res.msg }, '🛑 LAB-LIVE: HL CLOSE order FAILED'); return; }
  logger.warn({ code: s.code, coin }, '✅ LAB-LIVE: HL CLOSED real position (or already flat)');
}

/** Boot summary — logs the deployed set + intended capital split so the sizing is
 *  visible immediately at deploy, not only when a (slow, 4h) signal fires. */
export function logLabLivePlan(): void {
  if (LAB_LIVE.mode === 'off') return;
  const lines = LAB_LIVE.deployed.map((c) => `${c}:${((WEIGHT.get(c) ?? 0) * 100).toFixed(0)}%→$${(LAB_LIVE.capitalUsd * (WEIGHT.get(c) ?? 0) * LAB_LIVE.leverage).toFixed(0)}`);
  logger.warn({ mode: LAB_LIVE.mode, capital: LAB_LIVE.capitalUsd, lev: LAB_LIVE.leverage, split: lines.join(' ') }, 'LAB-LIVE plan (notional per strategy = capital×weight×leverage)');
}
