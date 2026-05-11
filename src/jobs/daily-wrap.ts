import cron from 'node-cron';
import { sendMessage } from '../telegram/bot.js';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { getBinanceKlines } from '../exchange/binance-public.js';
import { getBybitKlines } from '../exchange/bybit-public.js';

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
  close_price: number | null;
  close_reason: string | null;
  pnl_pct: number | null;
  pnl_r: number | null;
};

const sigsToday = db.prepare<[number], { symbol: string; timeframe: string; c: number }>(
  'SELECT symbol, timeframe, COUNT(*) AS c FROM signals WHERE received_at >= ? GROUP BY symbol, timeframe ORDER BY symbol, timeframe',
);
const SELECT_COLS = `
  id, created_at, symbol, decision, side, entry, sl, tp_json,
  status, parent_decision_id, closed_at, reasoning_short,
  close_price, close_reason, pnl_pct, pnl_r
`;
const decisionsToday = db.prepare<[number], DecisionDayRow>(
  `SELECT ${SELECT_COLS} FROM decisions WHERE created_at >= ? ORDER BY created_at ASC`,
);
const closedTradesToday = db.prepare<[number], DecisionDayRow>(`
  SELECT ${SELECT_COLS} FROM decisions
  WHERE decision = 'OPEN' AND status = 'closed' AND closed_at IS NOT NULL AND closed_at >= ?
  ORDER BY closed_at ASC
`);
const stillActive = db.prepare<[], DecisionDayRow>(
  `SELECT ${SELECT_COLS} FROM decisions WHERE decision = 'OPEN' AND status = 'active' ORDER BY created_at ASC`,
);
const nearestSignalPrice = db.prepare<[string, number, number, number], { price: number | null }>(`
  SELECT price FROM signals
  WHERE symbol = ? AND price IS NOT NULL
    AND received_at BETWEEN ? AND ?
  ORDER BY ABS(received_at - ?) ASC LIMIT 1
`);

