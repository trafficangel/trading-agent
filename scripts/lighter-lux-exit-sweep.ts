/**
 * Read-only exit-overlay research for the LuxAlgo -> Lighter portfolio.
 *
 * Replays the exact shadow entry/exit windows over 1m Bybit candles (a liquid
 * price-path proxy) and compares:
 *   - the native LuxAlgo exit;
 *   - alternative hard stops;
 *   - fixed take-profits;
 *   - trailing exits that arm only after a favourable move.
 *
 * It never writes to the trading DB and never touches live positions.
 * Run on the VPS, where Bybit public klines are reachable:
 *   pnpm tsx scripts/lighter-lux-exit-sweep.ts
 */

import type { Candle } from '../src/backtest/indicators.js';
import { getKlines } from '../src/backtest/klines.js';
import { closeDb, db } from '../src/db/client.js';

type Side = 'long' | 'short';

type Trade = {
  id: number;
  strategy_id: string;
  symbol: string;
  side: Side;
  opened_at: number;
  closed_at: number;
  entry_price: number;
  exit_price: number;
  funding_pnl_pct: number;
  net_pnl_pct: number;
};

type OpenTrade = Omit<Trade, 'closed_at' | 'exit_price' | 'net_pnl_pct'>;

type Variant =
  | { kind: 'native'; name: string }
  | { kind: 'stop'; name: string; stopPct: number }
  | { kind: 'take-profit'; name: string; stopPct: number; takeProfitPct: number }
  | { kind: 'trailing'; name: string; stopPct: number; armPct: number; trailPct: number };

type Outcome = {
  tradeId: number;
  strategyId: string;
  variant: string;
  pnlPct: number;
  exitedAt: number;
  reason: 'native' | 'stop' | 'take-profit' | 'trailing';
};

type Metrics = {
  variant: string;
  trades: number;
  netPct: number;
  avgPct: number;
  winRatePct: number;
  maxDrawdownPct: number;
  worstPct: number;
  changed: number;
};

const MINUTE_MS = 60_000;

const STRATEGY_STOP_PCT: Record<string, number> = {
  'sol-lg-mf50': 5,
  'eth-cntr-st': 4,
  'btc-choch-cfm-tc': 3.5,
  'ltc-tcs-smart-trail': 5,
  'uni-cfm-smart-weak': 5,
  'dot-cntr-tc-hw': 5,
  'hbar-cfm-smart-weak': 5,
  'aave-cntr-strong': 5,
  'xrp-choch-mf50': 5,
  'bnb-fvgm-tc-hw': 5,
  'bnb-cntr-hw-weak': 5,
  'doge-fvgm-smart-tc': 5,
  'ada-cntr-mf-hw': 5,
  'ada-cfm-cntr-hw': 5,
  'pol-fvgm-neo-tsr': 5,
};

const FIXED_STOP_GRID = [2, 3, 4, 5];
const FIXED_TP_GRID = [1, 2, 3, 4, 5];
const TRAILING_GRID = [
  { armPct: 1, trailPct: 0.5 },
  { armPct: 2, trailPct: 0.5 },
  { armPct: 2, trailPct: 1 },
  { armPct: 3, trailPct: 0.5 },
  { armPct: 3, trailPct: 1 },
  { armPct: 3, trailPct: 1.5 },
  { armPct: 4, trailPct: 1 },
  { armPct: 4, trailPct: 1.5 },
  { armPct: 4, trailPct: 2 },
];

function pct(side: Side, entry: number, exit: number): number {
  return (side === 'long' ? 1 : -1) * (exit - entry) / entry * 100;
}

function stopPrice(side: Side, entry: number, stopPct: number): number {
  return side === 'long'
    ? entry * (1 - stopPct / 100)
    : entry * (1 + stopPct / 100);
}

function takeProfitPrice(side: Side, entry: number, takeProfitPct: number): number {
  return side === 'long'
    ? entry * (1 + takeProfitPct / 100)
    : entry * (1 - takeProfitPct / 100);
}

function trailPrice(side: Side, best: number, trailPct: number): number {
  return side === 'long'
    ? best * (1 - trailPct / 100)
    : best * (1 + trailPct / 100);
}

