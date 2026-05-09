import { aggregateSymbol, shouldInvokeLlm } from '../signals/aggregator.js';
import {
  recentNonSkipDecision,
  insertDecision,
  findActiveOnSide,
} from '../db/repos/decisions.js';
import { callLlm } from '../llm/client.js';
import { captureChart } from '../browser/tradingview.js';
import { checkDecision, type RiskLimits } from '../risk/manager.js';
import { sendMessage, sendPhoto } from '../telegram/bot.js';
import { tradeCaption, skipLog } from '../telegram/decision-template.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getMarketSentiment } from '../exchange/bybit-public.js';

const COOLDOWN_MS = 15 * 60 * 1000;
const STORAGE_STATE = resolve('data', 'tradingview-storage-state.json');

/**
 * Decide pipeline: called after every signal insertion. Computes confluence,
 * checks threshold + cooldown, captures screenshots, calls LLM, stores
 * decision, posts to Telegram. Best-effort; errors are logged but never
 * propagate to the webhook handler.
 */
export async function maybeDecide(symbol: string): Promise<void> {
  if (config.MODE === 'telemetry') return;

  const agg = aggregateSymbol(symbol);
  if (!shouldInvokeLlm(agg) || !agg.side) {
    logger.debug({ symbol, bullish: agg.bullish, bearish: agg.bearish }, 'below threshold');
    return;
  }

  const recent = recentNonSkipDecision(symbol, agg.side, COOLDOWN_MS);
  if (recent) {
    logger.info(
      { symbol, side: agg.side, last_id: recent.id },
      'cooldown active — skipping LLM call',
    );
    return;
  }

  // If there is already an active position in the same direction, monitor cron
  // owns the lifecycle — we skip a fresh OPEN call.
  const active = findActiveOnSide(symbol, agg.side);
  if (active) {
    logger.info(
      { symbol, side: agg.side, active_id: active.id },
      'active position exists — monitor will handle, skipping new OPEN call',
    );
    return;
  }

  logger.info(
    { symbol, side: agg.side, bullish: agg.bullish, bearish: agg.bearish, signals: agg.signals.length },
    'invoking LLM',
  );

  let screenshots: { path: string; mediaType: 'image/png' }[] = [];
  let primaryScreenshot: string | null = null;
  if (existsSync(STORAGE_STATE)) {
    try {
      // Subject charts first, then BTC context.
      const subj15 = await captureChart(symbol, '15');
      const subj1h = await captureChart(symbol, '60');
      const btc15 = await captureChart('BTCUSDT', '15');
      const btc1h = await captureChart('BTCUSDT', '60');
      screenshots = [
        { path: subj15, mediaType: 'image/png' },
        { path: subj1h, mediaType: 'image/png' },
        { path: btc15, mediaType: 'image/png' },
        { path: btc1h, mediaType: 'image/png' },
      ];
      primaryScreenshot = subj15;
    } catch (err) {
      logger.error({ err, symbol }, 'screenshot capture failed — calling LLM without images');
    }
  } else {
    logger.warn('tradingview storage state not present — calling LLM without screenshots');
  }

  const sentiment = await getMarketSentiment(symbol).catch((err: unknown) => {
    logger.warn({ err, symbol }, 'sentiment fetch failed — proceeding without');
    return null;
  });

  const result = await callLlm(
    {
      symbol,
      agg,
      open_positions: [],
      daily_pnl_pct: 0,
      mode: config.MODE,
      sentiment,
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
    minRR: 1.5,
  };
  const riskGate = checkDecision(result.decision, limits);

  const decisionId = insertDecision({
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
      decision_id: decisionId,
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

  const post = {
    decisionId,
    symbol,
    agg,
    decision: result.decision,
    riskGate,
    shadowMode: config.MODE !== 'full_auto',
  };

  // Routing:
  //   OPEN / CLOSE / MODIFY → Signals channel with photo (15m chart) + Russian caption
  //   SKIP                  → Logs channel only, compact one-liner
  if (result.decision.decision === 'SKIP') {
    await sendMessage({ channel: 'logs', text: skipLog(post), disable_notification: true });
    return;
  }

  const caption = tradeCaption(post);
  if (primaryScreenshot && existsSync(primaryScreenshot)) {
    const sent = await sendPhoto({
      channel: 'signals',
      photoPath: primaryScreenshot,
      caption,
    });
    if (!sent) {
      // fallback to text-only if sendPhoto fails (file too big, network etc.)
      await sendMessage({ channel: 'signals', text: caption });
    }
  } else {
    await sendMessage({ channel: 'signals', text: caption });
  }

  // Always mirror to Logs for audit trail
  await sendMessage({ channel: 'logs', text: caption, disable_notification: true });
}
