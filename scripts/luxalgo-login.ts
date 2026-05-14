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
  console.log('2. Once you land on the dashboard / any non-signin page,');
  console.log('   storage state will save automatically.');
  console.log('3. You can also navigate to your AI Strategy Builder chat');
  console.log('   to verify everything works before the script captures.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await page.goto(SIGNIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const start = Date.now();
  let lastReport = 0;

  const isLoggedIn = async (): Promise<boolean> => {
    try {
      const cookies = await ctx.cookies('https://www.luxalgo.com');
      // Look for any session-like cookie. LuxAlgo cookie names vary by
      // their auth provider (could be Supabase, NextAuth, Auth0...) so we
      // do a generic "has substantial cookie value" check.
      const sessionish = cookies.find(
        (c) =>
          c.value.length > 20 &&
          !/^(_ga|_gid|_gcl|cf_|hubspotutk|__hs|mp_)/i.test(c.name),
      );
      const url = page.url();
      const onSignin = /signin|signup|login|auth\//i.test(url);
      const onLuxalgo = /luxalgo\.com/.test(url);
      return Boolean(sessionish) && !onSignin && onLuxalgo;
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
