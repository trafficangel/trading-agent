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
  /** Total trades in the strategy (from Performance tab), regardless of cap. */
  totalTradesInStrategy: number;
  /** Cap that was applied to tradesLog. */
  tradesLogCap: number;
  /** True if tradesLog was truncated (collected.length < totalTradesInStrategy). */
  tradesLogCapped: boolean;
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
const EN_MONTH: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseLuxAlgoDate(raw: string): number | null {
  const s = raw.trim();
  // English: "Sun, Oct 19, 2025, 00:45" — parse explicitly (Date.parse
  // doesn't accept this exact comma-heavy form in all engines).
  const enMatch = s.match(
    /([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4}),?\s*(\d{1,2}):(\d{2})/,
  );
  if (enMatch) {
    const monKey = enMatch[1]!.toLowerCase().slice(0, 3);
    if (EN_MONTH[monKey] !== undefined) {
      return Date.UTC(
        parseInt(enMatch[3]!, 10),
        EN_MONTH[monKey]!,
        parseInt(enMatch[2]!, 10),
        parseInt(enMatch[4]!, 10),
        parseInt(enMatch[5]!, 10),
      );
    }
  }
  // Fallback: lenient Date.parse
  const en = Date.parse(s);
  if (!Number.isNaN(en)) return en;
  // Russian: "ср, 13 мая 2026 г., 12:45" — note the period after month
  // ("окт.") for some months. Allow optional period + optional whitespace.
  const m = s.match(
    /(\d{1,2})\s+([а-яё]+)\.?\s*(\d{4})\s*г?\.?,?\s*(\d{1,2}):(\d{2})/i,
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
 * Strategy: walk UP from the label element until we find an ancestor
 * whose text contains the label AND at least 3 numeric tokens. The first
 * such ancestor is the row.
 *
 * The naive "first div ancestor" approach fails when LuxAlgo wraps the
 * label cell in a div separate from the value cells — the label's own
 * div has no numbers, so we'd read just the label and bail.
 */
async function readTriple(page: Page, label: string): Promise<TripleNum> {
  const tail = (await page.evaluate(`(() => {
    const target = ${JSON.stringify(label)};
    // Collect ALL elements whose text content equals the label exactly.
    // (Same label can appear in chart legend + table — try each until one
    // walks up to a valid row.)
    const all = document.querySelectorAll('*');
    const candidates = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      // Skip nodes inside SVG (chart legend lives there).
      let p = el;
      let inSvg = false;
      while (p) {
        if (p.tagName === 'svg' || p.tagName === 'SVG') { inSvg = true; break; }
        p = p.parentElement;
      }
      if (inSvg) continue;
      if (el.children.length !== 0) continue;
      const tc = (el.textContent || '').trim();
      if (tc === target) candidates.push(el);
    }
    // For each candidate, walk up looking for an ancestor with the label
    // AND 3+ numeric tokens AND total text < 500 chars AND the FIRST
    // non-whitespace char after the label is a digit or sign (rules out
    // chart-container catch where the legend has multiple label words
    // BEFORE any numbers).
    for (const cand of candidates) {
      let cur = cand.parentElement;
      for (let depth = 0; depth < 12 && cur; depth++) {
        const t = (cur.innerText || cur.textContent || '');
        if (!t.includes(target)) break;
        if (t.length > 500) break;
        const idx = t.indexOf(target);
        const after = t.slice(idx + target.length);
        // First non-whitespace after label must be digit or +/- sign
        const firstChar = after.trimStart().charAt(0);
        if (!/[+\\-\\d]/.test(firstChar)) {
          cur = cur.parentElement;
          continue;
        }
        const nums = after.match(/[+-]?\\d[\\d,]*(?:\\.\\d+)?\\s*[kKmM]?(?=\\s|$|USDT|%|\\))/g) || [];
        if (nums.length >= 3) return after;
        cur = cur.parentElement;
      }
    }
    return null;
  })()`)) as string | null;

  if (!tail) return { all: NaN, long: NaN, short: NaN };
  const numRe = /[+-]?\d[\d,]*(?:\.\d+)?\s*[kKmM]?(?=\s|$|USDT|%|\))/g;
  const matches = (tail.match(numRe) ?? []).map((s) => parseNum(s)).filter((n) => !Number.isNaN(n));
  return {
    all: matches[0] ?? NaN,
    long: matches[1] ?? NaN,
    short: matches[2] ?? NaN,
  };
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

  // Strategy Configuration block (left side). Older LuxAlgo layouts
  // included a dedicated "Strategy Configuration" header on the right
  // pane; the newer chat-based layout drops it and only shows the
  // strategy details inline in the chat reply (in the user's locale —
  // typically Russian or English depending on account settings).
  //
  // We try BOTH layouts. If nothing matches, the fields stay null —
  // they're informational only (the actual backtest stats come from
  // the right-side Strategy Tester KPIs, which are always English).
  const configBlock = await page
    .locator('text=Strategy Configuration')
    .first()
    .locator('xpath=..')
    .innerText()
    .catch(() => '');
  const bodyText = ((await page
    .evaluate(`document.body.innerText`)
    .catch(() => '')) as string) || '';
  // EN layout patterns
  let evalMatch = configBlock.match(/Evaluation Start[:\s]+([^\n•]+)/i);
  let longMatch = configBlock.match(/Long Entry Conditions[:\s]+([^\n•]+)/i);
  let shortMatch = configBlock.match(/Short Entry Conditions[:\s]+([^\n•]+)/i);
  let exitMatch = configBlock.match(/Exit Condition[:\s]+([^\n•]+)/i);
  let orderSizeMatch = configBlock.match(/Order Size[:\s]+([^\n•]+)/i);
  // RU chat-layout fallback. LuxAlgo's chat reply renders:
  //   "Условия входа\nLong: …\nShort: …\nДетали стратегии\n
  //    Условие выхода: …\nДата начала: …\nРазмер ордера: …"
  if (!longMatch) longMatch = bodyText.match(/Long:\s*([^\n]+)/);
  if (!shortMatch) shortMatch = bodyText.match(/Short:\s*([^\n]+)/);
  if (!exitMatch) exitMatch = bodyText.match(/Условие выхода:\s*([^\n]+)/);
  if (!evalMatch) evalMatch = bodyText.match(/Дата начала:\s*([^\n]+)/);
  if (!orderSizeMatch) orderSizeMatch = bodyText.match(/Размер ордера:\s*([^\n]+)/);

  // Performance Summary prose
  const summaryBlock = await page
    .locator('text=Performance Summary')
    .first()
    .locator('xpath=..')
    .innerText()
    .catch(() => '');
  const summaryProse = summaryBlock.replace(/^Performance Summary\s*/i, '').trim();

  // Top KPI strip: NET PROFIT / TRADES / WIN RATE / MAX DRAWDOWN / PROFIT FACTOR
  // Each label has its value directly below in the same flex column.
  // Walk up from the label until we find a container that ALSO contains
  // numeric content (the value sibling).
  async function readKpi(label: string): Promise<string> {
    return ((await page.evaluate(`(() => {
      const target = ${JSON.stringify(label)};
      // Strategy: find ALL elements whose textContent equals target.
      // For each, try:
      //   (a) parent's innerText starting with target → take suffix
      //   (b) next sibling's innerText
      //   (c) walk up to grandparent
      const all = document.querySelectorAll('*');
      const candidates = [];
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const tc = (el.textContent || '').trim();
        if (tc === target) candidates.push(el);
      }
      for (const cand of candidates) {
        // Try sibling first — KPI cards often have <label/><value/>.
        const next = cand.nextElementSibling;
        if (next) {
          const sib = (next.textContent || '').trim();
          if (sib && /^[+-]?\\d/.test(sib)) return sib;
        }
        // Try parent.innerText
        let cur = cand.parentElement;
        for (let d = 0; d < 6 && cur; d++) {
          const t = (cur.innerText || cur.textContent || '').trim();
          if (t.startsWith(target) && t.length < 200) {
            const after = t.slice(target.length).trim();
            if (after && /^[+-]?\\d/.test(after)) return after;
          }
          cur = cur.parentElement;
        }
      }
      return null;
    })()`)) as string | null) ?? '';
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

async function scrapeTradesLog(
  page: Page,
  expectedTotal: number,
  maxTrades: number,
): Promise<TradeRow[]> {
  await clickTab(page, 'Trades Log');

  // Target: collect MIN(expectedTotal, maxTrades). LuxAlgo's Trades Log
  // shows newest first (top of list = trade #N), scrolling down loads
  // older trades. So stopping early gives us the MOST RECENT N — exactly
  // what subscribers care about.
  const target = Math.min(expectedTotal || Infinity, maxTrades);

  const collected = new Map<number, TradeRow>(); // dedup by trade number

  // The log container is the scrollable element containing the rows.
  // We scroll inside it (not the window) because the left strategy
  // sidebar is also scrollable.
  const tableLocator = page.locator('text=Trade #').first().locator('xpath=ancestor::*[contains(@class, "overflow") or contains(@style, "overflow")][1]');

  type VisibleRow = { num: number; side: 'long' | 'short'; cells: string[] };
  const extractVisibleRows = async (): Promise<VisibleRow[]> => {
    // Rows are matched by: starts with "<num>\n<side>" AND contains 4+ USDT
    // mentions (2 prices + net PnL + cumulative PnL). We pick the SMALLEST
    // element that satisfies both — going deeper than that would lose data,
    // going wider would pull in the whole table.
    const raw = (await page.evaluate(`(() => {
      const rows = [];
      const seen = new Set();
      const all = document.querySelectorAll('div, tr, [role="row"]');
      for (const el of Array.from(all)) {
        const t = el.innerText || '';
        if (!t || t.length > 800) continue;
        const m = t.match(/^\\s*(\\d{1,3})\\s*\\n\\s*(long|short)/i);
        if (!m) continue;
        // Must contain at least 2 price/USDT amounts.
        const usdtCount = (t.match(/USDT/g) || []).length;
        if (usdtCount < 2) continue;
        const num = parseInt(m[1], 10);
        const side = m[2].toLowerCase();
        // Dedup by (num, side, text-length) — keep the FIRST (smallest)
        // matching element. Since DOM walk is in document order and
        // ancestors come AFTER their descendants in querySelectorAll only
        // for some configurations, we explicitly skip if we already have
        // a smaller-text row for this trade num.
        const key = num + ':' + side;
        const existing = seen.has(key);
        if (existing) continue;
        seen.add(key);
        rows.push({
          num,
          side,
          cells: t.split('\\n').map(function(s){return s.trim();}).filter(Boolean),
        });
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
      // Cells layout: [num, side, entryDate, entryPriceUSDT, exitDate,
      //                exitPriceUSDT, "+netUSDT\t+cumUSDT"]
      // Parse via a single regex against the flat-string. Supports both
      // English ("Sun, Oct 19, 2025, 00:45") and Russian ("ср, 19 окт.
      // 2025 г., 04:15") date formats; the (.+?) lazy groups handle both.
      // Whitespace between price digits and USDT is optional (LuxAlgo
      // sometimes omits it).
      const flat = v.cells.join('|');
      const rowRe =
        /^(?<num>\d+)\|(?<side>long|short)\|(?<eDate>[^|]+)\|(?<eP>\d+\.\d+)\s*USDT\|(?<xDate>[^|]+)\|(?<xP>\d+\.\d+)\s*USDT\|(?<net>[+\-]?\d+\.\d+)\s*USDT[\s\t]*(?<cum>[+\-]?\d+\.\d+)\s*USDT/;
      const m = flat.match(rowRe);
      if (m && m.groups) {
        collected.set(v.num, {
          num: v.num,
          side: v.side,
          entryAt: parseLuxAlgoDate(m.groups.eDate ?? ''),
          entryPrice: parseFloat(m.groups.eP ?? 'NaN'),
          exitAt: parseLuxAlgoDate(m.groups.xDate ?? ''),
          exitPrice: parseFloat(m.groups.xP ?? 'NaN'),
          netPnlUsdt: parseFloat((m.groups.net ?? 'NaN').replace('+', '')),
          cumulativePnlUsdt: parseFloat((m.groups.cum ?? 'NaN').replace('+', '')),
        });
      } else {
        // Fallback: capture what we can from cells positionally
        const priceFromCell = (c: string): number => {
          const pm = c.match(/(\d+\.\d+)/);
          return pm ? parseFloat(pm[1]!) : NaN;
        };
        const last = v.cells[v.cells.length - 1] ?? '';
        // last cell often: "+9.15USDT\t+9.15USDT"
        const pnlParts = last.split(/[\s\t]+/).filter(Boolean);
        collected.set(v.num, {
          num: v.num,
          side: v.side,
          entryAt: parseLuxAlgoDate(v.cells[2] ?? ''),
          entryPrice: priceFromCell(v.cells[3] ?? ''),
          exitAt: parseLuxAlgoDate(v.cells[4] ?? ''),
          exitPrice: priceFromCell(v.cells[5] ?? ''),
          netPnlUsdt: parseFloat((pnlParts[0] ?? 'NaN').replace(/[+USDT]/g, '')),
          cumulativePnlUsdt: parseFloat((pnlParts[1] ?? 'NaN').replace(/[+USDT]/g, '')),
        });
      }
    }
    if (collected.size === before) stuck++;
    else stuck = 0;

    if (collected.size >= target) break;
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

  // PREFER detailed-table values over fragile top-KPI scrape. The KPI
  // strip layout (NET PROFIT / TRADES / WIN RATE / etc) varies between
  // LuxAlgo versions; the detailed All/Long/Short table is stable.
  const netPnlUsd = perf.detailed.netProfit.all;
  const totalTrades = analysis.closedTrades.all;
  const winRatePct = analysis.winRatePct.all;
  const profitFactor = perf.detailed.profitFactor.all;
  const maxDdUsd = perf.detailed.drawdown.usdt;
  const maxDdPct = perf.detailed.drawdown.pct;
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
    // TODO: set the TradingView alert identifier you use in posts, e.g.
    //   '<SYMBOL>|<TF>|LONG=...|SHORT=...|EXIT=...'
    // alertName: '',
    sourceUrl: '${url}',
    backtest: {
      periodLabel: ${JSON.stringify(periodLabel)},
      periodDays: ${periodDays},
      initialCapital: 1000,
      notionalUsd: 1000,
      commissionPctPerSide: 0.00055,
      netPnlUsd: ${netPnlUsd.toFixed(2)},
      netPnlPct: ${(netPnlUsd / 10).toFixed(2)},
      cagrPct: ${perf.detailed.cagrPct.all.toFixed(2)},
      totalTrades: ${totalTrades},
      wins: ${analysis.winningTrades.all},
      losses: ${analysis.losingTrades.all},
      winRate: ${(winRatePct / 100).toFixed(4)},
      profitFactor: ${profitFactor.toFixed(3)},
      commissionPaidUsd: ${(totalTrades * 1000 * 0.00055 * 2).toFixed(2)},
      maxDrawdownPct: ${maxDdPct.toFixed(2)},
      maxDrawdownUsd: ${maxDdUsd.toFixed(2)},
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

/**
 * Default cap on how many trades to scrape into the JSON file. Aggregate
 * stats come from LuxAlgo's Performance/Analysis tables and are unaffected;
 * this only limits the per-trade detail log used for the equity curve +
 * landing-page trades table. Tunable via --max-trades on the CLI.
 */
const DEFAULT_MAX_TRADES = 150;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args.find((a) => a.startsWith('http'));
  if (!url) {
    console.error(
      'Usage: pnpm tsx scripts/import-strategy.ts <luxalgo-strategy-url> [--code 002] [--slug ton-foo] [--max-trades 150]',
    );
    process.exit(1);
  }
  const codeIdx = args.indexOf('--code');
  const slugIdx = args.indexOf('--slug');
  const maxIdx = args.indexOf('--max-trades');
  const code = codeIdx !== -1 ? args[codeIdx + 1]! : 'XXX';
  const slug = slugIdx !== -1 ? args[slugIdx + 1]! : 'TBD';
  const maxTrades = maxIdx !== -1 ? parseInt(args[maxIdx + 1]!, 10) : DEFAULT_MAX_TRADES;

  const ctx = await getLuxAlgoContext();
  const page = await ctx.newPage();
  try {
    console.error(`→ Opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Strategy Tester right pane takes a couple of seconds to render.
    // Anchor on a KPI label that ALWAYS exists on the right panel
    // ('NET PROFIT'). The chat-side panel localizes (RU/EN) but the
    // Strategy Tester KPIs stay in English — this is the most robust
    // gate. ('Strategy Configuration' block was used previously, but
    // LuxAlgo's newer chat layout no longer renders it inline.)
    try {
      await page.waitForSelector('text=NET PROFIT', { timeout: 60_000 });
    } catch (err) {
      const dbgPath = resolve('data', 'imports', `_debug-${Date.now()}.png`);
      await page.screenshot({ path: dbgPath, fullPage: true }).catch(() => {});
      console.error(`NET PROFIT not visible. Debug screenshot: ${dbgPath}`);
      console.error(`Current URL: ${page.url()}`);
      throw err;
    }
    await page.waitForSelector('text=Performance', { timeout: 15_000 });
    await page.waitForTimeout(2_000);

    console.error('→ Scraping Performance tab…');
    const performance = await scrapePerformance(page);
    console.error(`  trades=${performance.trades}, WR=${performance.winRatePct}%, PF=${performance.profitFactor}, NetPnL=${performance.netProfit} USDT`);

    console.error('→ Scraping Trades Analysis tab…');
    const tradesAnalysis = await scrapeTradesAnalysis(page);
    console.error(`  closedTrades=${tradesAnalysis.closedTrades.all}, largestLoss=${tradesAnalysis.largestLosingTrade.all} USDT`);

    const totalTrades = tradesAnalysis.closedTrades.all || performance.trades || 0;
    console.error(`→ Scraping Trades Log tab (expecting ~${totalTrades} rows, cap=${maxTrades})…`);
    const tradesLog = await scrapeTradesLog(page, totalTrades, maxTrades);
    const capped = totalTrades > 0 && tradesLog.length < totalTrades;
    console.error(`  collected ${tradesLog.length} trades${capped ? ` (capped from ${totalTrades})` : ''}`);

    const sl = deriveSlPctFromTrades(tradesLog);
    console.error(`→ ${sl.rationale}`);

    const out: ScrapeResult = {
      url,
      scrapedAt: Date.now(),
      performance,
      tradesAnalysis,
      tradesLog,
      totalTradesInStrategy: totalTrades,
      tradesLogCap: maxTrades,
      tradesLogCapped: capped,
    };

    // Write to src/strategies/data/ so the trades log ships with the
    // repo and the landing page can render it server-side. (data/ is
    // gitignored; we want this artifact under version control.)
    mkdirSync(resolve('src', 'strategies', 'data'), { recursive: true });
    const outPath = resolve('src', 'strategies', 'data', `${slug}.json`);
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
