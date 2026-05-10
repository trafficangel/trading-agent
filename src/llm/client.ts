import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { Decision } from './decision.schema.js';
import { buildSystemPrompt, buildUserMessage, type LlmContext } from './prompt.js';
import { maybeNotifyBillingError } from './billing-alert.js';
import { readFileSync } from 'node:fs';

const MAX_RETRIES = 2;

const anthropic = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY ?? 'placeholder',
});

export type LlmResult = {
  decision: Decision;
  raw: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

type ImageInput = { path: string; mediaType: 'image/png' | 'image/jpeg' };

function imageBlock(img: ImageInput): Anthropic.ImageBlockParam {
  const data = readFileSync(img.path).toString('base64');
  return {
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data },
  };
}

/**
 * Call Claude with the confluence context + chart screenshots.
 * Retries up to MAX_RETRIES on invalid JSON, feeding zod issues back to the model.
 */
export async function callLlm(
  ctx: LlmContext,
  screenshots: ImageInput[],
): Promise<LlmResult | { skipped: true; reason: string }> {
  if (!config.ANTHROPIC_API_KEY) {
    return { skipped: true, reason: 'ANTHROPIC_API_KEY not set' };
  }

  const system = buildSystemPrompt();
  const userText = buildUserMessage(ctx);

  let lastError: string | null = null;
  let raw = '';
  let inputTokens = 0;
  let outputTokens = 0;
  const t0 = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          ...screenshots.map(imageBlock),
          ...(lastError
            ? [
                {
                  type: 'text' as const,
                  text: `Your previous response failed validation:\n${lastError}\n\nRespond again with VALID JSON only, matching the schema exactly. No markdown fences, no prose.`,
                },
              ]
            : []),
        ],
      },
    ];

    try {
      const resp = await anthropic.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: 1500,
        system,
        messages,
      });

      inputTokens += resp.usage.input_tokens;
      outputTokens += resp.usage.output_tokens;
      raw = resp.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.TextBlock).text).join('\n').trim();

      // strip ```json fences if model added them anyway
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');

      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch (e) {
        lastError = `JSON parse error: ${(e as Error).message}`;
        logger.warn({ attempt, raw: cleaned.slice(0, 200) }, 'llm json parse failed');
        continue;
      }

      const result = Decision.safeParse(parsed);
      if (!result.success) {
        lastError = result.error.issues
          .map((i) => `  ${i.path.join('.')}: ${i.message}`)
          .join('\n');
        logger.warn({ attempt, issues: result.error.issues }, 'llm schema validation failed');
        continue;
      }

      // Cross-field validation for OPEN decisions
      if (result.data.decision === 'OPEN') {
        const d = result.data;
        if (!d.side || !d.entry || !d.sl || d.tp.length === 0 || d.size_pct === undefined) {
          lastError = 'OPEN decisions require side, entry, sl, tp[≥1], size_pct';
          continue;
        }
      }

      return {
        decision: result.data,
        raw,
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - t0,
      };
    } catch (err) {
      logger.error({ err, attempt }, 'anthropic call failed');
      lastError = `API error: ${(err as Error).message}`;
      // If this is a billing error, no point retrying. Notify and bail.
      const isBilling = await maybeNotifyBillingError(err, 'decide.callLlm');
      if (isBilling) break;
    }
  }

  // Final fallback: SKIP with explanation
  logger.error({ lastError }, 'llm exhausted retries — falling back to SKIP');
  return {
    decision: {
      decision: 'SKIP',
      tp: [],
      confidence: 0,
      reasoning_short: 'LLM error — auto SKIP',
      reasoning_full: `LLM failed validation after ${MAX_RETRIES + 1} attempts. Last error:\n${lastError ?? 'unknown'}\n\nRaw last response:\n${raw.slice(0, 1000)}`,
    },
    raw,
    inputTokens,
    outputTokens,
    latencyMs: Date.now() - t0,
  };
}
