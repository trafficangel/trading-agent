import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/client.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { sendMessage } from '../telegram/bot.js';
import {
  getRuntimeConfig,
  setRuntimeConfig,
  RUNTIME_KEYS,
} from '../db/repos/runtime-config.js';
import {
  SIZING_FLOOR_SCALP_MIN,
  SIZING_FLOOR_SCALP_MAX,
} from '../risk/sizing.js';
import { effectiveScalpFloor } from '../risk/scalp-floor.js';

/**
 * Self-review job. Runs every 12 hours (03:00, 15:00 UTC).
 *
 * Three things happen each run:
 *   1. **Stats collection** — pull last 12h of decisions from SQLite,
 *      compute counts, win rate (where closed), top SKIP reasons.
 *   2. **LLM self-analysis** — separate Claude call (different system prompt
 *      from the trading one) acts as a meta-critic of the bot's own
 *      behaviour. Returns observations + 1-3 concrete proposed changes.
 *   3. **Bounded auto-tune** — ONE knob is allowed to move automatically:
 *      `scalp.confidence_floor` within [0.40, 0.55] in ±0.05 steps.
 *      Everything else is just a recommendation in the report for the
 *      human operator to apply or ignore.
 *
 * Output: a markdown report posted to Telegram Logs. Audit rows written
 * to `self_reviews` and (if auto-tune fired) `self_review_actions`.
 *
 * Why not more auto-tune? Shadow mode means PnL is paper, and 10-30 trades
 * per week is too small a sample to drive parameter sweeps. Auto-tuning
 * many knobs on tiny samples = chasing noise. Expand scope only after
 * ≥30 closed positions show stable behaviour.
 */

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY ?? 'placeholder' });

const WINDOW_MS = 12 * 60 * 60 * 1000;

type DecisionRowRaw = {
  id: number;
  created_at: number;
  symbol: string;
  decision: string;
  side: string | null;
  entry: number | null;
  sl: number | null;
  tp_json: string | null;
  size_pct: number | null;
  confidence: number;
  reasoning_short: string;
  status: string | null;
  close_reason: string | null;
  pnl_pct: number | null;
  pnl_r: number | null;
  features_json: string | null;
};

/** Enriched row: tp_strategy and entry_type live inside features_json (the
 *  decisions table doesn't have dedicated columns for them — they were
 *  added to the LLM schema later). We parse once here and pass the
 *  flattened shape around the rest of self-review. */
type DecisionRow = Omit<DecisionRowRaw, 'features_json' | 'close_reason'> & {
  tp_strategy: string | null;
  entry_type: string | null;
  exit_reason: string | null;
};

const recentDecisionsStmt = db.prepare<[number, number], DecisionRowRaw>(`
  SELECT id, created_at, symbol, decision, side,
         entry, sl, tp_json, size_pct, confidence, reasoning_short,
         status, close_reason, pnl_pct, pnl_r, features_json
  FROM decisions
  WHERE created_at BETWEEN ? AND ?
  ORDER BY created_at ASC
`);

function parseRow(r: DecisionRowRaw): DecisionRow {
  let tp_strategy: string | null = null;
  let entry_type: string | null = null;
  if (r.features_json) {
    try {
      const f = JSON.parse(r.features_json) as { tp_strategy?: string; entry_type?: string };
      tp_strategy = f.tp_strategy ?? null;
      entry_type = f.entry_type ?? null;
    } catch {
      // Malformed features_json — ignore, leave nulls.
    }
  }
  return {
    id: r.id,
    created_at: r.created_at,
    symbol: r.symbol,
    decision: r.decision,
    side: r.side,
    entry: r.entry,
    sl: r.sl,
    tp_json: r.tp_json,
    size_pct: r.size_pct,
    confidence: r.confidence,
    reasoning_short: r.reasoning_short,
    status: r.status,
    exit_reason: r.close_reason,
    pnl_pct: r.pnl_pct,
    pnl_r: r.pnl_r,
    tp_strategy,
    entry_type,
  };
}

const insertReviewStmt = db.prepare<
  [number, number, number, number, number, number, number, number, number | null, number | null, string, string | null],
  unknown
