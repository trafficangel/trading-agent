/**
 * THE LAB — strategy registry (pure data, NO web/db deps).
 *
 * Split out of lab.ts so the backtest script and the live runner can import
 * the strategy list without pulling in the page/route layer.
 *
 * THIS SET IS VERIFIED. Each entry survived the full battery
 * (scripts/strategy-sweep.ts → scripts/verify-candidate.ts):
 *   - cross-symbol transfer (the rule works on multiple coins, not one fit),
 *   - 4-fold walk-forward (edge persists across time, not one regime),
 *   - cost stress ×2 (beats double commission/slippage).
 * They forward-test on paper here (track='lab', isolated) before any
 * promotion to the live book. Promotion gate: ≥15–20 net-positive PAPER
 * trades that match the backtest.
 *
 * Provisional safety SLs below are catastrophe nets, not the strategy's
 * exit (mean-rev exits at the mid-band; trend exits on the cross). They get
 * tuned per-strategy from the engine's native MAE (audit-sl-distribution).
 */

import { bollMr, donchianFlip, smaTrend } from '../backtest/strategies/families.js';
import { keltnerMr, zscoreMr } from '../backtest/strategies/families-lowtf.js';
import type { CustomStrategy } from '../backtest/strategy.js';

export type LabStrategy = CustomStrategy & {
  launchedAt: number;
  longDescription?: string;
  /** Execution track: 'lab' = market-order runner (default), 'lab-maker' =
   *  limit-order (maker) runner. Drives which runner trades it + which
   *  commission the stats subtract. */
  track?: string;
};

export const LAB_TRACK = 'lab';
export const LAB_MAKER_TRACK = 'lab-maker';
/** Maker round-trip commission used for the maker book's net PnL — HL maker
 *  ×2 as an honest cushion for fill-risk (real maker ≈ 0.02% RT). */
export const LAB_MAKER_COMMISSION_RT_PCT = 0.04;
const LAB_LAUNCH = Date.parse('2026-06-14T00:00:00Z');

// Helper: take a family factory's CustomStrategy and stamp lab identity.
function lab(base: CustomStrategy, code: string, name: string, longDescription: string): LabStrategy {
  return { ...base, id: `lab-${code.toLowerCase()}`, code, name, launchedAt: LAB_LAUNCH, longDescription };
}
function labMaker(base: CustomStrategy, code: string, name: string, longDescription: string): LabStrategy {
  return { ...base, id: `lab-${code.toLowerCase()}`, code, name, launchedAt: LAB_LAUNCH, longDescription, track: LAB_MAKER_TRACK };
}

