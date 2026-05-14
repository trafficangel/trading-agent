/**
 * One-time LuxAlgo login → save storage state for headless scraping.
 *
 * Run locally (where you have a GUI):
 *   pnpm tsx scripts/luxalgo-login.ts
 *
 * Opens a Chromium window pointing at LuxAlgo's homepage. You log in
 * manually (email + password, no 2FA needed per user). Script detects
 * authenticated state by:
 *   1. URL is NOT a signin/login page
 *   2. At least one cookie with value length > 20 (session token)
 *   3. URL is on luxalgo.com domain
 *
 * Once detected, storage state is saved to `data/luxalgo-storage-state.json`.
 * After that, scp it to the VPS:
 *   scp data/luxalgo-storage-state.json trading-vps:/home/trader/apps/trading-agent/data/
 */

import { chromium } from 'playwright';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('data', 'luxalgo-storage-state.json');
const SIGNIN_URL = 'https://www.luxalgo.com/';
const TIMEOUT_MS = 10 * 60_000;

(async () => {
  mkdirSync('data', { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });
  const ctx = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('LuxAlgo login flow (manual)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('1. Sign in in the browser window (top-right "Sign in").');
  console.log('2. After signing in, NAVIGATE TO YOUR AI BUILDER CHAT URL');
  console.log('   (e.g. https://www.luxalgo.com/chat/<chat-id>/) or any');
  console.log('   authenticated page — script will not save while you are');
  console.log('   on the homepage to avoid false positives.');
  console.log('3. Once you land on /chat/ or any non-root path, storage');
  console.log('   state saves automatically.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await page.goto(SIGNIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const start = Date.now();
  let lastReport = 0;

  const isLoggedIn = async (): Promise<boolean> => {
    try {
      const cookies = await ctx.cookies('https://www.luxalgo.com');
      // Filter out KNOWN analytics/tracking cookie patterns. PostHog
      // (ph_phc_*) is the big false-positive culprit — it sets a long
      // value on first page load even while user is anonymous.
      const ANALYTICS_PATTERNS = /^(ph_phc_|__ph_|_ga|_gid|_gcl|_fbp|_fbc|cf_|hubspotutk|__hs|mp_|_pin_|_uetsid|_uetvid|_ttp)/i;
      const sessionish = cookies.find(
        (c) => c.value.length > 20 && !ANALYTICS_PATTERNS.test(c.name),
      );

      // Cross-check via PostHog state: if the only cookie we have IS
      // PostHog AND its $user_state is "anonymous", we're definitely not
      // logged in yet regardless of URL.
      const phCookie = cookies.find((c) => c.name.startsWith('ph_phc_'));
      if (phCookie && /\$user_state%22%3A%22anonymous/.test(phCookie.value)) {
        // Only block if we ALSO don't have a real session cookie
        if (!sessionish) return false;
      }

      const url = page.url();
      const onSignin = /signin|signup|login|auth\//i.test(url);
      const onLuxalgo = /luxalgo\.com/.test(url);

      // The HOMEPAGE (luxalgo.com/) shows a "Sign in" button even after
      // a fresh login flow opens, so we also require the user to navigate
      // to an authenticated section (/chat, /dashboard, /account, /pricing
      // hits an auth check, etc.) before we declare success.
      const urlPath = (() => {
        try {
          return new URL(url).pathname;
        } catch {
          return '/';
        }
      })();
      const onAuthSection = urlPath !== '/' && urlPath !== '';

      return Boolean(sessionish) && !onSignin && onLuxalgo && onAuthSection;
    } catch {
      return false;
    }
  };

  while (Date.now() - start < TIMEOUT_MS) {
    if (await isLoggedIn()) {
      console.log(`\n✅ Login detected (URL: ${page.url()})`);
      await ctx.storageState({ path: OUT });
      const sz = statSync(OUT).size;
      console.log(`✅ Storage state saved: ${OUT} (${sz} bytes)`);
      console.log(
        '\nNext: scp data/luxalgo-storage-state.json trading-vps:/home/trader/apps/trading-agent/data/',
      );
      await browser.close();
      process.exit(0);
    }
    if (Date.now() - lastReport > 15000) {
      console.log(`waiting… (current url: ${page.url()})`);
      lastReport = Date.now();
    }
    await page.waitForTimeout(2000);
  }

  console.error('\n❌ Timed out waiting for login.');
  if (existsSync(OUT)) console.error(`Old state remains at ${OUT}`);
  await browser.close();
  process.exit(2);
})().catch((err) => {
  console.error('login flow failed:', err);
  process.exit(1);
});
