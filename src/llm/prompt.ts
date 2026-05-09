import { DECISION_JSON_SCHEMA } from './decision.schema.js';
import type { AggregatedScore } from '../signals/aggregator.js';

export function buildSystemPrompt(): string {
  return `You are a discretionary intraday crypto trader on Bybit USDT-perp.
You receive: (1) a confluence summary of LuxAlgo signals on a single symbol over the last 10 minutes,
(2) chart screenshots: SUBJECT 15m + 1H plus BTC 15m + 1H for market context,
(3) account state.

Your task: decide ONE of OPEN, SKIP, CLOSE, MODIFY and return strict JSON matching this schema:
${DECISION_JSON_SCHEMA}

Hard rules — violation means SKIP:
- Never set SL further than 5% from entry, never closer than 0.2%.
- Never set size_pct above 2.
- Provide EXACTLY ONE take-profit level in tp[0]. Risk:reward of that TP must be >= 1.5 (TP distance >= 1.5 × SL distance).
- If signals conflict (mixed bullish/bearish in window) — SKIP.
- If 1H context on the SUBJECT contradicts the 15m setup direction — SKIP unless you see textbook reversal pattern; in that case still cap confidence at 0.5.
- BTC alignment: if BTC 15m and 1H are both moving against the proposed direction (e.g. BTC dumping while you want to go LONG alt) — SKIP or cap confidence at 0.45. Crypto alts correlate ~70-80% with BTC; trading against BTC needs textbook reversal evidence on BTC itself.
- If a position is already open in the same direction on this symbol — SKIP unless adding makes structural sense; explain in reasoning_full.

Style:
- IMPORTANT: write reasoning_short, reasoning_full, sl_reason, tp_reason, invalidation in **Russian**. Use plain language, no English jargon (keep technical terms like "BOS", "CHoCH", "OB", "FVG", "swing", "liquidity" — these are universal).
- reasoning_short ≤220 chars. Punchy, concrete. Example: "Шорт TON 15m: CHoCH+ вниз + двойной bearish+. Структура сломана, 1H тренд тоже медвежий."
- reasoning_full ≤2000 chars. Cite which signals you used (events + timeframes + times), what the chart shows, what could invalidate. Russian.

For OPEN decisions, you MUST justify the exact SL and TP placement:
- sl_reason ≤120 chars: WHY the SL is exactly at this level. Cite a chart reference. Examples:
    "за последним swing high 14:00, выход за ликвидность инвалидирует структуру"
    "под bullish OB на 2.50, потеря зоны = слом"
- tp_reason ≤120 chars: WHY the TP is exactly at this level. Cite a chart reference. Examples:
    "equal lows на 15m, ближайшая ликвидность снизу"
    "1H supply 2.85, верхняя граница диапазона"
- invalidation ≤160 chars: condition that kills the idea earlier than SL. Examples:
    "закрытие 15m бара выше 2.4750"
    "появление bullish CHoCH+ на 15m с обратной структурой"
- These three fields make your reasoning auditable: every level on screen has a stated reason.

Confidence calibration: 0.3-0.5 = "приличный сетап, рисков много", 0.5-0.7 = "чистое совпадение, рабочая сделка", 0.7+ = "исключительно чисто — редкий случай".

You DO NOT have access to risk limits or position sizing logic — that is enforced after you in code. Your job is the trade idea + JSON.

Respond ONLY with valid JSON. No prose before or after. No markdown fences.`;
}

export type LlmContext = {
  symbol: string;
  agg: AggregatedScore;
  /** open positions on this symbol (stub for stage 2 — empty) */
  open_positions: { side: 'long' | 'short'; entry: number; size_pct: number }[];
  daily_pnl_pct: number;
  mode: string;
};

export function buildUserMessage(ctx: LlmContext): string {
  const sigs = ctx.agg.signals
    .map(
      (s) =>
        `  - ${new Date(s.received_at).toISOString().slice(11, 19)}Z [${s.timeframe}m ${s.source}] ${s.event}${s.direction ? ` (${s.direction})` : ''}${s.price ? ` @ ${s.price}` : ''}`,
    )
    .join('\n');

  return `Symbol: ${ctx.symbol}
Mode: ${ctx.mode}
Window: last 10 minutes (${new Date(ctx.agg.windowStart).toISOString()} → ${new Date(ctx.agg.windowEnd).toISOString()})

Confluence score:
  bullish: ${ctx.agg.bullish}
  bearish: ${ctx.agg.bearish}
  dominant side: ${ctx.agg.side ?? 'none'}

Signals in window (${ctx.agg.signals.length}):
${sigs || '  (none)'}

Account:
  open_positions: ${JSON.stringify(ctx.open_positions)}
  daily_pnl_pct:  ${ctx.daily_pnl_pct}

Attached, in order:
  1. ${ctx.symbol} 15m  (primary entry timeframe)
  2. ${ctx.symbol} 1H   (subject context)
  3. BTCUSDT 15m        (market context — does BTC support or contradict?)
  4. BTCUSDT 1H         (BTC trend / structure)

Decide and respond with JSON only.`;
}
