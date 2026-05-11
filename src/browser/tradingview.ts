import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

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

    // Inject overlay-hiding CSS into EVERY page that opens in this context.
    // Applied BEFORE the page's own JS runs, so even modals that try to
    // appear at first paint get caught.
    await ctx.addInitScript(`
      (() => {
        const css = \`
          [class*="toastCommonBase"],
          [class*="toastContainer"],
          [class*="swipable-"],
          [class*="contentContainerWrapper"],
          [class*="contentContainerInner"],
          [class*="contentContainer-"],
          [class*="itemInnerInner"],
          [class*="overlap-manager-root"],
          [class*="popup-modal"],
          [class*="marketingDialog"],
          [class*="bottom-banner"],
          [class*="promo-banner"],
          [class*="i-dialog"],
          [data-name="dialog"],
          [data-dialog-name],
          #onetrust-banner-sdk,
          #onetrust-consent-sdk,
          .ot-sdk-row,
          [class*="tour-step"],
          [class*="onboarding"] {
            display: none !important;
            visibility: hidden !important;
            pointer-events: none !important;
          }
        \`;
        const style = document.createElement('style');
        style.setAttribute('data-injected', 'overlay-hide');
        style.textContent = css;
        if (document.head) {
          document.head.appendChild(style);
        } else {
          document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
        }
      })();
    `);

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
 * Dismiss any visible TradingView modal/overlay that would obscure the chart.
 * TV occasionally shows promo modals ("Don't miss this crypto sale 80% off"),
 * tutorial popups, feature-announcement dialogs, etc. Without dismissing them
 * the screenshot is unusable — the LLM sees the promo, not the chart.
 *
 * Two passes:
 *   1. Click any visible close-button (X) inside dialogs we recognize.
 *   2. Press Escape twice — most TV modals support keyboard dismiss.
 */
/**
 * Inject CSS that hides every TradingView promo / dialog / cookie banner
 * container we know about. This is more robust than DOM removal because:
 *   - TV's React/Angular layer re-injects removed elements within ms
 *   - CSS persists even after re-render — the element stays hidden
 *
 * Called once per page load. Pure visual hide; doesn't break any TV
 * functionality we use.
 */
async function injectOverlayHidingCSS(page: Page): Promise<void> {
  await page
    .addStyleTag({
      content: `
        /* TV "toast" promo popups (Crypto sale, feature announcements) */
        [class*="toastCommonBase"],
        [class*="toastContainer"],
        [class*="swipable-"],
        [class*="contentContainerWrapper"],
        [class*="contentContainerInner"],
        [class*="contentContainer-"],
        [class*="itemInnerInner"],
        /* Generic dialogs/popups */
        [class*="overlap-manager-root"],
        [class*="popup-modal"],
        [class*="marketingDialog"],
        [class*="bottom-banner"],
        [class*="promo-banner"],
        [class*="i-dialog"],
        [data-name="dialog"],
        [data-dialog-name],
        /* Cookie consent (OneTrust) */
        #onetrust-banner-sdk,
        #onetrust-consent-sdk,
        .ot-sdk-row,
        /* Side-effect: hide tutorial-style intro tours */
        [class*="tour-step"],
        [class*="onboarding"] {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          pointer-events: none !important;
        }
      `,
    })
    .catch(() => {
      // addStyleTag can fail if page is navigating; ignore.
    });
}

async function dismissOverlays(page: Page): Promise<void> {
  // 0. Inject CSS to hide overlays permanently (survives re-injection by TV)
  await injectOverlayHidingCSS(page);

  // 1. Click known close buttons
  const closeSelectors = [
    'button[aria-label="Close" i]',
    'button[data-name="close"]',
    '.tv-dialog__close',
    '[class*="closeButton" i]',
    'div[role="dialog"] button:has(svg)',
    'button:has-text("No thanks")',
    'button:has-text("Decline")',
    'button:has-text("Skip")',
    'button:has-text("Maybe later")',
  ];
  for (const sel of closeSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
        await btn.click({ timeout: 1000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
    } catch {
      // ignore
    }
  }

  // 2. Press Escape twice — handles most generic TV dialogs
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }

  // 3. Nuclear option: directly remove any modal/dialog/promo containers
  // from the DOM. TradingView wraps marketing promos in various containers
  // we can't reliably target by close-button. Removing the container
  // entirely guarantees the screenshot won't show it. We don't care about
  // state — these are non-functional decorative overlays during automated
  // capture.
  // Use Function-string form so we don't depend on `document` being in
  // TypeScript's lib (our tsconfig doesn't include DOM lib because the
  // server is Node-only; Playwright's evaluate runs the function in the
  // browser context where `document` exists.)
  await page
    .evaluate(`(() => {
      const selectors = [
        // TV "toast" promo overlays (e.g. "Crypto sale 80% off") use
        // hashed class names like toastCommonBase-zMOxH_8U; match by prefix.
        '[class*="toastCommonBase"]',
        '[class*="toastContainer"]',
        '[class*="swipable-"]',
        '[class*="contentContainerWrapper"]',
        // Generic dialog/popup containers
        '[class*="overlap-manager-root"]',
        '[class*="js-rootresizer"] [role="dialog"]',
        '[data-name="dialog"]',
        '[data-dialog-name]',
        '[class*="i-dialog"]',
        '[class*="popup-modal"]',
        '[class*="marketingDialog"]',
        '[class*="bottom-banner"]',
        '[class*="promo-banner"]',
        // Cookie banner — visual noise at bottom-left
        '#onetrust-banner-sdk',
        '#onetrust-consent-sdk',
      ];
      let removed = 0;
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          el.remove();
          removed++;
        });
      }
      return removed;
    })()`)
    .catch(() => 0);

  // 4. Settle after DOM removal
  await page.waitForTimeout(300);
}

