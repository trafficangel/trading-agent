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
  filled_at: number | null;
  pending_until: number | null;
  reasoning_short: string | null;
  close_price: number | null;
  close_reason: string | null;
  pnl_pct: number | null;
  pnl_r: number | null;
  features_json: string | null;
  /** A/B bucket — 'llm' or 'signal'. Migration 008. */
  track: string;
};

const sigsToday = db.prepare<[number], { symbol: string; timeframe: string; c: number }>(
  'SELECT symbol, timeframe, COUNT(*) AS c FROM signals WHERE received_at >= ? GROUP BY symbol, timeframe ORDER BY symbol, timeframe',
);
const SELECT_COLS = `
  id, created_at, symbol, decision, side, entry, sl, tp_json,
  status, parent_decision_id, closed_at, filled_at, pending_until, reasoning_short,
  close_price, close_reason, pnl_pct, pnl_r, features_json, track
`;
const decisionsToday = db.prepare<[number], DecisionDayRow>(
  `SELECT ${SELECT_COLS} FROM decisions WHERE created_at >= ? ORDER BY created_at ASC`,
);

// Trades that REALLY closed today (TP/SL hit, or LLM CLOSE). Only these
// produce real PnL. Excludes the broken-data zombie (entry==sl → pnl null)
// via the explicit pnl_pct IS NOT NULL filter — those rows shouldn't show
// up in win/loss/USD stats.
const closedTradesToday = db.prepare<[number], DecisionDayRow>(`
  SELECT ${SELECT_COLS} FROM decisions
  WHERE decision = 'OPEN' AND status = 'closed'
    AND closed_at IS NOT NULL AND closed_at >= ?
    AND pnl_pct IS NOT NULL
  ORDER BY closed_at ASC
`);

// Currently-active trades (market entries OR filled limits).
const stillActive = db.prepare<[], DecisionDayRow>(
  `SELECT ${SELECT_COLS} FROM decisions WHERE decision = 'OPEN' AND status = 'active' ORDER BY created_at ASC`,
);

// Limits still waiting for price touch. They might still fire today.
const pendingLimits = db.prepare<[], DecisionDayRow>(
  `SELECT ${SELECT_COLS} FROM decisions WHERE status = 'pending' ORDER BY created_at ASC`,
);

// Limits that expired without filling today. Important for transparency
// but NOT counted in PnL (they were never trades).
const cancelledLimitsToday = db.prepare<[number], DecisionDayRow>(`
  SELECT ${SELECT_COLS} FROM decisions
  WHERE status = 'cancelled' AND closed_at IS NOT NULL AND closed_at >= ?
  ORDER BY closed_at ASC
`);

