/**
 * Templates for trade-result posts (TP hit, SL hit, strategy exit, time-guard,
 * LLM-driven close). Different from the regular OPEN/MODIFY caption — these
 * summarise the OUTCOME with actual fill price, PnL %, USD PnL (when notional
 * known), duration, and an exit-reason-specific tail line.
 *
 * Two flavours:
 *   - Track A/B (signal & LLM tracks): % only, randomised morale note
 *   - Track C (strategy): % + USD on $1000 notional, exit-reason-specific
 *     tail line (NOT randomised — subscribers want consistent context).
 */
import type { CloseReason } from '../db/repos/decisions.js';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESC[c] ?? c);
}

const SIDE_RU: Record<string, string> = { long: 'ЛОНГ', short: 'ШОРТ' };
const SIDE_EMOJI: Record<string, string> = { long: '🟢', short: '🔴' };

const TP_HIT_NOTES: string[] = [
  'Дисциплина окупается. План отработан, плановое закрытие. 💪',
  'Сетап отработал чисто. Терпение → результат. 🎯',
  'Структурный анализ + момент входа = плюс. Идём дальше с холодной головой.',
  '+1 в копилку. Не зацикливаемся, ищем следующий setup. ⚡',
  'TP взят. Это и есть смысл — рисковать малым ради большего.',
  'Ровно по плану. Так и зарабатывают: 50%+ winrate × R≥1.5.',
];

const SL_HIT_NOTES: string[] = [
  'Риск был контролируемым. Стоп уберёг от большего убытка — план сработал. ⏭',
  'Стоп. Минус в плане. Идея не подтвердилась — рынок не обязан.',
  'Часть бизнеса. Главное — соблюдён risk management. Капитал цел.',
  '−1R, и это норма. Профит = winrate × avg R, а не победами подряд.',
  'Не угадали. Без страха идём в следующий setup. ⚡',
  'Сигнал не сработал — нормально, у LuxAlgo есть и ошибочные. Следующий.',
];

const LLM_CLOSE_WIN_NOTES: string[] = [
  'Закрытие до TP — структура изменилась, фиксируем плюс пока есть.',
  'Контекст подсказал выйти заранее. Лучше синица в руках.',
  'Не жадничаем — выходим в плюсе пока сетап ещё держится.',
];

const LLM_CLOSE_LOSS_NOTES: string[] = [
  'Закрытие до SL — структура слома, риск растёт. Сохраняем капитал.',
  'Сетап перестал работать. Выходим с малым убытком — это лучше большого.',
  'Дисциплина: лучше уйти на −0.5R чем досидеть до −1R.',
];

/**
 * Track C motivational tail. Always randomised so the channel feels
 * alive — subscribers see a different uplifting phrase every close.
 * Each note explicitly references the $1000 notional so newcomers
 * understand the math being shown.
 *
 * Functions accept the USD pnl (already-signed) so they can interpolate
 * the actual number.
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

const TRACK_C_LOSS_NOTES: NoteBuilder[] = [
  (usd, n) => `Минус контролируемый: −$${usd} на $${n}-позицию. Risk management отработал — главное капитал цел. ⏭`,
  (usd, n) => `−$${usd} с $${n} ставки — часть бизнеса. Profit = winrate × avg R, не победами подряд.`,
  (usd, n) => `Setup не подтвердился. −$${usd} на $${n} — это цена за разведку, дешевле чем большой убыток.`,
  (usd, n) => `Без страха идём дальше. −$${usd} с $${n} — норма в системе. Дисциплина → долгий профит. 💪`,
  (usd, n) => `Не угадали. Risk был под контролем: −$${usd} на $${n}-позицию. Следующий сетап впереди. ⚡`,
  (usd, n) => `−$${usd} с $${n} — нормальная цена за edge. В долгосрочной winrate × R даёт plus. Едем дальше.`,
];

function pickStrategyNote(usdAbs: number, notional: number, isWin: boolean): string {
  const bank = isWin ? TRACK_C_WIN_NOTES : TRACK_C_LOSS_NOTES;
  const fn = bank[Math.floor(Math.random() * bank.length)]!;
  return fn(usdAbs.toFixed(2), notional);
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
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
  /** Track marker — controls trade-id prefix:
   *   'strategy' (Track C) → 'T#XXXX'
   *   'signal'   (Track B) → 'S#XXXX'
   *   else (Track A / legacy) → '#XXXX'
   */
  track?: string;
  /** Notional USD per trade. When set, the post adds a USD P&L line
   *  (e.g. "+$17.90"). Track C uses TRACK_C_NOTIONAL_USD = 1000. */
  notionalUsd?: number;
  /** Force-close reason from decisions table — used for Track C to
   *  pick the right tail line. One of:
   *  'strategy_exit' | 'time_guard' | 'counter_exit' | null. */
  forceCloseReason?: string | null;
  /** Track C — show "[STRAT-001]" badge in header for context. */
  strategyCode?: string | null;
};

