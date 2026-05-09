/**
 * Smoke test for Stage 2 screenshot capture.
 * Calls captureChart for a single symbol/interval and prints the resulting path.
 */
import { captureChart, closeBrowser } from '../src/browser/tradingview.js';

const symbol = process.argv[2] ?? 'TONUSDT';
const interval = (process.argv[3] ?? '15') as '5' | '15' | '60' | '240' | 'D';

(async () => {
  console.log(`Capturing ${symbol} @ ${interval}m …`);
  const path = await captureChart(symbol, interval);
  console.log(`OK: ${path}`);
  await closeBrowser();
})().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
