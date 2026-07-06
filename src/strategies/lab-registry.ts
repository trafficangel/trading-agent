/**
 * THE LAB — strategy registry (pure data, NO web/db deps).
 *
 * Split out of lab.ts so the backtest script and the live runner can import
 * the strategy list without pulling in the page/route layer.
 *
 * ── RE-LAUNCHED Jul 6 2026 as a SEPARATE forward-validation book ────────────
 * The diversified MR + trend book (retired Jun 25 in the pivot to the fast
 * wick-fade) is revived here on PAPER — its OWN separate strategy track, fully
 * isolated from the live wick-fade book (track='lab'/'lab-maker', NULL user_id,
 * NO real orders). Motivation (Jul 6 cascade-risk analysis): the wick-fade is a
 * single correlated alt-fade whose EDGE and cascade-TAIL are the SAME flush
 * event — you cannot cut the tail without cutting the edge (proven: concurrency
 * cap / taper / market-hedge all backfire). The honest path to "profitable +
 * stable + low drawdown" is 3 genuinely UNCORRELATED clusters: 4h Bollinger-MR
 * (L01-L05,L10) + trend (L06-L09) + 1h maker-MR (M09-M14) — cross-corr 0.19,
 * backtest Sharpe ~2.4, DD ~5% @1x. This book is BACKTEST-GRADE (never forward-
 * confirmed; the one thing forward-tested, the 5m maker M01-M08, DIED and stays
 * culled) — so it must EARN a forward record here before a cent of live capital.
 *
 * Promotion gate (unchanged): a strategy forward-tests on paper here
 * (track='lab' / 'lab-maker', isolated) and needs ≥15–20 net-positive paper
 * trades matching its backtest before any promotion to the live book.
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
/** Taker round-trip commission for the MARKET lab book (custom-runner places
 *  market orders). HL taker ≈ 0.07% RT — the lab is HL-oriented, so it nets at
 *  HL fees, NOT the Bybit 0.11% the live copytrading product pays. */
export const LAB_COMMISSION_RT_PCT = 0.07;
const LAB_LAUNCH = Date.parse('2026-07-06T00:00:00Z'); // re-launch date (forward clock restarts)

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
  // ── PRIMARY EDGE, new coin (HL re-sweep, Jun 15). boll-MR-4h re-verified at
  // HL fees: ROBUST 7/10 coins. The cross-symbol walk-forward KILLED the
  // single-window SOL (one fold −53%, DD 79%) and LTC (only 2/4 folds) that
  // the sweep flagged green — BTC is the one clean new survivor: 3/4 folds,
  // +33% net, DD 14.6%, balanced IS/OOS. Fee-negligible at 4h → market runner.
  // SL 6% provisional (BTC least volatile major) — pending MAE-audit before promo.
  lab(bollMr('BTCUSDT', '240', 20, 2, 200, 0.06), 'L10', 'BTC Bollinger-MR 4h',
    'Та же конфигурация Боллинджер-MR(20,2)+EMA200 на BTC 4h. Добавлена после HL-пересвипа: семейство переподтвердилось на 7/10 монет, BTC — чистый новый выживший (3/4 walk-forward фолда, +33% нетто, просадка 14.6%, баланс IS/OOS). На 4h комиссия почти не влияет → market-раннер. SL 6% предварительный (BTC наименее волатилен из мейджоров), требует MAE-аудита перед промоушеном.'),
];

