import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import {
  findActivePositions,
  findDecisionById,
  insertDecision,
  closePositionWithStats,
  updatePositionSl,
  calcPnl,
  type DecisionRow,
} from '../db/repos/decisions.js';
import { recentSignals } from '../db/repos/signals.js';
import { captureChart } from '../browser/tradingview.js';
import { Decision } from '../llm/decision.schema.js';
import { buildMonitorSystemPrompt, buildMonitorUserMessage } from '../llm/monitor-prompt.js';
import { maybeNotifyBillingError } from '../llm/billing-alert.js';
import { aggregateSymbol } from '../signals/aggregator.js';
import { sendMessage, sendPhoto } from '../telegram/bot.js';
import { tradeCaption } from '../telegram/decision-template.js';
import { resultPost } from '../telegram/result-template.js';
import { getLastPrice, getMarketSentiment } from '../exchange/bybit-public.js';
import { getVolumeProfile } from '../exchange/bybit-volume.js';
import {
  getAggregatedOrderbook,
  getAggregatedSentiment,
  getStopClusters,
} from '../exchange/multi-exchange.js';
import { getLiquidations } from '../exchange/liquidations.js';

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
      // Prompt caching on monitor system prompt — same pattern as
      // decide/critique. Monitor cron processes active positions back-to-back
      // (typically 1, sometimes 2-3), so 2nd+ calls within a tick hit cache.
      const resp = await anthropic.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: 2500,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
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
      const isBilling = await maybeNotifyBillingError(err, 'monitor.callMonitorLlm');
      if (isBilling) break;
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

/** Min relative change of SL or TP (% of current price) to count as "substantial". */
const SUBSTANTIAL_CHANGE_PCT = 0.3;

/**
 * A MODIFY is substantial if SL or TP moves >= SUBSTANTIAL_CHANGE_PCT.
 * Trivial MODIFY (small trailing tweaks) are silenced — logged but not posted.
 * CLOSE is always substantial.
 */
function isSubstantialChange(parent: DecisionRow, d: Decision): boolean {
  if (d.decision === 'CLOSE') return true;
  if (d.decision !== 'MODIFY') return true; // OPEN/SKIP — not relevant here

  const parentSl = parent.sl ?? 0;
  const newSl = d.sl ?? parentSl;
  const slChangePct = parentSl > 0 ? (Math.abs(newSl - parentSl) / parentSl) * 100 : 0;

  const parentTp =
    parent.tp_json && parent.tp_json !== 'null' ? Number(JSON.parse(parent.tp_json)?.[0] ?? 0) : 0;
  const newTp = d.tp[0] ?? parentTp;
  const tpChangePct = parentTp > 0 ? (Math.abs(newTp - parentTp) / parentTp) * 100 : 0;

  return slChangePct >= SUBSTANTIAL_CHANGE_PCT || tpChangePct >= SUBSTANTIAL_CHANGE_PCT;
}

/**
 * Per-position locks. Prevents two concurrent monitorPosition() calls on
 * the same position id from racing — which can happen when the webhook
 * ad-hoc trigger fires at the same time as the scheduled monitor cron tick.
 *
 * Two concurrent calls would:
 *   - Double the LLM cost on a single position
 *   - Possibly produce conflicting MODIFY decisions (one wants SL=100, the
 *     other wants SL=101, race-condition on the DB write)
 *   - Confuse the audit trail with two near-simultaneous decision rows
 *
 * Acquired at function entry, released in finally. Late callers see the
 * lock and skip silently (with a log line).
 */
const positionLocks = new Set<number>();

export async function monitorPosition(pInput: DecisionRow): Promise<void> {
  if (positionLocks.has(pInput.id)) {
    logger.info(
      { position_id: pInput.id },
      'monitorPosition: another pass already running for this position, skipping',
    );
    return;
  }
  positionLocks.add(pInput.id);
  try {
    // Refresh from DB at function entry: between when the caller fetched
    // the row and now, another path (tpsl auto-BE, a previous monitor
    // MODIFY, an external CLOSE) may have updated SL or closed the
    // position entirely. Using the stale snapshot would mean: feeding the
    // LLM the wrong SL, or running monitor logic on an already-closed
    // position.
    const fresh = findDecisionById(pInput.id);
    if (!fresh) {
      logger.warn({ position_id: pInput.id }, 'monitorPosition: row gone from DB, skipping');
      return;
    }
    if (fresh.status !== 'active') {
      logger.info(
        { position_id: pInput.id, status: fresh.status },
        'monitorPosition: position no longer active, skipping',
      );
      return;
    }
    await monitorPositionImpl(fresh);
  } finally {
    positionLocks.delete(pInput.id);
  }
}

