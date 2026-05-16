/**
 * Templates for trade-result posts (TP hit, SL hit, strategy exit, time-guard).
 *
 * Track C only. Track A/B were removed in May 2026 — historical rows
 * may still exist in the DB but they're never closed by the live system
 * anymore, so this template renders only the Track C / strategy variant
 * (% + USD on $1000 notional, exit-reason-specific tail line).
 */
import type { CloseReason } from '../db/repos/decisions.js';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESC[c] ?? c);
}

const SIDE_RU: Record<string, string> = { long: 'ЛОНГ', short: 'ШОРТ' };
const SIDE_EMOJI: Record<string, string> = { long: '🟢', short: '🔴' };

/**
 * Track C motivational tail. Always randomised so the channel feels
 * alive — subscribers see a different uplifting phrase every close.
 * Each note explicitly references the $1000 notional so newcomers
 * understand the math being shown.
 */
type NoteBuilder = (usdAbs: string, notional: number) => string;

const TRACK_C_WIN_NOTES: NoteBuilder[] = [
  (usd, n) => `Edge сработал. На каждые $${n} в позиции — плюс $${usd}. Идём дальше! 🚀`,
  (usd, n) => `Дисциплина приносит плоды. +$${usd} на $${n} ставку — в копилку! 💪`,
  (usd, n) => `Стратегия отработала чисто. +$${usd} с каждой $${n}-позиции. Так строится система. 🎯`,
  (usd, n) => `Patience paid off. +$${usd} на наши $${n} капитала. Маленькие победы → большая дистанция.`,
  (usd, n) => `Win rate × R = profit. +$${usd} на $${n} позицию — формула работает. ⚡`,
  (usd, n) => `Capital в работе → +$${usd} на $${n}. Каждая такая сделка приближает цель. 📈`,
  (usd, n) => `Setup отработал. Плюс $${usd} на $${n}-позицию. Холодная голова + риск-менеджмент. 🧊`,
  (usd, n) => `Заработано $${usd} на каждые $${n} ставки. Это и есть смысл системного подхода. ✨`,
];

/**
 * Loss notes split by HOW the position closed:
 *
 *   - Safety SL fired (`closeReason='sl_hit'`):
 *     The strategy DIDN'T exit on its own — our 2.5% safety net caught
 *     the move. Wording emphasises "risk management", "stop fire saved
 *     us", "could have been worse".
 *
 *   - Strategy decided to exit at a loss (`forceReason='strategy_exit'`
 *     or `reverse_signal`):
 *     The strategy's own logic detected something wrong and bailed
 *     BEFORE hitting SL. Wording emphasises "edge worked",
 *     "стратегия сама вышла", "spotted invalidation early".
 *
 *   - Other (rare — manual close, time_guard, etc.):
 *     Generic discipline language.
 */
const TRACK_C_LOSS_SL_NOTES: NoteBuilder[] = [
  (usd, n) => `Safety SL отработал — отрезали убыток на 2.5%. −$${usd} с $${n} вместо большего. Капитал цел. 🛡`,
  (usd, n) => `Стратегия не успела сама выйти, сработал safety SL: −$${usd} на $${n}. Это и есть смысл стоп-лосса. ⏭`,
  (usd, n) => `−$${usd} с $${n} — крайний сценарий, для которого мы и держим SL. Идём дальше дисциплинированно. 💪`,
  (usd, n) => `SL сработал на −2.5% позиции $${n} (−$${usd}). Setup не подтвердился, ножом отрезали. Так и зарабатывают долгосрочно.`,
];

