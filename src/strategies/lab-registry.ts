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
import type { CustomStrategy } from '../backtest/strategy.js';

export type LabStrategy = CustomStrategy & {
  launchedAt: number;
  longDescription?: string;
};

export const LAB_TRACK = 'lab';
const LAB_LAUNCH = Date.parse('2026-06-14T00:00:00Z');

// Helper: take a family factory's CustomStrategy and stamp lab identity.
function lab(base: CustomStrategy, code: string, name: string, longDescription: string): LabStrategy {
  return { ...base, id: `lab-${code.toLowerCase()}`, code, name, launchedAt: LAB_LAUNCH, longDescription };
}

export const LAB_STRATEGIES: LabStrategy[] = [
  // ── PRIMARY EDGE — Bollinger(20,2) mean-reversion gated by EMA200 trend,
  // on 4h. The sweep+verify winner: positive on 8/10 coins, survived the
  // full kill-battery on 5 (ETH/LINK/XRP/BNB/DOGE), lowest drawdown (~20%),
  // WR 66–80%. A genuine, generalising, cost-robust mean-reversion edge.
  lab(bollMr('ETHUSDT', '240', 20, 2, 200, 0.06), 'L01', 'ETH Bollinger-MR 4h',
    'Победитель свипа. Откупаем отклонение от средней (нижняя/верхняя полоса Боллинджера 20/2) ТОЛЬКО в сторону тренда EMA200, выход у средней. Прошёл кросс-символьную проверку (плюс на 8/10 монет), 3/4 walk-forward фолдов и ×2 издержки. ETH: +84% нетто, просадка −21%, WR ~80%.'),
  lab(bollMr('LINKUSDT', '240', 20, 2, 200, 0.06), 'L02', 'LINK Bollinger-MR 4h',
    'Та же конфигурация на LINK — самый робастный по времени (4/4 фолда), +57% нетто, просадка −20%, WR ~70%.'),
  lab(bollMr('XRPUSDT', '240', 20, 2, 200, 0.06), 'L03', 'XRP Bollinger-MR 4h',
    'Та же конфигурация на XRP — +37% нетто, просадка −20%, WR ~79%, 3/4 фолда.'),
  lab(bollMr('BNBUSDT', '240', 20, 2, 200, 0.06), 'L04', 'BNB Bollinger-MR 4h',
    'Та же конфигурация на BNB — +30% нетто, просадка −20%, WR ~67%, 3/4 фолда.'),
  lab(bollMr('DOGEUSDT', '240', 20, 2, 200, 0.06), 'L05', 'DOGE Bollinger-MR 4h',
    'Та же конфигурация на DOGE — +16% нетто, но просадка выше (−44%); самый маргинальный из выживших, наблюдаем.'),
  // ── TREND EDGE — only the specific (config, major) pairs that were robust
  // per-fold with tolerable drawdown. Raw crypto trend is real but wild
  // (huge DD); these three are the exceptions that passed 4/4 folds.
  lab(donchianFlip('BTCUSDT', '240', 40, 0.10), 'L06', 'BTC Donchian-40 4h',
    'Пробой канала Дончиана(40) на BTC 4h: единственный пробойный конфиг с малой просадкой (−16%) и 4/4 walk-forward фолдов, +81% нетто. Трендовый диверсификатор к mean-rev корзине.'),
  lab(smaTrend('ETHUSDT', 'D', 50, 0.12), 'L07', 'ETH SMA50 Trend (daily)',
    'Дневной трендследящий на ETH: лонг пока цена выше SMA(50), иначе кэш. 4/4 фолда, просадка −24%, +138% нетто. Настоящий дневной трендовый край из Фазы 0, на активе где он держится.'),
  lab(smaTrend('BTCUSDT', 'D', 100, 0.12), 'L08', 'BTC SMA100 Trend (daily)',
    'Дневной тренд на BTC выше SMA(100): 4/4 фолда, просадка −20%, +148% нетто. Якорный трендовый край на главном активе.'),
];

export const LAB_BY_CODE = new Map(LAB_STRATEGIES.map((s) => [s.code, s]));
export const LAB_BY_ID = new Map(LAB_STRATEGIES.map((s) => [s.id, s]));
