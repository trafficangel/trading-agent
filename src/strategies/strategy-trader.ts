import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import {
  insertDecision,
  findActiveByStrategy,
  forceClose,
  calcPnl,
} from '../db/repos/decisions.js';
import { aggregateSymbol } from '../signals/aggregator.js';
import { getLastPrice } from '../exchange/bybit-public.js';
import { sendMessage } from '../telegram/bot.js';
import { deriveActionSide, type LuxAlgoStrategyPayload } from '../webhooks/luxalgo.schema.js';
import type { Decision } from '../llm/decision.schema.js';
import {
  getStrategyConfig,
  TRACK_C_NOTIONAL_USD,
  type StrategyConfig,
} from './track-c-config.js';

/**
 * Track C — LuxAlgo AI Strategy Builder webhook trader.
 *
 * Receives entry/exit webhooks from LuxAlgo strategies configured by the
 * operator. Each strategy has a stable `strategy_id` (matches the key in
 * STRATEGY_CONFIGS) and its own safety `slPct`. The strategy itself owns
 * exit logic via "Builtin Exits" — we just execute and record.
 *
 * Lifecycle:
 *   ENTRY webhook  → open market position with safety SL (no TP)
 *   EXIT webhook   → close at market, recorded with force_close_reason='strategy_exit'
 *   SL hit         → close at market by tpsl-monitor (track-C SL-only branch)
 *   Time-guard 24h → close at market by tpsl-monitor (force_close_reason='time_guard')
 *
 * Edge cases (all return 200 to TradingView to avoid retry storms):
 *   - Duplicate entry while open: ignored, log warn
 *   - Exit on no active position: ignored, log warn
 *   - Unknown / disabled strategy: ignored
 *   - Symbol mismatch (config has symbol pin): ignored
 *
 * One position per (symbol, strategy_id) at a time — flip-without-exit is
 * NOT auto-handled (forces clean exit→entry sequence in the alert config).
 */

export type StrategyWebhookResult = {
  ok: boolean;
  reason?: string;
  decisionId?: number;
};

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export async function handleStrategyWebhook(
  p: LuxAlgoStrategyPayload,
): Promise<StrategyWebhookResult> {
  if (!config.TRACK_C_ENABLED) {
    logger.debug({ strategy_id: p.strategy_id }, 'strategy-trader: Track C disabled');
    return { ok: true, reason: 'track_c_disabled' };
  }

  const cfg = getStrategyConfig(p.strategy_id);
  if (!cfg) {
    logger.warn({ strategy_id: p.strategy_id, symbol: p.symbol }, 'strategy-trader: unknown strategy_id');
    return { ok: true, reason: 'unknown_or_disabled_strategy' };
  }
  if (!cfg.enabled) {
    logger.info({ strategy_id: p.strategy_id }, 'strategy-trader: strategy disabled in config');
    return { ok: true, reason: 'unknown_or_disabled_strategy' };
  }

  if (cfg.symbol && cfg.symbol !== p.symbol) {
    logger.warn(
      { strategy_id: p.strategy_id, expected: cfg.symbol, got: p.symbol },
      'strategy-trader: symbol mismatch',
    );
    return { ok: true, reason: 'symbol_mismatch' };
  }

  // Normalise LuxAlgo's strategy_event placeholder (or explicit action+side)
  // into a single {action, side} pair the rest of the trader works with.
  const derived = deriveActionSide(p);

  if (derived.action === 'entry') {
    return handleStrategyEntry(p, cfg, derived.side);
  }
  return handleStrategyExit(p, cfg);
}

