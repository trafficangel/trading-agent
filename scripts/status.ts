/**
 * One-glance operator dashboard (read-only). Run on the VPS:
 *   pnpm tsx scripts/status.ts
 *
 * Consolidates what used to be 4 separate scripts: aggregate PnL (net of
 * commission), circuit-breaker/cooldown/probation state, per-strategy live
 * stats + Kelly weight, and open positions. Start here for any audit.
 */

import { db } from '../src/db/client.js';
import { STRATEGY_CONFIGS, TRACK_C_COMMISSION_RT_PCT } from '../src/strategies/track-c-config.js';
import { getStrategyLiveStats } from '../src/strategies/live-stats.js';
import { TIER_CONFIGS } from '../src/strategies/tier-config.js';
import { computeWeights } from '../src/strategies/kelly-allocator.js';
import {
  getRecentShadowSlHits, decideBreaker,
  getLastSlHitForStrategy, decideCooldown,
  getLastClosedTrades, decideProbation,
} from '../src/strategies/risk-control.js';

const C = TRACK_C_COMMISSION_RT_PCT;
const now = Date.now();
const fmtT = (ms: number | null) => (ms === null ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));

// ---- aggregate (shadow closed, commission-net) ----
const closed = db.prepare<[], { pnl_pct: number; side: string | null; closed_at: number }>(`
  SELECT pnl_pct, side, closed_at FROM decisions
   WHERE user_id IS NULL AND track='strategy' AND status='closed' AND pnl_pct IS NOT NULL
   ORDER BY closed_at`).all();
let cum = 0, peak = 0, maxDd = 0, wins = 0, longNet = 0, shortNet = 0;
for (const r of closed) {
  const net = r.pnl_pct - C;
  cum += net; if (cum > peak) peak = cum; if (peak - cum > maxDd) maxDd = peak - cum;
  if (net > 0) wins++;
  if (r.side === 'short') shortNet += net; else longNet += net;
}
const n = closed.length;
console.log(`\n━━ Robot Claude · status @ ${fmtT(now)} UTC ━━\n`);
console.log(`PORTFOLIO (shadow, net of ${C}% commission)`);
console.log(`  closed ${n}  ·  net ${cum >= 0 ? '+' : ''}${cum.toFixed(1)}%  ·  WR ${n ? ((wins / n) * 100).toFixed(0) : 0}%  ·  maxDD −${maxDd.toFixed(1)}%`);
console.log(`  long ${longNet >= 0 ? '+' : ''}${longNet.toFixed(1)}%   short ${shortNet >= 0 ? '+' : ''}${shortNet.toFixed(1)}%`);

// ---- circuit breaker ----
const breaker = decideBreaker(getRecentShadowSlHits(now), now);
console.log(`\nRISK`);
console.log(`  circuit breaker: ${breaker.blocked ? `⛔ ACTIVE until ${fmtT(breaker.until)}` : '✅ clear'}`);

// ---- per-strategy ----
const enabled = Object.values(STRATEGY_CONFIGS).filter((c) => c.enabled);
const weights = computeWeights(TIER_CONFIGS['plus'].strategyIds);
const eq = 1 / TIER_CONFIGS['plus'].strategyIds.length;
console.log(`\nSTRATEGIES (enabled)`);
console.log(`  code sym       tf   fanOut  net$    WR   N   open  weight  risk`);
for (const cfg of enabled.sort((a, b) => a.code.localeCompare(b.code))) {
  const live = getStrategyLiveStats(cfg.id);
  const cd = decideCooldown(getLastSlHitForStrategy(cfg.id), cfg.timeframe, now);
  const pr = decideProbation(getLastClosedTrades(cfg.id), now);
  const risk = cd.blocked ? '🧊cooldown' : pr.blocked ? '🚧probation' : 'ok';
  const w = weights.get(cfg.id);
  const wStr = w !== undefined ? `${(w * 100).toFixed(0)}%${w > eq * 1.05 ? '↑' : w < eq * 0.95 ? '↓' : ''}` : '—';
  console.log(
    `  ${cfg.code}  ${String(cfg.symbol).padEnd(9)} ${cfg.timeframe.padEnd(4)} ${(cfg.fanOut ? 'live' : 'shdw').padEnd(6)} ` +
    `${(live.netPnlUsd >= 0 ? '+' : '') + live.netPnlUsd.toFixed(0)}`.padEnd(7) +
    ` ${live.winRate !== null ? (live.winRate * 100).toFixed(0) + '%' : '—'}`.padEnd(5) +
    ` ${String(live.closed).padStart(3)}  ${String(live.open).padStart(4)}  ${wStr.padStart(6)}  ${risk}`,
  );
}

