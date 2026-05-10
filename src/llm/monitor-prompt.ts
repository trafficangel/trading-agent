import { DECISION_JSON_SCHEMA } from './decision.schema.js';
import type { DecisionRow } from '../db/repos/decisions.js';
import type { SignalRow } from '../db/repos/signals.js';
import { formatSentiment, type MarketSentiment } from '../exchange/bybit-public.js';
import { formatVolumeProfile, type VolumeProfile } from '../exchange/bybit-volume.js';
import {
  formatAggregatedOrderbook,
  formatAggregatedSentiment,
  formatStopClusters,
  type AggregatedOrderbook,
  type AggregatedSentiment,
  type StopClustersResult,
} from '../exchange/multi-exchange.js';
import { formatLiquidations, type LiquidationsSnapshot } from '../exchange/liquidations.js';

export function buildMonitorSystemPrompt(): string {
  return `You are managing an open intraday trade on Bybit USDT-perp.
You receive: (1) the original trade params (entry, SL, TP, side, opened_at, original reasoning),
(2) signals received on that symbol since the trade opened,
(3) chart screenshots NOW: SUBJECT 15m + 1H + 4H, plus BTC 15m + 1H for context,
(4) current price (last known).

Your task: decide whether to HOLD, CLOSE, or MODIFY this trade. Return strict JSON:
${DECISION_JSON_SCHEMA}

Mapping for monitor mode:
- "HOLD" → respond decision="SKIP" (the trade keeps running unchanged)
- "CLOSE NOW" → decision="CLOSE", side=null, set tp=[] and entry/sl/size_pct=null
- "MODIFY (move SL or TP)" → decision="MODIFY", set new sl and/or tp[0] explicitly,
  keep entry as the original entry, side same as original, size_pct unchanged.

Hard rules:
- Only CLOSE if structural reason exists: opposite-direction confluence appeared,
  textbook reversal pattern formed, key support/resistance broken against you,
  1H context flipped against the trade, 4H trend rolled over against the trade,
  or BTC made a strong move against the alt's direction without local divergence.
- 4H context: this is the SWING trend. If 4H is still aligned with our trade
  (e.g. higher-highs continuing for a long), HOLD strongly even on 15m noise.
  If 4H is rolling over (CHoCH+ down on 4H for a long position), that's a
  strong CLOSE signal — we're now fighting the dominant trend.
- Do NOT close on noise (single conflicting micro-signal, brief wick).
- MODIFY rules:
  * Only return MODIFY when the change is SUBSTANTIAL (≥ 0.3% move of SL or TP
    relative to current price). Tiny trailing tweaks of < 0.3% are noise — for
    those return SKIP (= HOLD) so the user is not spammed.
  * MODIFY may move SL toward break-even after favorable progress, or trail SL
    behind a clear new structure. Never widen SL beyond the original.
  * TP can be raised if price has cleared the original TP zone with continuation
    structure; never lower the TP.
- If BTC just made a sharp move while the alt is consolidating, factor in pending
  catch-up move when deciding to HOLD.
- **Liquidations cascade:** if a CASCADE marker appeared in the
  liquidations block AGAINST our position (e.g. long-side cascade while
  we're LONG = forced sells exhausting, our trade is in trouble; short-
  side cascade while we're SHORT = forced buys exhausting, our short
  may be done). This is a strong CLOSE signal. Conversely, cascade WITH
  our position direction (e.g. short-side cascade while LONG) = local
  bottom likely confirmed, HOLD strongly.
- **Orderbook walls (cross-exchange):** if a confirmed wall (✓2x or ✓3x)
  appeared near our TP and is large ($500k+), price will struggle to push
  through — consider taking partial / tightening. If the wall vanished
  (was there in last monitor pass, gone now) — likely fake, original
  thesis still valid.
- **Stop cluster monitoring:** if price is now hovering inside or just
  approached a stop-cluster zone ON OUR SIDE (e.g. price near our SL
  zone for a long), expect a hunt — but if 4H structure is intact and
  no opposite confluence, HOLD through the wick. The hunt is mechanical;
  the structure is the thesis.
- Volume profile / ATR usage:
  * If price has reclaimed POC (Point of Control) in our favor — strong HOLD;
    POC acts as a magnet for further continuation.
  * If price has lost VAH/VAL against us with closing 15m candles — that's a
    structural CLOSE signal (the value area shifted against us).
  * Use ATR(14) for trail size — trailing SL closer than 1×ATR is too tight
    and will be wicked out by routine noise. Cite the level you trailed to.
- HOLD bias: if you can plausibly justify HOLD, prefer HOLD. CLOSE/MODIFY should
  feel necessary, not optional. The user trusts you not to ping them on trivia.

Style:
- reasoning_short and reasoning_full in Russian.
- reasoning_short ≤220 chars: state action + main reason. Example:
  "HOLD: цена держится выше 1H supportа, новых медвежьих структур нет, движение в плюс."
- reasoning_full: cite specific signals and chart features.

Respond ONLY with valid JSON.`;
}