async function handleStrategyEntry(
  p: LuxAlgoStrategyPayload,
  cfg: StrategyConfig,
  derivedSide: 'long' | 'short' | undefined,
): Promise<StrategyWebhookResult> {
  // Side from deriveActionSide() — works for both explicit (form A) and
  // strategy_event-driven (form B) payloads.
  const side = derivedSide;
  if (side !== 'long' && side !== 'short') {
    logger.warn({ strategy_id: p.strategy_id, derivedSide }, 'strategy-trader: missing side on entry');
    return { ok: false, reason: 'missing_side' };
  }

  // Single-position-per-(symbol, strategy_id) guard.
  const occupied = findActiveByStrategy(p.symbol, p.strategy_id);
  if (occupied) {
    logger.warn(
      { strategy_id: p.strategy_id, occupied_id: occupied.id, symbol: p.symbol },
      'strategy-trader: entry rejected — strategy already has open position',
    );
    await sendMessage({
      channel: 'logs',
      text:
        `⚠️ <b>Track C duplicate entry ignored</b>\n` +
        `Стратегия: <code>${p.strategy_id}</code> на ${p.symbol}\n` +
        `Уже открыта позиция T#${occupied.id.toString().padStart(4, '0')}. Новый entry webhook отброшен.`,
      disable_notification: true,
    }).catch(() => {});
    return { ok: true, reason: 'already_open', decisionId: occupied.id };
  }

  // Entry price: payload's `price` (TV bar close) or fallback to ticker.
  let entry = p.price ?? null;
  if (entry == null) {
    entry = await getLastPrice(p.symbol);
  }
  if (entry == null) {
    logger.warn({ strategy_id: p.strategy_id, symbol: p.symbol }, 'strategy-trader: no entry price available');
    return { ok: false, reason: 'no_price' };
  }

  // Safety SL = entry ± entry × slPct
  const slDist = entry * cfg.slPct;
  const sl = round(side === 'long' ? entry - slDist : entry + slDist, 4);
  const slPctDisplay = (cfg.slPct * 100).toFixed(2);

  // Build a synthetic Decision that flows through the existing insertDecision
  // pipeline. Empty tp[] + tp1Price=null keeps tpsl-monitor on the SL-only
  // branch (added in this commit) — no TP detection, no BE move.
  const decision: Decision = {
    decision: 'OPEN',
    side,
    entry_type: 'market',
    tp_strategy: 'swing', // arbitrary — Track C has no scalp/swing concept
    entry,
    sl,
    tp: [], // empty — strategy decides exit via webhook
    size_pct: 0.5, // cosmetic — actual sizing is $1000 fixed (see TRACK_C_NOTIONAL_USD)
    confidence: 0.5, // arbitrary — no LLM here
    reasoning_short:
      `🤖 STRAT [${p.strategy_id}] ${side} ${p.symbol} @ ${entry} · SL ${sl} (${slPctDisplay}%)`,
    reasoning_full: [
      `Track C — LuxAlgo Strategy Builder entry.`,
      ``,
      `Strategy: ${p.strategy_id}`,
      `Description: ${cfg.description}`,
      `Symbol: ${p.symbol}`,
      `Timeframe: ${p.timeframe}m`,
      ``,
      `Side: ${side}`,
      `Entry: ${entry} (market)`,
      `Safety SL: ${sl} (${slPctDisplay}% from entry)`,
      `Notional: $${TRACK_C_NOTIONAL_USD}`,
      ``,
      `Exit is delegated to the strategy's Builtin Exits via webhook.`,
      `Time-guard: 24h hard close if no exit webhook arrives.`,
    ].join('\n'),
  };

  const agg = aggregateSymbol(p.symbol);
  const decisionId = insertDecision({
    symbol: p.symbol,
    agg,
    decision,
    screenshotPath: null,
    inputTokens: 0,
    outputTokens: 0,
    rawResponse: JSON.stringify(p),
    features: {
      source: 'strategy_trader',
      strategy_id: p.strategy_id,
      strategy_code: cfg.code,
      strategy_description: cfg.description,
      strategy_timeframe: p.timeframe,
      notional_usd: TRACK_C_NOTIONAL_USD,
    },
    track: 'strategy',
    strategyId: p.strategy_id,
  });

  logger.info(
    {
      decision_id: decisionId,
      strategy_id: p.strategy_id,
      symbol: p.symbol,
      side,
      entry,
      sl,
      slPct: cfg.slPct,
    },
    'strategy-trader: entry opened',
  );

  await sendStrategyEntryPost(decisionId, p, cfg, entry, sl, side);
  return { ok: true, decisionId };
}