// ---- open positions ----
const open = db.prepare<[], { strategy_id: string; symbol: string; side: string | null; entry: number | null; created_at: number }>(`
  SELECT strategy_id, symbol, side, entry, created_at FROM decisions
   WHERE user_id IS NULL AND track='strategy' AND status IN ('active','pending') ORDER BY created_at DESC`).all();
console.log(`\nOPEN (${open.length})`);
for (const o of open) {
  console.log(`  ${String(o.symbol).padEnd(9)} ${(o.side === 'short' ? 'short' : 'long').padEnd(5)} @ ${o.entry ?? '—'}  ${fmtT(o.created_at)}  ${o.strategy_id}`);
}

const wick = db.prepare<[], { closed: number; exact: number; net_pct: number | null; net_usd: number | null }>(`
  SELECT COUNT(*) AS closed,
         COALESCE(SUM(CASE WHEN pnl_source = 'fills-v1' THEN 1 ELSE 0 END), 0) AS exact,
         SUM(pnl_pct) AS net_pct,
         SUM(COALESCE(net_pnl_usd, (pnl_pct / 100.0) * qty * entry_px)) AS net_usd
    FROM wick_fade_log
   WHERE mode='live' AND closed_at IS NOT NULL AND pnl_pct IS NOT NULL
`).get()!;
const wickOpen = db.prepare<[], { coin: string; side: string; entry_px: number; qty: number; opened_at: number }>(`
  SELECT coin, side, entry_px, qty, opened_at FROM wick_fade_pos ORDER BY opened_at
`).all();
console.log(`\nHL WICK-FADE LIVE`);
console.log(`  closed ${wick.closed} · exact ${wick.exact}/${wick.closed} · net ${(wick.net_pct ?? 0) >= 0 ? '+' : ''}${(wick.net_pct ?? 0).toFixed(3)}% / $${(wick.net_usd ?? 0).toFixed(3)}`);
const wickDriftRaw = db.prepare<[string], { value: string }>('SELECT value FROM runtime_config WHERE key = ?').get('wick_fade_drift_guard_state')?.value;
if (wickDriftRaw) {
  try {
    const state = JSON.parse(wickDriftRaw) as { blocked?: boolean; checkedAt?: number; reason?: string; fast?: { averagePct?: number; sumPct?: number; profitFactor?: number | null }; slow?: { averagePct?: number; sumPct?: number; profitFactor?: number | null } };
    const pf = (value: number | null | undefined, sumPct: number | undefined): string => value == null ? ((sumPct ?? 0) > 0 ? 'inf' : 'na') : value.toFixed(2);
    console.log(`  drift ${state.blocked ? 'PAUSED' : 'LIVE'} @ ${fmtT(state.checkedAt ?? null)} · last20 ${(state.fast?.averagePct ?? 0).toFixed(3)}% PF ${pf(state.fast?.profitFactor, state.fast?.sumPct)} · last40 ${(state.slow?.averagePct ?? 0).toFixed(3)}% PF ${pf(state.slow?.profitFactor, state.slow?.sumPct)} · ${state.reason ?? 'no reason'}`);
  } catch { console.log(`  drift INVALID — entries fail closed`); }
} else {
  console.log(`  drift INITIALIZING — entries fail closed`);
}
for (const p of wickOpen) {
  console.log(`  ${p.coin.padEnd(9)} ${p.side.padEnd(5)} @ ${p.entry_px} · $${(p.entry_px * p.qty).toFixed(2)} · ${fmtT(p.opened_at)}`);
}

