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

/**
 * Zoom the chart in to a sensible per-TF range. Default TradingView view
 * shows 80-120 bars which is fine for 15m but on 4H means looking at a
 * full month of data — too wide for spotting actionable setups.
 *
 * Implementation note: page.mouse.wheel doesn't reliably reach TradingView's
 * chart — TV attaches `wheel` listeners with `{passive:false}` to the
 * specific time-scale canvas, and Playwright's synthesized scroll often
 * lands on a parent layer instead. So we use TWO approaches in sequence:
 *
 *   1. Direct dispatchEvent on the pane canvas — fires a real `wheel`
 *      event with the exact target/coordinates TV expects. This is the
 *      one that actually zooms.
 *   2. Fallback: page.mouse.wheel — in case dispatchEvent path is blocked
 *      by a future TV change (e.g. they switch to PointerEvent).
 *
 * Per-TF zoom amounts tuned so we end up with roughly 30-60 most recent
 * bars visible.
 */
async function adjustChartZoom(page: Page, interval: string): Promise<void> {
  const canvas = page.locator('canvas[data-name="pane-canvas"]').first();
  const box = await canvas.boundingBox().catch(() => null);
  if (!box) return;

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Bring chart into focus by clicking once (mouse hover alone doesn't
  // make the chart the active keyboard target).
  await page.mouse.click(cx, cy, { delay: 50 }).catch(() => {});
  await page.waitForTimeout(150);

  // End-key sometimes scrolls to most recent, sometimes not (TV setting
  // dependent). Wrap in try-catch — not a hard failure if no-op.
  await page.keyboard.press('End').catch(() => {});
  await page.waitForTimeout(200);

  // Per-TF zoom levels. Higher number = more zoomed in.
  //   5m, 15m: default already shows ~30-50 recent bars, light zoom
  //   1H:       wider default, moderate zoom
  //   4H, 1D:   TV defaults to MONTHS of bars, aggressive zoom needed
  const zoomSteps: Record<string, number> = {
    '5': 3,
    '15': 3,
    '60': 6,
    '240': 12,
    D: 10,
  };
  const steps = zoomSteps[interval] ?? 3;

  // PRIMARY method: dispatch synthetic wheel events directly on the
  // canvas at chart-center coordinates. TV's wheel handler reads
  // ctrlKey to differentiate zoom from pan — but actually for chart zoom
  // it just needs deltaY != 0 on the chart pane. We send strong deltaY
  // so each event is one full zoom level.
  await page
    .evaluate(
      `(async () => {
        const steps = ${steps};
        const target = document.querySelector('canvas[data-name="pane-canvas"]');
        if (!target) return 'no-canvas';
        const rect = target.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        for (let i = 0; i < steps; i++) {
          const ev = new WheelEvent('wheel', {
            deltaY: -200,
            deltaMode: 0,
            clientX,
            clientY,
            bubbles: true,
            cancelable: true,
            ctrlKey: false,
          });
          target.dispatchEvent(ev);
          await new Promise((r) => setTimeout(r, 120));
        }
        return 'done:' + steps;
      })()`,
    )
    .catch(() => 'evaluate-failed');

  // FALLBACK: page.mouse.wheel — in case the dispatchEvent path didn't
  // work for some reason (different TV build, etc.). Same number of
  // steps, but with deltaY=-400 since mouse.wheel goes through a
  // different code path.
  await page.mouse.move(cx, cy);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(80);
  }

  // Settle after zoom changes — TV renders animations async
  await page.waitForTimeout(600);
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
  // Multi-pass detection with progressive backoff. Total wait up to 15 sec.
  // Empirical observation: BTC 15m specifically renders indicators
  // 5-8 seconds later than other TFs (heavier chart). 2-sec single-pass
  // detector caused 4-8 false positives/hour overnight.
  // Now we wait 2s → 5s → 8s = up to 15s total before declaring failure.
  const legendSelectors = [
    '[data-name="legend-source-item"]',
    '.legend-source-item',
    '[class*="sourcesWrapper"] [class*="item"]',
  ];

  const checkOnce = async (): Promise<boolean> => {
    for (const sel of legendSelectors) {
      const count = await page.locator(sel).count().catch(() => 0);
      if (count >= 2) return true;
    }
    const luxAlgoText = await page
      .getByText(/luxalgo|lux algo/i)
      .count()
      .catch(() => 0);
    return luxAlgoText > 0;
  };

  const waitsMs = [2000, 5000, 8000];
  for (const ms of waitsMs) {
    await page.waitForTimeout(ms);
    if (await checkOnce()) return true;
  }
  return false;
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
 * Returns the PNG path. Throws if the TV session is logged out OR indicators
 * don't render even after one retry.
 *
 * Two-attempt strategy: if the first capture fails on the "indicators not
 * loaded" gate, we close the page and try once more in a fresh tab. TV
 * intermittently serves a half-loaded chart (especially BTC 15m); a single
 * retry catches almost all such cases. Hard auth failures (logged out)
 * skip the retry — those won't fix themselves by re-trying.
 */
export async function captureChart(
  symbol: string,
  interval: '5' | '15' | '60' | '240' | 'D',
): Promise<string> {
  try {
    return await captureChartOnce(symbol, interval);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    // Only retry the soft failure case (indicators not loaded). Logged-out
    // / storage-state failures need user action and won't self-heal.
    if (msg.includes('indicators not loaded')) {
      logger.warn(
        { symbol, interval },
        'capture failed on indicators, retrying once in fresh tab',
      );
      // Brief pause so TV's rendering pipeline isn't immediately overloaded
      // by an instant re-navigation.
      await new Promise((r) => setTimeout(r, 1500));
      return await captureChartOnce(symbol, interval);
    }
    throw err;
  }
}

async function captureChartOnce(
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

    // Zoom in per-TF so we don't show LLM a month of 4H data when we
    // only need the recent 30-50 bars for analysis.
    await adjustChartZoom(page, interval);

    // Last-resort modal-killer: find anything overlapping the chart center
    // and remove it. The chart canvas is the topmost element at center on
    // a clean page; if something else is on top (modal/promo), we drop it.
    await page
      .evaluate(`(() => {
        const removed = [];
        // Sample multiple points to catch wide modals
        const points = [
          [800, 450],   // center
          [400, 450],   // mid-left
          [1200, 450],  // mid-right
          [800, 300],   // upper
        ];
        for (const [x, y] of points) {
          const at = document.elementFromPoint(x, y);
          if (!at) continue;
          // Walk up to find fixed/absolute high-z-index ancestor
          let cur = at;
          while (cur && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
            const cs = getComputedStyle(cur);
            const isCanvas = cur.tagName === 'CANVAS';
            // Don't touch chart canvases or their parents
            if (isCanvas || (cur.className && cur.className.toString().includes('chart-'))) {
              break;
            }
            // Modal-like: fixed/absolute position with high z-index
            const isFixed = cs.position === 'fixed' || cs.position === 'absolute';
            const z = parseInt(cs.zIndex) || 0;
            if (isFixed && z > 100) {
              const cls = (cur.className && cur.className.toString) ? cur.className.toString().slice(0, 80) : '';
              removed.push({ tag: cur.tagName, cls, z });
              cur.remove();
              break;
            }
            cur = cur.parentElement;
          }
        }
        return removed;
      })()`)
      .catch(() => []);

    // Settle after removal
    await page.waitForTimeout(300);

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

/**
 * Bar-boundary screenshot cache.
 *
 * Higher timeframes don't change visually within their bar — a 4H chart at
 * 12:00 and 13:30 shows IDENTICAL bars (the in-progress 12:00-16:00 candle
 * just grew a wick). Re-capturing every cron tick is wasted CPU and, more
 * importantly, wasted image input tokens (a chart PNG is ~25-50K tokens
 * input). For 4 symbols × 5 charts × 4 ticks/hour = 80 PNG sends per hour;
 * caching the 4H + 1H levels saves ~60% of that.
 *
 * Cache key: (symbol, interval, barStart). Hit only if the saved file still
 * exists on disk (file may have been swept by `data/screenshots` cleanup).
 *
 * TTL strategy is implicit via barStart: as soon as a new bar begins, the
 * key changes and we capture fresh. 15m: ~15 min cache, 1H: ~1h, 4H: ~4h,
 * 1D: ~24h.
 *
 * Critically: the IDENTICAL bytes are read again, so when paired with
 * cache_control on the image block in client.ts, Anthropic's vision cache
 * hits and we pay 10% of the image-input price.
 */
function barStart(intervalMs: number, now: number = Date.now()): number {
  return Math.floor(now / intervalMs) * intervalMs;
}

const INTERVAL_MS: Record<string, number> = {
  '5': 5 * 60 * 1000,
  '15': 15 * 60 * 1000,
  '60': 60 * 60 * 1000,
  '240': 4 * 60 * 60 * 1000,
  D: 24 * 60 * 60 * 1000,
};

type CacheEntry = { path: string; barStart: number };
const screenshotCache = new Map<string, CacheEntry>();

/**
 * Wraps captureChart with per-bar caching. Use for LLM-bound captures
 * (decide.ts, monitor.ts). For test/QA captures (chart-test.ts) keep using
 * captureChart directly so the user always sees current rendering state.
 */
export async function captureChartCached(
  symbol: string,
  interval: '5' | '15' | '60' | '240' | 'D',
): Promise<string> {
  const ms = INTERVAL_MS[interval];
  if (!ms) return captureChart(symbol, interval);

  const bs = barStart(ms);
  const cacheKey = `${symbol}_${interval}`;
  const cached = screenshotCache.get(cacheKey);

  if (cached && cached.barStart === bs && existsSync(cached.path)) {
    logger.debug({ symbol, interval, path: cached.path, barStart: bs }, 'chart cache hit');
    return cached.path;
  }

  const path = await captureChart(symbol, interval);
  screenshotCache.set(cacheKey, { path, barStart: bs });
  return path;
}

export async function closeBrowser(): Promise<void> {
  if (contextInstance) await contextInstance.close();
  if (browserInstance) await browserInstance.close();
  contextInstance = null;
  browserInstance = null;
}
