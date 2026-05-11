import { aggregateSymbol } from '../signals/aggregator.js';
import {
  insertDecision,
  findActivePosition,
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
  // Pure activity gate: any recent signals at all? If literally nothing
  // happened in the last 30 min, no point burning tokens on a blank LLM
  // call. The model gets to decide the side and confidence — we don't
  // pre-judge with weighted heuristics anymore.
  if (agg.signals.length === 0) {
    logger.debug({ symbol }, 'no signals in window, skipping LLM');
    return;
  }

  // Active-position guard. If we have an open position on this symbol
  // (either side), decide-cron skips — monitor cron + the ad-hoc webhook
  // trigger own the lifecycle. We don't OPEN on top of an existing position.
  const active = findActivePosition(symbol);
  if (active) {
    logger.info(
      { symbol, active_id: active.id, side: active.side },
      'active position exists — monitor owns lifecycle, skipping decide',
    );
    return;
  }

  // Note: chop regime gate REMOVED. Two reasons:
  //   1. Same philosophical reason we removed weighted confluence — it was
  //      an arbitrary heuristic OUTSIDE the LLM, and the LLM is better at
  //      judging "is the chart tradeable" than a single ATR percentile.
  //   2. Percentile-based detection has a fundamental flaw: after a big
  //      move, recent extreme bars dominate the historical distribution,
  //      making subsequent NORMAL volatility look like "chop" by comparison.
  //      Concrete case from 2026-05-11: TON had a 10% intraday range (real
  //      moves on huge bars), then traded normally at 0.9%/bar — the
  //      detector reported percentile 7 (= "dead") because the big bars
  //      from the same day inflated the baseline. We blocked LLM on the
  //      entire post-move calm trading window.
  // The LLM sees ATR(14) 15m directly in the volume profile block and can
  // self-assess volatility regime.

  logger.info(
    {
      symbol,
      bullish_count: agg.bullish,
      bearish_count: agg.bearish,
      signals: agg.signals.length,
    },
    'invoking LLM',
  );

  let screenshots: { path: string; mediaType: 'image/png' }[] = [];
  let primaryScreenshot: string | null = null;
  if (existsSync(STORAGE_STATE)) {
    try {
      // Parallel capture: 5 screenshots from the SAME Playwright browser
      // context (multiple tabs of one logged-in session). Sequential took
      // 25-50 sec just for screenshots before the LLM call could even start;
      // parallel cuts that to ~10-15 sec (each capture still takes time but
      // they overlap). Same-context = same TV session — no "multiple devices"
      // detection risk.
      const [subj15, subj1h, subj4h, btc15, btc1h] = await Promise.all([
        captureChart(symbol, '15'),
        captureChart(symbol, '60'),
        captureChart(symbol, '240'),
        captureChart('BTCUSDT', '15'),
        captureChart('BTCUSDT', '60'),
      ]);
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
        const fullReasoning =
          `Originally proposed OPEN ${original.side} @ ${original.entry} (SL ${original.sl}, TP ${original.tp[0]}, conf ${original.confidence}).\n\n` +
          `Original reasoning:\n${original.reasoning_full}\n\n` +
          `Self-critique downgraded to SKIP. Reason: ${crit.critique.verdict_reason}\n\nRisks:\n${risksBlock}`;
        result.decision = {
          decision: 'SKIP',
          tp: [],
          confidence: crit.critique.reassessed_confidence,
          reasoning_short: `Self-critique → SKIP: ${crit.critique.verdict_reason}`.slice(0, 400),
          reasoning_full: fullReasoning.slice(0, 5000),
        };
      } else {
        // KEEP: lower confidence if critique was harsher; append risks to
        // reasoning_full so the Telegram caption (and audit log) carries them.
        const newConf = Math.min(result.decision.confidence, crit.critique.reassessed_confidence);
        const risksBlock = crit.critique.risks.map((r, i) => `  ${i + 1}. ${r}`).join('\n');
        const fullReasoning = `${result.decision.reasoning_full}\n\nSelf-critique (риски):\n${risksBlock}`;
        result.decision = {
          ...result.decision,
          confidence: newConf,
          reasoning_full: fullReasoning.slice(0, 5000),
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
      const fullReasoning = `Originally OPEN ${original.side} @ ${original.entry} with conf ${original.confidence}.\nSizing tier rejected: ${sizing.reason}.\n\nOriginal reasoning:\n${original.reasoning_full}`;
      result.decision = {
        decision: 'SKIP',
        tp: [],
        confidence: original.confidence,
        reasoning_short: `Sizing-floor SKIP: ${sizing.reason}`.slice(0, 400),
        reasoning_full: fullReasoning.slice(0, 5000),
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

  // raw_response in DB is for audit only; cap at 30 KB to keep row size sane.
  // Combined raw + critique can reach 15-20 KB on verbose OPEN decisions;
  // 30 KB gives headroom without bloating the DB toward GB-scale over years.
  const RAW_RESPONSE_CAP = 30_000;
  const rawCombined = critiqueRaw
    ? `${result.raw}\n\n--- CRITIQUE ---\n${critiqueRaw}`
    : result.raw;
  const decisionId = insertDecision({
    symbol,
    agg,
    decision: result.decision,
    screenshotPath: primaryScreenshot,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    rawResponse:
      rawCombined.length > RAW_RESPONSE_CAP
        ? rawCombined.slice(0, RAW_RESPONSE_CAP) + '\n... [truncated]'
        : rawCombined,
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
