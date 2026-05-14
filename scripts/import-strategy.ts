/**
 * LuxAlgo AI Strategy Builder importer.
 *
 * Usage:
 *   pnpm tsx scripts/import-strategy.ts <strategy-url> [--code 002] [--slug ton-foo-bar]
 *
 * Opens the LuxAlgo chat URL with the saved storage state, scrapes the
 * three Strategy Tester tabs (Performance, Trades Analysis, Trades Log),
 * and writes:
 *
 *   data/imports/<slug>.json   — raw scraped data (all three tabs)
 *   stdout                     — a ready-to-paste StrategyConfig block
 *
 * Then you (operator) paste the block into src/strategies/track-c-config.ts,
 * commit, deploy.
 *
 * Why this exists: the previous "send me screenshots" workflow took
 * ~5 min per strategy and risked transcription error. This runs in
 * ~15 seconds and gives us the raw trades log too, so we can recompute
 * everything under our standard commission + simulate safety-SL effects.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { getLuxAlgoContext, closeLuxAlgoBrowser } from '../src/browser/luxalgo.js';

// ---------- Types ----------

type ScrapedPerformance = {
  symbol: string;
  timeframe: string;
  strategyTitle: string;
  // Strategy Configuration block (left side)
  evaluationStart: string | null;
  longConditions: string | null;
  shortConditions: string | null;
  exitCondition: string | null;
  orderSize: string | null;
  performanceSummaryProse: string | null;
  // Right-side Performance tab KPIs (the big numbers above the small charts)
  netProfit: number; // USDT, signed
  trades: number;
  winRatePct: number; // 0..100
  winsLossesLabel: string | null; // e.g. "76 | 28"
  maxDrawdownUsdt: number; // unsigned
  maxDrawdownPct: number; // unsigned
  profitFactor: number;
  // Detailed All/Long/Short table on Performance tab
  detailed: {
    netProfit: TripleNum;
    cagrPct: TripleNum;
    grossProfit: TripleNum;
    grossLoss: TripleNum;
    profitFactor: TripleNum;
    avgPerDay: TripleNum;
    avgPerWeek: TripleNum;
    drawdown: { usdt: number; pct: number };
  };
};

type ScrapedTradesAnalysis = {
  closedTrades: TripleNum;
  winningTrades: TripleNum;
  losingTrades: TripleNum;
  winRatePct: TripleNum;
  avgPnl: TripleNum;
  avgWinningTrade: TripleNum;
  avgLosingTrade: TripleNum;
  largestWinningTrade: TripleNum;
  largestLosingTrade: TripleNum;
  avgTradeDurationBars: TripleNum;
  avgWinningDurationBars: TripleNum;
  avgLosingDurationBars: TripleNum;
};

type TradeRow = {
  num: number;
  side: 'long' | 'short';
  entryAt: number | null; // unix ms
  entryPrice: number;
  exitAt: number | null;
  exitPrice: number;
  netPnlUsdt: number;
  cumulativePnlUsdt: number;
};

type TripleNum = { all: number; long: number; short: number };

type ScrapeResult = {
  url: string;
  scrapedAt: number;
  performance: ScrapedPerformance;
  tradesAnalysis: ScrapedTradesAnalysis;
  tradesLog: TradeRow[];
};

// ---------- Date parsing (RU locale) ----------

const RU_MONTH: Record<string, number> = {
  янв: 0, февр: 1, март: 2, апр: 3, мая: 4, июн: 5,
  июл: 6, авг: 7, сент: 8, окт: 9, нояб: 10, дек: 11,
};

/**
 * Parse LuxAlgo date strings. Examples seen:
 *   "ср, 13 мая 2026 г., 12:45"
 *   "пн, 11 мая 2026 г., 15:15"
 * Returns unix ms or null.
 *
 * Note: LuxAlgo renders in user's browser locale. With Cyrillic months,
 * we manually parse. If user switches LuxAlgo to English, falls back to
 * Date.parse (which handles English month names natively).
 */
