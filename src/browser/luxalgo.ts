/**
 * LuxAlgo Strategy Builder browser context — Playwright wrapper that
 * re-uses a saved session (storage state) so headless scraping works
 * without re-logging in every run.
 *
 * Mirrors src/browser/tradingview.ts but simpler:
 *   - No chart canvas / no zoom logic / no overlay-dismiss heuristics
 *     (LuxAlgo UI is cleaner than TV's promo-littered chart)
 *   - Single-shot scrapes — no parallel/cached path
 *
 * Entry points:
 *   getLuxAlgoContext() → BrowserContext (lazy-init, reusable)
 *   closeLuxAlgoBrowser() → graceful teardown for SIGINT/SIGTERM
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../lib/logger.js';

export const LUXALGO_STORAGE_STATE_PATH = resolve('data', 'luxalgo-storage-state.json');

let browserInstance: Browser | null = null;
let contextInstance: BrowserContext | null = null;
let contextInitPromise: Promise<BrowserContext> | null = null;

export async function getLuxAlgoContext(): Promise<BrowserContext> {
  if (contextInstance) return contextInstance;
  if (contextInitPromise) return contextInitPromise;

  if (!existsSync(LUXALGO_STORAGE_STATE_PATH)) {
    throw new Error(
      `LuxAlgo storage state not found at ${LUXALGO_STORAGE_STATE_PATH}. ` +
        `Run scripts/luxalgo-login.ts first to log in manually.`,
    );
  }

  contextInitPromise = (async () => {
    browserInstance = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    const ctx = await browserInstance.newContext({
      storageState: LUXALGO_STORAGE_STATE_PATH,
      // 1600x1200 so the right-hand "Performance" tab table renders fully
      // without the page collapsing to its mobile layout. Height tall
      // enough that "Largest Losing Trade" row is in viewport before scroll.
      viewport: { width: 1600, height: 1200 },
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    });
    contextInstance = ctx;
    logger.info('luxalgo playwright context ready (storage state loaded)');
    return ctx;
  })().catch((err) => {
    contextInitPromise = null;
    throw err;
  });

  return contextInitPromise;
}

export async function closeLuxAlgoBrowser(): Promise<void> {
  if (contextInstance) await contextInstance.close().catch(() => {});
  if (browserInstance) await browserInstance.close().catch(() => {});
  contextInstance = null;
  browserInstance = null;
  contextInitPromise = null;
}