>(`
  INSERT INTO self_reviews (
    created_at, window_start, window_end,
    total_decisions, open_count, skip_count, close_count, modify_count,
    llm_input_tokens, llm_output_tokens, report_md, llm_raw
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertActionStmt = db.prepare<
  [number, number, string, string | null, string, string],
  unknown
>(`
  INSERT INTO self_review_actions (
    created_at, review_id, param_key, old_value, new_value, reason
  ) VALUES (?, ?, ?, ?, ?, ?)
`);

// --- Stats computation -----------------------------------------------------

type ReviewStats = {
  windowStart: number;
  windowEnd: number;
  total: number;
  openCount: number;
  skipCount: number;
  closeCount: number;
  modifyCount: number;
  scalpOpenCount: number;
  swingOpenCount: number;
  closedScalpWins: number;
  closedScalpLosses: number;
  closedSwingWins: number;
  closedSwingLosses: number;
  sizingFloorSkipsInBand: number; // confidence in [floor-0.08, floor)
  topSkipReasons: { reason: string; count: number }[];
  openDecisions: DecisionRow[];
  closedDecisions: DecisionRow[];
};

function summariseSkipReason(text: string): string {
  // Collapse decision details into a category for grouping.
  // Order matters — most specific first.
  const t = text.toLowerCase();
  if (t.startsWith('self-critique')) return 'Self-critique → SKIP';
  if (t.startsWith('sizing-floor')) return 'Sizing-floor SKIP';
  if (t.includes('btc') && (t.includes('downtrend') || t.includes('медвежий') || t.includes('красный'))) {
    return 'BTC headwind';
  }
  if (t.includes('боковик') || t.includes('диапазон') || t.includes('chop') || t.includes('without structure')) {
    return 'No clear structure';
  }
  if (t.includes('конфликт') || t.includes('противореч') || t.includes('mixed')) {
    return 'Mixed signals';
  }
  if (t.includes('4h') && (t.includes('против') || t.includes('тренд'))) {
    return '4H trend against';
  }
  if (t.includes('r:r') || t.includes('rr')) return 'R:R too tight';
  return 'Other';
}

function collectStats(now: number): ReviewStats {
  const windowEnd = now;
  const windowStart = now - WINDOW_MS;
  const rows = recentDecisionsStmt.all(windowStart, windowEnd).map(parseRow);

  const stats: ReviewStats = {
    windowStart,
    windowEnd,
    total: rows.length,
    openCount: 0,
    skipCount: 0,
    closeCount: 0,
    modifyCount: 0,
    scalpOpenCount: 0,
    swingOpenCount: 0,
    closedScalpWins: 0,
    closedScalpLosses: 0,
    closedSwingWins: 0,
    closedSwingLosses: 0,
    sizingFloorSkipsInBand: 0,
    topSkipReasons: [],
    openDecisions: [],
    closedDecisions: [],
  };

  const skipReasonCounts = new Map<string, number>();
  const currentFloor = effectiveScalpFloor();
  const bandLow = currentFloor - 0.08;

  for (const r of rows) {
    if (r.decision === 'OPEN') {
      stats.openCount++;
      if (r.tp_strategy === 'scalp') stats.scalpOpenCount++;
      else stats.swingOpenCount++;
      stats.openDecisions.push(r);
    } else if (r.decision === 'SKIP') {
      stats.skipCount++;
      const cat = summariseSkipReason(r.reasoning_short);
      skipReasonCounts.set(cat, (skipReasonCounts.get(cat) ?? 0) + 1);
      if (cat === 'Sizing-floor SKIP' && r.confidence >= bandLow && r.confidence < currentFloor) {
        stats.sizingFloorSkipsInBand++;
      }
    } else if (r.decision === 'CLOSE') {
      stats.closeCount++;
      stats.closedDecisions.push(r);
      if (r.pnl_r !== null) {
        const isScalp = r.tp_strategy === 'scalp';
        if (r.pnl_r > 0) (isScalp ? stats.closedScalpWins++ : stats.closedSwingWins++);
        else (isScalp ? stats.closedScalpLosses++ : stats.closedSwingLosses++);
      }
    } else if (r.decision === 'MODIFY') {
      stats.modifyCount++;
    }
  }

  stats.topSkipReasons = [...skipReasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return stats;
}

// --- Auto-tune logic -------------------------------------------------------

type TuneAction = {
  paramKey: string;
  oldValue: string;
  newValue: string;
  reason: string;
};

/**
 * Bounded auto-tune for SCALP_CONFIDENCE_FLOOR only.
 *
 * Lower (more permissive) — by 0.05 if:
 *   - ≥3 sizing-floor SKIPs in last 12h fell into the "near miss" band
 *     [floor−0.08, floor) — meaning the model wanted to trade and we
 *     blocked it but barely
 *   - AND closed scalps in last 12h are NOT net losers (wins >= losses)
 *
 * Raise (more conservative) — by 0.05 if:
 *   - ≥2 closed scalps in last 12h were losers
 *   - AND wins < losses (net negative)
 *
 * Hard bounds [SIZING_FLOOR_SCALP_MIN, SIZING_FLOOR_SCALP_MAX].
 * No-op if both lower- and raise-triggers fire (mixed signal — leave alone).
 */
function maybeAutoTuneScalpFloor(stats: ReviewStats): TuneAction | null {
  const current = effectiveScalpFloor();

  const scalpClosed = stats.closedScalpWins + stats.closedScalpLosses;
  const scalpNetPositive = stats.closedScalpWins >= stats.closedScalpLosses;
  const scalpNetNegative = stats.closedScalpLosses > stats.closedScalpWins;

  const wantLower =
    stats.sizingFloorSkipsInBand >= 3 && (scalpClosed === 0 || scalpNetPositive);
  const wantRaise = stats.closedScalpLosses >= 2 && scalpNetNegative;

  if (wantLower && wantRaise) {
    logger.info(
      { sizingSkips: stats.sizingFloorSkipsInBand, scalpWins: stats.closedScalpWins, scalpLosses: stats.closedScalpLosses },
      'self-tune: mixed signal, no-op',
    );
    return null;
  }

  if (wantLower && current > SIZING_FLOOR_SCALP_MIN) {
    const newVal = Math.max(SIZING_FLOOR_SCALP_MIN, Math.round((current - 0.05) * 100) / 100);
    return {
      paramKey: RUNTIME_KEYS.scalpConfidenceFloor,
      oldValue: current.toFixed(2),
      newValue: newVal.toFixed(2),
      reason: `${stats.sizingFloorSkipsInBand} near-miss SKIPs in band [${(current - 0.08).toFixed(2)},${current.toFixed(2)}); scalp PnL net non-negative (${stats.closedScalpWins}W/${stats.closedScalpLosses}L)`,
    };
  }

  if (wantRaise && current < SIZING_FLOOR_SCALP_MAX) {
    const newVal = Math.min(SIZING_FLOOR_SCALP_MAX, Math.round((current + 0.05) * 100) / 100);
    return {
      paramKey: RUNTIME_KEYS.scalpConfidenceFloor,
      oldValue: current.toFixed(2),
      newValue: newVal.toFixed(2),
      reason: `Net negative scalp PnL (${stats.closedScalpWins}W/${stats.closedScalpLosses}L) — tighten floor`,
    };
  }

  return null;
}

// --- LLM self-review -------------------------------------------------------

function buildReviewPrompt(stats: ReviewStats): { system: string; user: string } {
  const system = `Ты — ревизор-аналитик собственной торговой системы. Ты только что отработал 12 часов как discretionary crypto trader (см. данные ниже). Твоя задача — оценить свою работу критически и предложить улучшения.

Формат ответа — строгий JSON:
{
  "summary": string (1-2 предложения по-русски — что произошло за 12ч),
  "observations": [string, ...] (2-4 наблюдения по-русски: паттерны в решениях, сильные и слабые стороны),
  "suggestions": [
    {
      "title": string (короткий заголовок улучшения по-русски),
      "rationale": string (1-2 предложения — почему это улучшит торговлю),
      "type": "prompt_tweak" | "param_change" | "new_feature" | "discard"
    }
  ] (1-3 предложений)
}

ПРАВИЛА:
- НЕ говори "увеличить размер позиции / убрать риск-лимиты". Размер и риск — священны.
- НЕ предлагай "торговать больше" если рынок реально плохой. SKIP в чопе = правильно.
- ЦЕЛИ: прибыльность сделок + достаточное количество (1-3 сделки/день норма).
- Если за 12ч было 0 OPEN — это либо мёртвый рынок (норма), либо мы пропустили
  очевидное (надо это диагностировать).
- Если много "Self-critique → SKIP" — может промпт critique слишком строгий?
- Если много "Sizing-floor SKIP" — а если опустить floor scalp с 0.50 до 0.45,
  что мы потеряем? (Это уже автоматически тюнится — просто отметь паттерн.)
- Если scalp-сделки убыточны — что общего у них? Не научила ли модель торговать
  чопо ради чопа?

ОТВЕЧАЙ ТОЛЬКО JSON, без markdown-обёрток.`;

  const skipReasonsLines = stats.topSkipReasons
    .map((r) => `  - ${r.reason}: ${r.count}`)
    .join('\n');

  const openLines = stats.openDecisions
    .slice(-15)
    .map(
      (d) =>
        `  [${new Date(d.created_at).toISOString().slice(11, 16)}Z] ${d.symbol} ${d.side} ${d.tp_strategy ?? '?'} ${d.entry_type ?? '?'} conf=${d.confidence.toFixed(2)} status=${d.status ?? '?'} pnl_r=${d.pnl_r?.toFixed(2) ?? 'open'} — ${d.reasoning_short.slice(0, 120)}`,
    )
    .join('\n');

  const closedLines = stats.closedDecisions
    .slice(-15)
    .map(
      (d) =>
        `  [${new Date(d.created_at).toISOString().slice(11, 16)}Z] ${d.symbol} ${d.side} ${d.tp_strategy ?? '?'} pnl_r=${d.pnl_r?.toFixed(2) ?? 'n/a'} reason=${d.exit_reason ?? '?'} — ${d.reasoning_short.slice(0, 100)}`,
    )
    .join('\n');

  const user = `Окно: ${new Date(stats.windowStart).toISOString().slice(0, 16)}Z … ${new Date(stats.windowEnd).toISOString().slice(0, 16)}Z

Всего решений: ${stats.total}
  OPEN: ${stats.openCount}   (scalp ${stats.scalpOpenCount} / swing ${stats.swingOpenCount})
  SKIP: ${stats.skipCount}
  CLOSE: ${stats.closeCount}
  MODIFY: ${stats.modifyCount}

Закрытые позиции (выборка scalp/swing):
  scalp: ${stats.closedScalpWins}W / ${stats.closedScalpLosses}L
  swing: ${stats.closedSwingWins}W / ${stats.closedSwingLosses}L

Топ причин SKIP:
${skipReasonsLines || '  (нет SKIPов)'}

Текущий scalp floor: ${effectiveScalpFloor().toFixed(2)}
Near-miss SKIPs (sizing-floor с confidence в зоне floor−0.08…floor): ${stats.sizingFloorSkipsInBand}

Последние OPEN:
${openLines || '  (нет OPEN)'}

Последние CLOSE:
${closedLines || '  (нет CLOSE)'}`;

  return { system, user };
}

type LlmReview = {
  summary: string;
  observations: string[];
  suggestions: { title: string; rationale: string; type: string }[];
  inputTokens: number;
  outputTokens: number;
  raw: string;
};

async function callReviewLlm(stats: ReviewStats): Promise<LlmReview | null> {
  if (!config.ANTHROPIC_API_KEY) {
    logger.warn('self-review: no ANTHROPIC_API_KEY, skipping LLM analysis');
    return null;
  }
  const { system, user } = buildReviewPrompt(stats);

  try {
    const resp = await anthropic.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const raw = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as Anthropic.TextBlock).text)
      .join('\n')
      .trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    const parsed = JSON.parse(cleaned) as Omit<LlmReview, 'inputTokens' | 'outputTokens' | 'raw'>;
    return {
      summary: parsed.summary,
      observations: parsed.observations,
      suggestions: parsed.suggestions,
      inputTokens: resp.usage.input_tokens,
      outputTokens: resp.usage.output_tokens,
      raw,
    };
  } catch (err) {
    logger.error({ err }, 'self-review LLM call failed');
    return null;
  }
}

// --- Report formatting -----------------------------------------------------

function formatReport(stats: ReviewStats, review: LlmReview | null, action: TuneAction | null): string {
  const winLossOverall =
    stats.closeCount > 0
      ? `${stats.closedScalpWins + stats.closedSwingWins}W / ${stats.closedScalpLosses + stats.closedSwingLosses}L`
      : '—';

  const lines: string[] = [
    `🔬 <b>Самоанализ за 12 часов</b>`,
    `<i>${new Date(stats.windowStart).toISOString().slice(0, 16)}Z … ${new Date(stats.windowEnd).toISOString().slice(0, 16)}Z</i>`,
    '',
    `<b>Цифры:</b>`,
    `  Всего решений: <code>${stats.total}</code>`,
    `  OPEN: <code>${stats.openCount}</code> (⚡${stats.scalpOpenCount} / 🌊${stats.swingOpenCount})`,
    `  SKIP: <code>${stats.skipCount}</code>  ·  CLOSE: <code>${stats.closeCount}</code>  ·  MODIFY: <code>${stats.modifyCount}</code>`,
    `  Закрытые: <b>${winLossOverall}</b>`,
    `  Текущий scalp floor: <code>${effectiveScalpFloor().toFixed(2)}</code>`,
  ];

  if (stats.topSkipReasons.length > 0) {
    lines.push('', `<b>Топ причин SKIP:</b>`);
    for (const r of stats.topSkipReasons) {
      lines.push(`  · ${r.reason}: <code>${r.count}</code>`);
    }
  }

  if (action) {
    lines.push('', `🔧 <b>Авто-настройка:</b>`);
    lines.push(`  <code>${action.paramKey}</code>: <code>${action.oldValue}</code> → <code>${action.newValue}</code>`);
    lines.push(`  <i>${action.reason}</i>`);
  }

  if (review) {
    lines.push('', `<b>📋 Сводка:</b> ${review.summary}`);
    if (review.observations.length > 0) {
      lines.push('', `<b>Наблюдения:</b>`);
      for (const o of review.observations) lines.push(`  • ${o}`);
    }
    if (review.suggestions.length > 0) {
      lines.push('', `<b>💡 Предложения:</b>`);
      for (const s of review.suggestions) {
        const badge =
          s.type === 'param_change'
            ? '⚙️'
            : s.type === 'prompt_tweak'
              ? '📝'
              : s.type === 'new_feature'
                ? '✨'
                : '🗑';
        lines.push(`  ${badge} <b>${s.title}</b>`);
        lines.push(`     <i>${s.rationale}</i>`);
      }
    }
  } else {
    lines.push('', `<i>(LLM-анализ недоступен — см. журнал)</i>`);
  }

  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

// --- Entry point -----------------------------------------------------------

export async function runSelfReview(): Promise<void> {
  const now = Date.now();
  logger.info({ now }, 'self-review: starting');

  const stats = collectStats(now);
  if (stats.total === 0) {
    logger.info('self-review: no decisions in window, skipping');
    return;
  }

  const review = await callReviewLlm(stats);

  // Auto-tune (bounded, scalp floor only)
  const action = maybeAutoTuneScalpFloor(stats);

  // Persist report row
  const inserted = insertReviewStmt.run(
    now,
    stats.windowStart,
    stats.windowEnd,
    stats.total,
    stats.openCount,
    stats.skipCount,
    stats.closeCount,
    stats.modifyCount,
    review?.inputTokens ?? null,
    review?.outputTokens ?? null,
    formatReport(stats, review, action),
    review?.raw ?? null,
  );
  const reviewId = Number(inserted.lastInsertRowid);

  // Apply auto-tune (after report row exists so action row can reference it)
  if (action) {
    setRuntimeConfig(action.paramKey, action.newValue, action.reason);
    insertActionStmt.run(now, reviewId, action.paramKey, action.oldValue, action.newValue, action.reason);
    logger.warn(
      { paramKey: action.paramKey, old: action.oldValue, new: action.newValue, reason: action.reason },
      'self-review: auto-tune applied',
    );
  }

  // Sanitize report text for HTML — escape user-controlled strings, then re-introduce intended tags.
  // Easier: format already used <b>/<i>/<code> tags; the dynamic strings could contain < or >.
  // We escaped already-formatted reasons via &escapes around dynamic content; here just send as-is.
  const reportHtml = formatReport(stats, review, action);

  await sendMessage({
    channel: 'logs',
    text: reportHtml,
    disable_notification: true,
  }).catch((err) => logger.error({ err }, 'self-review: telegram send failed'));

  logger.info(
    { reviewId, total: stats.total, action: action ? 'applied' : 'none' },
    'self-review: complete',
  );
}

export function startSelfReviewJob(): void {
  // 03:00 and 15:00 UTC — covers EU-morning and US-afternoon analysis windows.
  // 12h apart means each review sees a fresh half-day of activity.
  cron.schedule('0 3,15 * * *', () => {
    runSelfReview().catch((err) => logger.error({ err }, 'self-review crashed'));
  });
  logger.info('self-review cron started (03:00 + 15:00 UTC, every 12h)');
}

// Make functions reachable for ad-hoc trigger from REPL / debug.
export const _internal = { runSelfReview, collectStats, maybeAutoTuneScalpFloor };

// Currently-unused escapeHtml is exported in case future formatters need it.
void escapeHtml;