function parseLuxAlgoDate(raw: string): number | null {
  const s = raw.trim();
  // Try English first (Date.parse handles "Wed, May 13, 2026, 12:45")
  const en = Date.parse(s);
  if (!Number.isNaN(en)) return en;
  // Russian: "ср, 13 мая 2026 г., 12:45"
  const m = s.match(
    /(\d{1,2})\s+([а-яё]+)\s+(\d{4})\s*г?\.?,?\s*(\d{1,2}):(\d{2})/i,
  );
  if (!m) return null;
  const day = parseInt(m[1]!, 10);
  const monKey = m[2]!.toLowerCase().slice(0, 4).replace(/[^а-яё]/g, '');
  const month =
    RU_MONTH[monKey] ??
    RU_MONTH[m[2]!.toLowerCase().slice(0, 3)] ??
    RU_MONTH[m[2]!.toLowerCase().slice(0, 2)];
  if (month === undefined) return null;
  const year = parseInt(m[3]!, 10);
  const hour = parseInt(m[4]!, 10);
  const min = parseInt(m[5]!, 10);
  // Treat as UTC (LuxAlgo's tooltip showed "(UTC)" — backtest is in UTC)
  return Date.UTC(year, month, day, hour, min);
}

// ---------- Number parsing ----------

/** "+864.65 USDT" → 864.65, "-49.60 USDT" → -49.60, "73.08%" → 73.08, "1.3K USDT" → 1300. */
function parseNum(raw: string): number {
  if (!raw) return NaN;
  let s = raw.replace(/\s|usdt|%/gi, '').replace(',', '.').trim();
  let mult = 1;
  if (/k$/i.test(s)) {
    mult = 1000;
    s = s.replace(/k$/i, '');
  } else if (/m$/i.test(s)) {
    mult = 1_000_000;
    s = s.replace(/m$/i, '');
  }
  const n = parseFloat(s);
  return Number.isNaN(n) ? NaN : n * mult;
}

// ---------- Scrape: Performance tab ----------

async function clickTab(page: Page, name: 'Performance' | 'Trades Analysis' | 'Trades Log'): Promise<void> {
  // The three tabs render as text links with underline-on-active. Use
  // getByRole('tab') first; fall back to plain text locator if LuxAlgo
  // doesn't use ARIA tabs.
  const tab = page.getByRole('tab', { name, exact: true });
  if ((await tab.count()) > 0) {
    await tab.first().click();
  } else {
    await page.getByText(name, { exact: true }).first().click();
  }
  // LuxAlgo's tab switches do a content swap but no URL change — wait
  // for content to settle by polling for a tab-specific anchor text.
  const anchor = {
    Performance: 'Net Daily PNL',
    'Trades Analysis': 'P&L Distribution',
    'Trades Log': 'Trade #',
  }[name];
  await page.waitForSelector(`text=${anchor}`, { timeout: 15_000 });
  await page.waitForTimeout(500);
}

/**
 * Find a row by its label and read three columns (All / Long / Short).
 * Generic helper — works on both Performance detailed table and
 * Trades Analysis table since both use the same layout pattern.
 *
 * Strategy: locate the label text node, walk to its row container,
 * pull the next three numeric-looking cells.
 */
async function readTriple(page: Page, label: string): Promise<TripleNum> {
  // Approach: locate the row by label, then read ALL spans/cells inside,
  // pick last 3 numeric values.
  // LuxAlgo uses a div-based table. The label and values share a parent.
  const row = page.locator(`xpath=//*[normalize-space(text())="${label}"]/ancestor::*[self::tr or self::div][1]`).first();
  const text = await row.innerText({ timeout: 5_000 }).catch(() => '');
  if (!text) return { all: NaN, long: NaN, short: NaN };
  // Strip the label, split remainder on whitespace/newlines, find numbers.
  const tail = text.replace(label, '').trim();
  // Match signed numbers possibly followed by k/M suffix and units.
  const nums = tail
    .split(/[\s\n]+/)
    .map((t) => parseNum(t))
    .filter((n) => !Number.isNaN(n));
  if (nums.length < 3) {
    // Fallback — maybe split picked the wrong tokens. Try regex.
    const numRe = /-?\d[\d,.]*\s*(?:K|M)?(?=\s|$|USDT|%)/gi;
    const matches = tail.match(numRe) ?? [];
    const parsed = matches.map(parseNum).filter((n) => !Number.isNaN(n));
    if (parsed.length >= 3) {
      return { all: parsed[0]!, long: parsed[1]!, short: parsed[2]! };
    }
  }
  return { all: nums[0] ?? NaN, long: nums[1] ?? NaN, short: nums[2] ?? NaN };
}