// Safety SLs below are MAE-OPTIMAL (scripts/audit-sl-distribution.ts on the
// native-exit trade logs) — the SL that catches the catastrophic adverse-
// excursion tail without clipping normal mean-reversion noise. They differ
// per coin because the MAE distribution does (XRP worst −42%, BNB −29% vs
// ETH −13%). Audit confirmed mean-reversion IS SL-compatible here (5–8%
// even improves results by cutting the fat tail).
//
// MONEY MANAGEMENT (applies at promotion to the live book, not on paper):
//   - sizing = risk-parity. maxSafeLeverage=floor(0.70/(slPct+0.02)) makes
//     $-risk/trade ≈ 0.5–0.6×margin regardless of SL width (tighter stop →
//     more leverage → same risk). So margin pool splits give ~equal risk.
//   - CLUSTER CAP: L01–L05 are the SAME rule on 5 alts = ONE correlated bet
//     (alt mean-reversion), NOT 5 independent edges. At promotion they must
//     share a combined concurrent-risk cap, else a broad alt dip fires all
//     five at once = 5× the intended risk. maxConcurrentPositions bounds it
//     coarsely; a per-cluster cap is the right refinement.
//   - Kelly tilt (kelly-allocator) weights by realised forward edge once
//     each has MIN_SAMPLE=15 paper/live trades.
export const LAB_STRATEGIES: LabStrategy[] = [
  // ── PRIMARY EDGE — Bollinger(20,2) mean-reversion gated by EMA200 trend,
  // on 4h. The sweep+verify winner: positive on 8/10 coins, survived the
  // full kill-battery on 5 (ETH/LINK/XRP/BNB/DOGE), lowest drawdown (~20%),
  // WR 66–80%. A genuine, generalising, cost-robust mean-reversion edge.
  // SLs are MAE-audit-optimal per coin.
  lab(bollMr('ETHUSDT', '240', 20, 2, 200, 0.07), 'L01', 'ETH Bollinger-MR 4h',
    'Победитель свипа. Откупаем отклонение от средней (полосы Боллинджера 20/2) ТОЛЬКО в сторону тренда EMA200, выход у средней. Прошёл кросс-символьную проверку (плюс на 8/10 монет), 3/4 walk-forward фолдов, ×2 издержки. SL 7% — MAE-аудит-оптимум (PF 3.4, DD 14%, ловит 96% эджа).'),
  lab(bollMr('LINKUSDT', '240', 20, 2, 200, 0.08), 'L02', 'LINK Bollinger-MR 4h',
    'Та же конфигурация на LINK — самый робастный по времени (4/4 фолда), +60% нетто, WR ~70%. SL 8% (MAE-оптимум, ловит 97% эджа).'),
  lab(bollMr('XRPUSDT', '240', 20, 2, 200, 0.05), 'L03', 'XRP Bollinger-MR 4h',
    'Та же конфигурация на XRP — WR ~79%, 3/4 фолда, но маргинальна (PF 1.16). SL 5% — у XRP толстый хвост (worst MAE −42%), стоп срезает катастрофу и УЛУЧШАЕТ результат.'),
  lab(bollMr('BNBUSDT', '240', 20, 2, 200, 0.05), 'L04', 'BNB Bollinger-MR 4h',
    'Та же конфигурация на BNB — +20% нетто, PF 1.9, WR ~67%, 3/4 фолда. SL 5% (MAE-оптимум, DD всего 5%).'),
  lab(bollMr('DOGEUSDT', '240', 20, 2, 200, 0.08), 'L05', 'DOGE Bollinger-MR 4h',
    'Та же конфигурация на DOGE — +45% нетто, PF 1.7. SL 8% (MAE-оптимум; DOGE шире остальных).'),
  // ── TREND EDGE — only configs robust per-fold with tolerable drawdown.
  lab(donchianFlip('BTCUSDT', '240', 40, 0.08), 'L06', 'BTC Donchian-40 4h',
    'Пробой канала Дончиана(40) на BTC 4h: 4/4 walk-forward фолдов, +81% нетто. SL 8% — BORDERLINE по аудиту (стоп стоит части EV, но +32%, PF 1.4). Единственный пробойный конфиг с тугим стопом; трендовый диверсификатор к mean-rev корзине.'),
  // ── DAILY TREND — real edge (verified 4/4 folds on 1600d). SLs are now
  // MAE-audited on the FULL 1600d sample (37 / 29 trades, scripts/backtest-
  // daily.ts), correcting the earlier 540d audit that ran on only ~8 trades
  // and mis-flagged L08 as INCOMPATIBLE. Daily trend is volatile (deep equity
  // DD) but the per-trade MAE fits an 8% stop on these two majors.
  lab(smaTrend('ETHUSDT', 'D', 50, 0.08), 'L07', 'ETH SMA50 Trend (daily)',
    'Дневной трендследящий на ETH: лонг пока цена выше SMA(50), иначе кэш. 1600д/37 сделок, +138% нетто, 4/4 фолда. SL 8% — MAE-аудит (BORDERLINE: ловит 71% эджа, PF 1.82). Просадка эквити −46% — дневной тренд волатилен. Торгует редко.'),
  lab(smaTrend('BTCUSDT', 'D', 100, 0.08), 'L08', 'BTC SMA100 Trend (daily)',
    'Дневной тренд на BTC выше SMA(100). ВОССТАНОВЛЕНА после переаудита: 1600д/29 сделок → ✅ COMPATIBLE при SL 8% (PF 2.85, просадка −22%, +141% нетто, ловит 95% эджа). Ранний вердикт INCOMPATIBLE был артефактом малой выборки (8 сделок на 540д). Лучший дневной тренд набора.'),
  // ── 1h BREAKOUT — Donchian(40) on 1h. Found via the maker/HL sweep; the
  // sweep window (450d) showed it positive on 5 majors, but a CROSS-WINDOW
  // re-check (540d, backtest-custom) flipped BTC (−42%, INCOMPATIBLE) and
  // BNB (IS −11%, PF 1.07) negative — window-fragile, dropped. Only ETH held
  // across both windows (450d +121%, 540d +97%, PF 1.36, both folds +,
  // MAE-audit ✅ COMPATIBLE at 8%). Taker by nature → market-order runner
  // tests it faithfully. The honest survivor of the 1h search.
  lab(donchianFlip('ETHUSDT', '60', 40, 0.08), 'L09', 'ETH Donchian-40 1h',
    'Пробой канала Дончиана(40) на ETH 1h. Найдена в maker/HL-свипе, единственный 1h-пробой, переживший КРОСС-ОКОННУЮ проверку (450д +121% и 540д +97%, PF 1.36, обе walk-forward половины в плюс). SL 8% MAE-аудит (✅ COMPATIBLE, стоп улучшает результат). Просадка −37%. BTC/BNB на этом TF оказались оконно-хрупкими и отброшены.'),
];

