/**
 * Automated TradingView login → save storage state.
 *
 * Reads credentials from ~/.ssh/trading-creds.txt:
 *   TRADINGVIEW_USER=...
 *   TRADINGVIEW_PASS=...
 *   TRADINGVIEW_2FA_BACKUP_CODES:
 *     code1
 *     code2
 *     ...
 *
 * Uses Playwright to fill the form, including 2FA backup code if needed.
 * Consumes one backup code on success and rewrites the file without it.
 *
 * Usage: pnpm tsx scripts/tradingview-login-auto.ts
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const CREDS_PATH = resolve(homedir(), '.ssh', 'trading-creds.txt');
const OUT = resolve('data', 'tradingview-storage-state.json');
const SIGNIN_URL = 'https://www.tradingview.com/accounts/signin/';

type Creds = {
  user: string;
  pass: string;
  backupCodes: string[];
};

function readCreds(): Creds {
  const text = readFileSync(CREDS_PATH, 'utf8');
  const userMatch = text.match(/^TRADINGVIEW_USER=(.+)$/m);
  const passMatch = text.match(/^TRADINGVIEW_PASS=(.+)$/m);
  if (!userMatch || !passMatch) throw new Error('TRADINGVIEW_USER/PASS not found in creds file');

  // Backup codes — block under TRADINGVIEW_2FA_BACKUP_CODES: with indented lines
  const codesBlock = text.match(/TRADINGVIEW_2FA_BACKUP_CODES:\s*\n((?:\s+\S+\s*\n?)+)/);
  const backupCodes = codesBlock
    ? codesBlock[1]!
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    : [];

  return { user: userMatch[1]!.trim(), pass: passMatch[1]!.trim(), backupCodes };
}

function consumeBackupCode(code: string): void {
  const text = readFileSync(CREDS_PATH, 'utf8');
  // Remove the line containing the code (with optional whitespace)
  const updated = text
    .split('\n')
    .filter((l) => l.trim() !== code)
    .join('\n');
  writeFileSync(CREDS_PATH, updated, { mode: 0o600 });
  console.log(`(consumed backup code; ${updated.split('\n').filter((l) => /^\s+[A-Za-z0-9]{8}$/.test(l)).length} remaining)`);
}

(async () => {
  mkdirSync('data', { recursive: true });

  const creds = readCreds();
  console.log(`Logging in as ${creds.user}; ${creds.backupCodes.length} backup codes available`);

  const browser = await chromium.launch({
    headless: false, // headed so user can step in if automation fails
    args: ['--start-maximized'],
  });
  const ctx = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();

  await page.goto(SIGNIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // === Step 1: click "Email" sign-in button if multi-method picker is shown ===
  // TV signin page typically shows: Email, Phone, Apple, Google, etc.
  const emailButton = page.locator(
    'button:has-text("Email"), button[name="Email"], [data-name="email"]',
  ).first();
  if (await emailButton.count()) {
    console.log('clicking Email signin option');
    await emailButton.click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  // === Step 2: fill email/username ===
  const userInput = page
    .locator('input[name="id_username"], input#id_username, input[name="username"], input[type="email"]')
    .first();
  await userInput.waitFor({ timeout: 10_000 });
  await userInput.fill(creds.user);
  console.log('filled username');

  // === Step 3: fill password ===
  const passInput = page
    .locator('input[name="id_password"], input#id_password, input[name="password"], input[type="password"]')
    .first();
  await passInput.fill(creds.pass);
  console.log('filled password');

  // === Step 4: submit ===
  const submitBtn = page
    .locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Войти")')
    .first();
  await submitBtn.click();
  console.log('clicked submit, waiting for next step');
  await page.waitForTimeout(4000);

  // === Step 5: 2FA — use a backup code if prompted ===
  const twoFaPresent = await page
    .locator('input[name*="code"], input[autocomplete*="one-time-code"], [data-name="2fa"]')
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  if (twoFaPresent) {
    if (creds.backupCodes.length === 0) {
      console.error('2FA prompt shown but no backup codes available!');
      console.log('Please complete 2FA manually in the browser window.');
    } else {
      // TV shows TOTP code field by default; need to switch to backup-code mode.
      // Look for a link "Use backup code" or similar.
      const useBackupLink = page
        .locator('a:has-text("backup"), button:has-text("backup"), a:has-text("резерв")')
        .first();
      if (await useBackupLink.count()) {
        console.log('switching to backup-code mode');
        await useBackupLink.click().catch(() => {});
        await page.waitForTimeout(1500);
      }

      const code = creds.backupCodes[0]!;
      const codeInput = page
        .locator('input[name*="code"], input[autocomplete*="one-time-code"]')
        .first();
      await codeInput.fill(code);
      console.log(`filled backup code (${code.slice(0, 2)}...)`);

      const verifyBtn = page
        .locator('button[type="submit"], button:has-text("Verify"), button:has-text("Подтвердить")')
        .first();
      await verifyBtn.click().catch(() => {});
      await page.waitForTimeout(4000);
      // Mark as consumed only after we actually proceed past 2FA
      // (we'll do it once we confirm login success below).
      (page as unknown as { __usedCode: string }).__usedCode = code;
    }
  }

  // === Step 6: wait for successful redirect ===
  const start = Date.now();
  const TIMEOUT = 5 * 60_000;
  let success = false;
  while (Date.now() - start < TIMEOUT) {
    const cookies = await ctx.cookies('https://www.tradingview.com');
    const session = cookies.find(
      (c) => c.name === 'sessionid' || c.name === 'tv_session' || c.name === 'sessionid_sign',
    );
    const url = page.url();
    const onSignin = /signin|signup|accounts\.tradingview\.com/.test(url);
    if (session && session.value && session.value.length > 5 && !onSignin) {
      console.log(`\n✅ Login detected (url=${url})`);
      success = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  if (!success) {
    console.error('\n❌ Login did not complete in time. The browser is still open — finish manually if you can.');
    console.error('Press Ctrl+C when done, or wait for timeout.');
    // Leave the browser open for manual rescue
    await page.waitForTimeout(10 * 60_000);
    await browser.close();
    process.exit(2);
  }

  await ctx.storageState({ path: OUT });
  const sz = statSync(OUT).size;
  console.log(`✅ Storage state saved: ${OUT} (${sz} bytes)`);

  const usedCode = (page as unknown as { __usedCode?: string }).__usedCode;
  if (usedCode) consumeBackupCode(usedCode);

  await browser.close();
  console.log('\nNext: scp data/tradingview-storage-state.json trading-vps:/home/trader/apps/trading-agent/data/');
})().catch((err) => {
  console.error('login flow failed:', err);
  process.exit(1);
});