const TRACK_C_LOSS_STRAT_NOTES: NoteBuilder[] = [
  (usd, n) => `Стратегия сама вышла с минимальным минусом: −$${usd} с $${n}. Logic spotted что setup перестал работать, не дала просадке разрастись. 🎯`,
  (usd, n) => `Builtin Exit в минус: −$${usd} на $${n}. Edge подсказал — выйти. Лучше малый минус сейчас, чем большой потом. ⚡`,
  (usd, n) => `Стратегия закрылась раньше SL: −$${usd} с $${n}. Это **дисциплинированный** выход, не паника. Risk control работает. 💪`,
  (usd, n) => `−$${usd} на $${n} — стратегия увидела разворот условий и вышла сама. Profit factor 3.0 не из воздуха берётся. 🧊`,
  (usd, n) => `Контролируемый минус: −$${usd} с $${n}-позиции. Strategy logic решила что setup invalidated — закрылись досрочно. Капитал в работе дальше.`,
];

const TRACK_C_LOSS_OTHER_NOTES: NoteBuilder[] = [
  (usd, n) => `Минус контролируемый: −$${usd} на $${n}-позицию. Часть бизнеса — едем дальше с холодной головой. ⏭`,
  (usd, n) => `−$${usd} с $${n} — нормальная цена за edge. В долгосрочной winrate × R даёт plus. ⚡`,
];

function pickStrategyNote(
  usdAbs: number,
  notional: number,
  isWin: boolean,
  closeReason: CloseReason,
  forceReason: string | null | undefined,
): string {
  let bank: NoteBuilder[];
  if (isWin) {
    bank = TRACK_C_WIN_NOTES;
  } else if (closeReason === 'sl_hit') {
    bank = TRACK_C_LOSS_SL_NOTES;
  } else if (forceReason === 'strategy_exit' || forceReason === 'reverse_signal') {
    bank = TRACK_C_LOSS_STRAT_NOTES;
  } else {
    bank = TRACK_C_LOSS_OTHER_NOTES;
  }
  const fn = bank[Math.floor(Math.random() * bank.length)]!;
  return fn(usdAbs.toFixed(2), notional);
}

