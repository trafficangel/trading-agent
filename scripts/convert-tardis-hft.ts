/** Convert normalized Tardis CSV samples into the collector's 250ms replay format. */

import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import {
  parseTardisBookSnapshot,
  parseTardisLiquidation,
  parseTardisTrade,
  type TardisEvent,
} from '../src/lib/tardis-hft.js';

const SAMPLE_US = 250_000;
const STALE_US = 3_000_000;
const VENUES = [
  { key: 'hl', id: 'hyperliquid', symbol: (coin: string) => coin },
  { key: 'binance', id: 'binance-futures', symbol: (coin: string) => `${coin}USDT` },
  { key: 'bybit', id: 'bybit', symbol: (coin: string) => `${coin}USDT` },
] as const;
type Venue = (typeof VENUES)[number]['key'];
type Parser = (line: string) => TardisEvent;

type Book = {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  bid5: number;
  ask5: number;
  exchangeAtUs: number;
  receivedAtUs: number;
};
type Flow = {
  buy: number;
  sell: number;
  buyHigh: number | null;
  sellLow: number | null;
  trades: number;
  prices: Map<number, number>;
};
type LiquidationFlow = { buyUsd: number; sellUsd: number };

class EventSource {
  current: TardisEvent | null = null;
  private readonly lines: Interface;
  private readonly iterator: AsyncIterator<string>;

  constructor(
    readonly venue: Venue,
    path: string,
    private readonly parser: Parser,
  ) {
    this.lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
    this.iterator = this.lines[Symbol.asyncIterator]();
  }

  async initialize(): Promise<void> {
    const header = await this.iterator.next();
    if (header.done) throw new Error(`empty Tardis input for ${this.venue}`);
    await this.advance();
  }

  async advance(): Promise<void> {
    const next = await this.iterator.next();
    this.current = next.done ? null : this.parser(next.value);
  }

