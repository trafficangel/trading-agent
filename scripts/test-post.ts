/**
 * Send a representative test post to the Logs channel showing the *current*
 * caption format with all today's improvements (multi-exchange walls,
 * stop-cluster citations, ATR-aware SL reasoning, self-critique risks).
 *
 * Uses the real tradeCaption builder so what you see is what real OPEN
 * posts will look like.
 *
 * Usage on the VPS:
 *   sudo -u trader bash -lc "cd ~/apps/trading-agent && node dist/scripts/test-post.js"
 *
 * Locally (sends through the real bot):
 *   pnpm tsx scripts/test-post.ts
 */
import { sendMessage, sendPhoto } from '../src/telegram/bot.js';
import { tradeCaption } from '../src/telegram/decision-template.js';
import type { Decision } from '../src/llm/decision.schema.js';
import type { AggregatedScore } from '../src/signals/aggregator.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const fakeDecision: Decision = {
  decision: 'OPEN',
  side: 'short',
  entry: 2.5057,
  sl: 2.5470,
  tp: [2.4400], // R:R = (2.5057-2.4400) / (2.5470-2.5057) = 0.0657/0.0413 = 1.59 — passes minRR 1.5
  size_pct: 1.0,
  confidence: 0.62,
  reasoning_short:
    'Шорт TON 15m: bearish+ × 2 на закрытии 14:30, 1H теряет VWAP, 4H тренд закрашивается. Cross-confirmed ask стенки выше — путь сопротивления вверх.',
  reasoning_full:
    'TONUSDT 15m: пара 14:00 и 14:30 закрылись с bearish+ от LuxAlgo (CHoCH+ down подтвердил перелом). 1H провалила VWAP 2.474 без отбоя — структура за продавцов. На 4H Smart Trail развернулся (свечи теперь под зелёной линией), это первое касание после impulse-leg вверх — классика для шорта по продолжению.\n\nMulti-exchange: funding на Bybit/OKX 0.005% против Binance 0.0017% — лонги на Bybit крауднуты (mean-reversion риск в нашу пользу). OI растёт на Binance быстрее (+3.2% за 4h vs +1.6% Bybit) — реальные продажи, не локальный шум.\n\nStop clusters выше 2.58 (далеко) и 2.55 (близко — не трогаем как цель). Ставим SL за зону 2.55 чтобы не попасть в hunt.\n\nSelf-critique (риски):\n  1. BTC консолидируется 0.1%, может подтянуть TON наверх — но BTC 4H тоже под 1H трендом вниз, риск ограничен.\n  2. Bid стенки $828k на 2.495 + $656k на 2.503 — близкая зона поддержки, цена может застрять.\n  3. L/S ratio 1.33 — крауд лонги, но не экстрим (>2.0 был бы тревогой).',
  sl_reason: 'за свинг-хаем 14:00 и cross-confirmed ask-стенкой 2.5294 ✓3x',
  tp_reason: 'через bid-стенки 2.495+2.485 ✓3x в стоп-кластер ниже свинг-лоу 2.4572',
  invalidation: 'закрытие 15m свечи выше 2.5470 + появление bullish+ → структура восстановлена',
};

const fakeAgg: AggregatedScore = {
  symbol: 'TONUSDT',
  bullish: 1.4,
  bearish: 11.2,
  side: 'short',
  signals: [],
  windowStart: Date.now() - 20 * 60_000,
  windowEnd: Date.now(),
};

const post = {
  decisionId: 9999,
  symbol: 'TONUSDT',
  agg: fakeAgg,
  decision: fakeDecision,
  riskGate: { ok: true as const },
  shadowMode: true,
};

const caption = tradeCaption(post);

console.log('=== CAPTION (preview) ===');
console.log(caption);
console.log('=== END (length:', caption.length, '/ 1024) ===\n');

// Find a recent screenshot to use
const screenshotsDir = resolve('data', 'screenshots');
let primary: string | null = null;
try {
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(screenshotsDir)
    .filter((f) => f.startsWith('TONUSDT_15m_') && f.endsWith('.png'))
    .sort()
    .reverse();
  if (files[0]) {
    primary = resolve(screenshotsDir, files[0]);
    console.log('using screenshot:', primary);
  }
} catch {
  // ignore
}

const header = '🧪 <b>TEST POST</b> — пример того как будет выглядеть реальный OPEN после всех изменений\n\n';
const fullText = header + caption;

if (primary && existsSync(primary)) {
  const sent = await sendPhoto({
    channel: 'logs',
    photoPath: primary,
    caption: fullText.slice(0, 1024),
  });
  if (!sent) {
    console.log('sendPhoto failed, falling back to text-only');
    await sendMessage({ channel: 'logs', text: fullText });
  } else {
    console.log('✅ test post sent to Logs channel with photo');
  }
} else {
  await sendMessage({ channel: 'logs', text: fullText });
  console.log('✅ test post sent to Logs channel (text only — no screenshot found)');
}

process.exit(0);
