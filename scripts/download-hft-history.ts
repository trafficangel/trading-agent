/**
 * Download synchronized raw inputs for the Hyperliquid microstructure study.
 *
 * Hyperliquid's official archive is an authenticated Requester Pays bucket.
 * The script lists objects before downloading, so the operator sees the exact
 * billable L2 byte count. Binance and Bybit trade archives are public; Binance
 * files are verified against the publisher's SHA-256 checksum.
 *
 * Usage:
 *   pnpm tsx scripts/download-hft-history.ts \
 *     --from 2026-06-24 --to 2026-06-30 --coins BTC,ETH,SOL --out data/hft-history
 *
 * Add --cex-only to prepare the free trade inputs before AWS access exists.
 * Add --manifest-only to inspect availability and billable HL bytes.
 */

import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const DAY_MS = 86_400_000;
const CONCURRENCY = Math.max(1, Number(process.env.HFT_DOWNLOAD_CONCURRENCY ?? 3));

type Args = {
  from: string;
  to: string;
  coins: string[];
  out: string;
  cexOnly: boolean;
  manifestOnly: boolean;
};

type S3Object = { Key: string; Size: number };
type DownloadResult = { source: string; path: string; status: 'downloaded' | 'cached' | 'missing'; bytes: number };

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function isoDate(value: string | undefined, flag: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${flag} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  const from = isoDate(valueAfter(argv, '--from'), '--from');
  const to = isoDate(valueAfter(argv, '--to'), '--to');
  if (Date.parse(`${from}T00:00:00Z`) > Date.parse(`${to}T00:00:00Z`)) throw new Error('--from must not be after --to');
  const coins = (valueAfter(argv, '--coins') ?? '')
    .split(',')
    .map((coin) => coin.trim().toUpperCase())
    .filter(Boolean);
  if (!coins.length || coins.some((coin) => !/^[A-Z0-9]+$/.test(coin))) {
    throw new Error('--coins must be a comma-separated list such as BTC,ETH,SOL');
  }
  return {
    from,
    to,
    coins: [...new Set(coins)],
    out: resolve(valueAfter(argv, '--out') ?? 'data/hft-history'),
    cexOnly: argv.includes('--cex-only'),
    manifestOnly: argv.includes('--manifest-only'),
  };
}

