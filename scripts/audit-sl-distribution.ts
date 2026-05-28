/**
 * Standalone SL-distribution auditor.
 *
 * Usage:
 *   pnpm tsx scripts/audit-sl-distribution.ts                  # audit ALL strategies
 *   pnpm tsx scripts/audit-sl-distribution.ts <strategy-id>    # audit one
 *   pnpm tsx scripts/audit-sl-distribution.ts --cap 7          # use 7% cap instead of 5%
 *
 * Reads `src/strategies/data/<id>.json` (the trades log scraped by
 * `import-strategy.ts`) and prints the loss distribution + verdict for
 * each strategy.
 *
 * Use this when:
 *   - Re-validating an existing strategy after adding more trade history
 *   - Sanity-checking a strategy whose live performance differs from backtest
 *   - Exploring a different SL cap before making a config change
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeSlDistribution, formatSlDistribution, type AnalyzableTrade } from '../src/lib/sl-distribution.js';
import { STRATEGY_CONFIGS, MAX_SAFE_SL_PCT } from '../src/strategies/track-c-config.js';

function parseArgs(argv: string[]): { id: string | null; capPct: number } {
  let id: string | null = null;
  let capPct = MAX_SAFE_SL_PCT * 100;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--cap' || a === '-c') {
      const v = parseFloat(argv[++i] ?? '');
      if (!Number.isFinite(v) || v <= 0 || v > 100) {
        console.error(`bad --cap value: ${argv[i]}`);
        process.exit(2);
      }
      capPct = v;
    } else if (a.startsWith('-')) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else {
      id = a;
    }
  }
  return { id, capPct };
}

function loadTrades(strategyId: string): AnalyzableTrade[] | null {
  const path = resolve('src/strategies/data', `${strategyId}.json`);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    tradesLog?: Array<AnalyzableTrade & { maePct?: number }>
  };
  if (!raw.tradesLog || !Array.isArray(raw.tradesLog)) return null;
  return raw.tradesLog
    .map((t) => ({
      side: t.side,
      entryPrice: Number(t.entryPrice),
      exitPrice: Number(t.exitPrice),
      maePct: typeof t.maePct === 'number' ? t.maePct : undefined,
    }))
    .filter((t) => Number.isFinite(t.entryPrice) && Number.isFinite(t.exitPrice));
}

function listAvailableStrategies(): string[] {
  return readdirSync('src/strategies/data')
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

function auditOne(strategyId: string, capPct: number): void {
  const cfg = STRATEGY_CONFIGS[strategyId];
  const trades = loadTrades(strategyId);
  const banner = `STRAT-${cfg?.code ?? '???'} · ${strategyId}` +
    (cfg ? ` · current slPct=${(cfg.slPct * 100).toFixed(2)}% · enabled=${cfg.enabled ? 'yes' : 'no'}` : ' (not in STRATEGY_CONFIGS)');
  console.log(`\n${'='.repeat(banner.length)}\n${banner}\n${'='.repeat(banner.length)}`);
  if (!trades) {
    console.log(`  ⚠ No trades log at src/strategies/data/${strategyId}.json — skip.`);
    return;
  }
  const dist = analyzeSlDistribution(trades, { maxSlPct: capPct / 100 });
  console.log(formatSlDistribution(dist));
}

function main(): void {
  const { id, capPct } = parseArgs(process.argv);

  console.log(`\nSL-distribution audit · cap = ${capPct.toFixed(1)}% · target cut rate = 10%`);

  if (id) {
    auditOne(id, capPct);
    return;
  }

  console.log(`Auditing ALL strategies with a trades log…\n`);
  const ids = listAvailableStrategies();
  // Sort: enabled first (alphabetical), then disabled.
  const ordered = ids.sort((a, b) => {
    const ea = STRATEGY_CONFIGS[a]?.enabled ? 0 : 1;
    const eb = STRATEGY_CONFIGS[b]?.enabled ? 0 : 1;
    return ea - eb || a.localeCompare(b);
  });
  for (const sid of ordered) {
    auditOne(sid, capPct);
  }
}

main();
