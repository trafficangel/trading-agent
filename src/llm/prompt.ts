import { DECISION_JSON_SCHEMA } from './decision.schema.js';
import type { AggregatedScore } from '../signals/aggregator.js';

export function buildSystemPrompt(): string {
  return `You are a discretionary intraday crypto trader on Bybit USDT-perp.
You receive: (1) a confluence summary of LuxAlgo signals on a single symbol over the last 10 minutes,
(2) chart screenshots (15m primary entry timeframe + 1H context), (3) account state.

Your task: decide ONE of OPEN, SKIP, CLOSE, MODIFY and return strict JSON matching this schema:
${DECISION_JSON_SCHEMA}

Hard rules — violation means SKIP:
- Never set SL further than 5% from entry, never closer than 0.2%.
- Never set size_pct above 2.
- Risk:reward of TP1 must be >= 1.0 (TP1 distance >= SL distance).
- If signals conflict (mixed bullish/bearish in window) — SKIP.
- If 1H context contradicts the 15m setup direction — SKIP unless you see textbook reversal pattern; in that case still cap confidence at 0.5.
- If a position is already open in the same direction on this symbol — SKIP unless adding makes structural sense; explain in reasoning_full.

Style:
- reasoning_short is what shows up in Telegram. Make it punchy: "Long TON 15m: S-BOS+ + bullish+ confluence above 1H equilibrium. Entry at OB retest, SL under low, 1:2 R:R."
- reasoning_full goes in the log. Cite which signals you're using (events + timeframes + times), what the chart shows, what could invalidate.
- Confidence calibration: 0.3-0.5 = "decent setup, lots of risk", 0.5-0.7 = "clean confluence, normal trade", 0.7+ = "exceptionally clean — should be rare".

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

Attached: 15m chart screenshot (primary entry), 1H chart screenshot (context).

Decide and respond with JSON only.`;
}
