import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { aggregateSymbol } from './aggregator.js';
import {
  insertDecision,
  findActiveOrPendingByTrack,
  findRecentSignalOpen,
} from '../db/repos/decisions.js';
import { getVolumeProfile } from '../exchange/bybit-volume.js';
import { sendMessage } from '../telegram/bot.js';
import type { LuxAlgoPayload } from '../webhooks/luxalgo.schema.js';
import type { Decision } from '../llm/decision.schema.js';

/**
 * Track B — Pure LuxAlgo Signal Trader.
 *
 * A rule-based trader that fires on qualifying webhook events with NO
 * LLM involvement. Stored in the same `decisions` table with track='signal'
 * for direct A/B comparison against the LLM-driven decisions (track='llm').
 *
 * Trigger rules (intentionally simple to start — easy to read, easy to
 * harden later based on observed behaviour):
 *   - Event must be a "primary entry" type:
 *       bullish_plus / bearish_plus  (Signals & Overlays)
 *       choch_up / choch_down        (PAC structure break)
 *       bos_up / bos_down            (Break of structure)
 *   - Timeframe must be 15m (we ignore 5m noise + 1H/4H rare).
 *   - Cooldown: no signal-track OPEN on same symbol in last
 *     SIGNAL_COOLDOWN_MIN minutes (default 30).
 *   - Capacity: no existing active OR pending signal-track position on
 *     this symbol (1 concurrent per symbol — same hygiene as LLM track).
 *
 * SL / TP geometry:
 *   - If ATR(14) on 15m is available → SL = 1.5×ATR, TP = 3×ATR (R:R 1:2)
 *   - Fallback (ATR fetch failed) → fixed 1% SL, 2% TP
 *
 * Size: SIGNAL_TRADE_SIZE_PCT (default 0.5%) flat. No confidence tiers
 * because there's no LLM to produce confidence here.
 *
 * Why we DON'T require confluence today:
 *   The whole point of Track B is to test "raw LuxAlgo signals" — adding
 *   confluence filters drifts us back toward the LLM-track complexity we
 *   want to compare against. Start dumb, observe, then add filters that
 *   provably improve the win rate.
 */

const ENTRY_EVENTS_LONG = new Set([
  'bullish_plus',
  'bullish_plus_strong',
  'choch_up',
  'bos_up',
  'reversal_signal_up',
]);
const ENTRY_EVENTS_SHORT = new Set([
  'bearish_plus',
  'bearish_plus_strong',
  'choch_down',
  'bos_down',
  'reversal_signal_down',
]);

/** Only the 15m entry timeframe is wired up. Easy to add 1H later if needed. */
const TRADEABLE_TIMEFRAMES = new Set(['15']);

function isEntryEvent(event: string): 'long' | 'short' | null {
  if (ENTRY_EVENTS_LONG.has(event)) return 'long';
  if (ENTRY_EVENTS_SHORT.has(event)) return 'short';
  return null;
}

type TradeGeometry = {
  entry: number;
  sl: number;
  tp: number;
  slPct: number;
  tpPct: number;
  rr: number;
  source: 'atr' | 'fixed';
};

