/**
 * Backfill HL hourly funding into hl_micro.funding (ONE-TIME, 429-safe) so the funding sweep
 * reads from the DB instead of hammering the HL API mid-run (the 429s that broke the 10-coin
 * cross-symbol verdict). Funding is tiny (hourly, ~15k pts/coin) — the only issue was rate
 * limiting, fixed here with exponential backoff + inter-call delay. Run once on the VPS:
 *   pnpm tsx scripts/backfill-funding.ts [days]
 * Idempotent UPSERT on (coin,ts); only touches the funding column.
 */
import { db } from '../src/db/client.js';

const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'LTC', 'LINK', 'DOGE', 'AVAX'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 700);
const INFO = 'https://api.hyperliquid.xyz/info';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const up = db.prepare(
  `INSERT INTO hl_micro (coin, ts, funding) VALUES (?, ?, ?)
   ON CONFLICT(coin, ts) DO UPDATE SET funding = excluded.funding`,
);

async function fetchPage(coin: string, startMs: number, endMs: number): Promise<{ time: number; fundingRate: string }[]> {
  for (let attempt = 0; attempt < 7; attempt++) {
    const res = await fetch(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'fundingHistory', coin, startTime: startMs, endTime: endMs }) });
    if (res.status === 429) { const back = 1000 * 2 ** attempt; process.stderr.write(`  ${coin} 429 → backoff ${back}ms\n`); await sleep(back); continue; }
    if (!res.ok) throw new Error(`HL funding ${coin}: ${res.status}`);
    return (await res.json()) as { time: number; fundingRate: string }[];
  }
  throw new Error(`${coin}: 429 after retries`);
}

(async () => {
  const start = NOW - DAYS * 86_400_000;
  console.log(`backfill HL funding · ${COINS.length} coins · ${DAYS}d · → hl_micro.funding`);
  for (const coin of COINS) {
    let cursor = start; let n = 0; let guard = 0;
    while (cursor < NOW && guard++ < 300) {
      const arr = await fetchPage(coin, cursor, NOW);
      if (!arr.length) break;
      const tx = db.transaction((rows: { time: number; fundingRate: string }[]) => {
        for (const r of rows) up.run(coin, r.time, Number(r.fundingRate));
      });
      tx(arr); n += arr.length;
      const last = arr[arr.length - 1]!.time;
      if (last <= cursor) break;
      cursor = last + 1;
      await sleep(300); // courtesy gap between pages
      if (arr.length < 400) break;
    }
    console.log(`  ${coin}: ${n} funding pts`);
    await sleep(500); // gap between coins
  }
  const cov = db.prepare(`SELECT coin, COUNT(*) c, MIN(date(ts/1000,'unixepoch')) a, MAX(date(ts/1000,'unixepoch')) b FROM hl_micro WHERE funding IS NOT NULL GROUP BY coin ORDER BY coin`).all();
  console.log('funding rows in hl_micro:'); for (const r of cov as { coin: string; c: number; a: string; b: string }[]) console.log(`  ${r.coin}: ${r.c} (${r.a}..${r.b})`);
})().catch((e) => { console.error(e); process.exit(1); });
