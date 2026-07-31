import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeDb, db } from '../src/db/client.js';
import { auditEr60Strategy, type Er60Trade } from '../src/lib/lighter-er60-audit.js';

const outputArg = process.argv.indexOf('--output');
const output = resolve(outputArg >= 0 && process.argv[outputArg + 1]
  ? process.argv[outputArg + 1]!
  : 'data/lighter-native-er60-audit.json');

type Row = {
  strategy_id: string;
  side: 'long' | 'short';
  opened_at: number;
  closed_at: number;
  net_pnl_pct: number;
  native_er60: number;
};

const strategyIds = ['btc-vwz60-touch', 'hype-vwz60-touch'] as const;
const rows = db.prepare<string[], Row>(`
  SELECT trade.strategy_id, trade.side, trade.opened_at, trade.closed_at,
         trade.net_pnl_pct, signal.native_er60
  FROM lighter_lux_trades trade
  JOIN lighter_lux_signals signal ON signal.id = trade.entry_signal_id
  WHERE trade.strategy_id IN (${strategyIds.map(() => '?').join(',')})
    AND trade.notional_usd = 100
    AND trade.closed_at IS NOT NULL
    AND trade.net_pnl_pct IS NOT NULL
    AND signal.native_er60 IS NOT NULL
  ORDER BY trade.closed_at, trade.id`).all(...strategyIds);

const audits = Object.fromEntries(strategyIds.map((strategyId) => {
  const trades: Er60Trade[] = rows
    .filter((row) => row.strategy_id === strategyId)
    .map((row) => ({
      side: row.side,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      netPct: row.net_pnl_pct,
      er60: row.native_er60,
    }));
  return [strategyId, auditEr60Strategy(trades)];
}));

const report = {
  version: 'lighter-native-er60-prospective-v1',
  generatedAt: new Date().toISOString(),
  cohort: {
    notionalUsd: 100,
    source: 'completed 5m Native signals recorded after migration 061',
    autoChangesTrading: false,
  },
  policy: {
    minimumClosed: 60,
    minimumCoverageDays: 30,
    minimumRetainedPerSide: 10,
    minimumExcluded: 10,
    minimumProfitFactorImprovement: 0.10,
    note: 'Eligibility is evidence for manual replacement review, never automatic activation.',
  },
  audits,
};

writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
closeDb();
