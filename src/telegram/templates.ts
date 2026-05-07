import type { LuxAlgoPayload } from '../webhooks/luxalgo.schema.js';

const SOURCE_EMOJI: Record<string, string> = {
  signals_overlays: '🎯',
  pac: '🧱',
  oscillator_matrix: '📊',
};

const DIR_EMOJI: Record<string, string> = {
  up: '🟢',
  down: '🔴',
  neutral: '⚪️',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function rawSignalLog(p: LuxAlgoPayload, raw: unknown): string {
  const src = SOURCE_EMOJI[p.source] ?? '•';
  const dir = p.direction ? DIR_EMOJI[p.direction] ?? '' : '';
  const price = p.price ? ` @ <code>${p.price}</code>` : '';
  const json = escapeHtml(JSON.stringify(raw, null, 2));
  return [
    `${src} ${dir} <b>${escapeHtml(p.symbol)}</b> ${escapeHtml(p.timeframe)}`,
    `<i>${escapeHtml(p.source)}</i> · <code>${escapeHtml(p.event)}</code>${price}`,
    `<pre>${json}</pre>`,
  ].join('\n');
}

export function summaryPost(
  windowMin: number,
  rows: { symbol: string; event: string; direction: string | null; n: number }[],
): string {
  if (rows.length === 0) {
    return `🟦 <b>Signals digest</b> · last ${windowMin} min\n<i>тишина</i>`;
  }
  const bySymbol = new Map<string, { event: string; direction: string | null; n: number }[]>();
  for (const r of rows) {
    const arr = bySymbol.get(r.symbol) ?? [];
    arr.push({ event: r.event, direction: r.direction, n: r.n });
    bySymbol.set(r.symbol, arr);
  }
  const lines: string[] = [`🟦 <b>Signals digest</b> · last ${windowMin} min`];
  for (const [symbol, items] of bySymbol) {
    const inner = items
      .map((i) => `${i.direction ? DIR_EMOJI[i.direction] ?? '' : ''} ${escapeHtml(i.event)}×${i.n}`)
      .join(', ');
    lines.push(`<b>${escapeHtml(symbol)}</b>: ${inner}`);
  }
  return lines.join('\n');
}

export function startupBanner(mode: string, port: number): string {
  return `🚀 <b>trading-agent</b> started\nmode: <code>${escapeHtml(mode)}</code> · port <code>${port}</code>`;
}

export function statusReply(uptimeSec: number, signals24h: number, mode: string): string {
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  return `📟 <b>status</b>\nmode: <code>${escapeHtml(mode)}</code>\nuptime: ${h}h ${m}m\nsignals 24h: <b>${signals24h}</b>`;
}
