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
 * Track C exit-reason tail line. Context-specific (NOT randomised) so
 * subscribers learn what each exit kind means and trust the system.
 */
function strategyExitTail(
  forceReason: string | null | undefined,
  closeReason: CloseReason,
  isWin: boolean,
): string {
  // Safety SL hit (closeReason='sl_hit')
  if (closeReason === 'sl_hit') {
    return isWin
      ? '🛡 Safety SL зафиксировал прибыль раньше выхода стратегии.'
      : '🛡 Сработал safety SL — стратегия задержалась с выходом, мы отрезали убыток на 2.5%.';
  }
  // Strategy's own exit signal arrived (Builtin Exits)
  if (forceReason === 'strategy_exit') {
    return isWin
      ? '✅ Выход по сигналу стратегии — Builtin Exits сработали в плюсе как и задумано.'
      : '✅ Выход по сигналу стратегии — Builtin Exits сработали по своей логике.';
  }
  // Time-guard 24h
  if (forceReason === 'time_guard') {
    return isWin
      ? '⏰ Сработал 24h time-guard: стратегия не выдала выходной сигнал за сутки. Закрыли в плюс автоматически.'
      : '⏰ Сработал 24h time-guard: стратегия не выдала выходной сигнал за сутки. Закрыли по таймауту.';
  }
  // Fallback for any other manual close
  return isWin
    ? 'Сделка закрыта в плюсе.'
    : 'Сделка закрыта с убытком.';
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
    // Tag for "(time-out)" / "(stop)" / "(signal)"
    if (i.closeReason === 'sl_hit') exitTag = ' (safety SL)';
    else if (i.forceCloseReason === 'strategy_exit') exitTag = ' (сигнал стратегии)';
    else if (i.forceCloseReason === 'time_guard') exitTag = ' (24h time-out)';
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
  let tail: string;
  if (isStrategy) {
    tail = strategyExitTail(i.forceCloseReason, i.closeReason, isWin);
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