function startOfTodayUtc(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** $1000 per position simulation — what closed-trade PnL maps to in USD. */
const POSITION_NOTIONAL_USD = 1000;

function entryTypeOf(row: DecisionDayRow): 'market' | 'limit' | 'unknown' {
  if (!row.features_json) return 'unknown';
  try {
    const f = JSON.parse(row.features_json) as { entry_type?: string };
    if (f.entry_type === 'market' || f.entry_type === 'limit') return f.entry_type;
  } catch {
    // ignore parse errors
  }
  return 'unknown';
}

function reasonEmoji(reason: string | null): string {
  if (reason === 'tp_hit') return '🎯';
  if (reason === 'sl_hit') return '🛑';
  if (reason === 'llm_close') return '🏁';
  return '·';
}

async function tick(now: Date = new Date()): Promise<void> {
  const dayStart = startOfTodayUtc(now);

  // === Signals ===
  const sigRows = sigsToday.all(dayStart);
  const sigBySymbol = new Map<string, { tf: string; n: number }[]>();
  for (const r of sigRows) {
    const arr = sigBySymbol.get(r.symbol) ?? [];
    arr.push({ tf: r.timeframe, n: r.c });
    sigBySymbol.set(r.symbol, arr);
  }

  // === Decisions by type ===
  const allDec = decisionsToday.all(dayStart);
  const counts = { OPEN: 0, CLOSE: 0, MODIFY: 0, SKIP: 0 };
  for (const d of allDec) {
    counts[d.decision as keyof typeof counts] = (counts[d.decision as keyof typeof counts] ?? 0) + 1;
  }

  // === Real closed trades (have actual PnL) ===
  const closed = closedTradesToday.all(dayStart);
  const wins = closed.filter((t) => (t.pnl_pct ?? 0) > 0).length;
  const losses = closed.filter((t) => (t.pnl_pct ?? 0) < 0).length;
  const breakevens = closed.filter((t) => (t.pnl_pct ?? 0) === 0).length;
  const totalR = closed.reduce((s, t) => s + (t.pnl_r ?? 0), 0);
  const totalUsd = closed.reduce(
    (s, t) => s + ((t.pnl_pct ?? 0) / 100) * POSITION_NOTIONAL_USD,
    0,
  );
  // Breakdown by entry type (after limit-vs-market is meaningful)
  const closedByType = { market: 0, limit: 0, unknown: 0 };
  const winsByType = { market: 0, limit: 0, unknown: 0 };
  for (const t of closed) {
    const k = entryTypeOf(t);
    closedByType[k]++;
    if ((t.pnl_pct ?? 0) > 0) winsByType[k]++;
  }

  // === Pending limits (still waiting) ===
  const pending = pendingLimits.all();
  // === Cancelled limits today (expired without fill) ===
  const cancelled = cancelledLimitsToday.all(dayStart);
  // === Active trades right now ===
  const active = stillActive.all();

  // === Render ===
  const dateStr = now.toISOString().slice(0, 10);
  const lines: string[] = [`📊 <b>Сводка за ${dateStr}</b> (23:55 UTC)`, ''];

  // --- Signals ---
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

  // --- Decisions counts + per-track breakdown ---
  // "Решения за день" — нейтрально для всех треков (A/B/C).
  const llmDec = allDec.filter((d) => d.track === 'llm');
  const sigDec = allDec.filter((d) => d.track === 'signal');
  const stratDec = allDec.filter((d) => d.track === 'strategy');
  lines.push(`<b>Решения за день:</b> ${allDec.length}`);
  if (allDec.length) {
    lines.push(
      `  📈 OPEN: <b>${counts.OPEN}</b>  ·  🏁 CLOSE: <b>${counts.CLOSE}</b>  ·  🔧 MODIFY: <b>${counts.MODIFY}</b>  ·  ⏸ SKIP: <b>${counts.SKIP}</b>`,
    );
    const activeTracks = [
      llmDec.length > 0 ? `🤖 LLM: <b>${llmDec.length}</b>` : null,
      sigDec.length > 0 ? `📡 Signal: <b>${sigDec.length}</b>` : null,
      stratDec.length > 0 ? `🛠 Strategy: <b>${stratDec.length}</b>` : null,
    ].filter((x): x is string => x !== null);
    if (activeTracks.length > 1) {
      lines.push(`  ${activeTracks.join('  ·  ')}`);
    } else if (activeTracks.length === 1) {
      const onlyTrack =
        llmDec.length > 0 ? 'Track A (LLM)' :
        sigDec.length > 0 ? 'Track B (Signal)' :
        'Track C (Strategy)';
      lines.push(`  ${activeTracks[0]} — все сделки на ${onlyTrack}`);
    }
  }
  lines.push('');

  // --- Real closed trades (the meat of the report) ---
  if (closed.length > 0) {
    const rSign = totalR >= 0 ? '+' : '';
    const usdSign = totalUsd >= 0 ? '+' : '';
    const winrate = ((wins / closed.length) * 100).toFixed(0);
    const avgR = (totalR / closed.length).toFixed(2);
    const avgRSign = totalR >= 0 ? '+' : '';

    lines.push(`<b>💼 Закрыто сделок: ${closed.length}</b>`);
    lines.push(
      `  Win: <b>${wins}</b>  ·  Loss: <b>${losses}</b>${breakevens ? `  ·  BE: ${breakevens}` : ''}  ·  Win-rate: <b>${winrate}%</b>`,
    );
    lines.push(`  Σ R: <b>${rSign}${totalR.toFixed(2)}R</b>  ·  Avg R/trade: <b>${avgRSign}${avgR}</b>`);
    lines.push(`  💰 PnL при $1000/позиция: <b>${usdSign}$${totalUsd.toFixed(2)}</b>`);
    // Per-entry-type stats (useful once we have enough trades)
    if (closedByType.limit > 0 || closedByType.market > 0) {
      const segs: string[] = [];
      if (closedByType.market > 0) {
        const wr = ((winsByType.market / closedByType.market) * 100).toFixed(0);
        segs.push(`market ${closedByType.market} (W ${wr}%)`);
      }
      if (closedByType.limit > 0) {
        const wr = ((winsByType.limit / closedByType.limit) * 100).toFixed(0);
        segs.push(`limit ${closedByType.limit} (W ${wr}%)`);
      }
      if (segs.length) lines.push(`  Тип входа: ${segs.join(' · ')}`);
    }
    lines.push('');
    lines.push('<b>Детально:</b>');
    for (const t of closed) {
      const sideE = t.side === 'long' ? '🟢' : t.side === 'short' ? '🔴' : '';
      const pnlPct = t.pnl_pct ?? 0;
      const pnlStr = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
      const r = t.pnl_r ?? 0;
      const rStr = `(${r >= 0 ? '+' : ''}${r.toFixed(2)}R)`;
      const usdPnl = (pnlPct / 100) * POSITION_NOTIONAL_USD;
      const usdStr = `${usdPnl >= 0 ? '+' : ''}$${usdPnl.toFixed(2)}`;
      const etype = entryTypeOf(t);
      const typeTag = etype === 'limit' ? ' <i>limit</i>' : '';
      // Track-aware trade ID prefix ('S#' for signal, '#' for LLM).
      const idPrefix = t.track === 'strategy' ? 'T#' : t.track === 'signal' ? 'S#' : '#';
      lines.push(
        `  ${reasonEmoji(t.close_reason)} ${idPrefix}${t.id.toString().padStart(4, '0')}${typeTag} ${sideE} ${t.symbol} · ${t.entry} → ${t.close_price ?? '?'} · <b>${pnlStr}</b> ${rStr} · ${usdStr}`,
      );
    }
  } else {
    lines.push(`<b>Закрытых сделок сегодня нет.</b>`);
  }
  lines.push('');

  // --- Active trades ---
  if (active.length > 0) {
    lines.push(`<b>🛡 Открытые сделки: ${active.length}</b>`);
    for (const t of active) {
      const sideE = t.side === 'long' ? '🟢' : '🔴';
      const ageMin = Math.round((Date.now() - (t.filled_at ?? t.created_at)) / 60000);
      const ageStr = ageMin < 60 ? `${ageMin}мин` : `${Math.round(ageMin / 60)}ч`;
      const etype = entryTypeOf(t);
      const tag = etype === 'limit' ? ' <i>(filled limit)</i>' : '';
      const idPrefix = t.track === 'strategy' ? 'T#' : t.track === 'signal' ? 'S#' : '#';
      lines.push(
        `  ${idPrefix}${t.id.toString().padStart(4, '0')}${tag} ${sideE} ${t.symbol} @ ${t.entry} (открыта ${ageStr} назад)`,
      );
    }
    lines.push('');
  }

  // --- Pending limits (still waiting) ---
  if (pending.length > 0) {
    lines.push(`<b>📋 Лимитные ордера в ожидании: ${pending.length}</b>`);
    for (const t of pending) {
      const sideE = t.side === 'long' ? '🟢' : '🔴';
      const expiresIn = t.pending_until ? Math.max(0, Math.round((t.pending_until - Date.now()) / 60000)) : 0;
      lines.push(
        `  ${sideE} ${t.symbol} @ ${t.entry} (истекает через ${expiresIn}мин)`,
      );
    }
    lines.push('');
  }

  // --- Cancelled limits today (didn't fire) ---
  if (cancelled.length > 0) {
    lines.push(`<b>⏱ Лимитов отменено сегодня: ${cancelled.length}</b>`);
    lines.push(`  <i>(ретест не пришёл за 2ч — в P&L не учитываются)</i>`);
    for (const t of cancelled) {
      const sideE = t.side === 'long' ? '🟢' : '🔴';
      lines.push(`  ${sideE} ${t.symbol} @ ${t.entry}`);
    }
    lines.push('');
  }

  // --- Empty footer if nothing happened ---
  if (active.length === 0 && pending.length === 0 && cancelled.length === 0 && closed.length === 0) {
    lines.push(`<i>Без открытых, закрытых и pending позиций.</i>`);
  }

  const text = lines.join('\n');
  await sendMessage({ channel: 'signals', text });
  logger.info(
    {
      closed_today: closed.length,
      active: active.length,
      pending: pending.length,
      cancelled_today: cancelled.length,
      decisions: allDec.length,
      total_r: Math.round(totalR * 100) / 100,
      total_usd: Math.round(totalUsd * 100) / 100,
    },
    'daily wrap sent',
  );
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
