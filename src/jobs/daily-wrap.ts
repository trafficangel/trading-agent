import cron from 'node-cron';
import { sendMessage } from '../telegram/bot.js';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';

type DecisionDayRow = {
  id: number;
  created_at: number;
  symbol: string;
  decision: string;
  side: string | null;
  entry: number | null;
  sl: number | null;
  tp_json: string | null;
  status: string;
  parent_decision_id: number | null;
  closed_at: number | null;
  reasoning_short: string | null;
};

const sigsToday = db.prepare<[number], { symbol: string; timeframe: string; c: number }>(
  'SELECT symbol, timeframe, COUNT(*) AS c FROM signals WHERE received_at >= ? GROUP BY symbol, timeframe ORDER BY symbol, timeframe',
);
const decisionsToday = db.prepare<[number], DecisionDayRow>(`
  SELECT id, created_at, symbol, decision, side, entry, sl, tp_json,
         status, parent_decision_id, closed_at, reasoning_short
  FROM decisions WHERE created_at >= ? ORDER BY created_at ASC
`);
const closedTradesToday = db.prepare<[number], DecisionDayRow>(`
  SELECT id, created_at, symbol, decision, side, entry, sl, tp_json,
         status, parent_decision_id, closed_at, reasoning_short
  FROM decisions
  WHERE decision = 'OPEN' AND status = 'closed' AND closed_at IS NOT NULL AND closed_at >= ?
  ORDER BY closed_at ASC
`);
const stillActive = db.prepare<[], DecisionDayRow>(`
  SELECT id, created_at, symbol, decision, side, entry, sl, tp_json,
         status, parent_decision_id, closed_at, reasoning_short
  FROM decisions WHERE decision = 'OPEN' AND status = 'active'
  ORDER BY created_at ASC
`);
const nearestSignalPrice = db.prepare<[string, number, number, number], { price: number | null }>(`
  SELECT price FROM signals
  WHERE symbol = ? AND price IS NOT NULL
    AND received_at BETWEEN ? AND ?
  ORDER BY ABS(received_at - ?) ASC LIMIT 1
`);

function startOfTodayUtc(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function approxClosePrice(symbol: string, closedAt: number): number | null {
  const window = 30 * 60 * 1000;
  const row = nearestSignalPrice.get(symbol, closedAt - window, closedAt + window, closedAt);
  return row?.price ?? null;
}

function pnlPct(side: string | null, entry: number, exit: number): number {
  const dir = side === 'short' ? -1 : 1;
  return ((exit - entry) / entry) * 100 * dir;
}

async function tick(now: Date = new Date()): Promise<void> {
  const dayStart = startOfTodayUtc(now);

  // Signals: group by symbol, then bucket by timeframe inside.
  const sigRows = sigsToday.all(dayStart);
  const sigBySymbol = new Map<string, { tf: string; n: number }[]>();
  for (const r of sigRows) {
    const arr = sigBySymbol.get(r.symbol) ?? [];
    arr.push({ tf: r.timeframe, n: r.c });
    sigBySymbol.set(r.symbol, arr);
  }

  // Decisions count by type
  const allDec = decisionsToday.all(dayStart);
  const counts = { OPEN: 0, CLOSE: 0, MODIFY: 0, SKIP: 0 };
  for (const d of allDec) {
    counts[d.decision as keyof typeof counts] = (counts[d.decision as keyof typeof counts] ?? 0) + 1;
  }

  // Closed trades with approximate PnL
  const closed = closedTradesToday.all(dayStart);
  const closedDetails = closed.map((t) => {
    const exit = t.entry && t.closed_at ? approxClosePrice(t.symbol, t.closed_at) : null;
    const pnl = exit && t.entry ? pnlPct(t.side, t.entry, exit) : null;
    return { ...t, exit, pnl };
  });
  const wins = closedDetails.filter((t) => t.pnl !== null && t.pnl > 0).length;
  const losses = closedDetails.filter((t) => t.pnl !== null && t.pnl < 0).length;

  const active = stillActive.all();

  const dateStr = now.toISOString().slice(0, 10);
  const lines: string[] = [`📊 <b>Сводка за ${dateStr}</b> (23:55 UTC)`, ''];

  // Signals
  if (sigBySymbol.size === 0) {
    lines.push(`Сигналов: <i>не было</i>`);
  } else {
    lines.push('<b>Сигналы за день:</b>');
    for (const [sym, arr] of sigBySymbol) {
      const total = arr.reduce((s, x) => s + x.n, 0);
      const detail = arr.map((x) => `${x.tf}m×${x.n}`).join(', ');
      lines.push(`  ${sym}: ${total} (${detail})`);
    }
  }
  lines.push('');

  // Decisions
  lines.push(`<b>Решения LLM:</b> ${allDec.length}`);
  if (allDec.length) {
    lines.push(`  📈 OPEN: <b>${counts.OPEN}</b>  ·  🏁 CLOSE: <b>${counts.CLOSE}</b>  ·  🔧 MODIFY: <b>${counts.MODIFY}</b>  ·  ⏸ SKIP: <b>${counts.SKIP}</b>`);
  }
  lines.push('');

  // Closed today
  if (closedDetails.length) {
    lines.push(`<b>Закрыто сегодня:</b> ${closedDetails.length} (W ${wins} / L ${losses})`);
    for (const t of closedDetails) {
      const sideE = t.side === 'long' ? '🟢' : t.side === 'short' ? '🔴' : '';
      const pnlStr = t.pnl !== null ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}%` : '?';
      const exitStr = t.exit !== null ? `~${t.exit}` : '?';
      lines.push(
        `  #${t.id.toString().padStart(4, '0')} ${sideE} ${t.symbol} · вход ${t.entry} → выход ${exitStr} · <b>${pnlStr}</b>`,
      );
    }
  } else {
    lines.push(`<b>Закрытых сделок сегодня нет.</b>`);
  }
  lines.push('');

  // Active
  if (active.length) {
    lines.push(`<b>Открытые сделки:</b> ${active.length}`);
    for (const t of active) {
      const sideE = t.side === 'long' ? '🟢' : '🔴';
      const ageH = Math.round((Date.now() - t.created_at) / 3600000);
      lines.push(`  #${t.id.toString().padStart(4, '0')} ${sideE} ${t.symbol} @ ${t.entry} (открыта ${ageH}ч назад)`);
    }
  } else {
    lines.push(`<b>Открытых сделок нет.</b>`);
  }

  const text = lines.join('\n');
  await sendMessage({ channel: 'signals', text });
  logger.info({ trades_today: closedDetails.length, active: active.length, decisions: allDec.length }, 'daily wrap sent');
}

export function startDailyWrapJob(): void {
  // 23:55 UTC daily.
  cron.schedule('55 23 * * *', () => {
    void tick(new Date());
  });
  logger.info('daily wrap cron started (23:55 UTC)');
}

// Exposed for one-off invocations / tests.
export const _internal = { tick, startOfTodayUtc };