function computeGeometry(side: 'long' | 'short', entry: number, atr15m: number | null): TradeGeometry {
  if (atr15m && atr15m > 0) {
    const slDist = 1.5 * atr15m;
    const tpDist = 3.0 * atr15m;
    const sl = side === 'long' ? entry - slDist : entry + slDist;
    const tp = side === 'long' ? entry + tpDist : entry - tpDist;
    return {
      entry,
      sl: round(sl, 4),
      tp: round(tp, 4),
      slPct: (slDist / entry) * 100,
      tpPct: (tpDist / entry) * 100,
      rr: tpDist / slDist,
      source: 'atr',
    };
  }
  // Fixed-percent fallback
  const slPct = 0.01; // 1%
  const tpPct = 0.02; // 2%
  const sl = side === 'long' ? entry * (1 - slPct) : entry * (1 + slPct);
  const tp = side === 'long' ? entry * (1 + tpPct) : entry * (1 - tpPct);
  return {
    entry,
    sl: round(sl, 4),
    tp: round(tp, 4),
    slPct: slPct * 100,
    tpPct: tpPct * 100,
    rr: tpPct / slPct,
    source: 'fixed',
  };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Process an incoming signal — called from the webhook route after the
 * raw signal has been inserted into `signals`. No-op if the feature flag
 * is off, the event doesn't qualify, or guards block.
 */
export async function maybeTriggerSignalTrade(payload: LuxAlgoPayload): Promise<void> {
  if (!config.SIGNAL_TRADER_ENABLED) return;

  // 1. Event qualifies?
  const side = isEntryEvent(payload.event);
  if (!side) {
    logger.debug({ event: payload.event }, 'signal-trader: event not in entry set');
    return;
  }

  // 2. Timeframe in our tradeable set?
  if (!TRADEABLE_TIMEFRAMES.has(payload.timeframe)) {
    logger.debug({ tf: payload.timeframe }, 'signal-trader: timeframe not in tradeable set');
    return;
  }

  // 3. Cooldown check — last signal OPEN on this symbol within window?
  const cooldownMs = config.SIGNAL_COOLDOWN_MIN * 60 * 1000;
  const recent = findRecentSignalOpen(payload.symbol, Date.now() - cooldownMs);
  if (recent) {
    logger.info(
      { symbol: payload.symbol, recent_id: recent.id, age_min: Math.round((Date.now() - recent.created_at) / 60000) },
      'signal-trader: cooldown active, skipping',
    );
    return;
  }

  // 4. Concurrent capacity — already an active/pending signal trade on this symbol?
  const occupied = findActiveOrPendingByTrack(payload.symbol, 'signal');
  if (occupied) {
    logger.info(
      { symbol: payload.symbol, occupied_id: occupied.id, side: occupied.side },
      'signal-trader: symbol occupied on signal track, skipping',
    );
    return;
  }

  // 5. Need a price reference. Webhook payload price is best; fall back
  //    to volume profile VWAP.
  let entryPrice = payload.price ?? null;
  let atr15m: number | null = null;
  try {
    const vp = await getVolumeProfile(payload.symbol);
    if (vp) {
      atr15m = vp.atr14_15m;
      if (entryPrice == null) entryPrice = vp.vwap;
    }
  } catch (err) {
    logger.warn({ err, symbol: payload.symbol }, 'signal-trader: volume profile fetch failed');
  }
  if (entryPrice == null) {
    logger.warn({ symbol: payload.symbol }, 'signal-trader: no entry price available, skipping');
    return;
  }

  // 6. Geometry
  const geo = computeGeometry(side, entryPrice, atr15m);

  // 7. Build synthetic Decision. Track='signal' — flows through the same
  //    insertDecision + tpsl-monitor pipeline as LLM trades.
  const decision: Decision = {
    decision: 'OPEN',
    side,
    entry_type: 'market', // signal-trader fires market at the bar close price
    tp_strategy: 'swing', // R:R 1:2 fits swing, not scalp
    entry: geo.entry,
    sl: geo.sl,
    tp: [geo.tp],
    size_pct: config.SIGNAL_TRADE_SIZE_PCT,
    confidence: 0.5, // arbitrary — there's no LLM here, but downstream code reads this
    reasoning_short: `📡 SIG ${side} ${payload.symbol}: ${payload.event} on ${payload.timeframe}m @ ${geo.entry}. SL ${geo.sl} (${geo.slPct.toFixed(2)}%), TP ${geo.tp} (${geo.tpPct.toFixed(2)}%), R:R 1:${geo.rr.toFixed(1)} (${geo.source}).`,
    reasoning_full: [
      `Pure-signal Track B trigger.`,
      ``,
      `Trigger event: ${payload.event} on ${payload.timeframe}m`,
      `Source: ${payload.source}`,
      `Bar time: ${new Date(payload.bar_time).toISOString()}`,
      ``,
      `Side: ${side}`,
      `Entry: ${geo.entry} (market)`,
      `SL: ${geo.sl} (${geo.slPct.toFixed(2)}%)`,
      `TP: ${geo.tp} (${geo.tpPct.toFixed(2)}%)`,
      `R:R: 1:${geo.rr.toFixed(2)}`,
      `Geometry source: ${geo.source} (ATR15m=${atr15m ?? 'unavailable'})`,
      `Size: ${config.SIGNAL_TRADE_SIZE_PCT}%`,
      ``,
      `No LLM was consulted — pure rule-based trade for A/B comparison vs the LLM track.`,
    ].join('\n'),
  };

  // Use the existing aggregate (mostly for signal_ids audit trail).
  const agg = aggregateSymbol(payload.symbol);

  const decisionId = insertDecision({
    symbol: payload.symbol,
    agg,
    decision,
    screenshotPath: null, // pure-signal trader takes no chart screenshots
    inputTokens: 0,
    outputTokens: 0,
    rawResponse: JSON.stringify({ payload, geometry: geo }),
    features: { source: 'signal_trader', trigger_event: payload.event, geometry_source: geo.source },
    track: 'signal',
  });

  logger.info(
    {
      decision_id: decisionId,
      symbol: payload.symbol,
      side,
      entry: geo.entry,
      sl: geo.sl,
      tp: geo.tp,
      rr: geo.rr,
      track: 'signal',
    },
    'signal-trader: trade opened',
  );

  // Telegram — distinct visual prefix so the user can tell tracks apart
  // at a glance. SIG # prefix + 📡 emoji + bracketed track label.
  const sideE = side === 'long' ? '🟢' : '🔴';
  const sideRu = side === 'long' ? 'ЛОНГ' : 'ШОРТ';
  const tradeIdStr = `S#${decisionId.toString().padStart(4, '0')}`;
  const tgText = [
    `📡 <b>[TRACK B · SIGNAL] ${tradeIdStr}</b>`,
    `${sideE} <b>${payload.symbol}</b> ${sideRu} · pure-rule trigger`,
    ``,
    `🎯 Trigger: <code>${payload.event}</code> на <code>${payload.timeframe}m</code>`,
    `📥 Вход:  <code>${geo.entry}</code> (market)`,
    `🛡 Стоп:  <code>${geo.sl}</code>  (<code>${geo.slPct.toFixed(2)}%</code>)`,
    `🎯 Цель:  <code>${geo.tp}</code>  (<code>${geo.tpPct.toFixed(2)}%</code>)`,
    `📐 R:R:   <code>1 : ${geo.rr.toFixed(1)}</code>  ·  size <code>${config.SIGNAL_TRADE_SIZE_PCT}%</code>`,
    `⚙️ Геометрия: <i>${geo.source === 'atr' ? `1.5×ATR / 3×ATR (ATR=${atr15m?.toFixed(4)})` : 'fixed 1% / 2% fallback'}</i>`,
    ``,
    `<i>Параллельная стратегия — без LLM, чистые сигналы LuxAlgo.</i>`,
  ].join('\n');

  await sendMessage({ channel: 'signals', text: tgText }).catch((err) =>
    logger.error({ err }, 'signal-trader: telegram send failed'),
  );
  await sendMessage({ channel: 'logs', text: tgText, disable_notification: true }).catch(() => {});
}
