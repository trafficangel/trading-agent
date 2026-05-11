import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { logger } from '../lib/logger.js';

const STORAGE_STATE_PATH = resolve('data', 'tradingview-storage-state.json');
const SCREENSHOTS_DIR = resolve('data', 'screenshots');

let browserInstance: Browser | null = null;
let contextInstance: BrowserContext | null = null;
/**
 * In-flight initialization promise. CRITICAL: prevents the race condition
 * where parallel callers (parallel screenshot capture) all see
 * `contextInstance === null` at the same moment and each launch their own
 * Chromium. Without this, 5 parallel captureChart() calls each spawn a
 * full browser → 5× memory, 5× CPU, contention, hangs, OOM.
 *
 * Pattern: first caller creates the promise and starts launching; concurrent
 * callers await the same promise.
 */
let contextInitPromise: Promise<BrowserContext> | null = null;

/** Symbols → TradingView ticker (Bybit perp). */
function tvSymbol(symbol: string): string {
  return `BYBIT:${symbol.toUpperCase()}.P`;
}

async function getContext(): Promise<BrowserContext> {
  if (contextInstance) return contextInstance;
  if (contextInitPromise) return contextInitPromise;

  if (!existsSync(STORAGE_STATE_PATH)) {
    throw new Error(
      `tradingview storage state not found at ${STORAGE_STATE_PATH}. Run scripts/tradingview-login.ts first.`,
    );
  }

  contextInitPromise = (async () => {
    browserInstance = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    const ctx = await browserInstance.newContext({
      storageState: STORAGE_STATE_PATH,
      viewport: { width: 1600, height: 900 },
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    });
    contextInstance = ctx;
    logger.info('playwright context ready (storage state loaded)');
    return ctx;
  })().catch((err) => {
    // On failure, allow the next caller to retry instead of locking forever.
    contextInitPromise = null;
    throw err;
  });

  return contextInitPromise;
}

/**
 * Detect and dismiss TradingView's "Session disconnected" modal that appears
 * when another device (e.g. user's laptop) signs into the same TV account.
 * The modal blocks the chart with a centered dialog and a black "Connect"
 * button. Clicking Connect reclaims the session for the bot — at the cost of
 * kicking the other device. That's the deliberate trade-off in shadow mode.
 */
async function reclaimSessionIfNeeded(page: Page): Promise<boolean> {
  // Headings TV uses across locales:
  //   English:   "Session disconnected"
  //   Russian:   "Сессия завершена" / "Сеанс завершён"
  const dialog = page.getByText(
    /Session disconnected|Сессия завершена|Сеанс завершён|Session ended/i,
  );
  if ((await dialog.count()) === 0) return false;

  logger.warn({ url: page.url() }, 'TV session-disconnected modal detected — reclaiming');

  // Try the localized "Connect" / "Подключить" button.
  const connectBtn = page.getByRole('button', {
    name: /^\s*(connect|подключить|continue|продолжить)\s*$/i,
  });
  if ((await connectBtn.count()) > 0) {
    await connectBtn.first().click({ timeout: 5_000 }).catch(() => {});
  } else {
    // Fallback: any button containing "Connect"-like word.
    const anyConnect = page.locator('button:has-text("Connect"), button:has-text("Подключить")');
    await anyConnect.first().click({ timeout: 5_000 }).catch(() => {});
  }

  await page.waitForTimeout(3_000);
  // Re-wait for chart canvas after reclaiming.
  await page
    .waitForSelector('canvas[data-name="pane-canvas"]', { timeout: 15_000 })
    .catch(() => {});
  await page.waitForTimeout(2_000);
  return true;
}

/**
 * Heuristic: is the TV session still authenticated? Without login, we get
 * bare candles + a cookie banner and NO LuxAlgo Premium indicators at all
 * — those screenshots are useless to the LLM (silent failure mode that
 * already cost us 10 hours of decisions on blank charts).
 *
 * Two checks:
 *   1. Cookie banner (#onetrust-banner-sdk or similar): visible only when
 *      anonymous; logged-in users have already accepted cookies.
 *   2. User avatar / header user button: present only when authenticated.
 *
 * Returns true when the page is clearly NOT logged in.
 */
async function detectLoggedOut(page: Page): Promise<boolean> {
  const cookieBanner = page.locator('#onetrust-banner-sdk, .tv-cookie-notice, [data-name="cookies-banner"]').first();
  const cookieVisible = await cookieBanner.isVisible({ timeout: 500 }).catch(() => false);
  if (cookieVisible) return true;

  // The user-menu button only appears when authenticated.
  const userMenu = page
    .locator(
      'button[aria-label*="user menu" i], [data-name="header-user-menu-button"], .tv-header__user-menu-button',
    )
    .first();
  const hasUserMenu = (await userMenu.count()) > 0;
  if (hasUserMenu) return false;

  // Fallback signal: presence of a "Sign in" link in the header.
  const signInLink = page.locator('a[href*="/signin"], button:has-text("Sign in")').first();
  const hasSignIn = (await signInLink.count()) > 0;
  return hasSignIn;
}

/**
 * Capture a chart screenshot for `symbol` at `interval` (TradingView interval string).
 * Returns the PNG path. Throws if the TV session is logged out — caller should
 * surface this loudly instead of silently feeding blank charts to the LLM.
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
    await page.waitForTimeout(4_000);

    // If TV booted us with the session-conflict modal, click Connect and try again.
    const reclaimed = await reclaimSessionIfNeeded(page);
    if (reclaimed) await page.waitForTimeout(2_000);

    // Hard gate: if we're logged out, the chart has NO LuxAlgo indicators.
    // Blowing up here is correct — we'd rather skip the LLM call than feed
    // it a bare-candle screenshot pretending to be analysis-ready.
    if (await detectLoggedOut(page)) {
      throw new Error(
        'TradingView session is logged out (cookie banner visible / no user menu). ' +
          'Indicators are NOT loaded. Re-run scripts/tradingview-login.ts and refresh storage state.',
      );
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const out = resolve(SCREENSHOTS_DIR, `${symbol}_${interval}m_${ts}.png`);
    mkdirSync(dirname(out), { recursive: true });

    const chartLocator = page.locator('.chart-container').first();
    if (await chartLocator.count()) {
      await chartLocator.screenshot({ path: out });
    } else {
      await page.screenshot({ path: out, fullPage: false });
    }

    logger.info({ symbol, interval, path: out, reclaimed }, 'chart captured');
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
