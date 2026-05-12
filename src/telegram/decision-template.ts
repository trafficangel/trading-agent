import type { Decision } from '../llm/decision.schema.js';
import type { AggregatedScore } from '../signals/aggregator.js';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESC[c] ?? c);
}

const SIDE_RU: Record<string, string> = { long: 'ЛОНГ', short: 'ШОРТ' };
const SIDE_EMOJI: Record<string, string> = { long: '🟢', short: '🔴' };
const DECISION_RU: Record<string, string> = {
  OPEN: '📈 Открытие сделки',
  CLOSE: '🏁 Закрытие сделки',
  MODIFY: '🔧 Изменение сделки',
  SKIP: '⏸ Пропуск',
};

function tfLabel(tf: string): string {
  if (tf === '60') return '1H';
  if (tf === '240') return '4H';
  if (tf === 'D') return '1D';
  return `${tf}m`;
}

function pctDistance(a: number, b: number): number {
  return Math.round((Math.abs(a - b) / a) * 10000) / 100;
}

/**
 * Telegram caption for a freshly-PLACED limit order (not yet filled).
 *
 * Deliberately has NO trade number — until the limit actually fills it
 * isn't a trade. The first sequential number a user sees is when the
 * limit activates (limitFilledCaption). Internal decision ID is still
 * stored in DB for audit (passed in `decisionId` for log purposes only).
 */
export function limitPlacedCaption(input: {
  decisionId: number;
  symbol: string;
  side: 'long' | 'short';
  entry: number;
  sl: number;
  tp: number;
  confidence: number;
  reasoningShort: string;
  slReason?: string;
  tpReason?: string;
  invalidation?: string;
  pendingUntilMs: number;
}): string {
  const sideE = input.side === 'long' ? '🟢' : '🔴';
  const sideRu = input.side === 'long' ? 'ЛОНГ' : 'ШОРТ';
  const slPct = pctDistance(input.entry, input.sl);
  const tpPct = pctDistance(input.entry, input.tp);
  const slDist = Math.abs(input.entry - input.sl);
  const tpDist = Math.abs(input.tp - input.entry);
  const rr = slDist > 0 ? Math.round((tpDist / slDist) * 10) / 10 : 0;
  const expiresAt = new Date(input.pendingUntilMs).toISOString().slice(11, 16) + 'Z';

  const lines = [
    `<b>📋 Лимитный ордер размещён</b>`,
    `${sideE} <b>${input.symbol}</b> ${sideRu} · ждём ретест на уровень`,
    '',
    `🎯 Уровень входа: <code>${input.entry}</code>`,
    `🛡 Стоп: <code>${input.sl}</code> (<code>${slPct}%</code>)${input.slReason ? ' — ' + escapeHtml(input.slReason) : ''}`,
    `🎯 Цель: <code>${input.tp}</code> (<code>${tpPct}%</code>)${input.tpReason ? ' — ' + escapeHtml(input.tpReason) : ''}`,
    `📐 R:R: <code>1 : ${rr}</code>`,
    `💪 Уверенность: <code>${(input.confidence * 100).toFixed(0)}%</code>`,
    `⏱ Действителен до: <code>${expiresAt}</code>`,
    '',
    `<i>Это ещё не сделка. Номер появится если цена коснётся уровня.</i>`,
    '',
    escapeHtml(input.reasoningShort),
  ];
  if (input.invalidation) {
    lines.push('');
    lines.push(`❌ Отмена: ${escapeHtml(input.invalidation)}`);
  }
  return lines.join('\n').slice(0, 1024);
}

/** Telegram message when a pending limit just got filled. */
export function limitFilledCaption(input: {
  decisionId: number;
  symbol: string;
  side: 'long' | 'short';
  entry: number;
}): string {
  const tradeId = `#${input.decisionId.toString().padStart(4, '0')}`;
  const sideE = input.side === 'long' ? '🟢' : '🔴';
  const sideRu = input.side === 'long' ? 'ЛОНГ' : 'ШОРТ';
  return `🟢 <b>Лимит активирован → сделка ${tradeId}</b>\n${sideE} ${input.symbol} ${sideRu} @ <code>${input.entry}</code>\nЦена коснулась уровня — позиция открыта.`;
}

/**
 * Telegram message when a pending limit expired without filling.
 * No trade number — was never a trade.
 */
export function limitCancelledCaption(input: {
  symbol: string;
  side: 'long' | 'short';
  entry: number;
  reason: 'expired' | 'manual';
}): string {
  const sideRu = input.side === 'long' ? 'ЛОНГ' : 'ШОРТ';
  const reasonText = input.reason === 'expired' ? 'ретест не пришёл за 2 часа' : 'отмена вручную';
  return `⏱ <b>Лимитный ордер отменён</b>\n${input.symbol} ${sideRu} @ <code>${input.entry}</code> — ${reasonText}.\nСделка не открылась, в статистике не учитывается.`;
}