// ── MAKER book. The 5m MR book (former M01–M08, Keltner/z-score @5m) was CULLED
// (Jun 16): it backtested 8/10 coins but FORWARD-PAPER it bled (~67 closed — SOL
// 1/9 WR −10%, ADA −7, XRP −6.3, broadly net-negative). The bar-touch fill model
// overstated 5m maker fills; the edge didn't materialize live. Kept the 1h maker
// below (slower → far less fill-fragile). track='lab-maker', net of maker commission.
export const MAKER_LAB_STRATEGIES: LabStrategy[] = [
  // ── 1h MAKER MR — the HL re-sweep's best NEW edge (Jun 15). Keltner /
  // z-score reversion as M01-M08 but on 1h, not 5m — far more practical (fewer
  // trades, less noise, much less fill-model risk than 5m). Cross-symbol
  // walk-forward at HL maker: Keltner-1h ROBUST 5/10, z-score-1h 4/10. Only the
  // clean survivors below (≥3/4 folds + net+ at ×2 fee). Net+ even at HL TAKER
  // 0.07% (N~50 over 500d → fee drag ≪ net), so the edge isn't maker-fragile —
  // maker book just nets at the matching 0.04%. NOTE: these are a THIRD
  // correlated cluster (intraday alt MR); LTC now appears 4× across M02/M06/
  // M11/M12 — heavy concentration. At promotion they share the MR cluster cap.
  labMaker(keltnerMr('DOGEUSDT', '60', 20, 10, 2, 200, 0.08), 'M09', 'DOGE Keltner-MR 1h (maker)',
    'Keltner-MR(EMA20±2·ATR10)+EMA200 на DOGE 1h, лимитками, выход у средней. Лучший выживший HL-пересвипа: 4/4 walk-forward фолда (худший +6.5%), +46% нетто, просадка 10.5%, WR 72%, держит ×3 издержки.'),
  labMaker(keltnerMr('XRPUSDT', '60', 20, 10, 2, 200, 0.08), 'M10', 'XRP Keltner-MR 1h (maker)',
    'Keltner-MR на XRP 1h — 3/4 фолда, +19% нетто, просадка всего 10.3%.'),
  labMaker(keltnerMr('LTCUSDT', '60', 20, 10, 2, 200, 0.08), 'M11', 'LTC Keltner-MR 1h (maker)',
    'Keltner-MR на LTC 1h — 4/4 фолда (худший +0.5%), +37% нетто, просадка 10.8%, WR 74%, PF 2.46.'),
  labMaker(zscoreMr('LTCUSDT', '60', 50, 2, 200, 0.08), 'M12', 'LTC Z-score-MR 1h (maker)',
    'Возврат к средней z-score(50)±2σ+EMA200 на LTC 1h, лимитками. Лучший единичный конфиг всего пересвипа: +47% нетто, просадка всего 6.5%, 3/4 фолда. Держит ×3 издержки.'),
  labMaker(zscoreMr('ETHUSDT', '60', 50, 2, 200, 0.08), 'M13', 'ETH Z-score-MR 1h (maker)',
    'Z-score-MR на ETH 1h — 3/4 фолда, +19% нетто, просадка 9.6%, WR 77%.'),
  labMaker(zscoreMr('SOLUSDT', '60', 50, 2, 200, 0.08), 'M14', 'SOL Z-score-MR 1h (maker)',
    'Z-score-MR на SOL 1h — 3/4 фолда, +31% нетто, просадка 12%.'),
];

/** Backtest reference: net %/trade per strategy (from the sweeps/audits).
 *  The forward-gate (lib/lab-gate.ts) compares live paper expectancy to this
 *  to flag a decaying edge. Approximate — a yardstick, not a contract. */
export const BT_NET_PCT_PER_TRADE: Record<string, number> = {
  L01: 1.95, L02: 1.54, L03: 0.23, L04: 0.65, L05: 1.18, L06: 0.94, L07: 2.65, L08: 4.86, L09: 0.71, L10: 0.56,
  M09: 0.80, M10: 0.35, M11: 0.85, M12: 1.63, M13: 0.44, M14: 0.66,
};

/** Backtest max-drawdown % per strategy — the risk measure for risk-parity
 *  sizing (lower DD → more capital). Reference numbers from the audits/sweeps. */
export const BT_MAXDD_PCT: Record<string, number> = {
  L01: 14, L02: 15, L03: 16, L04: 5, L05: 16, L06: 17, L07: 46, L08: 22, L09: 37, L10: 15,
  M09: 11, M10: 10, M11: 11, M12: 7, M13: 10, M14: 12,
};

export const ALL_LAB_STRATEGIES: LabStrategy[] = [...LAB_STRATEGIES, ...MAKER_LAB_STRATEGIES];
export const LAB_BY_CODE = new Map(ALL_LAB_STRATEGIES.map((s) => [s.code, s]));
export const LAB_BY_ID = new Map(ALL_LAB_STRATEGIES.map((s) => [s.id, s]));
