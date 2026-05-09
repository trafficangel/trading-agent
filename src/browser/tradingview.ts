import { chromium, type Browser, type BrowserContext } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { logger } from '../lib/logger.js';

const STORAGE_STATE_PATH = resolve('data', 'tradingview-storage-state.json');
const SCREENSHOTS_DIR = resolve('data', 'screenshots');

let browserInstance: Browser | null = null;
let contextInstance: BrowserContext | null = null;

/** Symbols → TradingView ticker (Bybit perp). */
function tvSymbol(symbol: string): string {
  return `BYBIT:${symbol.toUpperCase()}.P`;
}

async function getContext(): Promise<BrowserContext> {
  if (contextInstance) return contextInstance;

  if (!existsSync(STORAGE_STATE_PATH)) {
    throw new Error(
      `tradingview storage state not found at ${STORAGE_STATE_PATH}. Run scripts/tradingview-login.ts first.`,
    );
  }

  browserInstance = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  contextInstance = await browserInstance.newContext({
    storageState: STORAGE_STATE_PATH,
    viewport: { width: 1600, height: 900 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });
  logger.info('playwright context ready (storage state loaded)');
  return contextInstance;
}

/**
 * Capture a chart screenshot for `symbol` at `interval` (TradingView interval string).
 * Returns the PNG path.
 */
export async function captureChart(
  symbol: string,
  interval: '5' | '15' | '60' | '240' | 'D',
): Promise<string> {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    const url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol(symbol))}&interval=${interval}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Wait for chart canvas to render
    await page.waitForSelector('canvas[data-name="pane-canvas"]', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const out = resolve(SCREENSHOTS_DIR, `${symbol}_${interval}m_${ts}.png`);
    mkdirSync(dirname(out), { recursive: true });

    // Try to crop chart area only (no left toolbar / right symbol panel).
    // Selector based on TV layout — fallback to full page if it changes.
    const chartLocator = page.locator('.chart-container').first();
    if (await chartLocator.count()) {
      await chartLocator.screenshot({ path: out });
    } else {
      await page.screenshot({ path: out, fullPage: false });
    }

    logger.info({ symbol, interval, path: out }, 'chart captured');
    return out;
  } finally {
    await page.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (contextInstance) await contextInstance.close();
  if (browserInstance) await browserInstance.close();
  contextInstance = null;
  browserInstance = null;
}
