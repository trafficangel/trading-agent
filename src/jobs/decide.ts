import { aggregateSymbol, shouldInvokeLlm } from '../signals/aggregator.js';
import { detectRegime } from '../signals/regime.js';
import {
  insertDecision,
  findActiveOnSide,
} from '../db/repos/decisions.js';
import { callLlm } from '../llm/client.js';
import { critiqueDecision } from '../llm/critique.js';
import { captureChart } from '../browser/tradingview.js';
import { checkDecision, type RiskLimits } from '../risk/manager.js';
import { sizeFromConfidence } from '../risk/sizing.js';
import { sendMessage, sendPhoto } from '../telegram/bot.js';
import { tradeCaption, skipLog } from '../telegram/decision-template.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getMarketSentiment } from '../exchange/bybit-public.js';
import { getVolumeProfile } from '../exchange/bybit-volume.js';
import {
  getAggregatedOrderbook,
  getAggregatedSentiment,
  getStopClusters,
} from '../exchange/multi-exchange.js';
import { getLiquidations } from '../exchange/liquidations.js';

const STORAGE_STATE = resolve('data', 'tradingview-storage-state.json');

/**
 * Decide pipeline: invoked from the scheduled decide-cron (every 15 min on
 * bar boundaries). Computes confluence, captures screenshots + market
 * context, calls LLM, applies self-critique + sizing tier + risk gate,
 * stores decision, posts to Telegram. Errors are logged, never thrown.
 *
 * Note on cooldown: the previous event-driven model needed a 15-min cooldown
 * to avoid firing the LLM multiple times on the same confluence as more
 * signals trickled in. The cron model removes this — by definition we
 * evaluate at most once per 15 min on each symbol, and we always see the
 * full set of webhooks from the just-closed bar at once.
 */