function dates(from: string, to: string): string[] {
  const result: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += DAY_MS) result.push(new Date(t).toISOString().slice(0, 10));
  return result;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = -1;
  do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(2)} ${units[unit]}`;
}

async function requireAwsIdentity(): Promise<void> {
  try {
    await execFile('aws', ['sts', 'get-caller-identity'], { maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error(
      'Hyperliquid history requires AWS CLI plus a valid billable IAM identity. Configure an IAM profile/role; never pass credentials on the command line.',
    );
  }
}

async function listHlObjects(day: string, coins: Set<string>): Promise<S3Object[]> {
  const compact = day.replaceAll('-', '');
  const { stdout } = await execFile('aws', [
    's3api', 'list-objects-v2',
    '--bucket', 'hyperliquid-archive',
    '--prefix', `market_data/${compact}/`,
    '--request-payer', 'requester',
    '--output', 'json',
    '--query', 'Contents[].{Key:Key,Size:Size}',
  ], { maxBuffer: 64 * 1024 * 1024 });
  const listed = JSON.parse(stdout || '[]') as S3Object[] | null;
  return (listed ?? []).filter((object) => {
    const match = object.Key.match(/\/l2Book\/([^/]+)\.lz4$/);
    return match?.[1] != null && coins.has(match[1]);
  });
}

async function downloadS3(object: S3Object, out: string): Promise<DownloadResult> {
  const relative = object.Key.replace(/^market_data\//, '');
  const path = resolve(out, 'hyperliquid', relative);
  if (existsSync(path) && statSync(path).size === object.Size) {
    return { source: 'hyperliquid', path, status: 'cached', bytes: object.Size };
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.part`;
  rmSync(temp, { force: true });
  try {
    await execFile('aws', [
      's3api', 'get-object',
      '--bucket', 'hyperliquid-archive',
      '--key', object.Key,
      '--request-payer', 'requester',
      temp,
    ], { maxBuffer: 4 * 1024 * 1024 });
    if (statSync(temp).size !== object.Size) throw new Error(`size mismatch for ${object.Key}`);
    renameSync(temp, path);
    return { source: 'hyperliquid', path, status: 'downloaded', bytes: object.Size };
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function fetchFile(url: string, path: string): Promise<'downloaded' | 'cached' | 'missing'> {
  if (existsSync(path) && statSync(path).size > 0) return 'cached';
  const response = await fetch(url);
  if (response.status === 404) return 'missing';
  if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.part`;
  rmSync(temp, { force: true });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
    renameSync(temp, path);
    return 'downloaded';
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

async function downloadBinance(day: string, coin: string, out: string): Promise<DownloadResult> {
  const symbol = `${coin}USDT`;
  const name = `${symbol}-aggTrades-${day}.zip`;
  const base = `https://data.binance.vision/data/futures/um/daily/aggTrades/${symbol}`;
  const path = resolve(out, 'binance', 'aggTrades', symbol, name);
  const status = await fetchFile(`${base}/${name}`, path);
  if (status === 'missing') return { source: 'binance', path, status, bytes: 0 };

  const checksumPath = `${path}.CHECKSUM`;
  const checksumStatus = await fetchFile(`${base}/${name}.CHECKSUM`, checksumPath);
  if (checksumStatus === 'missing') throw new Error(`missing Binance checksum for ${name}`);
  const expected = readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
  const actual = await sha256(path);
  if (!expected || actual !== expected.toLowerCase()) throw new Error(`SHA-256 mismatch for ${name}`);
  return { source: 'binance', path, status, bytes: statSync(path).size };
}

async function downloadBybit(day: string, coin: string, out: string): Promise<DownloadResult> {
  const symbol = `${coin}USDT`;
  const name = `${symbol}${day}.csv.gz`;
  const path = resolve(out, 'bybit', 'trades', symbol, name);
  const status = await fetchFile(`https://public.bybit.com/trading/${symbol}/${name}`, path);
  return { source: 'bybit', path, status, bytes: status === 'missing' ? 0 : statSync(path).size };
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
  const args = parseArgs(process.argv.slice(2));
  const days = dates(args.from, args.to);
  mkdirSync(args.out, { recursive: true });
  console.log(`HFT history ${args.from}..${args.to} · ${args.coins.join(',')} · ${args.out}`);

  let hlObjects: S3Object[] = [];
  if (!args.cexOnly) {
    await requireAwsIdentity();
    for (const day of days) hlObjects.push(...await listHlObjects(day, new Set(args.coins)));
    const hlBytes = hlObjects.reduce((sum, object) => sum + object.Size, 0);
    console.log(`Hyperliquid manifest: ${hlObjects.length} hourly L2 files, ${formatBytes(hlBytes)} billable transfer`);
    if (!hlObjects.length) console.warn('No matching Hyperliquid L2 objects were published for this range.');
  }

  if (args.manifestOnly) return;

  const jobs: Array<() => Promise<DownloadResult>> = [];
  for (const object of hlObjects) jobs.push(() => downloadS3(object, args.out));
  for (const day of days) for (const coin of args.coins) {
    jobs.push(() => downloadBinance(day, coin, args.out));
    jobs.push(() => downloadBybit(day, coin, args.out));
  }

  const results = await runLimited(jobs, CONCURRENCY);
  for (const result of results) {
    console.log(`${result.status.padEnd(10)} ${result.source.padEnd(11)} ${formatBytes(result.bytes).padStart(10)} ${basename(result.path)}`);
  }
  const downloaded = results.filter((result) => result.status === 'downloaded').reduce((sum, result) => sum + result.bytes, 0);
  const missing = results.filter((result) => result.status === 'missing').length;
  console.log(`Done: ${results.length - missing}/${results.length} files available, ${formatBytes(downloaded)} downloaded, ${missing} missing`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
