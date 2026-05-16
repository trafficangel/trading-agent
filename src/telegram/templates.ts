function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function startupBanner(mode: string, port: number): string {
  return `🚀 <b>trading-agent</b> started\nmode: <code>${escapeHtml(mode)}</code> · port <code>${port}</code>`;
}

export function statusReply(uptimeSec: number, signals24h: number, mode: string): string {
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  return `📟 <b>status</b>\nmode: <code>${escapeHtml(mode)}</code>\nuptime: ${h}h ${m}m\nsignals 24h: <b>${signals24h}</b>`;
}
