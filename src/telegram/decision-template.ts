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