async function scrapePerformance(page: Page): Promise<ScrapedPerformance> {
  await clickTab(page, 'Performance');

  // Title / symbol / TF from the header row "BNBUSDT 15m   Contrarian Any - Trend Tracer - Money Flow Above 50"
  const headerText = await page
    .locator('text=/[A-Z]{2,}USDT?\\s+\\d+[mhd]/i')
    .first()
    .innerText()
    .catch(() => '');
  const headerMatch = headerText.match(/([A-Z]{2,}USDT?)\s+(\d+[mhd])/i);
  const symbol = headerMatch?.[1] ?? '';
  const timeframe = (headerMatch?.[2] ?? '').replace(/[mhd]/i, '');

  // Strategy title — next to the symbol/TF. Often the H2-like heading.
  const strategyTitle = await page
    .locator(`text=/[A-Z]{2,}USDT?\\s+\\d+[mhd]/`)
    .first()
    .locator('xpath=following::*[1]')
    .innerText()
    .catch(() => '');

  // Strategy Configuration block (left side)
  const configBlock = await page
    .locator('text=Strategy Configuration')
    .first()
    .locator('xpath=..')
    .innerText()
    .catch(() => '');
  const evalMatch = configBlock.match(/Evaluation Start[:\s]+([^\n•]+)/i);
  const longMatch = configBlock.match(/Long Entry Conditions[:\s]+([^\n•]+)/i);
  const shortMatch = configBlock.match(/Short Entry Conditions[:\s]+([^\n•]+)/i);
  const exitMatch = configBlock.match(/Exit Condition[:\s]+([^\n•]+)/i);
  const orderSizeMatch = configBlock.match(/Order Size[:\s]+([^\n•]+)/i);

  // Performance Summary prose
  const summaryBlock = await page
    .locator('text=Performance Summary')
    .first()
    .locator('xpath=..')
    .innerText()
    .catch(() => '');
  const summaryProse = summaryBlock.replace(/^Performance Summary\s*/i, '').trim();

  // Top KPI strip: NET PROFIT / TRADES / WIN RATE / MAX DRAWDOWN / PROFIT FACTOR
  // These render as label-then-value pairs. Read each by label.
  async function readKpi(label: string): Promise<string> {
    const loc = page.locator(`text=${label}`).first();
    // The value is the immediate sibling block; walk to parent and grab.
    return loc
      .locator('xpath=..')
      .innerText()
      .then((t) => t.replace(label, '').trim())
      .catch(() => '');
  }
  const netProfitStr = await readKpi('NET PROFIT');
  const tradesStr = await readKpi('TRADES');
  const winRateStr = await readKpi('WIN RATE');
  const maxDdStr = await readKpi('MAX DRAWDOWN');
  const profitFactorStr = await readKpi('PROFIT FACTOR');

  // WIN RATE comes as "73.08% 76 | 28" — pull pct + W|L
  const wrPctMatch = winRateStr.match(/(\d+\.?\d*)\s*%/);
  const wlMatch = winRateStr.match(/(\d+)\s*\|\s*(\d+)/);
  // MAX DRAWDOWN: "103.56 0.95%" → 103.56 USDT, 0.95%
  const ddMatch = maxDdStr.match(/(\d+\.?\d*)\s+(\d+\.?\d*)\s*%/);

  // Detailed All/Long/Short table on Performance tab
  const detailed = {
    netProfit: await readTriple(page, 'Net Profit'),
    cagrPct: await readTriple(page, 'CAGR'),
    grossProfit: await readTriple(page, 'Gross Profit'),
    grossLoss: await readTriple(page, 'Gross Loss'),
    profitFactor: await readTriple(page, 'Profit Factor'),
    avgPerDay: await readTriple(page, 'Average P&L per Day'),
    avgPerWeek: await readTriple(page, 'Average P&L per Week'),
    drawdown: { usdt: NaN, pct: NaN },
  };
  // Drawdown row is special: "103.56 USDT (0.95%)" single value, not triple
  const ddRowText = await page
    .locator(`xpath=//*[normalize-space(text())="Drawdown"]/ancestor::*[self::tr or self::div][1]`)
    .first()
    .innerText()
    .catch(() => '');
  const ddRowMatch = ddRowText.match(/(\d+\.?\d*)\s*USDT\s*\(?\s*(\d+\.?\d*)\s*%\)?/);
  if (ddRowMatch) {
    detailed.drawdown.usdt = parseFloat(ddRowMatch[1]!);
    detailed.drawdown.pct = parseFloat(ddRowMatch[2]!);
  }

  return {
    symbol,
    timeframe,
    strategyTitle: strategyTitle.trim().split('\n')[0] ?? '',
    evaluationStart: evalMatch?.[1]?.trim() ?? null,
    longConditions: longMatch?.[1]?.trim() ?? null,
    shortConditions: shortMatch?.[1]?.trim() ?? null,
    exitCondition: exitMatch?.[1]?.trim() ?? null,
    orderSize: orderSizeMatch?.[1]?.trim() ?? null,
    performanceSummaryProse: summaryProse || null,
    netProfit: parseNum(netProfitStr),
    trades: parseNum(tradesStr),
    winRatePct: wrPctMatch ? parseFloat(wrPctMatch[1]!) : NaN,
    winsLossesLabel: wlMatch ? `${wlMatch[1]} | ${wlMatch[2]}` : null,
    maxDrawdownUsdt: ddMatch ? parseFloat(ddMatch[1]!) : NaN,
    maxDrawdownPct: ddMatch ? parseFloat(ddMatch[2]!) : NaN,
    profitFactor: parseNum(profitFactorStr),
    detailed,
  };
}