// ---- Funding-flip mainnet shadow ----
const fundingFlip = db.prepare<[], { closed: number; net_pct: number | null; wins: number }>(`
  SELECT COUNT(*) AS closed, SUM(pnl_pct) AS net_pct,
         COALESCE(SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END), 0) AS wins
    FROM funding_flip_log
   WHERE mode='shadow' AND reason='open' AND closed_at IS NOT NULL AND pnl_pct IS NOT NULL
`).get()!;
const fundingFlipOpen = db.prepare<[], { coin: string; side: string; entry_px: number; qty: number; opened_at: number }>(`
  SELECT p.coin, p.side, p.entry_px, p.qty, p.opened_at
    FROM funding_flip_pos p
   WHERE EXISTS (
     SELECT 1 FROM funding_flip_log l
      WHERE l.coin=p.coin AND l.mode='shadow' AND l.closed_at IS NULL
   )
   ORDER BY p.opened_at
`).all();
const fundingNet = fundingFlip.net_pct ?? 0;
console.log(`\nHL FUNDING-FLIP SHADOW`);
console.log(`  closed ${fundingFlip.closed}/20 · net ${fundingNet >= 0 ? '+' : ''}${fundingNet.toFixed(3)}% · WR ${fundingFlip.closed ? (fundingFlip.wins / fundingFlip.closed * 100).toFixed(0) : 0}% · open ${fundingFlipOpen.length}`);
for (const p of fundingFlipOpen) {
  console.log(`  ${p.coin.padEnd(9)} ${p.side.padEnd(5)} @ ${p.entry_px} · paper $${(p.entry_px * p.qty).toFixed(2)} · ${fmtT(p.opened_at)}`);
}

// ---- Hyperliquid momentum live ----
const momPublicStartRaw = Number(db.prepare<[string], { value: string }>('SELECT value FROM runtime_config WHERE key = ?').get('hl_momentum_public_start_ms')?.value ?? Date.UTC(2026, 6, 8, 18, 14, 0));
const momPublicStart = Number.isFinite(momPublicStartRaw) ? momPublicStartRaw : Date.UTC(2026, 6, 8, 18, 14, 0);
const mom = db.prepare<[number], { closed: number; exact: number; net_pct: number | null; net_usd: number | null }>(`
  SELECT COUNT(*) AS closed,
         COALESCE(SUM(CASE WHEN pnl_source = 'fills-v1' THEN 1 ELSE 0 END), 0) AS exact,
         SUM(pnl_pct) AS net_pct,
         SUM(COALESCE(net_pnl_usd, (pnl_pct / 100.0) * qty * entry_px)) AS net_usd
    FROM hl_momentum_live_log
   WHERE closed_at IS NOT NULL AND pnl_pct IS NOT NULL AND opened_at >= ?
`).get(momPublicStart)!;
const momOpen = db.prepare<[], { coin: string; side: string; entry_px: number; qty: number; opened_at: number }>(`
  SELECT coin, side, entry_px, qty, opened_at FROM hl_momentum_live_pos ORDER BY opened_at
`).all();
const pendingIntents = db.prepare<[], { n: number }>(`
  SELECT COUNT(*) AS n FROM hl_momentum_order_intent WHERE status IN ('pending', 'submitted')
`).get()?.n ?? 0;
const momRuntimeStmt = db.prepare<[string], { value: string }>('SELECT value FROM runtime_config WHERE key = ?');
const momRuntime = (key: string, fallback: string): string => momRuntimeStmt.get(key)?.value ?? fallback;
const momLiveEnabled = momRuntime('hl_momentum_live_enabled', '0') === '1';
const momPromotionStage = momRuntime('hl_momentum_promotion_stage', 'canary-1');
const momPromotionN = Number(momRuntime('hl_momentum_confirm_long_canary_live_n', '0'));
const momPromotionExactN = Number(momRuntime('hl_momentum_promotion_exact_n', String(momPromotionN)));
const momPromotionAvg = Number(momRuntime('hl_momentum_confirm_long_canary_live_avg_pct', '0'));
const momPromotionPfRaw = momRuntime('hl_momentum_promotion_profit_factor', '0');
const momPromotionPfNum = Number(momPromotionPfRaw);
const momPromotionPf = momPromotionPfRaw === 'inf' ? '∞' : Number.isFinite(momPromotionPfNum) && momPromotionN ? momPromotionPfNum.toFixed(2) : '—';
const momPromotionDd = Number(momRuntime('hl_momentum_promotion_max_drawdown_pct', '0'));
const momPromotionNext = momRuntime('hl_momentum_promotion_next_stage', 'canary-2');
const momPromotionNextN = Number(momRuntime('hl_momentum_promotion_next_min_trades', '10'));
const momPromotionMaxOpen = Number(momRuntime('hl_momentum_confirm_long_canary_max_open', '1'));
const momConfirmLongMinAbsR3 = Number(momRuntime('hl_momentum_confirm_long_min_abs_r3_pct', '0.50'));
const momConfirmLongShadowN = Number(momRuntime('hl_momentum_confirm_long_shadow_n', '0'));
const momConfirmLongShadowTargetN = Number(momRuntime('hl_momentum_confirm_long_sample_n', '40'));
const momPromotionProgress = momPromotionStage === 'shadow'
  ? `shadow proof ${momConfirmLongShadowN}/${momConfirmLongShadowTargetN}`
  : `${momPromotionN}/${momPromotionNextN || momPromotionN} → ${momPromotionNext}`;
