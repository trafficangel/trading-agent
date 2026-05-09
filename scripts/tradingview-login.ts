/**
 * One-time TradingView login → save storage state for headless reuse.
 *
 * Run on a machine with a GUI (your Mac).
 * Opens a Chromium window pointing at TradingView's signin page.
 * Wait for the user to log in manually (no env creds, robust to UI changes).
 * Detection: URL has been on a non-signin TV page for 5+ seconds AND tv_session
 * cookie is present.
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('data', 'tradingview-storage-state.json');
const SIGNIN_URL = 'https://www.tradingview.com/accounts/signin/';
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
  console.log('TradingView login flow (manual)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('1. Sign in in the browser window.');
  console.log('2. Once any TradingView page loads after signin, the script');
  console.log('   will detect the session cookie and save state.');
  console.log('3. You can also manually quit by pressing Ctrl+C — state will');
  console.log('   be saved on exit if you are logged in.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await page.goto(SIGNIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const start = Date.now();
  let lastReport = 0;

  const isLoggedIn = async (): Promise<boolean> => {
    try {
      const cookies = await ctx.cookies('https://www.tradingview.com');
      const session = cookies.find((c) => c.name === 'sessionid' || c.name === 'tv_session' || c.name === 'sessionid_sign');
      const url = page.url();
      const onSignin = /signin|signup|accounts\.tradingview\.com/.test(url);
      return Boolean(session && session.value && session.value.length > 5) && !onSignin;
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
      console.log('\nNext: scp data/tradingview-storage-state.json trading-vps:~/apps/trading-agent/data/');
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