// ---------- Scrape: Trades Analysis tab ----------

async function scrapeTradesAnalysis(page: Page): Promise<ScrapedTradesAnalysis> {
  await clickTab(page, 'Trades Analysis');
  return {
    closedTrades: await readTriple(page, 'Closed Trades'),
    winningTrades: await readTriple(page, 'Winning Trades'),
    losingTrades: await readTriple(page, 'Losing Trades'),
    winRatePct: await readTriple(page, 'Win Rate'),
    avgPnl: await readTriple(page, 'Avg P&L'),
    avgWinningTrade: await readTriple(page, 'Avg Winning Trade'),
    avgLosingTrade: await readTriple(page, 'Avg Losing Trade'),
    largestWinningTrade: await readTriple(page, 'Largest Winning Trade'),
    largestLosingTrade: await readTriple(page, 'Largest Losing Trade'),
    avgTradeDurationBars: await readTriple(page, 'Avg Trade Duration (bars)'),
    avgWinningDurationBars: await readTriple(page, 'Avg Winning Trade Duration (bars)'),
    avgLosingDurationBars: await readTriple(page, 'Avg Losing Trade Duration (bars)'),
  };
}

// ---------- Scrape: Trades Log tab ----------

async function scrapeTradesLog(page: Page, expectedTotal: number): Promise<TradeRow[]> {
  await clickTab(page, 'Trades Log');

  const collected = new Map<number, TradeRow>(); // dedup by trade number

  // The log container is the scrollable element containing the rows.
  // We scroll inside it (not the window) because the left strategy
  // sidebar is also scrollable.
  const tableLocator = page.locator('text=Trade #').first().locator('xpath=ancestor::*[contains(@class, "overflow") or contains(@style, "overflow")][1]');

  type VisibleRow = { num: number; side: 'long' | 'short'; cells: string[] };
  const extractVisibleRows = async (): Promise<VisibleRow[]> => {
    // page.evaluate body is serialized as a string, so DOM types aren't
    // needed in our TS lib. Pass as a Function-string (same pattern as
    // src/browser/tradingview.ts).
    const raw = (await page.evaluate(`(() => {
      const rows = [];
      const all = document.querySelectorAll('[role="row"], tr, div');
      for (const el of Array.from(all)) {
        const t = el.innerText || '';
        if (!t || t.length > 400) continue;
        const m = t.match(/^\\s*(\\d{1,3})\\s*\\n?\\s*(long|short)/i);
        if (!m) continue;
        const num = parseInt(m[1], 10);
        const side = m[2].toLowerCase();
        // Skip if any child matches too — pick deepest match
        const children = el.querySelectorAll('*');
        let childMatch = false;
        for (let i = 0; i < children.length; i++) {
          const ct = children[i].innerText || '';
          if (ct !== t && /^\\s*\\d{1,3}\\s*\\n?\\s*(long|short)/i.test(ct)) {
            childMatch = true; break;
          }
        }
        if (childMatch) continue;
        rows.push({ num, side, cells: t.split('\\n').map(function(s){return s.trim();}).filter(Boolean) });
      }
      return rows;
    })()`)) as VisibleRow[];
    return raw;
  };

  // Scroll and accumulate. Stop when we have all expected rows OR 5 no-progress passes.
  let stuck = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    const visible = await extractVisibleRows();
    const before = collected.size;
    for (const v of visible) {
      if (collected.has(v.num)) continue;
      // Cells layout: [num, side, entryDate, entryPrice "672.5750 USDT",
      //                exitDate, exitPrice, netPnL, cumPnL]
      // Some cells may glob together; reconstruct conservatively.
      const flat = v.cells.join(' ');
      const dateAndPrice = (chunk: string) => {
        // "ср, 13 мая 2026 г., 12:45 672.5750 USDT"
        const priceMatch = chunk.match(/(\d+\.\d+)\s*USDT/);
        const price = priceMatch ? parseFloat(priceMatch[1]!) : NaN;
        const dateMatch = chunk.match(/^(.*?)\s*\d+\.\d+\s*USDT/);
        const at = dateMatch ? parseLuxAlgoDate(dateMatch[1]!) : null;
        return { price, at };
      };
      // Split by USDT occurrences — net PnL and cumulative PnL each have USDT
      // Pattern overall: NUM SIDE DATE1 PRICE1_USDT DATE2 PRICE2_USDT NETPNL_USDT CUMPNL_USDT
      const usdtSplits = flat.split(/(?<=\d\.\d{2,4}\s*USDT)/);
      // After splits we likely have: [entry chunk] [exit chunk] [net pnl chunk] [cum pnl chunk]
      const entry = dateAndPrice(usdtSplits[0] ?? '');
      const exit = dateAndPrice(usdtSplits[1] ?? '');
      const netNum = parseNum(usdtSplits[2] ?? '');
      const cumNum = parseNum(usdtSplits[3] ?? '');
      collected.set(v.num, {
        num: v.num,
        side: v.side,
        entryAt: entry.at,
        entryPrice: entry.price,
        exitAt: exit.at,
        exitPrice: exit.price,
        netPnlUsdt: netNum,
        cumulativePnlUsdt: cumNum,
      });
    }
    if (collected.size === before) stuck++;
    else stuck = 0;

    if (collected.size >= expectedTotal) break;
    if (stuck >= 5) break;

    // Scroll the inner container if we have a handle, else page scroll.
    const handleCount = await tableLocator.count();
    if (handleCount > 0) {
      await tableLocator
        .first()
        .evaluate(`(el) => { el.scrollBy(0, 1000); }`)
        .catch(() => {});
    } else {
      await page.mouse.wheel(0, 1000);
    }
    await page.waitForTimeout(350);
  }

  return Array.from(collected.values()).sort((a, b) => a.num - b.num);
}