const momFastStage = momRuntime('hl_momentum_fast_long_promotion_stage', 'shadow');
const momFastN = Number(momRuntime('hl_momentum_fast_long_canary_live_n', '0'));
const momFastExactN = Number(momRuntime('hl_momentum_fast_long_promotion_exact_n', String(momFastN)));
const momFastAvg = Number(momRuntime('hl_momentum_fast_long_canary_live_avg_pct', '0'));
const momFastPfRaw = momRuntime('hl_momentum_fast_long_promotion_profit_factor', '0');
const momFastPfNum = Number(momFastPfRaw);
const momFastPf = momFastPfRaw === 'inf' ? '∞' : Number.isFinite(momFastPfNum) && momFastN ? momFastPfNum.toFixed(2) : '—';
const momFastDd = Number(momRuntime('hl_momentum_fast_long_promotion_max_drawdown_pct', '0'));
const momFastNext = momRuntime('hl_momentum_fast_long_promotion_next_stage', 'canary-2');
const momFastNextN = Number(momRuntime('hl_momentum_fast_long_promotion_next_min_trades', '10'));
const momFastMaxOpen = Number(momRuntime('hl_momentum_fast_long_canary_max_open', '1'));
const momFastMinAbsR90 = Number(momRuntime('hl_momentum_fast_long_min_abs_r90_pct', '0.80'));
const momFastShadowN = Number(momRuntime('hl_momentum_fast_long_shadow_n', '0'));
const momFastShadowTargetN = Number(momRuntime('hl_momentum_fast_long_sample_n', '20'));
const momFastExecutionVersion = momRuntime('hl_momentum_fast_execution_version', 'fast-intrabar-v2');
const momFastProgress = momFastStage === 'shadow'
  ? `shadow proof ${momFastShadowN}/${momFastShadowTargetN}`
  : `${momFastN}/${momFastNextN || momFastN} → ${momFastNext}`;
const reconcileRaw = db.prepare<[string], { value: string }>('SELECT value FROM runtime_config WHERE key = ?').get('hl_momentum_reconcile_state')?.value;
let reconcile = 'not checked';
if (reconcileRaw) {
  try {
    const state = JSON.parse(reconcileRaw) as { ok?: boolean; issues?: string[]; checkedAt?: number };
    reconcile = `${state.ok ? '✅ healthy' : '⛔ paused'} @ ${fmtT(state.checkedAt ?? null)}${state.issues?.length ? ` · ${state.issues.join('; ')}` : ''}`;
  } catch { reconcile = 'invalid state'; }
}
console.log(`\nHL MOMENTUM ${momLiveEnabled ? 'LIVE' : 'CLOSED · SHADOW ONLY'} (track since ${fmtT(momPublicStart)})`);
console.log(`  reconcile ${reconcile}`);
console.log(`  stage ${momPromotionStage} · |r3|≥${momConfirmLongMinAbsR3.toFixed(2)}% · ${momPromotionProgress} · live exact ${momPromotionExactN}/${momPromotionN} · avg ${momPromotionAvg >= 0 ? '+' : ''}${momPromotionAvg.toFixed(3)}% · PF ${momPromotionPf} · maxDD ${momPromotionDd.toFixed(3)}% · maxOpen ${momPromotionMaxOpen}`);
console.log(`  fast-long ${momFastStage} · ${momFastExecutionVersion} · |r90|≥${momFastMinAbsR90.toFixed(2)}% · ${momFastProgress} · live exact ${momFastExactN}/${momFastN} · avg ${momFastAvg >= 0 ? '+' : ''}${momFastAvg.toFixed(3)}% · PF ${momFastPf} · maxDD ${momFastDd.toFixed(3)}% · maxOpen ${momFastMaxOpen}`);
console.log(`  closed ${mom.closed} · exact ${mom.exact}/${mom.closed} · net ${(mom.net_pct ?? 0) >= 0 ? '+' : ''}${(mom.net_pct ?? 0).toFixed(3)}% / $${(mom.net_usd ?? 0).toFixed(3)} · pending intents ${pendingIntents}`);
for (const p of momOpen) {
  console.log(`  ${p.coin.padEnd(9)} ${p.side.padEnd(5)} @ ${p.entry_px} · $${(p.entry_px * p.qty).toFixed(2)} · ${fmtT(p.opened_at)}`);
}
console.log('');