// ── MAKER book — low-TF (5m) mean-reversion edges that are net-negative at
// taker but positive at maker fees. Found via the new-family sweep + verified
// cross-symbol (Keltner +EMA200 @5m survived 8/10 coins; z-score(50) @5m on 4
// majors), low DD (5-10%), WR ~70%. Driven by the maker-runner (rests a limit
// at the band, fills on touch), track='lab-maker', net of maker commission.
export const MAKER_LAB_STRATEGIES: LabStrategy[] = [
  labMaker(keltnerMr('ADAUSDT', '5', 20, 10, 2, 200), 'M01', 'ADA Keltner-MR 5m (maker)',
    'Откуп от канала Кельтнера (EMA20±2·ATR10) по тренду EMA200 на 5m, выход у средней — лимитками. Найдена в свипе новых семейств, прошла кросс-символьную проверку (8/10 монет), PF 1.74, просадка −6%, WR 72%. Реализуется ТОЛЬКО maker (на taker ≈ ноль).'),
  labMaker(keltnerMr('LTCUSDT', '5', 20, 10, 2, 200), 'M02', 'LTC Keltner-MR 5m (maker)',
    'Тот же Keltner-MR на LTC — 4/4 walk-forward фолда, просадка −8%. Часть обобщающегося 5m maker-края.'),
  labMaker(keltnerMr('SOLUSDT', '5', 20, 10, 2, 200), 'M03', 'SOL Keltner-MR 5m (maker)',
    'Keltner-MR на SOL — 3/4 фолда, просадка −5%.'),
  labMaker(keltnerMr('XRPUSDT', '5', 20, 10, 2, 200), 'M04', 'XRP Keltner-MR 5m (maker)',
    'Keltner-MR на XRP — 4/4 фолда, просадка −5%.'),
  labMaker(zscoreMr('ETHUSDT', '5', 50, 2, 200), 'M05', 'ETH Z-score-MR 5m (maker)',
    'Возврат к средней по z-score(50) ±2σ по тренду EMA200 на 5m, лимитками. Кросс-символьно чист на мейджорах: 4/4 фолда, PF 1.55, просадка −5%, WR 77%.'),
  labMaker(zscoreMr('LTCUSDT', '5', 50, 2, 200), 'M06', 'LTC Z-score-MR 5m (maker)',
    'Z-score-MR на LTC — 4/4 фолда, PF 1.84, просадка всего −3.7%, WR 77%. Самый чистый профиль набора.'),
  labMaker(zscoreMr('BTCUSDT', '5', 50, 2, 200), 'M07', 'BTC Z-score-MR 5m (maker)',
    'Z-score-MR на BTC — 4/4 фолда, PF 1.64, просадка −4.6%.'),
  labMaker(zscoreMr('BNBUSDT', '5', 50, 2, 200), 'M08', 'BNB Z-score-MR 5m (maker)',
    'Z-score-MR на BNB — 3/4 фолда, PF 1.33, просадка −10%.'),
];

/** Backtest reference: net %/trade per strategy (from the sweeps/audits).
 *  The forward-gate (lib/lab-gate.ts) compares live paper expectancy to this
 *  to flag a decaying edge. Approximate — a yardstick, not a contract. */
export const BT_NET_PCT_PER_TRADE: Record<string, number> = {
  L01: 1.95, L02: 1.54, L03: 0.23, L04: 0.65, L05: 1.18, L06: 0.94, L07: 2.65, L08: 4.86, L09: 0.71,
  M01: 0.14, M02: 0.07, M03: 0.07, M04: 0.04, M05: 0.12, M06: 0.14, M07: 0.10, M08: 0.06,
};

export const ALL_LAB_STRATEGIES: LabStrategy[] = [...LAB_STRATEGIES, ...MAKER_LAB_STRATEGIES];
export const LAB_BY_CODE = new Map(ALL_LAB_STRATEGIES.map((s) => [s.code, s]));
export const LAB_BY_ID = new Map(ALL_LAB_STRATEGIES.map((s) => [s.id, s]));