// ---------- Main ----------

function deriveSlPctFromTrades(trades: TradeRow[]): { suggestion: number; rationale: string } {
  // Pick the 90th percentile of losing-trade % drawdown (entryPrice basis)
  // and add a small buffer. Conservative — preempts the worst 10% of losses.
  if (trades.length === 0) {
    return { suggestion: 0.025, rationale: 'no trades — defaulting to 2.5%' };
  }
  const lossPcts = trades
    .filter((t) => t.netPnlUsdt < 0)
    .map((t) => {
      // Approximate loss as % of entry price (notional-normalized).
      // For a $1000 notional position, netPnlUsdt is also the % × 10.
      // Better: use entry vs exit price directly.
      const sign = t.side === 'long' ? -1 : 1;
      return sign * ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100;
    })
    .filter((p) => p > 0 && Number.isFinite(p))
    .sort((a, b) => b - a);
  if (lossPcts.length === 0) {
    return { suggestion: 0.025, rationale: 'no parseable losses — defaulting to 2.5%' };
  }
  // 90th percentile = top 10% worst
  const idx = Math.max(0, Math.floor(lossPcts.length * 0.1) - 1);
  const p90 = lossPcts[idx]!;
  // Round to nearest 0.5%
  const suggestionPct = Math.round((p90 * 1.2) * 2) / 2;
  return {
    suggestion: suggestionPct / 100,
    rationale: `90th-percentile loss = ${p90.toFixed(2)}%, × 1.2 buffer → suggested SL ${suggestionPct.toFixed(2)}%`,
  };
}