function startOfTodayUtc(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * Today's price change for a symbol — used for the HODL baseline.
 * Fetches the current 1-day kline (open = today 00:00 UTC, close = current
 * price since the day isn't done yet). Returns pct change open→current, or
 * null if neither Binance nor Bybit responded.
 */
async function fetchTodayPriceChange(
  symbol: string,
): Promise<{ open: number; current: number; pctChange: number } | null> {
  const tryParse = (k: { open: number; close: number } | undefined) => {
    if (!k || !Number.isFinite(k.open) || !Number.isFinite(k.close) || k.open <= 0) return null;
    return { open: k.open, current: k.close, pctChange: ((k.close - k.open) / k.open) * 100 };
  };
  const binance = await getBinanceKlines(symbol, '1d', 1).catch(() => null);
  if (binance && binance.length > 0) {
    const r = tryParse(binance[binance.length - 1]);
    if (r) return r;
  }
  const bybit = await getBybitKlines(symbol, '1d', 1).catch(() => null);
  if (bybit && bybit.length > 0) {
    const r = tryParse(bybit[bybit.length - 1]);
    if (r) return r;
  }
  return null;
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

  // Closed trades — prefer exact close_price/pnl_pct from DB; fall back to
  // nearest-signal approximation only when those are missing (legacy rows).
  const closed = closedTradesToday.all(dayStart);
  const closedDetails = closed.map((t) => {
    let exit = t.close_price;
    let pnl = t.pnl_pct;
    if (exit == null) {
      exit = t.entry && t.closed_at ? approxClosePrice(t.symbol, t.closed_at) : null;
      pnl = exit && t.entry ? pnlPct(t.side, t.entry, exit) : null;
    }
    return { ...t, exit, pnl };
  });
  const wins = closedDetails.filter((t) => t.pnl !== null && t.pnl > 0).length;
  const losses = closedDetails.filter((t) => t.pnl !== null && t.pnl < 0).length;
  const totalR = closedDetails.reduce((s, t) => s + (t.pnl_r ?? 0), 0);
  // Hypothetical: if we'd entered each closed trade with $1000 notional.
  // USD PnL = $1000 × pnl_pct/100. Doesn't apply leverage, fees, or slippage
  // — pure setup quality measurement.
  const POSITION_NOTIONAL_USD = 1000;
  const totalUsd = closedDetails.reduce(
    (s, t) => s + (t.pnl !== null ? (t.pnl / 100) * POSITION_NOTIONAL_USD : 0),
    0,
  );

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
    const rTotalSign = totalR >= 0 ? '+' : '';
    const usdTotalSign = totalUsd >= 0 ? '+' : '';
    lines.push(
      `<b>Закрыто сегодня:</b> ${closedDetails.length} (W ${wins} / L ${losses})  ·  Σ ${rTotalSign}${totalR.toFixed(2)}R`,
    );
    lines.push(
      `<i>Симуляция $1000 на позицию:</i> <b>${usdTotalSign}$${totalUsd.toFixed(2)}</b>`,
    );
    for (const t of closedDetails) {
      const sideE = t.side === 'long' ? '🟢' : t.side === 'short' ? '🔴' : '';
      const pnlStr = t.pnl !== null ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}%` : '?';
      const rStr = t.pnl_r !== null ? ` (${t.pnl_r >= 0 ? '+' : ''}${t.pnl_r.toFixed(2)}R)` : '';
      const usdPnl = t.pnl !== null ? (t.pnl / 100) * POSITION_NOTIONAL_USD : null;
      const usdStr = usdPnl !== null ? ` · ${usdPnl >= 0 ? '+' : ''}$${usdPnl.toFixed(2)}` : '';
      const exit = t.close_price ?? t.exit;
      const exitStr = exit !== null ? `${t.close_price ? '' : '~'}${exit}` : '?';
      const reason =
        t.close_reason === 'tp_hit' ? '🎯' : t.close_reason === 'sl_hit' ? '🛑' : t.close_reason === 'llm_close' ? '🏁' : '';
      lines.push(
        `  ${reason} #${t.id.toString().padStart(4, '0')} ${sideE} ${t.symbol} · ${t.entry} → ${exitStr} · <b>${pnlStr}</b>${rStr}${usdStr}`,
      );
    }
  } else {
    lines.push(`<b>Закрытых сделок сегодня нет.</b>`);
  }
  lines.push('');

  // HODL baseline — what would $1000 in each enabled symbol have done today?
  // Lets us answer "is our selectivity actually adding value, or are we
  // just buying-and-holding worse than a flat HODL would have?".
  const hodlResults = await Promise.all(
    config.SYMBOLS.map(async (sym) => ({ sym, stats: await fetchTodayPriceChange(sym) })),
  );
  const hodlPresent = hodlResults.filter(
    (r): r is { sym: string; stats: { open: number; current: number; pctChange: number } } =>
      r.stats !== null,
  );
  if (hodlPresent.length > 0) {
    lines.push(`<b>HODL baseline ($1000 в каждом символе с 00:00 UTC):</b>`);
    let hodlTotalUsd = 0;
    for (const { sym, stats } of hodlPresent) {
      const usd = (stats.pctChange / 100) * POSITION_NOTIONAL_USD;
      hodlTotalUsd += usd;
      const pctSign = stats.pctChange >= 0 ? '+' : '';
      const usdSign = usd >= 0 ? '+' : '';
      lines.push(
        `  ${sym}: ${pctSign}${stats.pctChange.toFixed(2)}% (${usdSign}$${usd.toFixed(2)})`,
      );
    }
    const hodlSign = hodlTotalUsd >= 0 ? '+' : '';
    lines.push(`  Σ HODL: <b>${hodlSign}$${hodlTotalUsd.toFixed(2)}</b>`);
    if (closedDetails.length > 0) {
      const diff = totalUsd - hodlTotalUsd;
      const diffSign = diff >= 0 ? '+' : '';
      const verdict = diff >= 0 ? 'наша стратегия ОБЫГРАЛА HODL' : 'наша стратегия ПРОИГРАЛА HODL';
      lines.push(`  Δ vs наш PnL: <b>${diffSign}$${diff.toFixed(2)}</b> — ${verdict}`);
    }
    lines.push('');
  }

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
