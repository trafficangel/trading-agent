/**
 * CVD-divergence kill battery on mature and extended Hyperliquid universes.
 * Mature coins have a 340-day CVD backfill; extended alts are reported only as
 * an 8-day preliminary panel and can never pass the promotion verdict here.
 *
 * Run on the VPS: pnpm tsx scripts/sweep-cvd-divergence.ts
 */
import { writeFileSync } from 'node:fs';
import { getKlines } from '../src/backtest/klines.js';
import { runBacktest, type SlMode } from '../src/backtest/engine.js';
import { loadMicroAligned } from '../src/backtest/micro.js';
import { cvdDivergence } from '../src/backtest/strategies/families-flow.js';
import type { Candle } from '../src/backtest/indicators.js';

type Instrument = { coin: string; symbol: string };
type Config = { signature: string; tf: '15' | '30'; lookback: number; slMode: SlMode };
type ResultRow = {
  universe: 'mature' | 'extended';
  signature: string;
  coin: string;
  n: number;
  net: number;
  stressNet: number;
  profitFactor: number;
  winRate: number;
  maxDrawdown: number;
  inSampleNet: number;
  outOfSampleNet: number;
  positiveFolds: number;
  green: boolean;
};

const NOW = Date.now();
const COST_PCT = 0.09;
const MATURE_DAYS = 340;
const EXTENDED_DAYS = 8;
const MATURE: Instrument[] = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'LTC', 'LINK', 'DOGE', 'AVAX']
  .map((coin) => ({ coin, symbol: `${coin}USDT` }));
const EXTENDED: Instrument[] = [
  { coin: 'ICP', symbol: 'ICPUSDT' },
  { coin: 'NEAR', symbol: 'NEARUSDT' },
  { coin: 'ATOM', symbol: 'ATOMUSDT' },
  { coin: 'CRV', symbol: 'CRVUSDT' },
  { coin: 'ENA', symbol: 'ENAUSDT' },
  { coin: 'TIA', symbol: 'TIAUSDT' },
  { coin: 'kPEPE', symbol: '1000PEPEUSDT' },
  { coin: 'RENDER', symbol: 'RENDERUSDT' },
  { coin: 'POPCAT', symbol: 'POPCATUSDT' },
  { coin: 'JUP', symbol: 'JUPUSDT' },
  { coin: 'AR', symbol: 'ARUSDT' },
  { coin: 'EIGEN', symbol: 'EIGENUSDT' },
  { coin: 'MANTA', symbol: 'MANTAUSDT' },
  { coin: 'JTO', symbol: 'JTOUSDT' },
  { coin: 'PNUT', symbol: 'PNUTUSDT' },
  { coin: 'ALT', symbol: 'ALTUSDT' },
  { coin: 'BLUR', symbol: 'BLURUSDT' },
];

const CONFIGS: Config[] = [];
for (const tf of ['15', '30'] as const) {
  for (const lookback of [8, 12, 20, 32, 48]) {
    CONFIGS.push({ signature: `cvdN${lookback}-${tf}-native`, tf, lookback, slMode: { kind: 'none' } });
    CONFIGS.push({
      signature: `cvdN${lookback}-${tf}-guarded`,
      tf,
      lookback,
      slMode: { kind: 'atr+time', mult: 4, period: 14, bars: tf === '15' ? 16 : 8 },
    });
  }
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function net(values: number[], costPct: number): number {
  return rounded(values.reduce((sum, value) => sum + value - costPct, 0));
}

function profitFactor(values: number[], costPct: number): number {
  let gains = 0;
  let losses = 0;
  for (const value of values) {
    const pnl = value - costPct;
    if (pnl > 0) gains += pnl;
    else if (pnl < 0) losses += Math.abs(pnl);
  }
  return losses > 0 ? rounded(gains / losses) : gains > 0 ? 99 : 0;
}

function maxDrawdown(values: number[], costPct: number): number {
  let cumulative = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of values) {
    cumulative += value - costPct;
    peak = Math.max(peak, cumulative);
    drawdown = Math.max(drawdown, peak - cumulative);
  }
  return rounded(drawdown);
}

function positiveFolds(values: number[], costPct: number): number {
  const foldSize = Math.floor(values.length / 4);
  if (foldSize < 4) return -1;
  let positive = 0;
  for (let fold = 0; fold < 4; fold++) {
    const end = fold === 3 ? values.length : (fold + 1) * foldSize;
    if (net(values.slice(fold * foldSize, end), costPct) > 0) positive++;
  }
  return positive;
}

async function loadPanel(instruments: Instrument[], days: number): Promise<Map<string, Candle[]>> {
  const panel = new Map<string, Candle[]>();
  for (const instrument of instruments) {
    for (const tf of ['15', '30'] as const) {
      try {
        const candles = await getKlines(instrument.symbol, tf, NOW - days * 86_400_000, NOW);
        panel.set(`${instrument.coin}:${tf}`, candles);
      } catch (error) {
        process.stderr.write(`  ${instrument.coin} ${tf}m skipped: ${(error as Error).message}\n`);
      }
    }
    process.stderr.write(`  loaded ${instrument.coin}\n`);
  }
  return panel;
}

