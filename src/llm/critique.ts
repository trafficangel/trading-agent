import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import type { Decision } from './decision.schema.js';
import type { LlmContext } from './prompt.js';
import { formatSentiment } from '../exchange/bybit-public.js';
import { formatVolumeProfile } from '../exchange/bybit-volume.js';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY ?? 'placeholder' });

/**
 * Self-critique pass: a second LLM call that re-examines its own OPEN
 * decision, lists what could go wrong, re-rates confidence, and may
 * downgrade the trade to SKIP. This is the cheapest discipline mechanism
 * for an opinionated model — Claude is biased toward action and tends to
 * over-rate setups; forcing a structured "what could kill this?" pass
 * tightens the OPEN bar without us hand-tuning the main prompt.
 *
 * Call AFTER the primary callLlm returned an OPEN. Skip the pass for
 * SKIP/CLOSE/MODIFY (no point re-litigating those).
 */

export const Critique = z.object({
  risks: z
    .array(z.string().min(1).max(220))
    .min(2)
    .max(4)
    .describe('2–4 specific reasons this trade may fail, in Russian'),
  reassessed_confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('honest confidence after listing risks; usually <= original'),
  verdict: z.enum(['KEEP', 'DOWNGRADE_TO_SKIP']),
  verdict_reason: z
    .string()
    .min(1)
    .max(220)
    .describe('one Russian sentence explaining the verdict'),
});
export type Critique = z.infer<typeof Critique>;

const CRITIQUE_JSON_SCHEMA = `{
  "risks": [string],            // 2–4 пункта на русском, конкретные риски этой сделки
  "reassessed_confidence": number 0..1, // переоценённая уверенность ПОСЛЕ перечисления рисков
  "verdict": "KEEP" | "DOWNGRADE_TO_SKIP",
  "verdict_reason": string      // одно предложение на русском, почему KEEP или DOWNGRADE
}`;

function buildCritiqueSystemPrompt(): string {
  return `You are reviewing your OWN previous OPEN decision on a Bybit USDT-perp intraday trade.
You have the same chart screenshots and the same market context you saw before.
Your job NOW is adversarial: list what could realistically kill this trade,
then decide whether to KEEP it or DOWNGRADE_TO_SKIP.

Return strict JSON:
${CRITIQUE_JSON_SCHEMA}

Rules:
- Risks must be SPECIFIC and grounded in what's on the charts or in the data.
  Bad: "рынок волатильный". Good: "BTC 1H делает HL под ключевым resistance 70k —
  пробой утянет альт за собой, инвалидация шорта по альту".
- 2–4 risks total. Quality over quantity.
- reassessed_confidence: usually LOWER than original. If after listing risks it's
  still >= original, you're hand-waving — re-read the charts.
- DOWNGRADE_TO_SKIP if any of:
  * a major structural risk you missed first time appears now
  * BTC context is more hostile than you weighed
  * R:R is tight AND any single risk realistically takes you out
  * confluence narrative depends on a single signal that's noise-prone
- KEEP if risks are real but quantified into the SL/invalidation, and the trade
  thesis still holds with reduced confidence.
- All Russian, plain language.

Respond ONLY with valid JSON. No prose, no fences.`;
}

function buildCritiqueUserMessage(d: Decision, ctx: LlmContext): string {
  const sigs = ctx.agg.signals
    .map(
      (s) =>
        `  - ${new Date(s.received_at).toISOString().slice(11, 19)}Z [${s.timeframe}m ${s.source}] ${s.event}${s.direction ? ` (${s.direction})` : ''}${s.price ? ` @ ${s.price}` : ''}`,
    )
    .join('\n');

  return `Your prior decision on ${ctx.symbol}:
  decision:    OPEN
  side:        ${d.side}
  entry:       ${d.entry}
  sl:          ${d.sl}     (sl_reason: ${d.sl_reason ?? '-'})
  tp:          ${d.tp[0] ?? '-'}     (tp_reason: ${d.tp_reason ?? '-'})
  size_pct:    ${d.size_pct}
  confidence:  ${d.confidence}
  invalidation: ${d.invalidation ?? '-'}

  reasoning_short: ${d.reasoning_short}
  reasoning_full:  ${d.reasoning_full}

Confluence window (last 20m):
  bullish: ${ctx.agg.bullish}
  bearish: ${ctx.agg.bearish}
  signals (${ctx.agg.signals.length}):
${sigs || '  (none)'}

Bybit market sentiment:
${formatSentiment(ctx.sentiment ?? null)}

Volume profile + ATR:
${formatVolumeProfile(ctx.volumeProfile ?? null)}

Attached, in order: SUBJECT 15m, SUBJECT 1H, SUBJECT 4H, BTCUSDT 15m, BTCUSDT 1H.

Critique your own OPEN. Respond with JSON only.`;
}

type ImageInput = { path: string; mediaType: 'image/png' | 'image/jpeg' };

function imageBlock(img: ImageInput): Anthropic.ImageBlockParam {
  const data = readFileSync(img.path).toString('base64');
  return { type: 'image', source: { type: 'base64', media_type: img.mediaType, data } };
}

export type CritiqueResult = {
  critique: Critique;
  raw: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

export async function critiqueDecision(
  decision: Decision,
  ctx: LlmContext,
  screenshots: ImageInput[],
): Promise<CritiqueResult | null> {
  if (!config.ANTHROPIC_API_KEY) return null;

  const system = buildCritiqueSystemPrompt();
  const userText = buildCritiqueUserMessage(decision, ctx);
  const t0 = Date.now();

  // Single attempt with one retry on schema fail. We don't want to spend
  // tokens re-asking 3+ times for what is already a luxury check.
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await anthropic.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: 800,
        system,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              ...screenshots.map(imageBlock),
              ...(lastError
                ? [{ type: 'text' as const, text: `Previous response failed:\n${lastError}\nReturn valid JSON only.` }]
                : []),
            ],
          },
        ],
      });
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
        lastError = `JSON parse: ${(e as Error).message}`;
        continue;
      }
      const result = Critique.safeParse(parsed);
      if (!result.success) {
        lastError = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        continue;
      }
      return {
        critique: result.data,
        raw,
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        latencyMs: Date.now() - t0,
      };
    } catch (err) {
      logger.error({ err, attempt }, 'critique call failed');
      lastError = `API error: ${(err as Error).message}`;
    }
  }

  logger.warn({ lastError }, 'critique exhausted retries — proceeding without critique');
  return null;
}