function stopTouched(side: Side, candle: Candle, price: number): boolean {
  return side === 'long' ? candle.l <= price : candle.h >= price;
}

function targetTouched(side: Side, candle: Candle, price: number): boolean {
  return side === 'long' ? candle.h >= price : candle.l <= price;
}

function favourableExtreme(side: Side, candle: Candle): number {
  return side === 'long' ? candle.h : candle.l;
}

function better(side: Side, candidate: number, current: number): boolean {
  return side === 'long' ? candidate > current : candidate < current;
}

function estimatedFunding(trade: Trade, exitedAt: number): number {
  const nativeDuration = Math.max(1, trade.closed_at - trade.opened_at);
  const variantDuration = Math.max(0, Math.min(nativeDuration, exitedAt - trade.opened_at));
  return trade.funding_pnl_pct * variantDuration / nativeDuration;
}

function variantOutcome(trade: Trade, candles: Candle[], variant: Variant): Outcome {
  if (variant.kind === 'native') {
    return {
      tradeId: trade.id,
      strategyId: trade.strategy_id,
      variant: variant.name,
      pnlPct: trade.net_pnl_pct,
      exitedAt: trade.closed_at,
      reason: 'native',
    };
  }

  const hardStop = stopPrice(trade.side, trade.entry_price, variant.stopPct);
  const fixedTarget = variant.kind === 'take-profit'
    ? takeProfitPrice(trade.side, trade.entry_price, variant.takeProfitPct)
    : null;
  let best = trade.entry_price;
  let armed = false;

  for (const candle of candles) {
    // Conservative same-bar ordering: hard stop first, then an already-armed
    // trail, then a fixed target. New highs/lows arm or tighten the trail only
    // after this bar, so the model never assumes an unknowable intrabar path.
    if (stopTouched(trade.side, candle, hardStop)) {
      return {
        tradeId: trade.id,
        strategyId: trade.strategy_id,
        variant: variant.name,
        pnlPct: pct(trade.side, trade.entry_price, hardStop) + estimatedFunding(trade, candle.t),
        exitedAt: candle.t,
        reason: 'stop',
      };
    }

    if (variant.kind === 'trailing' && armed) {
      const trailingStop = trailPrice(trade.side, best, variant.trailPct);
      if (stopTouched(trade.side, candle, trailingStop)) {
        return {
          tradeId: trade.id,
          strategyId: trade.strategy_id,
          variant: variant.name,
          pnlPct: pct(trade.side, trade.entry_price, trailingStop) + estimatedFunding(trade, candle.t),
          exitedAt: candle.t,
          reason: 'trailing',
        };
      }
    }

    if (fixedTarget != null && targetTouched(trade.side, candle, fixedTarget)) {
      return {
        tradeId: trade.id,
        strategyId: trade.strategy_id,
        variant: variant.name,
        pnlPct: pct(trade.side, trade.entry_price, fixedTarget) + estimatedFunding(trade, candle.t),
        exitedAt: candle.t,
        reason: 'take-profit',
      };
    }

    const extreme = favourableExtreme(trade.side, candle);
    if (better(trade.side, extreme, best)) best = extreme;
    if (
      variant.kind === 'trailing'
      && !armed
      && pct(trade.side, trade.entry_price, best) >= variant.armPct
    ) armed = true;
  }

  return {
    tradeId: trade.id,
    strategyId: trade.strategy_id,
    variant: variant.name,
    pnlPct: pct(trade.side, trade.entry_price, trade.exit_price) + trade.funding_pnl_pct,
    exitedAt: trade.closed_at,
    reason: 'native',
  };
}

function metrics(name: string, outcomes: Outcome[]): Metrics {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let wins = 0;
  let worst = Infinity;
  let changed = 0;
  for (const outcome of outcomes) {
    equity += outcome.pnlPct;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (outcome.pnlPct > 0) wins += 1;
    worst = Math.min(worst, outcome.pnlPct);
    if (outcome.reason !== 'native') changed += 1;
  }
  return {
    variant: name,
    trades: outcomes.length,
    netPct: equity,
    avgPct: outcomes.length ? equity / outcomes.length : 0,
    winRatePct: outcomes.length ? wins / outcomes.length * 100 : 0,
    maxDrawdownPct: maxDrawdown,
    worstPct: Number.isFinite(worst) ? worst : 0,
    changed,
  };
}

