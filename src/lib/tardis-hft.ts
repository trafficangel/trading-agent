export type TardisBookEvent = {
  kind: 'book';
  exchangeAtUs: number;
  receivedAtUs: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  bid5: number;
  ask5: number;
};

export type TardisTradeEvent = {
  kind: 'trade';
  exchangeAtUs: number;
  receivedAtUs: number;
  side: 'buy' | 'sell';
  price: number;
  size: number;
};

export type TardisLiquidationEvent = {
  kind: 'liquidation';
  exchangeAtUs: number;
  receivedAtUs: number;
  side: 'buy' | 'sell';
  price: number;
  size: number;
};

export type TardisEvent = TardisBookEvent | TardisTradeEvent | TardisLiquidationEvent;

function finitePositive(value: string | undefined, field: string): number {
  const number = Number(value);
  if (!(number > 0) || !Number.isFinite(number)) throw new Error(`invalid ${field}: ${value ?? ''}`);
  return number;
}

export function parseTardisBookSnapshot(line: string): TardisBookEvent {
  const cells = line.split(',');
  if (cells.length < 24) throw new Error(`invalid Tardis book row with ${cells.length} columns`);
  let ask5 = 0;
  let bid5 = 0;
  for (let level = 0; level < 5; level++) {
    ask5 += finitePositive(cells[5 + level * 4], `ask${level} size`);
    bid5 += finitePositive(cells[7 + level * 4], `bid${level} size`);
  }
  const ask = finitePositive(cells[4], 'ask');
  const bid = finitePositive(cells[6], 'bid');
  if (ask <= bid) throw new Error(`crossed Tardis book: ${bid}/${ask}`);
  return {
    kind: 'book',
    exchangeAtUs: finitePositive(cells[2], 'exchange timestamp'),
    receivedAtUs: finitePositive(cells[3], 'local timestamp'),
    ask,
    bid,
    askSize: finitePositive(cells[5], 'ask size'),
    bidSize: finitePositive(cells[7], 'bid size'),
    ask5,
    bid5,
  };
}

export function parseTardisTrade(line: string): TardisTradeEvent {
  return { kind: 'trade', ...parseDirectionalPrint(line) };
}

export function parseTardisLiquidation(line: string): TardisLiquidationEvent {
  return { kind: 'liquidation', ...parseDirectionalPrint(line) };
}

function parseDirectionalPrint(line: string): Omit<TardisTradeEvent, 'kind'> {
  const cells = line.split(',');
  if (cells.length < 8) throw new Error(`invalid Tardis print row with ${cells.length} columns`);
  const side = cells[5]?.toLowerCase();
  if (side !== 'buy' && side !== 'sell') throw new Error(`invalid print side: ${cells[5] ?? ''}`);
  return {
    exchangeAtUs: finitePositive(cells[2], 'exchange timestamp'),
    receivedAtUs: finitePositive(cells[3], 'local timestamp'),
    side,
    price: finitePositive(cells[6], 'trade price'),
    size: finitePositive(cells[7], 'trade size'),
  };
}