  close(): void {
    this.lines.close();
  }
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function csvArg(argv: string[], flag: string): string[] {
  return (valueAfter(argv, flag) ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

function emptyFlow(): Flow {
  return { buy: 0, sell: 0, buyHigh: null, sellLow: null, trades: 0, prices: new Map() };
}

function emptyLiquidationFlow(): LiquidationFlow {
  return { buyUsd: 0, sellUsd: 0 };
}

function appendTrade(flow: Flow, event: Extract<TardisEvent, { kind: 'trade' }>): void {
  flow[event.side] += event.size;
  flow.trades++;
  if (event.side === 'buy') flow.buyHigh = flow.buyHigh == null ? event.price : Math.max(flow.buyHigh, event.price);
  else flow.sellLow = flow.sellLow == null ? event.price : Math.min(flow.sellLow, event.price);
  const signed = event.side === 'buy' ? event.size : -event.size;
  flow.prices.set(event.price, (flow.prices.get(event.price) ?? 0) + signed);
}

function bookTuple(book: Book): number[] {
  return [
    book.bid,
    book.ask,
    book.bidSize,
    book.askSize,
    book.bid5,
    book.ask5,
    book.exchangeAtUs / 1_000,
    book.receivedAtUs / 1_000,
  ];
}

function flowTuple(flow: Flow): Array<number | null> {
  return [flow.buy, flow.sell, flow.buyHigh, flow.sellLow, flow.trades];
}

function priceFlowTuple(flow: Flow): number[] {
  return [...flow.prices.entries()].sort((a, b) => a[0] - b[0]).flatMap(([price, size]) => [price, size]);
}

function sourcePath(input: string, venue: (typeof VENUES)[number], type: string, coin: string, date: string): string {
  return resolve(input, venue.id, type, venue.symbol(coin), `${date}.csv.gz`);
}

function nextSource(sources: EventSource[]): EventSource | undefined {
  let earliest: EventSource | undefined;
  for (const source of sources) {
    if (!source.current) continue;
    if (!earliest?.current || source.current.receivedAtUs < earliest.current.receivedAtUs) earliest = source;
  }
  return earliest;
}

async function convertCoin(
  input: string,
  date: string,
  coin: string,
  windowStartHour: number,
  windowHours: number,
  write: (line: string) => Promise<void>,
): Promise<number> {
  const sources: EventSource[] = [];
  for (const venue of VENUES) {
    const book = sourcePath(input, venue, 'book_snapshot_5', coin, date);
    const trades = sourcePath(input, venue, 'trades', coin, date);
    if (!existsSync(book) || !existsSync(trades)) throw new Error(`missing Tardis inputs for ${venue.id} ${coin} ${date}`);
    sources.push(new EventSource(venue.key, book, parseTardisBookSnapshot));
    sources.push(new EventSource(venue.key, trades, parseTardisTrade));
    if (venue.key !== 'hl') {
      const liquidations = sourcePath(input, venue, 'liquidations', coin, date);
      if (!existsSync(liquidations)) throw new Error(`missing Tardis liquidations for ${venue.id} ${coin} ${date}`);
      sources.push(new EventSource(venue.key, liquidations, parseTardisLiquidation));
    }
  }
  await Promise.all(sources.map((source) => source.initialize()));
  const books: Partial<Record<Venue, Book>> = {};
  let flows: Record<Venue, Flow> = { hl: emptyFlow(), binance: emptyFlow(), bybit: emptyFlow() };
  let liquidations: Record<'binance' | 'bybit', LiquidationFlow> = {
    binance: emptyLiquidationFlow(),
    bybit: emptyLiquidationFlow(),
  };
  const dayStartUs = Date.parse(`${date}T00:00:00Z`) * 1_000;
  const fromUs = dayStartUs + windowStartHour * 3_600_000_000;
  const toUs = Math.min(dayStartUs + 86_400_000_000, fromUs + windowHours * 3_600_000_000);
  let sampleAtUs = fromUs;
  let rows = 0;
  try {
    // Reconstruct the opening books without leaking hours of pre-window trade
    // flow into the first 250ms sample.
    while (true) {
      const source = nextSource(sources);
      if (!source?.current || source.current.receivedAtUs > fromUs - SAMPLE_US) break;
      if (source.current.kind === 'book') books[source.venue] = source.current;
      await source.advance();
    }
    while (sampleAtUs < toUs) {
      while (true) {
        const source = nextSource(sources);
        if (!source?.current || source.current.receivedAtUs > sampleAtUs) break;
        const event = source.current;
        if (event.kind === 'book') books[source.venue] = event;
        else if (event.kind === 'trade') appendTrade(flows[source.venue], event);
        else if (source.venue !== 'hl') liquidations[source.venue][`${event.side}Usd`] += event.price * event.size;
        await source.advance();
      }
      const ready = VENUES.every(({ key }) => {
        const book = books[key];
        return book && sampleAtUs >= book.receivedAtUs && sampleAtUs - book.receivedAtUs <= STALE_US;
      });
      if (ready) {
        const hl = books.hl!;
        await write(`${JSON.stringify({
          v: 1,
          t: sampleAtUs / 1_000,
          s: coin,
          h: bookTuple(hl),
          b: bookTuple(books.binance!),
          y: bookTuple(books.bybit!),
          f: [...flowTuple(flows.hl), ...flowTuple(flows.binance), ...flowTuple(flows.bybit)],
          x: priceFlowTuple(flows.hl),
          l: [
            liquidations.binance.buyUsd,
            liquidations.binance.sellUsd,
            liquidations.bybit.buyUsd,
            liquidations.bybit.sellUsd,
          ],
        })}\n`);
        rows++;
      }
      flows = { hl: emptyFlow(), binance: emptyFlow(), bybit: emptyFlow() };
      liquidations = { binance: emptyLiquidationFlow(), bybit: emptyLiquidationFlow() };
      sampleAtUs += SAMPLE_US;
    }
  } finally {
    for (const source of sources) source.close();
  }
  return rows;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const input = resolve(valueAfter(argv, '--input') ?? 'data/hft-tardis');
  const out = resolve(valueAfter(argv, '--out') ?? 'data/hft-tardis-replay');
  const dates = csvArg(argv, '--dates').sort();
  const coins = csvArg(argv, '--coins').map((coin) => coin.toUpperCase());
  const windowHours = Number(valueAfter(argv, '--window-hours') ?? 4);
  if (!dates.length || dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new Error('invalid --dates');
  if (!coins.length || coins.some((coin) => !/^[A-Z0-9]+$/.test(coin))) throw new Error('invalid --coins');
  if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 24 || 24 % windowHours !== 0) {
    throw new Error('--window-hours must be a whole divisor of 24');
  }
  mkdirSync(out, { recursive: true });
  let totalRows = 0;
  for (let dateIndex = 0; dateIndex < dates.length; dateIndex++) {
    const date = dates[dateIndex]!;
    const windowStartHour = (dateIndex * windowHours) % 24;
    const name = `leadlag-${date.replaceAll('-', '')}${String(windowStartHour).padStart(2, '0')}00.ndjson.gz`;
    const path = resolve(out, name);
    const temporary = `${path}.part`;
    rmSync(temporary, { force: true });
    const output = createWriteStream(temporary);
    const gzip = createGzip({ level: 6 });
    gzip.pipe(output);
    const write = async (line: string): Promise<void> => {
      if (!gzip.write(line)) await once(gzip, 'drain');
    };
    let dateRows = 0;
    try {
      for (const coin of coins) dateRows += await convertCoin(input, date, coin, windowStartHour, windowHours, write);
      gzip.end();
      await finished(output);
      renameSync(temporary, path);
    } catch (error) {
      gzip.destroy();
      output.destroy();
      rmSync(temporary, { force: true });
      throw error;
    }
    totalRows += dateRows;
    console.warn(`converted ${date} ${windowStartHour}:00-${windowStartHour + windowHours}:00: ${dateRows} rows`);
  }
  writeFileSync(resolve(out, 'status.json'), JSON.stringify({
    version: 'tardis-replay-v1',
    generatedAt: Date.now(),
    sampleMs: SAMPLE_US / 1_000,
    staleMs: STALE_US / 1_000,
    markets: coins,
    dates,
    rotatingWindowHours: windowHours,
    rows: totalRows,
    currentPath: '',
  }, null, 2));
  console.warn(`Tardis replay complete: ${totalRows} rows -> ${out}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
