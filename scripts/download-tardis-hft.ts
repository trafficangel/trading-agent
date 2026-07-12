/** Download the no-key first-of-month Tardis HFT samples without paid access. */

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const CONCURRENCY = Math.max(1, Number(process.env.HFT_DOWNLOAD_CONCURRENCY ?? 3));
const MAX_FILE_BYTES = Number(process.env.HFT_TARDIS_MAX_FILE_BYTES ?? 1_073_741_824);
const VENUES = [
  { id: 'hyperliquid', symbol: (coin: string) => coin },
  { id: 'binance-futures', symbol: (coin: string) => `${coin}USDT` },
  { id: 'bybit', symbol: (coin: string) => `${coin}USDT` },
] as const;
const MARKET_DATA_TYPES = ['book_snapshot_5', 'trades'] as const;

type Job = { date: string; exchange: string; dataType: string; symbol: string; url: string; path: string };
type Result = Job & { status: 'cached' | 'downloaded'; bytes: number };

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function csvArg(argv: string[], flag: string): string[] {
  return (valueAfter(argv, flag) ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

async function download(job: Job): Promise<Result> {
  if (existsSync(job.path) && statSync(job.path).size > 0) {
    return { ...job, status: 'cached', bytes: statSync(job.path).size };
  }
  const response = await fetch(job.url);
  if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText}: ${job.url}`);
  const advertised = Number(response.headers.get('x-dataset-size') ?? response.headers.get('content-length') ?? 0);
  if (advertised > MAX_FILE_BYTES) {
    await response.body.cancel();
    throw new Error(`${job.url} is ${advertised} bytes, above HFT_TARDIS_MAX_FILE_BYTES=${MAX_FILE_BYTES}`);
  }
  mkdirSync(dirname(job.path), { recursive: true });
  const temporary = `${job.path}.part`;
  rmSync(temporary, { force: true });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    const bytes = statSync(temporary).size;
    if (advertised > 0 && bytes !== advertised) throw new Error(`size mismatch for ${job.url}: ${bytes}/${advertised}`);
    renameSync(temporary, job.path);
    return { ...job, status: 'downloaded', bytes };
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

async function runLimited<T>(jobs: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dates = csvArg(argv, '--dates');
  const coins = csvArg(argv, '--coins').map((coin) => coin.toUpperCase());
  const out = resolve(valueAfter(argv, '--out') ?? 'data/hft-tardis');
  if (!dates.length || dates.some((date) => !/^\d{4}-\d{2}-01$/.test(date))) {
    throw new Error('--dates must contain only free first-of-month dates, e.g. 2026-04-01,2026-05-01');
  }
  if (!coins.length || coins.some((coin) => !/^[A-Z0-9]+$/.test(coin))) {
    throw new Error('--coins must be a comma-separated list such as BTC,ETH');
  }
  if (process.env.TARDIS_API_KEY) {
    throw new Error('TARDIS_API_KEY must be unset: this command is intentionally restricted to free samples');
  }

  const jobs: Job[] = [];
  for (const date of [...new Set(dates)]) for (const coin of [...new Set(coins)]) {
    const [year, month, day] = date.split('-');
    for (const venue of VENUES) for (const dataType of [
      ...MARKET_DATA_TYPES,
      ...(venue.id === 'hyperliquid' ? [] : ['liquidations'] as const),
    ]) {
      const symbol = venue.symbol(coin);
      const url = `https://datasets.tardis.dev/v1/${venue.id}/${dataType}/${year}/${month}/${day}/${symbol}.csv.gz`;
      jobs.push({
        date,
        exchange: venue.id,
        dataType,
        symbol,
        url,
        path: resolve(out, venue.id, dataType, symbol, `${date}.csv.gz`),
      });
    }
  }
  console.warn(`Tardis free samples: ${jobs.length} files for ${coins.join(',')} across ${dates.length} days`);
  const results = await runLimited(jobs.map((job) => () => download(job)), CONCURRENCY);
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify({ generatedAt: Date.now(), dates, coins, results }, null, 2));
  const bytes = results.reduce((sum, result) => sum + result.bytes, 0);
  console.warn(`Tardis download complete: ${results.length} files, ${(bytes / 1024 ** 3).toFixed(2)} GiB`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