function runUniverse(
  universe: ResultRow['universe'],
  instruments: Instrument[],
  panel: Map<string, Candle[]>,
): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const config of CONFIGS) {
    for (const instrument of instruments) {
      const candles = panel.get(`${instrument.coin}:${config.tf}`);
      if (!candles || candles.length < 500) continue;
      const micro = loadMicroAligned(instrument.coin, config.tf, candles);
      if (micro.withData < 200) continue;
      const strategy = cvdDivergence(instrument.symbol, config.tf, micro, config.lookback);
      const pnls = runBacktest(strategy, candles, config.slMode).tradesLog.map((trade) => trade.realizedPct);
      if (pnls.length < 8) continue;
      const split = Math.floor(pnls.length * 0.7);
      const inSampleNet = net(pnls.slice(0, split), COST_PCT);
      const outOfSampleNet = net(pnls.slice(split), COST_PCT);
      const pf = profitFactor(pnls, COST_PCT);
      const folds = positiveFolds(pnls, COST_PCT);
      const rowNet = net(pnls, COST_PCT);
      const stressNet = net(pnls, COST_PCT * 2);
      const green = universe === 'mature'
        && pnls.length >= 30
        && rowNet > 0
        && stressNet > 0
        && pf >= 1.20
        && inSampleNet > 0
        && outOfSampleNet > 0
        && folds >= 3;
      rows.push({
        universe,
        signature: config.signature,
        coin: instrument.coin,
        n: pnls.length,
        net: rowNet,
        stressNet,
        profitFactor: pf,
        winRate: rounded(pnls.filter((pnl) => pnl > COST_PCT).length / pnls.length),
        maxDrawdown: maxDrawdown(pnls, COST_PCT),
        inSampleNet,
        outOfSampleNet,
        positiveFolds: folds,
        green,
      });
    }
    process.stderr.write(`  tested ${universe} ${config.signature}\n`);
  }
  return rows;
}

function line(row: ResultRow): string {
  return `${row.green ? 'KEEP' : '    '} ${row.coin.padEnd(7)} ${row.signature.padEnd(24)} N${String(row.n).padStart(4)} net ${row.net.toFixed(2).padStart(8)} stress ${row.stressNet.toFixed(2).padStart(8)} PF ${row.profitFactor.toFixed(2).padStart(5)} WR ${(row.winRate * 100).toFixed(0).padStart(3)}% DD ${row.maxDrawdown.toFixed(2).padStart(7)} f${row.positiveFolds}/4 IS/OOS ${row.inSampleNet.toFixed(1)}/${row.outOfSampleNet.toFixed(1)}`;
}

function robustSignatures(rows: ResultRow[]): { signature: string; green: ResultRow[] }[] {
  const grouped = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.signature) ?? [];
    bucket.push(row);
    grouped.set(row.signature, bucket);
  }
  return [...grouped.entries()]
    .map(([signature, signatureRows]) => ({ signature, green: signatureRows.filter((row) => row.green) }))
    .filter((entry) => entry.green.length >= 4)
    .sort((a, b) => b.green.length - a.green.length);
}

async function main(): Promise<void> {
  console.log(`CVD divergence kill battery · cost ${COST_PCT}% · stress ${COST_PCT * 2}%`);
  console.log(`Mature: ${MATURE.length} coins × ${MATURE_DAYS}d. Extended: ${EXTENDED.length} coins × ${EXTENDED_DAYS}d preliminary.\n`);
  const maturePanel = await loadPanel(MATURE, MATURE_DAYS);
  const matureRows = runUniverse('mature', MATURE, maturePanel);
  const robust = robustSignatures(matureRows);

  console.log('\n===== MATURE ROBUST SIGNATURES (green on >=4/10) =====');
  if (robust.length === 0) console.log('  none');
  for (const entry of robust) {
    console.log(`\n${entry.signature}: ${entry.green.length}/10`);
    console.log(entry.green.sort((a, b) => b.net - a.net).map(line).join('\n'));
  }
  console.log('\nMature top rows:');
  console.log([...matureRows].sort((a, b) => b.stressNet - a.stressNet).slice(0, 15).map(line).join('\n'));

  const extendedPanel = await loadPanel(EXTENDED, EXTENDED_DAYS);
  const extendedRows = runUniverse('extended', EXTENDED, extendedPanel);
  console.log('\n===== EXTENDED 8-DAY PRELIMINARY (never promotable) =====');
  console.log([...extendedRows].sort((a, b) => b.stressNet - a.stressNet).slice(0, 20).map(line).join('\n'));

  const rows = [...matureRows, ...extendedRows];
  writeFileSync('data/sweep-cvd-divergence-results.json', JSON.stringify(rows, null, 2));
  console.log(`\nVerdict: ${robust.length ? 'candidate signatures found; require independent forward shadow' : 'no cross-symbol mature CVD-divergence edge'}.`);
  console.log('Full results: data/sweep-cvd-divergence-results.json');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