export type DecisionPostInput = {
  /** decision row id from DB → unique trade number */
  decisionId: number;
  symbol: string;
  agg: AggregatedScore;
  decision: Decision;
  riskGate: { ok: true } | { ok: false; reason: string };
  shadowMode: boolean;
  /** when this is a CLOSE/MODIFY of an earlier OPEN, original trade id */
  parentTradeId?: number;
};

/** Russian Telegram caption for OPEN/CLOSE/MODIFY (max 1024 chars). */
export function tradeCaption(i: DecisionPostInput): string {
  const d = i.decision;
  const tradeId = `#${i.decisionId.toString().padStart(4, '0')}`;
  const parentRef =
    i.parentTradeId !== undefined
      ? ` ← по сделке #${i.parentTradeId.toString().padStart(4, '0')}`
      : '';
  const sideE = d.side ? SIDE_EMOJI[d.side] ?? '' : '';
  const sideRu = d.side ? SIDE_RU[d.side] ?? d.side : '';
  const shadow = i.shadowMode ? ' <i>(shadow)</i>' : '';
  const lines: string[] = [
    `<b>${DECISION_RU[d.decision] ?? d.decision} ${tradeId}</b>${parentRef}${shadow}`,
    `${sideE} <b>${escapeHtml(i.symbol)}</b>${sideRu ? ' ' + sideRu : ''} · ${tfLabel('15')} entry`,
  ];

  if (d.decision === 'OPEN' && d.entry && d.sl) {
    const slPct = pctDistance(d.entry, d.sl);
    lines.push('');
    const entryLabel = d.entry_type === 'limit' ? '📥 Вход (limit):' : '📥 Вход:';
    lines.push(`${entryLabel}  <code>${d.entry}</code>`);
    const slBase = `🛡 Стоп:  <code>${d.sl}</code>  (<code>${slPct}%</code>)`;
    lines.push(d.sl_reason ? `${slBase} — ${escapeHtml(d.sl_reason)}` : slBase);
    if (d.tp.length) {
      const tp1 = d.tp[0]!;
      const tp1Pct = pctDistance(d.entry, tp1);
      const tpBase = `🎯 Цель:  <code>${tp1}</code>  (<code>${tp1Pct}%</code>)`;
      lines.push(d.tp_reason ? `${tpBase} — ${escapeHtml(d.tp_reason)}` : tpBase);
      const slDist = Math.abs(d.entry - d.sl);
      const tp1Dist = Math.abs(tp1 - d.entry);
      const rr = Math.round((tp1Dist / slDist) * 10) / 10;
      lines.push(`📐 R:R:   <code>1 : ${rr}</code>`);
    }
    lines.push(`💪 Уверенность: <code>${(d.confidence * 100).toFixed(0)}%</code>`);
  } else if (d.decision === 'MODIFY') {
    lines.push('');
    if (d.sl !== undefined) {
      const slBase = `🛡 Новый стоп: <code>${d.sl}</code>`;
      lines.push(d.sl_reason ? `${slBase} — ${escapeHtml(d.sl_reason)}` : slBase);
    }
    if (d.tp.length) {
      const tpBase = `🎯 Новая цель: <code>${d.tp[0]}</code>`;
      lines.push(d.tp_reason ? `${tpBase} — ${escapeHtml(d.tp_reason)}` : tpBase);
    }
    lines.push(`💪 Уверенность: <code>${(d.confidence * 100).toFixed(0)}%</code>`);
  } else {
    lines.push('');
    lines.push(`💪 Уверенность: <code>${(d.confidence * 100).toFixed(0)}%</code>`);
  }

  lines.push('');
  lines.push(escapeHtml(d.reasoning_short));

  if (d.decision === 'OPEN' && d.invalidation) {
    lines.push('');
    lines.push(`❌ Отмена сигнала: ${escapeHtml(d.invalidation)}`);
  }

  if (!i.riskGate.ok) {
    lines.push('');
    lines.push(`⚠️ <i>risk gate: ${escapeHtml(i.riskGate.reason)}</i>`);
  }

  return lines.join('\n').slice(0, 1024);
}

/** Compact one-liner for SKIP decisions, posted only to Logs channel. */
export function skipLog(i: DecisionPostInput): string {
  const tradeId = `#${i.decisionId.toString().padStart(4, '0')}`;
  return `⏸ <b>SKIP ${tradeId}</b> ${escapeHtml(i.symbol)} · score ${i.agg.bullish}/${i.agg.bearish} · ${escapeHtml(i.decision.reasoning_short)}`;
}