function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}д ${h}ч ${m}м`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

export type ResultPostInput = {
  parentTradeId: number;
  symbol: string;
  side: 'long' | 'short';
  entry: number;
  sl: number;
  tp: number | null;
  closePrice: number;
  closeReason: CloseReason;
  pnlPct: number;
  pnlR: number;
  durationMs: number;
  /** Track marker. For Track C ('strategy') the post uses the T#NNN
   *  prefix from strategyTradeNum. Other values exist only on historical
   *  rows and render with a fallback '#NNNN' id. */
  track?: string;
  /** Notional USD per trade. Track C uses TRACK_C_NOTIONAL_USD = 1000. */
  notionalUsd?: number;
  /** Force-close reason — one of:
   *  'strategy_exit' | 'reverse_signal' | 'time_guard' | null. */
  forceCloseReason?: string | null;
  /** STRAT-XXX code badge in header for context. */
  strategyCode?: string | null;
  /** Short human name (e.g. "BNB Contrarian") rendered alongside STRAT code. */
  strategyName?: string | null;
  /** Per-strategy sequential trade counter (1, 2, 3, ...).
   *  Used for the T#001 prefix instead of the global decision.id. */
  strategyTradeNum?: number | null;
  /** Landing-page URL for the "see details" link at the bottom. */
  landingUrl?: string | null;
};

/** Build the result post (≤1024 chars, HTML, ready for sendPhoto caption).
 *  Renders Track C layout when `track === 'strategy'`; otherwise falls
 *  back to a minimal historical layout (only used if legacy rows are
 *  re-closed somehow — shouldn't happen in normal Track C operation). */
export function resultPost(i: ResultPostInput): string {
  const isStrategy = i.track === 'strategy';
  const tradeNumForId =
    isStrategy && typeof i.strategyTradeNum === 'number'
      ? i.strategyTradeNum
      : i.parentTradeId;
  const padDigits = isStrategy ? 3 : 4;
  const prefix = isStrategy ? 'T#' : '#';
  const tradeId = `${prefix}${tradeNumForId.toString().padStart(padDigits, '0')}`;
  const sideE = SIDE_EMOJI[i.side] ?? '';
  const sideRu = SIDE_RU[i.side] ?? i.side;
  const isWin = i.pnlPct > 0;

  const usdPnl =
    typeof i.notionalUsd === 'number'
      ? (i.pnlPct / 100) * i.notionalUsd
      : null;
  const usdStr =
    usdPnl !== null
      ? `${usdPnl >= 0 ? '+' : '−'}$${Math.abs(usdPnl).toFixed(2)}`
      : '';

  // ---------- Header ----------
  let header: string;
  let exitTag = '';

  if (isStrategy) {
    if (isWin) {
      const winEmoji =
        Math.abs(i.pnlPct) >= 3 ? '🚀' :
        Math.abs(i.pnlPct) >= 1.5 ? '💰' : '✅';
      header = `${winEmoji} <b>ПРОФИТ ${usdStr || `+${i.pnlPct.toFixed(2)}%`}</b>`;
    } else {
      // 🛡 — safety SL fired (worst case caught by the net)
      // 🎯 — strategy itself exited at a small loss (disciplined Builtin Exit)
      // 🔁 — reverse-signal flip
      // 🔻 — any other loss path (manual / time_guard / etc.)
      const lossEmoji =
        i.closeReason === 'sl_hit' ? '🛡' :
        i.forceCloseReason === 'strategy_exit' ? '🎯' :
        i.forceCloseReason === 'reverse_signal' ? '🔁' : '🔻';
      header = `${lossEmoji} <b>Убыток ${usdStr || i.pnlPct.toFixed(2) + '%'}</b>`;
    }
    if (i.closeReason === 'sl_hit') exitTag = ' (safety SL)';
    else if (i.forceCloseReason === 'strategy_exit') exitTag = ' (сигнал стратегии)';
    else if (i.forceCloseReason === 'reverse_signal') exitTag = ' (разворот сигнала)';
  } else {
    header = `🏁 <b>Закрытие</b> · сделка ${tradeId}`;
  }

  // ---------- Tail line ----------
  let tail = '';
  if (isStrategy && typeof i.notionalUsd === 'number' && usdPnl !== null) {
    tail = pickStrategyNote(
      Math.abs(usdPnl),
      i.notionalUsd,
      isWin,
      i.closeReason,
      i.forceCloseReason,
    );
  }

  const pnlSign = i.pnlPct >= 0 ? '+' : '';
  const pnlPct = `${pnlSign}${i.pnlPct.toFixed(2)}%`;
  const resultLine = usdStr
    ? `📊 Результат: <b>${pnlPct}</b>  ·  <b>${usdStr}</b>`
    : `📊 Результат: <b>${pnlPct}</b>`;

  let lines: string[];
  if (isStrategy) {
    const nameLine = i.strategyName
      ? `🤖 <b>STRAT-${escapeHtml(i.strategyCode ?? '???')}</b> · ${escapeHtml(i.strategyName)}`
      : `🤖 <b>STRAT-${escapeHtml(i.strategyCode ?? '???')}</b>`;
    const linkLine = i.landingUrl
      ? `📊 <a href="${i.landingUrl}">Детали и live статистика</a>`
      : '';
    lines = [
      `${header}  ${sideE} <b>${escapeHtml(i.symbol)}</b> ${sideRu}`,
      ``,
      nameLine,
      `🆔 <b>${tradeId}</b>`,
      ``,
      `📥 Вход:   <code>${i.entry}</code>`,
      `📤 Выход:  <code>${i.closePrice}</code>${exitTag}`,
      resultLine,
      `⏱ Длительность: ${formatDuration(i.durationMs)}`,
      ``,
      linkLine,
      linkLine ? `` : '',
      `<i>${escapeHtml(tail)}</i>`,
    ];
  } else {
    lines = [
      `${header}`,
      '',
      `${sideE} <b>${escapeHtml(i.symbol)}</b> ${sideRu}`,
      '',
      `📥 Вход:   <code>${i.entry}</code>`,
      `📤 Выход:  <code>${i.closePrice}</code>${exitTag}`,
      resultLine,
      `⏱ Длительность: ${formatDuration(i.durationMs)}`,
    ];
  }

  return lines.join('\n').slice(0, 1024);
}
