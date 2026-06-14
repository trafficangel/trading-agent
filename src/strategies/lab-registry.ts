/**
 * THE LAB — strategy registry (pure data, NO web/db deps).
 *
 * Split out of lab.ts so the backtest script and the live runner can import
 * the strategy list without pulling in the page/route layer (landing.ts →
 * fastify/db). lab.ts re-exports these for the page.
 *
 * Each entry is a CustomStrategy (pure decide()) + the launch stamp. The
 * runner reads `decide`; the page reads the rest. They forward-test on a
 * paper account, fully isolated on track='lab' (see lab.ts / custom-runner).
 */

import { rsiMeanRev } from '../backtest/strategies/rsi-meanrev.js';
import { smaTrend } from '../backtest/strategies/sma-trend.js';
import { donchianTrend } from '../backtest/strategies/donchian-trend.js';
import type { CustomStrategy } from '../backtest/strategy.js';

export type LabStrategy = CustomStrategy & {
  /** Unix ms when this entered the lab. */
  launchedAt: number;
  /** Longer prose for the detail page. Optional. */
  longDescription?: string;
};

/** The lab track value — one source of truth for runner, stats reads, page. */
export const LAB_TRACK = 'lab';

// Provisional safety SL for brand-new candidates. Mean-rev: 5% (standard
// cap). Trend/breakout: looser — the exit IS the signal, a tight stop just
// whipsaws the trend out. All tuned per-strategy from the engine's native
// MAE once the VPS backtest (scripts/backtest-custom.ts) has run.
const PROVISIONAL_SL = 0.05;
// Lab opened (paper trading from this date). Fixed so it doesn't drift on
// restart; the per-strategy note prefers the real first-trade time anyway.
const LAB_LAUNCH = Date.parse('2026-06-14T00:00:00Z');

export const LAB_STRATEGIES: LabStrategy[] = [
  // ── MEAN-REVERSION family — RSI(14) + EMA200 trend filter (only fade WITH
  // the higher-TF trend; the June lesson). Same family as the live book, so
  // not a diversifier — value is independence + an engine baseline.
  {
    ...rsiMeanRev({ id: 'lab-ada-rsi-trend', code: 'L01', symbol: 'ADAUSDT', timeframe: '15', period: 14, trendEma: 200, slPct: PROVISIONAL_SL }),
    launchedAt: LAB_LAUNCH,
    longDescription: 'Фейдим перепроданность/перекупленность RSI(14), но только в сторону тренда EMA200 на 15m. Урок июня: контр-лонги умирают в даунтренде — поэтому вход гейтится режимом. Кандидат на форвард-тесте.',
  },
  {
    ...rsiMeanRev({ id: 'lab-ltc-rsi-trend', code: 'L02', symbol: 'LTCUSDT', timeframe: '15', period: 14, trendEma: 200, slPct: PROVISIONAL_SL }),
    launchedAt: LAB_LAUNCH,
    longDescription: 'Та же логика RSI+EMA200, монета LTC. Параллельный форвард-тест для проверки независимости края от конкретного актива.',
  },
  {
    ...rsiMeanRev({ id: 'lab-link-rsi-trend', code: 'L03', symbol: 'LINKUSDT', timeframe: '15', period: 14, trendEma: 200, slPct: PROVISIONAL_SL }),
    launchedAt: LAB_LAUNCH,
    longDescription: 'Та же логика RSI+EMA200, монета LINK.',
  },
  // ── TREND family — the only edge that survived CRYPTO-TREND Phase 0
  // (real, robust, beats buy-hold by Sharpe; durable value = drawdown cut).
  // Structurally UNcorrelated with the contrarian book above — it rides the
  // trend that kills the faders. Forward-tested on the research assets
  // (BTC/ETH) on 4h. Long-only; exit = SMA cross; SL = loose catastrophe net.
  {
    ...smaTrend({ id: 'lab-btc-sma-trend', code: 'L04', symbol: 'BTCUSDT', timeframe: '240', period: 100 }),
    launchedAt: LAB_LAUNCH,
    longDescription: 'Порт доказанного края CRYPTO-TREND: лонг, пока цена выше SMA(100) на 4h, иначе в кэш. Трендследование — единственный край, прошедший адверсариальную проверку в Фазе 0 (бьёт buy-hold по Sharpe, режет просадку). Здесь — форвард-тест на BTC, активе исследования.',
  },
  {
    ...smaTrend({ id: 'lab-eth-sma-trend', code: 'L05', symbol: 'ETHUSDT', timeframe: '240', period: 100 }),
    launchedAt: LAB_LAUNCH,
    longDescription: 'Тот же трендовый край на ETH (4h). В OOS-тесте Фазы 0 ETH держался лучше BTC (Sharpe 0.70 vs 0.47) — проверяем, переносится ли это на форвард.',
  },
  // ── BREAKOUT family — Donchian/Turtle channel breakout (always-in flip).
  // A second uncorrelated trend mechanism, distinct from the SMA filter.
  {
    ...donchianTrend({ id: 'lab-link-donchian', code: 'L06', symbol: 'LINKUSDT', timeframe: '240', period: 20, slPct: 0.10 }),
    launchedAt: LAB_LAUNCH,
    longDescription: 'Пробой канала Дончиана(20) на 4h: лонг на пробое максимума прошлых 20 баров, шорт на пробое минимума. Классический трендовый брейкаут — второй некоррелированный механизм для портфеля краёв.',
  },
];

export const LAB_BY_CODE = new Map(LAB_STRATEGIES.map((s) => [s.code, s]));
export const LAB_BY_ID = new Map(LAB_STRATEGIES.map((s) => [s.id, s]));
