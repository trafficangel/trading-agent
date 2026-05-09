/**
 * One-time TradingView login → save storage state for headless reuse.
 *
 * Run on a machine with a GUI (your Mac). Opens a real Chromium window,
 * navigates to TradingView sign-in, fills email + password from environment,
 * waits for you to confirm any captcha / 2FA, then saves cookies+localStorage
 * to data/tradingview-storage-state.json.
 *
 * After capture: scp data/tradingview-storage-state.json trading-vps:~/apps/trading-agent/data/
 *
 * Env required:
 *   TRADINGVIEW_USER  — email or username
 *   TRADINGVIEW_PASS  — password
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('data', 'tradingview-storage-state.json');

const user = process.env.TRADINGVIEW_USER;
const pass = process.env.TRADINGVIEW_PASS;
if (!user || !pass) {
  console.error('Set TRADINGVIEW_USER and TRADINGVIEW_PASS env vars and re-run.');
  process.exit(1);
}

(async () => {
  mkdirSync('data', { recursive: true });
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();

  console.log('Opening TradingView sign-in…');
  await page.goto('https://www.tradingview.com/accounts/signin/', { waitUntil: 'domcontentloaded' });

  // Click "Email" button if a chooser is shown
  const emailButton = page.getByText(/email/i).first();
  if (await emailButton.count()) {
    await emailButton.click().catch(() => {});
  }

  await page.waitForSelector('input[name="id_username"], input[name="username"]', { timeout: 30_000 });
  await page.fill('input[name="id_username"], input[name="username"]', user);
  await page.fill('input[name="id_password"], input[name="password"]', pass);

  // Submit
  const submitBtn = page.getByRole('button', { name: /sign in|войти/i }).first();
  await submitBtn.click();

  console.log('\nSubmitted. If captcha or email-code appears, solve it in the open browser window.');
  console.log('Waiting up to 5 minutes for you to land on the chart page…\n');

  // Wait for either the user menu (logged in) or 5 min.
  const success = await Promise.race([
    page.waitForURL(/\/chart|\/u\//, { timeout: 5 * 60_000 }).then(() => true).catch(() => false),
    page.locator('[data-name="header-user-menu-button"]').waitFor({ timeout: 5 * 60_000 }).then(() => true).catch(() => false),
  ]);

  if (!success) {
    console.error('Did not detect successful login. Aborting without saving.');
    await browser.close();
    process.exit(2);
  }

  await ctx.storageState({ path: OUT });
  console.log(`\n✅ Storage state saved to ${OUT}`);
  console.log('Next: scp data/tradingview-storage-state.json trading-vps:~/apps/trading-agent/data/');
  await browser.close();
})().catch((err) => {
  console.error('login flow failed:', err);
  process.exit(1);
});
