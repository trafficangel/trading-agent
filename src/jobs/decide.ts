import { aggregateSymbol, shouldInvokeLlm } from '../signals/aggregator.js';
import { recentNonSkipDecision, insertDecision } from '../db/repos/decisions.js';
import { callLlm } from '../llm/client.js';
import { captureChart } from '../browser/tradingview.js';
import { checkDecision, type RiskLimits } from '../risk/manager.js';
import { sendMessage } from '../telegram/bot.js';
import { decisionPost } from '../telegram/decision-template.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const COOLDOWN_MS = 15 * 60 * 1000;
const STORAGE_STATE = resolve('data', 'tradingview-storage-state.json');

/**
 * Decide pipeline: called after every signal insertion. Computes confluence,
 * checks threshold + cooldown, captures screenshots, calls LLM, stores
 * decision, posts to Telegram. Best-effort; errors are logged but never
 * propagate to the webhook handler.
 */
export async function maybeDecide(symbol: string): Promise<void> {
  // Only run in modes that consult the LLM
  if (config.MODE === 'telemetry') return;

  const agg = aggregateSymbol(symbol);
  if (!shouldInvokeLlm(agg) || !agg.side) {
    logger.debug({ symbol, bullish: agg.bullish, bearish: agg.bearish }, 'below threshold');
    return;
  }

  // Cooldown
  const recent = recentNonSkipDecision(symbol, agg.side, COOLDOWN_MS);
  if (recent) {
    logger.info(
      { symbol, side: agg.side, last_id: recent.id },
      'cooldown active — skipping LLM call',
    );
    return;
  }

  logger.info(
    { symbol, side: agg.side, bullish: agg.bullish, bearish: agg.bearish, signals: agg.signals.length },
    'invoking LLM',
  );

  // Capture screenshots if storage state is available; otherwise skip
  let screenshots: { path: string; mediaType: 'image/png' }[] = [];
  let primaryScreenshot: string | null = null;
  if (existsSync(STORAGE_STATE)) {
    try {
      const path15 = await captureChart(symbol, '15');
      const path1h = await captureChart(symbol, '60');
      screenshots = [
        { path: path15, mediaType: 'image/png' },
        { path: path1h, mediaType: 'image/png' },
      ];
      primaryScreenshot = path15;
    } catch (err) {
      logger.error({ err, symbol }, 'screenshot capture failed — calling LLM without images');
    }
  } else {
    logger.warn('tradingview storage state not present — calling LLM without screenshots');
  }

  const result = await callLlm(
    {
      symbol,
      agg,
      open_positions: [], // stage 2 stub
      daily_pnl_pct: 0, // stage 2 stub
      mode: config.MODE,
    },
    screenshots,
  );

  if ('skipped' in result) {
    logger.warn({ reason: result.reason }, 'llm skipped');
    return;
  }

  const limits: RiskLimits = {
    maxSizePct: config.RISK_PCT_PER_TRADE * 4,
    minSlDistPct: 0.2,
    maxSlDistPct: 5.0,
  };
  const riskGate = checkDecision(result.decision, limits);
  // In shadow mode, post regardless; risk gate result is shown in the message
  // so we can see how often the model would have been blocked.

  const id = insertDecision({
    symbol,
    agg,
    decision: result.decision,
    screenshotPath: primaryScreenshot,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    rawResponse: result.raw,
  });

  logger.info(
    {
      decision_id: id,
      symbol,
      decision: result.decision.decision,
      side: result.decision.side,
      confidence: result.decision.confidence,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      latency_ms: result.latencyMs,
      risk_ok: riskGate.ok,
    },
    'decision stored',
  );

  await sendMessage({
    channel: 'signals',
    text: decisionPost({ symbol, agg, decision: result.decision, riskGate, shadowMode: true }),
  });
}