function renderConfigBlock(
  args: {
    id: string;
    code: string;
    url: string;
    perf: ScrapedPerformance;
    analysis: ScrapedTradesAnalysis;
    slPct: number;
    slRationale: string;
    tradesLogCount: number;
  },
): string {
  const { id, code, url, perf, analysis, slPct, slRationale, tradesLogCount } = args;
  const desc = `${perf.symbol} ${perf.timeframe}m | LONG: ${perf.longConditions ?? '—'} | SHORT: ${perf.shortConditions ?? '—'} | EXIT: ${perf.exitCondition ?? '—'}`;
  const periodDays = perf.evaluationStart
    ? Math.round((Date.now() - (Date.parse(perf.evaluationStart) || 0)) / 86_400_000)
    : 0;
  // Period label: "<start> — <today>"
  const periodLabel = `${perf.evaluationStart ?? '?'} — today`;

  // Long/Short PnL % off detailed table
  const longPnlPct = perf.detailed.netProfit.long / 10; // $1000 notional
  const shortPnlPct = perf.detailed.netProfit.short / 10;

  return `  // Imported from LuxAlgo: ${url}
  // Scraped ${new Date().toISOString().slice(0, 10)}, ${tradesLogCount} trades in log.
  // ${slRationale}
  '${id}': {
    id: '${id}',
    code: '${code}',
    description:
      '${desc.replace(/'/g, "\\'")}',
    longDescription:
      ${JSON.stringify(perf.performanceSummaryProse ?? '')},
    symbol: '${perf.symbol}',
    timeframe: '${perf.timeframe}',
    enabled: true,
    slPct: ${slPct},
    launchedAt: Date.parse('${new Date().toISOString()}'),
    backtest: {
      periodLabel: ${JSON.stringify(periodLabel)},
      periodDays: ${periodDays},
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: ${perf.netProfit.toFixed(2)},
      netPnlPct: ${(perf.netProfit / 10).toFixed(2)},
      cagrPct: ${perf.detailed.cagrPct.all.toFixed(2)},
      totalTrades: ${perf.trades},
      wins: ${analysis.winningTrades.all},
      losses: ${analysis.losingTrades.all},
      winRate: ${(perf.winRatePct / 100).toFixed(4)},
      profitFactor: ${perf.profitFactor.toFixed(3)},
      commissionPaidUsd: ${(perf.trades * 1000 * 0.00055 * 2).toFixed(2)},
      maxDrawdownPct: ${perf.maxDrawdownPct.toFixed(2)},
      maxDrawdownUsd: ${perf.maxDrawdownUsdt.toFixed(2)},
      avgWinUsd: ${analysis.avgWinningTrade.all.toFixed(2)},
      avgWinPct: ${(analysis.avgWinningTrade.all / 10).toFixed(2)},
      avgLossUsd: ${analysis.avgLosingTrade.all.toFixed(2)},
      avgLossPct: ${(analysis.avgLosingTrade.all / 10).toFixed(2)},
      largestWinUsd: ${analysis.largestWinningTrade.all.toFixed(2)},
      largestLossUsd: ${analysis.largestLosingTrade.all.toFixed(2)},
      longTrades: ${analysis.closedTrades.long},
      longPnlPct: ${longPnlPct.toFixed(2)},
      shortTrades: ${analysis.closedTrades.short},
      shortPnlPct: ${shortPnlPct.toFixed(2)},
    },
  },`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args.find((a) => a.startsWith('http'));
  if (!url) {
    console.error('Usage: pnpm tsx scripts/import-strategy.ts <luxalgo-strategy-url> [--code 002] [--slug ton-foo]');
    process.exit(1);
  }
  const codeIdx = args.indexOf('--code');
  const slugIdx = args.indexOf('--slug');
  const code = codeIdx !== -1 ? args[codeIdx + 1]! : 'XXX';
  const slug = slugIdx !== -1 ? args[slugIdx + 1]! : 'TBD';

  const ctx = await getLuxAlgoContext();
  const page = await ctx.newPage();
  try {
    console.error(`→ Opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Strategy Tester right pane takes a couple of seconds to render.
    await page.waitForSelector('text=Strategy Configuration', { timeout: 30_000 });
    await page.waitForSelector('text=Performance', { timeout: 15_000 });
    await page.waitForTimeout(2_000);

    console.error('→ Scraping Performance tab…');
    const performance = await scrapePerformance(page);
    console.error(`  trades=${performance.trades}, WR=${performance.winRatePct}%, PF=${performance.profitFactor}, NetPnL=${performance.netProfit} USDT`);

    console.error('→ Scraping Trades Analysis tab…');
    const tradesAnalysis = await scrapeTradesAnalysis(page);
    console.error(`  closedTrades=${tradesAnalysis.closedTrades.all}, largestLoss=${tradesAnalysis.largestLosingTrade.all} USDT`);

    console.error(`→ Scraping Trades Log tab (expecting ~${performance.trades} rows)…`);
    const tradesLog = await scrapeTradesLog(page, performance.trades);
    console.error(`  collected ${tradesLog.length} trades`);

    const sl = deriveSlPctFromTrades(tradesLog);
    console.error(`→ ${sl.rationale}`);

    const out: ScrapeResult = {
      url,
      scrapedAt: Date.now(),
      performance,
      tradesAnalysis,
      tradesLog,
    };

    mkdirSync(resolve('data', 'imports'), { recursive: true });
    const outPath = resolve('data', 'imports', `${slug}.json`);
    writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.error(`✅ Raw data → ${outPath}`);

    // Print ready-to-paste config block
    console.log('\n// ============ Paste into src/strategies/track-c-config.ts ============\n');
    console.log(
      renderConfigBlock({
        id: slug,
        code,
        url,
        perf: performance,
        analysis: tradesAnalysis,
        slPct: sl.suggestion,
        slRationale: sl.rationale,
        tradesLogCount: tradesLog.length,
      }),
    );
    console.log('\n// ====================================================================\n');
  } finally {
    await page.close();
    await closeLuxAlgoBrowser();
  }
}

main().catch((err) => {
  console.error('import failed:', err);
  process.exit(1);
});