async function monitorPositionImpl(p: DecisionRow): Promise<void> {
  const sinceOpen = recentSignals(p.created_at).filter((s) => s.symbol === p.symbol);
  const currentPrice = latestPriceFor(p.symbol);
  const ageMin = Math.round((Date.now() - p.created_at) / 60000);

  let screenshots: string[] = [];
  let primaryScreenshot: string | null = null;
  if (existsSync(STORAGE_STATE)) {
    try {
      // Parallel capture — same Playwright context, 5 tabs simultaneously.
      // See note in decide.ts for the rationale.
      const [subj15, subj1h, subj4h, btc15, btc1h] = await Promise.all([
        captureChart(p.symbol, '15'),
        captureChart(p.symbol, '60'),
        captureChart(p.symbol, '240'),
        captureChart('BTCUSDT', '15'),
        captureChart('BTCUSDT', '60'),
      ]);
      screenshots = [subj15, subj1h, subj4h, btc15, btc1h];
      primaryScreenshot = subj15;
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      logger.error({ err, symbol: p.symbol, position_id: p.id }, 'monitor screenshot failed');
      if (msg.includes('logged out')) {
        await sendMessage({
          channel: 'logs',
          text: `❗️ <b>TradingView logged out</b> (monitor для #${p.id.toString().padStart(4, '0')}). Залить новый storage state.`,
        });
      }
    }
  }

  const [sentiment, volumeProfile, aggSentiment, aggOrderbook] = await Promise.all([
    getMarketSentiment(p.symbol).catch(() => null),
    getVolumeProfile(p.symbol).catch(() => null),
    getAggregatedSentiment(p.symbol).catch(() => null),
    getAggregatedOrderbook(p.symbol).catch(() => null),
  ]);

  const priceForClusters =
    currentPrice ?? aggOrderbook?.midPrice ?? volumeProfile?.vwap ?? null;
  const stopClusters = priceForClusters
    ? await getStopClusters(p.symbol, priceForClusters).catch(() => null)
    : null;

  const liquidations = getLiquidations(p.symbol);

  const result = await callMonitorLlm(
    buildMonitorSystemPrompt(),
    buildMonitorUserMessage({
      position: p,
      signalsSinceOpen: sinceOpen,
      currentPrice,
      ageMinutes: ageMin,
      sentiment,
      volumeProfile,
      aggSentiment,
      aggOrderbook,
      stopClusters,
      liquidations,
    }),
    screenshots,
  );

  if (!result) {
    logger.warn({ position_id: p.id }, 'monitor llm unavailable — keeping HOLD');
    return;
  }

  // Aggregator output isn't strictly meaningful for monitor decisions, but we still
  // record the recent context (window=20m of recent signals).
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

  // Posting routing:
  //   SKIP (= HOLD)               -> Logs only, compact note
  //   MODIFY (trivial change)     -> Logs only — user shouldn't be pinged for tiny trail tweaks
  //   MODIFY (substantial change) -> Signals channel with photo (regular trade caption)
  //   CLOSE                        -> Signals channel with photo (RESULT template — PnL etc.)
  const tradeIdStr = `#${p.id.toString().padStart(4, '0')}`;

  if (result.decision.decision === 'SKIP') {
    await sendMessage({
      channel: 'logs',
      text: `🟦 <b>HOLD</b> по сделке ${tradeIdStr} ${p.symbol}: ${result.decision.reasoning_short}`,
      disable_notification: true,
    });
    return;
  }

  // Structural CLOSE from LLM — fetch real Bybit price, compute PnL, close
  // parent with stats, post the result template (different from MODIFY/OPEN).
  if (result.decision.decision === 'CLOSE' && p.entry && p.sl && p.side) {
    const livePrice = (await getLastPrice(p.symbol)) ?? p.entry;
    const tp = p.tp_json ? Number(JSON.parse(p.tp_json)?.[0]) : null;
    const { pnlPct, pnlR } = calcPnl(
      p.side as 'long' | 'short',
      p.entry,
      p.sl,
      livePrice,
    );
    const closedByUs = closePositionWithStats({
      id: p.id,
      closePrice: livePrice,
      closeReason: 'llm_close',
      pnlPct,
      pnlR,
    });
    if (!closedByUs) {
      // TPSL hit (or another monitor pass) won the race and already closed
      // this position. Skip our result-post to avoid duplicate notifications.
      logger.info(
        { position_id: p.id },
        'monitor LLM CLOSE: position already closed by another path, skipping post',
      );
      return;
    }
    logger.info(
      { position_id: p.id, close_price: livePrice, pnl_pct: pnlPct, pnl_r: pnlR },
      'monitor: LLM-driven close with stats',
    );

    const text = resultPost({
      parentTradeId: p.id,
      symbol: p.symbol,
      side: p.side as 'long' | 'short',
      entry: p.entry,
      sl: p.sl,
      tp,
      closePrice: livePrice,
      closeReason: 'llm_close',
      pnlPct,
      pnlR,
      durationMs: Date.now() - p.created_at,
    });
    // Append the LLM's structural reasoning so user sees WHY we closed early.
    const fullText = `${text}\n\n<i>${result.decision.reasoning_short.replace(/[<>&]/g, '')}</i>`.slice(0, 1024);

    if (primaryScreenshot && existsSync(primaryScreenshot)) {
      const sent = await sendPhoto({
        channel: 'signals',
        photoPath: primaryScreenshot,
        caption: fullText,
      });
      if (!sent) await sendMessage({ channel: 'signals', text: fullText });
    } else {
      await sendMessage({ channel: 'signals', text: fullText });
    }
    await sendMessage({ channel: 'logs', text: fullText, disable_notification: true });
    return;
  }

  const substantial = isSubstantialChange(p, result.decision);

  // Apply MODIFY's new SL to the parent position so subsequent TPSL polling
  // uses it. Without this the MODIFY existed only in the audit trail and
  // never affected shadow execution.
  //
  // Anti-widen check uses a FRESH DB read of the SL: during the 60-90s
  // the LLM was thinking, TPSL auto-BE may have moved SL to entry. We must
  // compare against THAT current SL, not the stale snapshot we passed to
  // the LLM. Otherwise the MODIFY could regress a freshly-moved BE SL back
  // to a wider losing-side level.
  if (
    result.decision.decision === 'MODIFY' &&
    result.decision.sl &&
    p.entry &&
    p.side
  ) {
    const currentRow = findDecisionById(p.id);
    if (!currentRow || currentRow.status !== 'active') {
      logger.info(
        { position_id: p.id, status: currentRow?.status ?? 'gone' },
        'monitor MODIFY: position already closed mid-pass, dropping',
      );
    } else {
      const currentSl = currentRow.sl ?? p.sl ?? 0;
      // Anti-widen vs CURRENT SL: long requires new >= current; short requires new <= current.
      const widensRisk =
        p.side === 'long'
          ? result.decision.sl < currentSl
          : result.decision.sl > currentSl;
      if (widensRisk) {
        logger.warn(
          {
            position_id: p.id,
            llm_seen_sl: p.sl,
            current_db_sl: currentSl,
            attempted_new_sl: result.decision.sl,
            side: p.side,
          },
          'MODIFY would widen SL vs current — rejected',
        );
      } else if (result.decision.sl === currentSl) {
        logger.debug(
          { position_id: p.id, sl: currentSl },
          'monitor MODIFY: SL unchanged from current, no-op',
        );
      } else {
        updatePositionSl(p.id, result.decision.sl);
        logger.info(
          { position_id: p.id, old_sl: currentSl, new_sl: result.decision.sl },
          'monitor MODIFY applied: SL updated',
        );
      }
    }
  }

  if (result.decision.decision === 'MODIFY' && !substantial) {
    await sendMessage({
      channel: 'logs',
      text: `🔧 <b>minor MODIFY</b> по сделке ${tradeIdStr} (silent — изменение &lt; ${SUBSTANTIAL_CHANGE_PCT}%): ${result.decision.reasoning_short}`,
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
  // Aligned with decide-cron: 1 min after each 15m bar close. Active
  // positions get re-evaluated 4× per hour now (was 1×) — more responsive
  // to structure changes on 15m TF, at the cost of 3 extra LLM calls per
  // active position per hour. Worth it for tighter trail/CLOSE timing;
  // can be throttled later via "no significant context change" check.
  cron.schedule('1,16,31,46 * * * *', () => {
    void tick();
  });
  logger.info('monitor cron started (1,16,31,46 of every hour, 15m-aligned)');
}
