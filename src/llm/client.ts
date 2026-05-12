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
 * Build the array of image blocks with ephemeral cache_control on the
 * LAST one. Anthropic's prompt cache treats everything before a
 * cache_control marker as the cacheable prefix; marking only the final
 * image means the system prompt + ALL screenshots get cached as one
 * block. When the next call sends the same bytes (because
 * captureChartCached returned the same file), we pay 10% for the cached
 * portion. If even one screenshot's bytes differ (new bar boundary),
 * only that image + everything after re-tokenizes.
 *
 * Order matters: we send screenshots in fixed order (15m, 1H, 4H, 1D
 * etc.) so the prefix stays maximal across calls.
 */
function buildImageBlocks(screenshots: ImageInput[]): Anthropic.ImageBlockParam[] {
  if (screenshots.length === 0) return [];
  const blocks = screenshots.map(imageBlock);
  // Mark the last image with cache_control — caches the entire prefix
  // (system + text + all prior images + this image).
  const last = blocks[blocks.length - 1];
  blocks[blocks.length - 1] = {
    ...last,
    cache_control: { type: 'ephemeral' },
  } as Anthropic.ImageBlockParam;
  return blocks;
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

  // Blindness warning — if no screenshots made it through the capture
  // pipeline (TV layout glitch, all 5 charts failed), we MUST tell the
  // model explicitly. Otherwise it will hallucinate "I see X on the
  // chart" descriptions from the numeric context alone, producing
  // confident-sounding but baseless reasoning. Observed in production
  // 2026-05-12: 15 overnight decisions ran blind with reasoning
  // referencing "higher lows on chart" while screenshot_path was NULL.
  const blindnessWarning =
    screenshots.length === 0
      ? `\n\n⚠️ ВАЖНО: чарты в этом вызове НЕДОСТУПНЫ (capture failed для всех 5). ` +
        `Анализируй ТОЛЬКО на основе текстовых данных выше (signals, sentiment, ` +
        `volume profile, orderbook, liquidations, stop clusters). ` +
        `НЕ описывай "что видно на графике", "candle wicks", "higher highs" ` +
        `и подобные визуальные паттерны — графиков ты НЕ ВИДИШЬ. ` +
        `Если без визуального контекста уверенность падает ниже 0.45 — выдай SKIP ` +
        `с reasoning_short, начинающимся с "Нет визуального контекста: ".`
      : '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: userText + blindnessWarning },
          ...buildImageBlocks(screenshots),
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
      // Prompt caching: system prompt is identical across all decide calls
      // (rules, JSON schema, etc.). Marking it cache_control:ephemeral means
      // Anthropic caches the tokenized version for 5 min — subsequent calls
      // within that window pay 10% of the input price for the cached portion.
      // For a cron tick that processes 4 symbols back-to-back, the 1st call
      // writes the cache and the next 3 hit it. decide+critique on an OPEN
      // also share the same system-cache prefix.
      //
      // EDITING NOTE: any change to the system prompt invalidates the cache
      // once (first call after edit pays full price, then re-caches). No
      // special handling needed — just edit normally.
      const resp = await anthropic.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: 2500,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages,
      });

      inputTokens += resp.usage.input_tokens;
      outputTokens += resp.usage.output_tokens;
      const cacheWrite = resp.usage.cache_creation_input_tokens ?? 0;
      const cacheRead = resp.usage.cache_read_input_tokens ?? 0;
      if (cacheWrite > 0 || cacheRead > 0) {
        logger.debug(
          { cache_write: cacheWrite, cache_read: cacheRead, fresh: resp.usage.input_tokens },
          'llm cache stats',
        );
      }
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