export async function maybeDecide(symbol: string): Promise<void> {
  if (config.MODE === 'telemetry') return;

  const agg = aggregateSymbol(symbol);
  if (!shouldInvokeLlm(agg) || !agg.side) {
    logger.debug({ symbol, bullish: agg.bullish, bearish: agg.bearish }, 'below threshold');
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

  // Regime gate: skip LLM call entirely if we're in low-vol chop. Saves
  // tokens and avoids the worst-EV slice of the trade distribution.
  const regime = await detectRegime(symbol).catch(() => null);
  if (regime?.inChop) {
    logger.info(
      {
        symbol,
        side: agg.side,
        atr_percentile: regime.atrPercentile,
        threshold: regime.threshold,
      },
      'chop regime — blocking new OPEN attempt',
    );
    await sendMessage({
      channel: 'logs',
      text: `🟫 <b>chop SKIP</b> ${symbol} ${agg.side}: ATR в ${regime.atrPercentile}-м перцентиле (порог ${regime.threshold}). LLM не зовём — рынок в боковике.`,
      disable_notification: true,
    });
    return;
  }

  logger.info(
    {
      symbol,
      side: agg.side,
      bullish: agg.bullish,
      bearish: agg.bearish,
      signals: agg.signals.length,
      atr_percentile: regime?.atrPercentile ?? null,
    },
    'invoking LLM',
  );

  let screenshots: { path: string; mediaType: 'image/png' }[] = [];
  let primaryScreenshot: string | null = null;
  if (existsSync(STORAGE_STATE)) {
    try {
      // Subject charts first (15m → 1H → 4H), then BTC context (15m → 1H).
      // 4H gives swing structure — most "bad" trades go against the 4H trend
      // and the model couldn't see it before.
      const subj15 = await captureChart(symbol, '15');
      const subj1h = await captureChart(symbol, '60');
      const subj4h = await captureChart(symbol, '240');
      const btc15 = await captureChart('BTCUSDT', '15');
      const btc1h = await captureChart('BTCUSDT', '60');
      screenshots = [
        { path: subj15, mediaType: 'image/png' },
        { path: subj1h, mediaType: 'image/png' },
        { path: subj4h, mediaType: 'image/png' },
        { path: btc15, mediaType: 'image/png' },
        { path: btc1h, mediaType: 'image/png' },
      ];
      primaryScreenshot = subj15;
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      logger.error({ err, symbol }, 'screenshot capture failed — calling LLM without images');
      // Loud alert when it's a known logged-out failure mode: the LLM is
      // about to reason without charts, which we don't want to repeat the
      // 10h-blind-mode incident from May 9-10.
      if (msg.includes('logged out') || msg.includes('storage state')) {
        await sendMessage({
          channel: 'logs',
          text: `❗️ <b>TradingView logged out</b> — скриншоты не делаются, LLM решает без чартов.\nНа маке: <code>pnpm tsx scripts/tradingview-login.ts</code>, потом залить data/tradingview-storage-state.json на VPS.\nКаждый decide идёт без визуального контекста до починки.`,
        });
      }
    }
  } else {
    logger.warn('tradingview storage state not present — calling LLM without screenshots');
  }

  // All public-data fetches in parallel: Bybit-only sentiment (kept for
  // backwards compat), volume profile, multi-exchange aggregated sentiment,
  // aggregated orderbook, stop clusters. Each has its own cache and graceful
  // null fallback.
  const [sentiment, volumeProfile, aggSentiment, aggOrderbook] = await Promise.all([
    getMarketSentiment(symbol).catch(() => null),
    getVolumeProfile(symbol).catch(() => null),
    getAggregatedSentiment(symbol).catch((err: unknown) => {
      logger.warn({ err, symbol }, 'aggregated sentiment fetch failed');
      return null;
    }),
    getAggregatedOrderbook(symbol).catch((err: unknown) => {
      logger.warn({ err, symbol }, 'aggregated orderbook fetch failed');
      return null;
    }),
  ]);

  // Stop clusters need current price — fetch after we have it
  const currentPriceForClusters =
    aggOrderbook?.midPrice ?? volumeProfile?.vwap ?? aggSentiment?.perExchange.bybit?.lastPrice ?? null;
  const stopClusters = currentPriceForClusters
    ? await getStopClusters(symbol, currentPriceForClusters).catch(() => null)
    : null;

  // Liquidations are in-memory rolling 5min — no async fetch, just read.
  const liquidations = getLiquidations(symbol);

  const result = await callLlm(
    {
      symbol,
      agg,
      open_positions: [],
      daily_pnl_pct: 0,
      mode: config.MODE,
      sentiment,
      volumeProfile,
      aggSentiment,
      aggOrderbook,
      stopClusters,
      liquidations,
    },
    screenshots,
  );

  if ('skipped' in result) {
    logger.warn({ reason: result.reason }, 'llm skipped');
    return;
  }

  // Self-critique pass: only on OPEN decisions. Forces Claude to enumerate
  // realistic failure modes and possibly downgrade its own call to SKIP.
  // Cheap discipline mechanism — costs ~1 extra LLM call per OPEN, no cost
  // on SKIP/CLOSE/MODIFY. Failure to run critique leaves the original
  // decision untouched.
  let critiqueRaw: string | null = null;
  if (result.decision.decision === 'OPEN') {
    const crit = await critiqueDecision(
      result.decision,
      {
        symbol,
        agg,
        open_positions: [],
        daily_pnl_pct: 0,
        mode: config.MODE,
        sentiment,
        volumeProfile,
        aggSentiment,
        aggOrderbook,
        stopClusters,
        liquidations,
      },
      screenshots,
    );
    if (crit) {
      critiqueRaw = crit.raw;
      logger.info(
        {
          symbol,
          original_confidence: result.decision.confidence,
          reassessed_confidence: crit.critique.reassessed_confidence,
          verdict: crit.critique.verdict,
          input_tokens: crit.inputTokens,
          output_tokens: crit.outputTokens,
          latency_ms: crit.latencyMs,
        },
        'self-critique done',
      );

      if (crit.critique.verdict === 'DOWNGRADE_TO_SKIP') {
        // Mutate the decision into a SKIP. We keep the original reasoning so
        // the audit trail shows what Claude WANTED to do before critique
        // killed it.
        const risksBlock = crit.critique.risks.map((r, i) => `  ${i + 1}. ${r}`).join('\n');
        const original = result.decision;
        result.decision = {
          decision: 'SKIP',
          tp: [],
          confidence: crit.critique.reassessed_confidence,
          reasoning_short: `Self-critique → SKIP: ${crit.critique.verdict_reason}`.slice(0, 220),
          reasoning_full:
            `Originally proposed OPEN ${original.side} @ ${original.entry} (SL ${original.sl}, TP ${original.tp[0]}, conf ${original.confidence}).\n\n` +
            `Original reasoning:\n${original.reasoning_full}\n\n` +
            `Self-critique downgraded to SKIP. Reason: ${crit.critique.verdict_reason}\n\nRisks:\n${risksBlock}`.slice(
              0,
              2000,
            ),
        };
      } else {
        // KEEP: lower confidence if critique was harsher; append risks to
        // reasoning_full so the Telegram caption (and audit log) carries them.
        const newConf = Math.min(result.decision.confidence, crit.critique.reassessed_confidence);
        const risksBlock = crit.critique.risks.map((r, i) => `  ${i + 1}. ${r}`).join('\n');
        result.decision = {
          ...result.decision,
          confidence: newConf,
          reasoning_full: `${result.decision.reasoning_full}\n\nSelf-critique (риски):\n${risksBlock}`.slice(
            0,
            2000,
          ),
        };
      }
    }
  }

  // Confidence-tiered sizing. Overrides whatever size_pct the LLM picked
  // (it tends to over-size when confident). Confidence below floor →
  // additional downgrade to SKIP regardless of self-critique verdict.
  if (result.decision.decision === 'OPEN') {
    const sizing = sizeFromConfidence(result.decision.confidence);
    if (sizing.action === 'SKIP') {
      logger.info(
        { symbol, confidence: result.decision.confidence, reason: sizing.reason },
        'sizing → SKIP (confidence below floor)',
      );
      const original = result.decision;
      result.decision = {
        decision: 'SKIP',
        tp: [],
        confidence: original.confidence,
        reasoning_short: `Sizing-floor SKIP: ${sizing.reason}`.slice(0, 220),
        reasoning_full: `Originally OPEN ${original.side} @ ${original.entry} with conf ${original.confidence}.\nSizing tier rejected: ${sizing.reason}.\n\nOriginal reasoning:\n${original.reasoning_full}`.slice(
          0,
          2000,
        ),
      };
    } else {
      logger.info(
        {
          symbol,
          original_size_pct: result.decision.size_pct,
          tiered_size_pct: sizing.sizePct,
          tier: sizing.tier,
          confidence: result.decision.confidence,
        },
        'sizing tier applied',
      );
      result.decision = { ...result.decision, size_pct: sizing.sizePct };
    }
  }

  const limits: RiskLimits = {
    maxSizePct: config.RISK_PCT_PER_TRADE * 4,
    minSlDistPct: 0.2,
    maxSlDistPct: 5.0,
    minRR: 1.5,
    minSlAtrMult: 0.7,
    maxSlAtrMult: 4.0,
  };
  const riskGate = checkDecision(result.decision, limits, volumeProfile?.atr14_15m ?? null);

  const decisionId = insertDecision({
    symbol,
    agg,
    decision: result.decision,
    screenshotPath: primaryScreenshot,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    rawResponse: critiqueRaw
      ? `${result.raw}\n\n--- CRITIQUE ---\n${critiqueRaw}`
      : result.raw,
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