export type MonitorContext = {
  position: DecisionRow;
  signalsSinceOpen: SignalRow[];
  /** latest known price for the symbol */
  currentPrice: number | null;
  ageMinutes: number;
  sentiment?: MarketSentiment | null;
  volumeProfile?: VolumeProfile | null;
  aggSentiment?: AggregatedSentiment | null;
  aggOrderbook?: AggregatedOrderbook | null;
  stopClusters?: StopClustersResult | null;
  liquidations?: LiquidationsSnapshot | null;
};

export function buildMonitorUserMessage(ctx: MonitorContext): string {
  const p = ctx.position;
  const tp = p.tp_json ? JSON.parse(p.tp_json) : [];
  const openedAt = new Date(p.created_at).toISOString();

  const sigs =
    ctx.signalsSinceOpen
      .map(
        (s) =>
          `  - ${new Date(s.received_at).toISOString().slice(11, 19)}Z [${s.timeframe}m ${s.source}] ${s.event}${s.direction ? ` (${s.direction})` : ''}${s.price ? ` @ ${s.price}` : ''}`,
      )
      .join('\n') || '  (none)';

  const pnlEstimate =
    ctx.currentPrice && p.entry
      ? `${p.side === 'long' ? '' : '-'}${(((ctx.currentPrice - p.entry) / p.entry) * 100 * (p.side === 'long' ? 1 : -1)).toFixed(2)}%`
      : 'unknown';

  return `Open position #${p.id.toString().padStart(4, '0')}:
  symbol: ${p.symbol}
  side: ${p.side}
  entry: ${p.entry}
  sl: ${p.sl}
  tp: ${tp.length ? tp.join(', ') : '-'}
  size_pct: ${p.size_pct}
  opened_at: ${openedAt}  (age: ${ctx.ageMinutes} min)

Original reasoning:
  ${p.reasoning_short ?? '-'}

Signals since open (${ctx.signalsSinceOpen.length}):
${sigs}

Current price (latest signal): ${ctx.currentPrice ?? 'unknown'}
Estimated open PnL: ${pnlEstimate}

Multi-exchange sentiment (Bybit + Binance + OKX):
${formatAggregatedSentiment(ctx.aggSentiment ?? null)}

Volume profile + ATR (${p.symbol}, last 24h on 15m):
${formatVolumeProfile(ctx.volumeProfile ?? null)}

Aggregated orderbook (Bybit + Binance + OKX, ±2% from mid):
${formatAggregatedOrderbook(ctx.aggOrderbook ?? null)}

Stop-cluster zones (4H swings):
${formatStopClusters(ctx.stopClusters ?? null)}

Liquidations (Binance forceOrder stream, last 5 min):
${formatLiquidations(ctx.liquidations ?? null)}

Attached, in order:
  1. ${p.symbol} 15m NOW
  2. ${p.symbol} 1H  NOW
  3. ${p.symbol} 4H  NOW (swing trend — has it rolled over against the trade?)
  4. BTCUSDT 15m NOW (market context)
  5. BTCUSDT 1H  NOW

Decide HOLD / CLOSE / MODIFY and respond with JSON only.`;
}