async function handleStrategyExit(
  p: LuxAlgoStrategyPayload,
  cfg: StrategyConfig,
): Promise<StrategyWebhookResult> {
  const active = findActiveByStrategy(p.symbol, p.strategy_id);
  if (!active) {
    logger.warn(
      { strategy_id: p.strategy_id, symbol: p.symbol },
      'strategy-trader: exit webhook but no active position (already closed by SL or duplicate exit)',
    );
    await sendMessage({
      channel: 'logs',
      text:
        `⚠️ <b>Track C exit ignored</b>\n` +
        `Стратегия: <code>${p.strategy_id}</code> на ${p.symbol}\n` +
        `Нет активной позиции — вероятно уже закрылась по SL или дубль exit webhook.`,
      disable_notification: true,
    }).catch(() => {});
    return { ok: true, reason: 'no_active_position' };
  }

  if (!active.entry || !active.side) {
    logger.error({ id: active.id }, 'strategy-trader: active position missing entry/side, cannot exit');
    return { ok: false, reason: 'corrupt_position' };
  }

  // Close at the strategy-reported price, or fallback to current ticker.
  let closePrice = p.price ?? null;
  if (closePrice == null) closePrice = await getLastPrice(p.symbol);
  if (closePrice == null) {
    logger.warn({ id: active.id }, 'strategy-trader: exit price unavailable');
    return { ok: false, reason: 'no_price' };
  }

  const slForR = active.original_sl ?? active.sl ?? active.entry;
  const side = active.side as 'long' | 'short';
  const { pnlPct, pnlR } = calcPnl(side, active.entry, slForR, closePrice);

  const closed = forceClose({
    id: active.id,
    closePrice,
    closeReason: 'manual',
    pnlPct,
    pnlR,
    forceReason: 'strategy_exit',
  });
  if (!closed) {
    logger.info({ id: active.id }, 'strategy-trader: exit — position already closed by another path');
    return { ok: true, reason: 'already_closed' };
  }

  logger.info(
    {
      decision_id: active.id,
      strategy_id: p.strategy_id,
      symbol: p.symbol,
      side: active.side,
      close_price: closePrice,
      pnl_pct: pnlPct,
      pnl_r: pnlR,
    },
    'strategy-trader: position closed via strategy exit webhook',
  );

  await sendStrategyExitPost(active.id, p, cfg, active.entry, closePrice, side, pnlPct, pnlR, active.created_at, active.filled_at);
  return { ok: true, decisionId: active.id };
}

// --- Telegram templates ---------------------------------------------------

function sideEmoji(side: 'long' | 'short'): string {
  return side === 'long' ? '🟢' : '🔴';
}

function sideRu(side: 'long' | 'short'): string {
  return side === 'long' ? 'ЛОНГ' : 'ШОРТ';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}д ${h}ч ${m}м`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

async function sendStrategyEntryPost(
  decisionId: number,
  p: LuxAlgoStrategyPayload,
  cfg: StrategyConfig,
  entry: number,
  sl: number,
  side: 'long' | 'short',
): Promise<void> {
  const tradeIdStr = `T#${decisionId.toString().padStart(4, '0')}`;
  const slPctDisplay = (cfg.slPct * 100).toFixed(2);
  const text = [
    `🤖 <b>${tradeIdStr}</b>  <b>[STRAT-${cfg.code}]</b>  ${sideEmoji(side)} <b>${escapeHtml(p.symbol)}</b> ${sideRu(side)}`,
    `🏷 <code>${escapeHtml(cfg.description)}</code>`,
    ``,
    `📥 Вход:  <code>${entry}</code>  (по рынку)`,
    `🛡 Стоп:  <code>${sl}</code>  (${slPctDisplay}%) — страховка`,
    ``,
    `<i>Выход — по сигналу стратегии (Builtin Exits).</i>`,
  ].join('\n');
  await sendMessage({ channel: 'signals', text }).catch((err) =>
    logger.error({ err }, 'strategy-trader: entry post to signals failed'),
  );
  await sendMessage({ channel: 'logs', text, disable_notification: true }).catch(() => {});
}

async function sendStrategyExitPost(
  decisionId: number,
  p: LuxAlgoStrategyPayload,
  cfg: StrategyConfig,
  entry: number,
  closePrice: number,
  side: 'long' | 'short',
  pnlPct: number,
  pnlR: number,
  createdAt: number,
  filledAt: number | null,
): Promise<void> {
  const tradeIdStr = `T#${decisionId.toString().padStart(4, '0')}`;
  const durMs = Date.now() - (filledAt ?? createdAt);
  const pnlSign = pnlPct >= 0 ? '+' : '';
  const usdPnl = (pnlPct / 100) * TRACK_C_NOTIONAL_USD;
  const usdSign = usdPnl >= 0 ? '+' : '';
  // pnlR computed (passed in) but not displayed — operator preference.
  void pnlR;
  const text = [
    `🏁 <b>Сигнал выхода · ${tradeIdStr}</b>  <b>[STRAT-${cfg.code}]</b>  ${sideEmoji(side)} ${escapeHtml(p.symbol)}`,
    `🏷 <code>${escapeHtml(cfg.description)}</code>`,
    ``,
    `📥 Вход:   <code>${entry}</code>`,
    `📤 Выход:  <code>${closePrice}</code>  (по сигналу стратегии)`,
    `📊 Результат: <b>${pnlSign}${pnlPct.toFixed(2)}%</b>  ·  <b>${usdSign}$${usdPnl.toFixed(2)}</b>`,
    `⏱ Длительность: ${formatDuration(durMs)}`,
  ].join('\n');
  await sendMessage({ channel: 'signals', text }).catch((err) =>
    logger.error({ err }, 'strategy-trader: exit post to signals failed'),
  );
  await sendMessage({ channel: 'logs', text, disable_notification: true }).catch(() => {});
}
