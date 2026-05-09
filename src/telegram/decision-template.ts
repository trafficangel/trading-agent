import type { Decision } from '../llm/decision.schema.js';
import type { AggregatedScore } from '../signals/aggregator.js';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESC[c] ?? c);
}

const SIDE_EMOJI: Record<string, string> = { long: '🟢', short: '🔴' };
const DECISION_EMOJI: Record<string, string> = {
  OPEN: '🚀',
  SKIP: '⏸',
  CLOSE: '🏁',
  MODIFY: '🔧',
};

export type DecisionPostInput = {
  symbol: string;
  agg: AggregatedScore;
  decision: Decision;
  riskGate: { ok: true } | { ok: false; reason: string };
  shadowMode: boolean;
};

export function decisionPost(i: DecisionPostInput): string {
  const d = i.decision;
  const e = DECISION_EMOJI[d.decision] ?? '•';
  const sideE = d.side ? SIDE_EMOJI[d.side] ?? '' : '';
  const lines: string[] = [
    `${e} <b>${escapeHtml(d.decision)}</b> ${sideE} <b>${escapeHtml(i.symbol)}</b>${i.shadowMode ? ' <i>(shadow)</i>' : ''}`,
  ];

  if (d.decision === 'OPEN' && d.entry && d.sl) {
    lines.push(
      `entry: <code>${d.entry}</code> · sl: <code>${d.sl}</code> · tp: <code>${d.tp.join(', ')}</code>`,
    );
    lines.push(
      `size: <code>${d.size_pct}%</code> · confidence: <code>${(d.confidence * 100).toFixed(0)}%</code>`,
    );
  } else {
    lines.push(`confidence: <code>${(d.confidence * 100).toFixed(0)}%</code>`);
  }

  lines.push(
    `score: bullish <code>${i.agg.bullish}</code> · bearish <code>${i.agg.bearish}</code> · ${i.agg.signals.length} signals/10m`,
  );

  if (!i.riskGate.ok) {
    lines.push(`⚠️ <i>risk gate: ${escapeHtml(i.riskGate.reason)}</i>`);
  }

  lines.push('');
  lines.push(escapeHtml(d.reasoning_short));

  return lines.join('\n');
}
