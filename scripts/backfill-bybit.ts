/**
 * Backfill BYBIT open-interest (1h) + funding (8h) history into bybit_micro
 * (ONE-TIME, rate-safe), so the cross-venue / OI-gate sweeps read from the DB
 * instead of hammering Bybit mid-run. Bybit OI history reaches ~365d @ 1h and
 * funding ~700d @ 8h — both cover the funding-flip validation window (unlike
 * hl_micro.oi which is forward-collected, ~11d). Run ONCE on the VPS (Bybit is
 * geo-blocked locally):
 *   pnpm tsx scripts/backfill-bybit.ts [days]
 * Idempotent UPSERT on (coin, ts). OI writes hourly; funding at 8h stamps
 * (null elsewhere, forward-filled at query time). Causal — all settled history.
 */
import { db } from '../src/db/client.js';

const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'LTC', 'LINK', 'DOGE', 'AVAX'];
const NOW = Date.now();
const DAYS = Number(process.argv[2] ?? 400);
const BASE = 'https://api.bybit.com';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const upOi = db.prepare(
  `INSERT INTO bybit_micro (coin, ts, oi) VALUES (?, ?, ?)
   ON CONFLICT(coin, ts) DO UPDATE SET oi = excluded.oi`,
);
const upFnd = db.prepare(
  `INSERT INTO bybit_micro (coin, ts, funding) VALUES (?, ?, ?)
   ON CONFLICT(coin, ts) DO UPDATE SET funding = excluded.funding`,
);

type BybitResult = { list?: Record<string, string>[]; nextPageCursor?: string };

async function getJson(url: string): Promise<BybitResult> {
  for (let attempt = 0; attempt < 7; attempt++) {
    let status = 0;
    let body: { retCode: number; retMsg: string; result?: BybitResult } | null = null;
    try {
      const res = await fetch(url, { method: 'GET' });
      status = res.status;
      if (res.ok) body = (await res.json()) as { retCode: number; retMsg: string; result?: BybitResult };
    } catch (e) {
      const back = 1000 * 2 ** attempt; process.stderr.write(`  net err → backoff ${back}ms (${(e as Error).message})\n`); await sleep(back); continue;
    }
    if (status === 429 || status === 403) { const back = 1000 * 2 ** attempt; process.stderr.write(`  ${status} → backoff ${back}ms\n`); await sleep(back); continue; }
    if (!body) throw new Error(`bybit HTTP ${status}`);
    if (body.retCode === 10006 || body.retCode === 10018) { const back = 1000 * 2 ** attempt; process.stderr.write(`  retCode ${body.retCode} → backoff ${back}ms\n`); await sleep(back); continue; }
    if (body.retCode !== 0) throw new Error(`bybit retCode ${body.retCode}: ${body.retMsg}`);
    return body.result ?? {};
  }
  throw new Error('bybit: rate-limited after retries');
}

/** Walk back from NOW to startMs in 200-point pages (newest-first), endTime cursor. */
async function backfillOi(coin: string, startMs: number): Promise<{ n: number; oldest: number }> {
  const sym = `${coin}USDT`;
  let endMs = NOW; let n = 0; let oldest = NOW; let guard = 0;
  while (guard++ < 300) {
    const r = await getJson(`${BASE}/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=1h&startTime=${startMs}&endTime=${endMs}&limit=200`);
    const list = r.list ?? [];
    if (!list.length) break;
    const tx = db.transaction((rows: Record<string, string>[]) => {
      for (const x of rows) { const ts = Number(x.timestamp); const oi = Number(x.openInterest); if (Number.isFinite(ts) && Number.isFinite(oi)) upOi.run(coin, ts, oi); }
    });
    tx(list); n += list.length;
    const minTs = Math.min(...list.map((x) => Number(x.timestamp)));
    oldest = Math.min(oldest, minTs);
    if (minTs <= startMs || list.length < 200) break;
    endMs = minTs - 1;
    await sleep(250);
  }
  return { n, oldest };
}

/** Same endTime-walk for 8h funding history. */
async function backfillFunding(coin: string, startMs: number): Promise<{ n: number; oldest: number }> {
  const sym = `${coin}USDT`;
  let endMs = NOW; let n = 0; let oldest = NOW; let guard = 0;
  while (guard++ < 300) {
    const r = await getJson(`${BASE}/v5/market/funding/history?category=linear&symbol=${sym}&startTime=${startMs}&endTime=${endMs}&limit=200`);
    const list = r.list ?? [];
    if (!list.length) break;
    const tx = db.transaction((rows: Record<string, string>[]) => {
      for (const x of rows) { const ts = Number(x.fundingRateTimestamp); const f = Number(x.fundingRate); if (Number.isFinite(ts) && Number.isFinite(f)) upFnd.run(coin, ts, f); }
    });
    tx(list); n += list.length;
    const minTs = Math.min(...list.map((x) => Number(x.fundingRateTimestamp)));
    oldest = Math.min(oldest, minTs);
    if (minTs <= startMs || list.length < 200) break;
    endMs = minTs - 1;
    await sleep(250);
  }
  return { n, oldest };
}

(async () => {
  const startMs = NOW - DAYS * 86_400_000;
  console.log(`backfill BYBIT OI(1h)+funding(8h) · ${COINS.length} coins · ${DAYS}d · → bybit_micro`);
  for (const coin of COINS) {
    const oi = await backfillOi(coin, startMs);
    await sleep(400);
    const fn = await backfillFunding(coin, startMs);
    console.log(`  ${coin}: OI ${oi.n} (→ ${new Date(oi.oldest).toISOString().slice(0, 10)}) · FND ${fn.n} (→ ${new Date(fn.oldest).toISOString().slice(0, 10)})`);
    await sleep(500);
  }
  const cov = db.prepare(`SELECT coin, SUM(oi IS NOT NULL) oiN, SUM(funding IS NOT NULL) fndN, MIN(date(ts/1000,'unixepoch')) a, MAX(date(ts/1000,'unixepoch')) b FROM bybit_micro GROUP BY coin ORDER BY coin`).all();
  console.log('bybit_micro coverage:');
  for (const r of cov as { coin: string; oiN: number; fndN: number; a: string; b: string }[]) console.log(`  ${r.coin}: oi ${r.oiN} fnd ${r.fndN} (${r.a}..${r.b})`);
})().catch((e) => { console.error(e); process.exit(1); });