/**
 * Are LuxAlgo indicators actually loaded on the chart?
 *
 * Distinct from detectLoggedOut(): we may be perfectly authenticated but
 * still get a bare-candle chart because TradingView served the default
 * layout without our saved indicators (template reset, account migration,
 * etc.). The model can't see LuxAlgo signals on the chart at all, even
 * though the bullish_plus / CHoCH webhooks are still firing in the data
 * pipeline. We must NOT feed such screenshots to the LLM.
 *
 * Heuristic: the chart legend (top-left) lists every data source on the
 * pane. A clean LuxAlgo setup shows 4+ entries (price + Signals & Overlays
 * + Price Action Concepts + Oscillator Matrix). A blank chart shows just 1
 * (the price symbol). We require >= 2 to consider indicators loaded.
 */
async function detectIndicatorsLoaded(page: Page): Promise<boolean> {
  // Give the chart 2 sec to render legend after navigation. waitForTimeout
  // is OK here because we're checking final state, not racing renders.
  await page.waitForTimeout(2000);

  // Multiple selector variants — TV's DOM has changed over time and
  // different chart versions use different attributes.
  const legendSelectors = [
    '[data-name="legend-source-item"]',
    '.legend-source-item',
    '[class*="sourcesWrapper"] [class*="item"]',
  ];

  for (const sel of legendSelectors) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count >= 2) return true;
  }

  // Fallback: search for "LuxAlgo" text anywhere on the chart (the indicator
  // names usually contain that string).
  const luxAlgoText = await page
    .getByText(/luxalgo|lux algo/i)
    .count()
    .catch(() => 0);
  return luxAlgoText > 0;
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
    // If TV_LAYOUT_ID is configured, navigate to that specific saved layout
    // (which has LuxAlgo indicators pre-attached). Otherwise use the default
    // chart route, which is fragile — depends on the user's default layout
    // not being mutated.
    const layoutPath = config.TV_LAYOUT_ID ? `${config.TV_LAYOUT_ID}/` : '';
    const url = `https://www.tradingview.com/chart/${layoutPath}?symbol=${encodeURIComponent(tvSymbol(symbol))}&interval=${interval}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Wait for chart canvas to render
    await page.waitForSelector('canvas[data-name="pane-canvas"]', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(4_000);

    // If TV booted us with the session-conflict modal, click Connect and try again.
    const reclaimed = await reclaimSessionIfNeeded(page);
    if (reclaimed) await page.waitForTimeout(2_000);

    // Dismiss any promo / tutorial / feature-announcement overlay that
    // could visually obscure the chart. Indicators may be loaded in the
    // DOM (passes detectIndicatorsLoaded) but rendered behind a "Crypto
    // sale 80% off" modal — screenshot useless.
    await dismissOverlays(page);

    // Hard gate: if we're logged out, the chart has NO LuxAlgo indicators.
    // Blowing up here is correct — we'd rather skip the LLM call than feed
    // it a bare-candle screenshot pretending to be analysis-ready.
    if (await detectLoggedOut(page)) {
      throw new Error(
        'TradingView session is logged out (cookie banner visible / no user menu). ' +
          'Indicators are NOT loaded. Re-run scripts/tradingview-login.ts and refresh storage state.',
      );
    }

    // Second gate: we're logged in but the chart layout has no indicators.
    // This happens when TV serves the default-empty layout instead of the
    // user's saved one (template reset, layout migration). Same fail-loud
    // policy — better skip the LLM than feed bare candles.
    if (!(await detectIndicatorsLoaded(page))) {
      throw new Error(
        'TradingView indicators not loaded on chart — only bare candles visible. ' +
          'The chart layout has lost LuxAlgo overlays. Open TradingView in browser, ' +
          'add LuxAlgo indicators back to the default chart layout, save, and ' +
          'optionally set TV_LAYOUT_ID env to a specific layout URL ID.',
      );
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const out = resolve(SCREENSHOTS_DIR, `${symbol}_${interval}m_${ts}.png`);
    mkdirSync(dirname(out), { recursive: true });

    // Mask known-modal containers in the screenshot itself. Even if CSS
    // hiding fails or TV adds a new modal class we don't recognize, the
    // mask replaces the area with a black rectangle in the saved image.
    // Far more robust than fighting the DOM — we just paint over it.
    // Trade-off: if a mask accidentally covers part of the chart, that
    // area is lost. Selectors below are conservative — modal-specific
    // patterns, not generic dialogs.
    const maskLocators = [
      page.locator('[class*="toastCommonBase"]'),
      page.locator('[class*="toastGroup"]'),
      page.locator('[class*="toastContainer"]'),
      page.locator('[class*="contentContainerWrapper"]'),
      page.locator('[class*="contentContainerInner"]'),
      page.locator('[class*="overlap-manager-root"]'),
      page.locator('[class*="marketingDialog"]'),
      page.locator('[class*="promo-banner"]'),
      page.locator('[class*="bottom-banner"]'),
      page.locator('#onetrust-banner-sdk'),
    ];

    const chartLocator = page.locator('.chart-container').first();
    if (await chartLocator.count()) {
      await chartLocator.screenshot({ path: out, mask: maskLocators });
    } else {
      await page.screenshot({ path: out, fullPage: false, mask: maskLocators });
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
