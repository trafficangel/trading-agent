/**
 * Templates for trade-result posts (TP hit, SL hit, LLM-driven close).
 * Different from the regular OPEN/MODIFY caption — these summarise the OUTCOME
 * with actual fill price, PnL, duration, and a short morale note.
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
  /** A/B track marker — controls trade-id prefix in the post.
   *  'signal' → 'S#XXXX', anything else (or undefined) → '#XXXX'. */
  track?: string;
};

/** Build the result post (≤1024 chars, HTML, ready for sendPhoto caption). */
export function resultPost(i: ResultPostInput): string {
  // Track-aware trade-id prefix:
  //   'signal'   (Track B) → 'S#XXXX'
  //   'strategy' (Track C) → 'T#XXXX'
  //   else (Track A / legacy) → '#XXXX'
  const prefix =
    i.track === 'strategy' ? 'T#' : i.track === 'signal' ? 'S#' : '#';
  const tradeId = `${prefix}${i.parentTradeId.toString().padStart(4, '0')}`;
  const sideE = SIDE_EMOJI[i.side] ?? '';
  const sideRu = SIDE_RU[i.side] ?? i.side;
  const isWin = i.pnlPct > 0;

  let header: string;
  let note: string;
  let exitTag = '';

  if (i.closeReason === 'tp_hit') {
    header = `🎉 <b>ЦЕЛЬ ВЗЯТА</b> · сделка ${tradeId}`;
    note = pickRandom(TP_HIT_NOTES);
    exitTag = ' (TP)';
  } else if (i.closeReason === 'sl_hit') {
    header = `🛑 <b>СТОП</b> · сделка ${tradeId}`;
    note = pickRandom(SL_HIT_NOTES);
    exitTag = ' (SL)';
  } else if (i.closeReason === 'llm_close') {
    header = `🏁 <b>Досрочное закрытие</b> · сделка ${tradeId}`;
    note = pickRandom(isWin ? LLM_CLOSE_WIN_NOTES : LLM_CLOSE_LOSS_NOTES);
    exitTag = ' (структурно)';
  } else {
    header = `🏁 <b>Закрытие</b> · сделка ${tradeId}`;
    note = isWin ? pickRandom(LLM_CLOSE_WIN_NOTES) : pickRandom(LLM_CLOSE_LOSS_NOTES);
  }

  // pnlR kept in the ResultPostInput type but NOT displayed in the user-
  // facing message — operator preference (R-multiple is noisy for a non-
  // quant reader, % already conveys the result). Still persisted to DB
  // and used internally by self-review LLM prompts.
  const pnlSign = i.pnlPct >= 0 ? '+' : '';
  const pnlStr = `${pnlSign}${i.pnlPct.toFixed(2)}%`;

  const lines: string[] = [
    header,
    '',
    `${sideE} <b>${escapeHtml(i.symbol)}</b> ${sideRu}`,
    '',
    `📥 Вход:   <code>${i.entry}</code>`,
    `📤 Выход:  <code>${i.closePrice}</code>${exitTag}`,
    `📊 Результат: <b>${pnlStr}</b>`,
    `⏱ Длительность: ${formatDuration(i.durationMs)}`,
    '',
    escapeHtml(note),
  ];

  return lines.join('\n').slice(0, 1024);
}