function variants(): Variant[] {
  const out: Variant[] = [{ kind: 'native', name: 'native Lux exit' }];
  for (const stopPct of FIXED_STOP_GRID) {
    out.push({ kind: 'stop', name: `SL ${stopPct}%`, stopPct });
  }
  for (const takeProfitPct of FIXED_TP_GRID) {
    out.push({
      kind: 'take-profit',
      name: `TP ${takeProfitPct}%`,
      stopPct: 5,
      takeProfitPct,
    });
  }
  for (const { armPct, trailPct } of TRAILING_GRID) {
    out.push({
      kind: 'trailing',
      name: `trail arm ${armPct}% / gap ${trailPct}%`,
      stopPct: 5,
      armPct,
      trailPct,
    });
  }
  return out;
}

function fmt(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`;
}

function isoMinute(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ');
}

async function main(): Promise<void> {
  const trades = db.prepare<[], Trade>(`
    SELECT id,strategy_id,symbol,side,opened_at,closed_at,entry_price,exit_price,
           funding_pnl_pct,net_pnl_pct
    FROM lighter_lux_trades
    WHERE closed_at IS NOT NULL
      AND exit_price IS NOT NULL
      AND net_pnl_pct IS NOT NULL
    ORDER BY closed_at,id
  `).all();

  if (!trades.length) {
    console.log('No closed Lighter-Lux shadow trades yet.');
    return;
  }

  const candlesByTrade = new Map<number, Candle[]>();
  const bySymbol = new Map<string, Trade[]>();
  for (const trade of trades) {
    const symbol = `${trade.symbol.replace(/USDT$/i, '')}USDT`;
    const rows = bySymbol.get(symbol) ?? [];
    rows.push(trade);
    bySymbol.set(symbol, rows);
  }

  for (const [symbol, symbolTrades] of bySymbol) {
    const from = Math.min(...symbolTrades.map((trade) => trade.opened_at)) - MINUTE_MS;
    const to = Math.max(...symbolTrades.map((trade) => trade.closed_at)) + MINUTE_MS;
    const candles = await getKlines(symbol, '1', from, to);
    for (const trade of symbolTrades) {
      candlesByTrade.set(
        trade.id,
        candles.filter((candle) => candle.t >= trade.opened_at && candle.t <= trade.closed_at),
      );
    }
  }

  const usableTrades = trades.filter((trade) => (candlesByTrade.get(trade.id)?.length ?? 0) > 0);
  const skipped = trades.length - usableTrades.length;
  const allVariants = variants();
  const outcomes = new Map<string, Outcome[]>();

  for (const variant of allVariants) {
    const rows: Outcome[] = [];
    for (const trade of usableTrades) {
      const configuredStop = STRATEGY_STOP_PCT[trade.strategy_id] ?? 5;
      const resolved = variant.kind === 'native'
        ? variant
        : { ...variant, stopPct: variant.kind === 'stop' ? variant.stopPct : configuredStop };
      rows.push(variantOutcome(trade, candlesByTrade.get(trade.id) ?? [], resolved));
    }
    outcomes.set(variant.name, rows);
  }

  const ranked = allVariants
    .map((variant) => metrics(variant.name, outcomes.get(variant.name) ?? []))
    .sort((a, b) => b.netPct - a.netPct);
  const native = ranked.find((row) => row.variant === 'native Lux exit');

  console.log(`\nLighter-Lux exit sweep · 1m Bybit path proxy · N=${usableTrades.length}` +
    `${skipped ? ` · skipped(no candles)=${skipped}` : ''}`);
  console.log('Funding is time-prorated; Lighter fee is 0%. Same-bar ordering is conservative.\n');
  console.log(
    `${'variant'.padEnd(31)} ${'net'.padStart(10)} ${'Δnative'.padStart(10)} ` +
    `${'avg'.padStart(10)} ${'WR'.padStart(8)} ${'maxDD'.padStart(10)} ` +
    `${'worst'.padStart(10)} ${'exits'.padStart(7)}`,
  );
  console.log('-'.repeat(105));
  for (const row of ranked) {
    const delta = row.netPct - (native?.netPct ?? 0);
    console.log(
      `${row.variant.padEnd(31)} ${fmt(row.netPct).padStart(10)} ${fmt(delta).padStart(10)} ` +
      `${fmt(row.avgPct).padStart(10)} ${(row.winRatePct.toFixed(1) + '%').padStart(8)} ` +
      `${fmt(-row.maxDrawdownPct).padStart(10)} ${fmt(row.worstPct).padStart(10)} ` +
      `${String(row.changed).padStart(7)}`,
    );
  }

  const half = Math.floor(usableTrades.length / 2);
  if (half >= 5) {
    console.log('\nChronological halves (anti-overfit check):');
    for (const row of ranked.slice(0, 6)) {
      const rows = outcomes.get(row.variant) ?? [];
      const first = metrics(row.variant, rows.slice(0, half));
      const second = metrics(row.variant, rows.slice(half));
      console.log(
        `  ${row.variant.padEnd(31)} first ${fmt(first.netPct).padStart(9)} · ` +
        `second ${fmt(second.netPct).padStart(9)}`,
      );
    }
  }

  const openTrades = db.prepare<[], OpenTrade>(`
    SELECT id,strategy_id,symbol,side,opened_at,entry_price,
           COALESCE(funding_pnl_pct,0) funding_pnl_pct
    FROM lighter_lux_trades
    WHERE closed_at IS NULL
    ORDER BY opened_at,id
  `).all();
  if (!openTrades.length) return;

  console.log('\nOpen positions (provisional; excluded from ranking):');
  for (const open of openTrades) {
    const now = Date.now();
    const symbol = `${open.symbol.replace(/USDT$/i, '')}USDT`;
    const candles = await getKlines(symbol, '1', open.opened_at - MINUTE_MS, now);
    const path = candles.filter((candle) => candle.t >= open.opened_at && candle.t <= now);
    const last = path.at(-1);
    if (!last) {
      console.log(`  #${open.id} ${open.strategy_id}: no current candles`);
      continue;
    }
    const synthetic: Trade = {
      ...open,
      closed_at: now,
      exit_price: last.c,
      net_pnl_pct: pct(open.side, open.entry_price, last.c) + open.funding_pnl_pct,
    };
    const configuredStop = STRATEGY_STOP_PCT[open.strategy_id] ?? 5;
    const provisional = allVariants.map((variant) => {
      const resolved = variant.kind === 'native'
        ? variant
        : { ...variant, stopPct: variant.kind === 'stop' ? variant.stopPct : configuredStop };
      return variantOutcome(synthetic, path, resolved);
    });
    const nativeMark = provisional.find((row) => row.variant === 'native Lux exit');
    const changed = provisional
      .filter((row) => row.reason !== 'native')
      .sort((a, b) => b.pnlPct - a.pnlPct);
    const peakMove = path.reduce((best, candle) => {
      const move = pct(open.side, open.entry_price, favourableExtreme(open.side, candle));
      return Math.max(best, move);
    }, 0);

    console.log(
      `  #${open.id} ${open.strategy_id} ${open.side.toUpperCase()} · ` +
      `mark ${fmt(nativeMark?.pnlPct ?? 0)} · MFE ${fmt(peakMove)} · ` +
      `open ${isoMinute(open.opened_at)} UTC`,
    );
    if (!changed.length) {
      console.log('    no tested exit overlay has fired yet');
      continue;
    }
    for (const outcome of changed) {
      console.log(
        `    ${outcome.variant.padEnd(31)} -> ${fmt(outcome.pnlPct).padStart(9)} · ` +
        `${outcome.reason} at ${isoMinute(outcome.exitedAt)} UTC`,
      );
    }
  }
}

try {
  await main();
} finally {
  closeDb();
}
