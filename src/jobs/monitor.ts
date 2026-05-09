import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import {
  findActivePositions,
  insertDecision,
  type DecisionRow,
} from '../db/repos/decisions.js';
import { recentSignals } from '../db/repos/signals.js';
import { captureChart } from '../browser/tradingview.js';
import { Decision } from '../llm/decision.schema.js';
import { buildMonitorSystemPrompt, buildMonitorUserMessage } from '../llm/monitor-prompt.js';
import { aggregateSymbol } from '../signals/aggregator.js';
import { sendMessage, sendPhoto } from '../telegram/bot.js';
import { tradeCaption } from '../telegram/decision-template.js';

const STORAGE_STATE = resolve('data', 'tradingview-storage-state.json');
const MAX_RETRIES = 2;

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY ?? 'placeholder' });

function imageBlock(path: string): Anthropic.ImageBlockParam {
  const data = readFileSync(path).toString('base64');
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
}

async function callMonitorLlm(
  systemPrompt: string,
  userText: string,
  screenshots: string[],
): Promise<{ decision: Decision; raw: string; inputTokens: number; outputTokens: number } | null> {
  if (!config.ANTHROPIC_API_KEY) return null;

  let lastError: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          ...screenshots.map(imageBlock),
          ...(lastError
            ? [{ type: 'text' as const, text: `Previous response failed validation:\n${lastError}\nReturn valid JSON only.` }]
            : []),
        ],
      },
    ];

    try {
      const resp = await anthropic.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: 1500,
        system: systemPrompt,
        messages,
      });
      inputTokens += resp.usage.input_tokens;
      outputTokens += resp.usage.output_tokens;
      const raw = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as Anthropic.TextBlock).text)
        .join('\n')
        .trim();
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch (e) {
        lastError = `JSON parse error: ${(e as Error).message}`;
        continue;
      }
      const result = Decision.safeParse(parsed);
      if (!result.success) {
        lastError = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        continue;
      }
      return { decision: result.data, raw, inputTokens, outputTokens };
    } catch (err) {
      logger.error({ err, attempt }, 'monitor llm call failed');
      lastError = `API error: ${(err as Error).message}`;
    }
  }

  logger.error({ lastError }, 'monitor llm exhausted retries');
  return null;
}

function latestPriceFor(symbol: string): number | null {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = recentSignals(since).filter((s) => s.symbol === symbol);
  return recent[0]?.price ?? null;
}

async function monitorPosition(p: DecisionRow): Promise<void> {
  const sinceOpen = recentSignals(p.created_at).filter((s) => s.symbol === p.symbol);
  const currentPrice = latestPriceFor(p.symbol);
  const ageMin = Math.round((Date.now() - p.created_at) / 60000);

  let screenshots: string[] = [];
  let primaryScreenshot: string | null = null;
  if (existsSync(STORAGE_STATE)) {
    try {
      const subj15 = await captureChart(p.symbol, '15');
      const subj1h = await captureChart(p.symbol, '60');
      const btc15 = await captureChart('BTCUSDT', '15');
      const btc1h = await captureChart('BTCUSDT', '60');
      screenshots = [subj15, subj1h, btc15, btc1h];
      primaryScreenshot = subj15;
    } catch (err) {
      logger.error({ err, symbol: p.symbol, position_id: p.id }, 'monitor screenshot failed');
    }
  }

  const result = await callMonitorLlm(
    buildMonitorSystemPrompt(),
    buildMonitorUserMessage({
      position: p,
      signalsSinceOpen: sinceOpen,
      currentPrice,
      ageMinutes: ageMin,
    }),
    screenshots,
  );

  if (!result) {
    logger.warn({ position_id: p.id }, 'monitor llm unavailable — keeping HOLD');
    return;
  }

  // Aggregator output isn't strictly meaningful for monitor decisions, but we still
  // record the recent context (window=10m of recent signals).
  const agg = aggregateSymbol(p.symbol);

  const newId = insertDecision({
    symbol: p.symbol,
    agg,
    decision: result.decision,
    screenshotPath: primaryScreenshot,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    rawResponse: result.raw,
    parentDecisionId: p.id,
  });

  logger.info(
    {
      monitor_decision_id: newId,
      parent_position: p.id,
      decision: result.decision.decision,
      symbol: p.symbol,
    },
    'monitor decision stored',
  );

  // Posting:
  //   SKIP (= HOLD)        -> Logs only, compact note (no Signals spam)
  //   CLOSE / MODIFY       -> Signals channel with 15m photo + caption referencing parent
  if (result.decision.decision === 'SKIP') {
    await sendMessage({
      channel: 'logs',
      text: `🟦 <b>HOLD</b> по сделке #${p.id.toString().padStart(4, '0')} ${p.symbol}: ${result.decision.reasoning_short}`,
      disable_notification: true,
    });
    return;
  }

  const post = {
    decisionId: newId,
    symbol: p.symbol,
    agg,
    decision: result.decision,
    riskGate: { ok: true as const },
    shadowMode: config.MODE !== 'full_auto',
    parentTradeId: p.id,
  };
  const caption = tradeCaption(post);
  if (primaryScreenshot && existsSync(primaryScreenshot)) {
    const sent = await sendPhoto({ channel: 'signals', photoPath: primaryScreenshot, caption });
    if (!sent) await sendMessage({ channel: 'signals', text: caption });
  } else {
    await sendMessage({ channel: 'signals', text: caption });
  }
  await sendMessage({ channel: 'logs', text: caption, disable_notification: true });
}

let monitorRunning = false;

async function tick(): Promise<void> {
  if (monitorRunning) {
    logger.warn('monitor: previous tick still running, skipping');
    return;
  }
  monitorRunning = true;
  try {
    const positions = findActivePositions();
    if (positions.length === 0) {
      logger.debug('monitor: no active positions');
      return;
    }
    logger.info({ count: positions.length }, 'monitor tick');
    for (const p of positions) {
      try {
        await monitorPosition(p);
      } catch (err) {
        logger.error({ err, position_id: p.id }, 'monitorPosition failed');
      }
    }
  } finally {
    monitorRunning = false;
  }
}

export function startMonitorJob(): void {
  // Every 30 minutes — 15m primary TF doesn't move structurally faster.
  cron.schedule('*/30 * * * *', () => {
    void tick();
  });
  logger.info('monitor cron started (every 30 min)');
}