/** Build the result post (≤1024 chars, HTML, ready for sendPhoto caption). */
export function resultPost(i: ResultPostInput): string {
  const prefix =
    i.track === 'strategy' ? 'T#' : i.track === 'signal' ? 'S#' : '#';
  const tradeId = `${prefix}${i.parentTradeId.toString().padStart(4, '0')}`;
  const sideE = SIDE_EMOJI[i.side] ?? '';
  const sideRu = SIDE_RU[i.side] ?? i.side;
  const isWin = i.pnlPct > 0;
  const isStrategy = i.track === 'strategy';
  const stratBadge = i.strategyCode ? `<b>[STRAT-${escapeHtml(i.strategyCode)}]</b>  ` : '';

  // Compute USD P&L when notional known. Format as "+$X.XX" / "-$X.XX"
  // (sign BEFORE the dollar symbol, never "$-X.XX").
  const usdPnl =
    typeof i.notionalUsd === 'number'
      ? (i.pnlPct / 100) * i.notionalUsd
      : null;
  const usdStr =
    usdPnl !== null
      ? `${usdPnl >= 0 ? '+' : '−'}$${Math.abs(usdPnl).toFixed(2)}`
      : '';

  // ---------- Header ----------
  // Wins get the EXPRESSIVE treatment — big emoji, USD front-and-centre.
  // Losses stay calm and informative — no doom-and-gloom drama.
  let header: string;
  let exitTag = '';

  if (isStrategy) {
    // Track C — strategy header
    if (isWin) {
      const winEmoji =
        Math.abs(i.pnlPct) >= 3 ? '🚀' :
        Math.abs(i.pnlPct) >= 1.5 ? '💰' : '✅';
      header = usdStr
        ? `${winEmoji} <b>ПРОФИТ ${usdStr}</b>  ·  ${tradeId}`
        : `${winEmoji} <b>ПРОФИТ +${i.pnlPct.toFixed(2)}%</b>  ·  ${tradeId}`;
    } else {
      const lossEmoji = i.closeReason === 'sl_hit' ? '🛡' : '🔻';
      header = usdStr
        ? `${lossEmoji} <b>Убыток ${usdStr}</b>  ·  ${tradeId}`
        : `${lossEmoji} <b>Убыток ${i.pnlPct.toFixed(2)}%</b>  ·  ${tradeId}`;
    }
    // Exit-reason tag on the "Выход" line. time_guard is intentionally
    // NOT tagged for Track C — those force-closes shouldn't even
    // happen here (guard disabled for strategies), and if they do
    // we don't want subscribers to see "(24h time-out)" wording.
    if (i.closeReason === 'sl_hit') exitTag = ' (safety SL)';
    else if (i.forceCloseReason === 'strategy_exit') exitTag = ' (сигнал стратегии)';
  } else {
    // Track A/B — legacy headers
    if (i.closeReason === 'tp_hit') {
      header = `🎉 <b>ЦЕЛЬ ВЗЯТА</b> · сделка ${tradeId}`;
      exitTag = ' (TP)';
    } else if (i.closeReason === 'sl_hit') {
      header = `🛑 <b>СТОП</b> · сделка ${tradeId}`;
      exitTag = ' (SL)';
    } else if (i.closeReason === 'llm_close') {
      header = `🏁 <b>Досрочное закрытие</b> · сделка ${tradeId}`;
      exitTag = ' (структурно)';
    } else {
      header = `🏁 <b>Закрытие</b> · сделка ${tradeId}`;
    }
  }

  // ---------- Tail line ----------
  // Track C: motivational note that mentions $1000 notional explicitly.
  // Track A/B: legacy randomised banks by close reason.
  let tail: string;
  if (isStrategy && typeof i.notionalUsd === 'number' && usdPnl !== null) {
    tail = pickStrategyNote(Math.abs(usdPnl), i.notionalUsd, isWin);
  } else if (i.closeReason === 'tp_hit') {
    tail = pickRandom(TP_HIT_NOTES);
  } else if (i.closeReason === 'sl_hit') {
    tail = pickRandom(SL_HIT_NOTES);
  } else {
    tail = pickRandom(isWin ? LLM_CLOSE_WIN_NOTES : LLM_CLOSE_LOSS_NOTES);
  }

  // ---------- P&L line ----------
  // Strategy: "+1.79%  ·  +$17.90"
  // Legacy:   "+1.79%"
  const pnlSign = i.pnlPct >= 0 ? '+' : '';
  const pnlPct = `${pnlSign}${i.pnlPct.toFixed(2)}%`;
  const resultLine = usdStr
    ? `📊 Результат: <b>${pnlPct}</b>  ·  <b>${usdStr}</b>`
    : `📊 Результат: <b>${pnlPct}</b>`;

  // ---------- Compose ----------
  const lines: string[] = [
    `${header}  ${stratBadge}${sideE} <b>${escapeHtml(i.symbol)}</b> ${sideRu}`,
    '',
    `📥 Вход:   <code>${i.entry}</code>`,
    `📤 Выход:  <code>${i.closePrice}</code>${exitTag}`,
    resultLine,
    `⏱ Длительность: ${formatDuration(i.durationMs)}`,
    '',
    escapeHtml(tail),
  ];

  return lines.join('\n').slice(0, 1024);
}
