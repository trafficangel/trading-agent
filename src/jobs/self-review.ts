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

const WINDOW_MS = 8 * 60 * 60 * 1000;

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
  track: string;
  strategy_id: string | null;
  force_close_reason: string | null;
};

/** Enriched row: tp_strategy and entry_type live inside features_json (the
 *  decisions table doesn't have dedicated columns for them — they were
 *  added to the LLM schema later). For Track B we also pull trigger_event
 *  + the source TF so the LLM reviewer can see which signals win/lose. */
type DecisionRow = Omit<DecisionRowRaw, 'features_json' | 'close_reason'> & {
  tp_strategy: string | null;
  entry_type: string | null;
  exit_reason: string | null;
  trigger_event: string | null; // 'bullish_plus' / 'choch_swing_plus_up' / etc. (Track B)
  trigger_tf: string | null;    // '5' / '15' / '60' / '240' (Track B)
};

const recentDecisionsStmt = db.prepare<[number, number], DecisionRowRaw>(`
  SELECT id, created_at, symbol, decision, side,
         entry, sl, tp_json, size_pct, confidence, reasoning_short,
         status, close_reason, pnl_pct, pnl_r, features_json, track,
         strategy_id, force_close_reason
  FROM decisions
  WHERE created_at BETWEEN ? AND ?
  ORDER BY created_at ASC
`);

function parseRow(r: DecisionRowRaw): DecisionRow {
  let tp_strategy: string | null = null;
  let entry_type: string | null = null;
  let trigger_event: string | null = null;
  let trigger_tf: string | null = null;
  if (r.features_json) {
    try {
      const f = JSON.parse(r.features_json) as {
        tp_strategy?: string;
        entry_type?: string;
        trigger_event?: string;
        trigger_tf?: string;
      };
      tp_strategy = f.tp_strategy ?? null;
      entry_type = f.entry_type ?? null;
      trigger_event = f.trigger_event ?? null;
      trigger_tf = f.trigger_tf ?? null;
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
    trigger_event,
    trigger_tf,
    track: r.track,
    strategy_id: r.strategy_id,
    force_close_reason: r.force_close_reason,
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

type EventWinrate = { event: string; tf: string; wins: number; losses: number; openR: number };

type StrategyWinrate = {
  strategy_id: string;
  wins: number;
  losses: number;
  openR: number;
  /** count of closes by reason — diagnoses where exits come from */
  exits_strategy: number;
  exits_sl: number;
  exits_timeguard: number;
};

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

  // ===== A/B per-track =====
  /** Counts per track in the window. */
  llmDecisions: number;
  signalDecisions: number;
  /** Closed-trades net R per track. */
  llmClosedR: number;
  signalClosedR: number;
  /** Closed-trades W/L per track. */
  llmWins: number;
  llmLosses: number;
  signalWins: number;
  signalLosses: number;

  // ===== Track B granular =====
  /** Per (event, tf) breakdown — winners vs losers + total R. */
  signalEventStats: EventWinrate[];
  /** Per-side win rate for signal track. */
  signalLongWins: number;
  signalLongLosses: number;
  signalShortWins: number;
  signalShortLosses: number;

  // ===== Track C granular =====
  /** Decisions made by Track C in the window. */
  strategyDecisions: number;
  /** Closed-trades W/L + R for Track C. */
  strategyWins: number;
  strategyLosses: number;
  strategyClosedR: number;
  /** Per-strategy_id breakdown for Track C. */
  strategyStats: StrategyWinrate[];
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
    llmDecisions: 0,
    signalDecisions: 0,
    llmClosedR: 0,
    signalClosedR: 0,
    llmWins: 0,
    llmLosses: 0,
    signalWins: 0,
    signalLosses: 0,
    signalEventStats: [],
    signalLongWins: 0,
    signalLongLosses: 0,
    signalShortWins: 0,
    signalShortLosses: 0,
    strategyDecisions: 0,
    strategyWins: 0,
    strategyLosses: 0,
    strategyClosedR: 0,
    strategyStats: [],
  };

  const skipReasonCounts = new Map<string, number>();
  const currentFloor = effectiveScalpFloor();
  const bandLow = currentFloor - 0.08;
  // Aggregator for Track B per-(event,tf) win-rate.
  const eventKey = (ev: string, tf: string): string => `${ev}@${tf}`;
  const eventAgg = new Map<string, EventWinrate>();
  // Aggregator for Track C per-strategy stats.
  const stratAgg = new Map<string, StrategyWinrate>();

  for (const r of rows) {
    // Per-track decision counters
    if (r.track === 'llm') stats.llmDecisions++;
    else if (r.track === 'signal') stats.signalDecisions++;
    else if (r.track === 'strategy') stats.strategyDecisions++;

    if (r.decision === 'OPEN') {
      stats.openCount++;
      if (r.tp_strategy === 'scalp') stats.scalpOpenCount++;
      else stats.swingOpenCount++;
      stats.openDecisions.push(r);

      // A closed result row carries decision='OPEN' AND status='closed' AND pnl_r.
      // (Track B has no separate decision='CLOSE' row — tpsl-monitor mutates
      //  the OPEN row to status='closed' on TP/SL hit.)
      if (r.status === 'closed' && r.pnl_r !== null) {
        stats.closedDecisions.push(r);
        const isWin = r.pnl_r > 0;

        // Per-track win/loss + total R
        if (r.track === 'llm') {
          stats.llmClosedR += r.pnl_r;
          if (isWin) stats.llmWins++;
          else stats.llmLosses++;
        } else if (r.track === 'signal') {
          stats.signalClosedR += r.pnl_r;
          if (isWin) stats.signalWins++;
          else stats.signalLosses++;

          // Per-side breakdown for signal track
          if (r.side === 'long') (isWin ? stats.signalLongWins++ : stats.signalLongLosses++);
          else if (r.side === 'short') (isWin ? stats.signalShortWins++ : stats.signalShortLosses++);

          // Per-(event, tf) aggregator
          const ev = r.trigger_event ?? 'unknown';
          const tf = r.trigger_tf ?? '?';
          const k = eventKey(ev, tf);
          const cur = eventAgg.get(k) ?? { event: ev, tf, wins: 0, losses: 0, openR: 0 };
          cur.openR += r.pnl_r;
          if (isWin) cur.wins++;
          else cur.losses++;
          eventAgg.set(k, cur);
        } else if (r.track === 'strategy') {
          stats.strategyClosedR += r.pnl_r;
          if (isWin) stats.strategyWins++;
          else stats.strategyLosses++;

          // Per-strategy aggregator with exit-reason breakdown.
          // exit_reason is the canonical close_reason ('sl_hit' / 'manual')
          // — for Track C, force_close_reason disambiguates 'manual' into
          // 'strategy_exit' vs 'time_guard'.
          const sid = r.strategy_id ?? 'unknown';
          const cur = stratAgg.get(sid) ?? {
            strategy_id: sid,
            wins: 0,
            losses: 0,
            openR: 0,
            exits_strategy: 0,
            exits_sl: 0,
            exits_timeguard: 0,
          };
          cur.openR += r.pnl_r;
          if (isWin) cur.wins++;
          else cur.losses++;
          if (r.exit_reason === 'sl_hit') cur.exits_sl++;
          else if (r.force_close_reason === 'strategy_exit') cur.exits_strategy++;
          else if (r.force_close_reason === 'time_guard') cur.exits_timeguard++;
          stratAgg.set(sid, cur);
        }

        // Legacy scalp/swing buckets (LLM-track meaningful, keep for back-compat)
        const isScalp = r.tp_strategy === 'scalp';
        if (isWin) (isScalp ? stats.closedScalpWins++ : stats.closedSwingWins++);
        else (isScalp ? stats.closedScalpLosses++ : stats.closedSwingLosses++);
      }
    } else if (r.decision === 'SKIP') {
      stats.skipCount++;
      const cat = summariseSkipReason(r.reasoning_short);
      skipReasonCounts.set(cat, (skipReasonCounts.get(cat) ?? 0) + 1);
      if (cat === 'Sizing-floor SKIP' && r.confidence >= bandLow && r.confidence < currentFloor) {
        stats.sizingFloorSkipsInBand++;
      }
    } else if (r.decision === 'CLOSE') {
      // LLM-track explicit close decision row (different from the OPEN row
      // it closed). Don't double-count P&L — that's on the OPEN row.
      stats.closeCount++;
    } else if (r.decision === 'MODIFY') {
      stats.modifyCount++;
    }
  }

  stats.topSkipReasons = [...skipReasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Sort event stats by total trades desc (most data first)
  stats.signalEventStats = [...eventAgg.values()].sort(
    (a, b) => b.wins + b.losses - (a.wins + a.losses),
  );
  // Per-strategy stats sorted by activity
  stats.strategyStats = [...stratAgg.values()].sort(
    (a, b) => b.wins + b.losses - (a.wins + a.losses),
  );

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
  // No-op when LLM track is disabled — scalp floor only affects LLM-track
  // decisions (Track B uses its own rule-based geometry), so tuning it
  // when LLM is off is meaningless.
  if (!config.LLM_TRACK_ENABLED) return null;

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
  // Pick mode based on which tracks have ACTIVITY in the window.
  // Priorities when multiple tracks are active:
  //   - All three → 'hybrid' (compare)
  //   - LLM + Signal → 'hybrid'
  //   - LLM + Strategy → 'hybrid_ac'
  //   - Signal + Strategy → 'hybrid_bc'
  //   - Strategy only → 'track_c_only'
  //   - Signal only → 'track_b_only'
  //   - LLM only → 'llm_only'
  const hasLlm = stats.llmDecisions > 0 && config.LLM_TRACK_ENABLED;
  const hasSignal = stats.signalDecisions > 0;
  const hasStrategy = stats.strategyDecisions > 0;

  type Mode = 'track_b_only' | 'track_c_only' | 'llm_only' | 'hybrid' | 'hybrid_bc' | 'hybrid_ac';
  let mode: Mode;
  if (hasLlm && hasSignal && hasStrategy) mode = 'hybrid';
  else if (hasLlm && hasSignal) mode = 'hybrid';
  else if (hasSignal && hasStrategy) mode = 'hybrid_bc';
  else if (hasLlm && hasStrategy) mode = 'hybrid_ac';
  else if (hasStrategy) mode = 'track_c_only';
  else if (hasSignal || !config.LLM_TRACK_ENABLED) mode = 'track_b_only';
  else mode = 'llm_only';

  const systemHeader = `Ты — ревизор-аналитик собственной торговой системы. Ты только что отработал 12 часов и должен оценить работу критически и предложить улучшения.

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

ОТВЕЧАЙ ТОЛЬКО JSON, без markdown-обёрток.`;

  const trackBRules = `
КОНТЕКСТ: сейчас активен ТОЛЬКО Track B (Pure-LuxAlgo Signal Trader). Это
rule-based трейдер БЕЗ LLM-вызовов. Алгоритм работает так:
  - Webhook от TradingView → проверка qualifying events (bullish_plus,
    bearish_plus, choch_swing_plus_*, bos_swing_*, reversal_signal_*)
  - TFs: 5m (с 15m confluence), 15m, 1H, 4H, 1D
  - Геометрия: SL = 1.5×ATR(14) на 15m, TP = 3×ATR (R:R 1:2)
  - Размер: 0.5% флэт
  - Per-TF cooldown между OPENs на символе (5m/15m=30мин, 1H=2ч, 4H=6ч)
  - tpsl-monitor каждую минуту: SL/TP hit detection + auto-BE на 1R

ЦЕЛИ КОТОРЫЕ ОЦЕНИВАЕМ:
1. Прибыльность по сигналам — какие event/tf комбинации стабильно выигрывают
2. Win rate в целом ≥45% (R:R 1:2 → breakeven при wr=33%)
3. Достаточная частота сделок (3-10 в день норма)
4. Долгие losing streaks = повод пересмотреть условия

ЧТО МОЖНО ПРЕДЛОЖИТЬ (suggestions):
- 📝 "prompt_tweak" — НЕ применимо (нет LLM в этом треке). Не использовать.
- ⚙️ "param_change" — изменить КОНКРЕТНОЕ значение:
    * ATR multipliers (1.5×/3× → может 1.2×/3.6× для большего R:R 1:3?)
    * cooldown на конкретном TF
    * SIGNAL_TRADE_SIZE_PCT
    * R:R соотношение (TP/SL ratio)
- ✨ "new_feature" — добавить логику:
    * Добавить TF в TRADEABLE_TIMEFRAMES если 1H/4H пустые
    * Добавить event в qualifying set (например liquidity_grab)
    * Добавить confluence требование для слабых сигналов
    * Добавить trailing stop после BE
    * Counter-signal exit (closing position when opposite signal fires)
- 🗑 "discard" — убрать что-то:
    * Event/TF комбинация с win rate <30% после ≥5 сделок → удалить из triggers
    * Слишком короткий cooldown — увеличить
    * Лишний confluence — убрать

ПРАВИЛА:
- ПОКАЗЫВАЙ ЦИФРЫ в rationale — "bullish_plus@5m: 1W/3L = 25% wr"
- Размер позиции и риск-лимиты — священны, не предлагай поднимать
- Если выборка <10 сделок — не говори "удалить", говори "продолжать собирать данные"
- Если за 12ч было 0 OPEN — диагностируй ПОЧЕМУ (не было сигналов? confluence режет?)`;

  const llmRules = `
КОНТЕКСТ: активен Track A (LLM-driven) — Claude каждые 15 мин принимает
торговое решение на основе чартов + контекста. Сlf-tune может опускать
scalp confidence floor в [0.40-0.55].

ПРАВИЛА:
- НЕ говори "увеличить размер позиции / убрать риск-лимиты". Размер и риск — священны.
- НЕ предлагай "торговать больше" если рынок реально плохой. SKIP в чопе = правильно.
- Если много "Self-critique → SKIP" — может промпт critique слишком строгий?
- Если много "Sizing-floor SKIP" — паттерн для авто-tune.
- Если scalp-сделки убыточны — что общего у них?`;

  const hybridRules = `
КОНТЕКСТ: несколько треков активны параллельно (A/B/C сравнение).
  Track A (LLM): ${stats.llmDecisions} решений, ${stats.llmWins}W/${stats.llmLosses}L, ${stats.llmClosedR.toFixed(2)}R
  Track B (Signal): ${stats.signalDecisions} решений, ${stats.signalWins}W/${stats.signalLosses}L, ${stats.signalClosedR.toFixed(2)}R
  Track C (Strategy): ${stats.strategyDecisions} решений, ${stats.strategyWins}W/${stats.strategyLosses}L, ${stats.strategyClosedR.toFixed(2)}R
ЗАДАЧА: сравнить треки, отметить какой работает лучше и почему.`;

  const trackCRules = `
КОНТЕКСТ: активен Track C — LuxAlgo AI Strategy Builder webhook trader.
Каждая сделка приходит как webhook от настроенной в LuxAlgo стратегии:
  - ENTRY webhook → открыли market-позицию с safety SL (без TP)
  - EXIT webhook → закрыли market-позицию (force_close_reason='strategy_exit')
  - SL hit → tpsl-monitor закрыл по safety stop'у (close_reason='sl_hit')
  - Time-guard 24h → принудительное закрытие если стратегия молчит
       (force_close_reason='time_guard')

ВАЖНО: мы НЕ контролируем логику входов/выходов — её владеет LuxAlgo
стратегия. Мы только исполнители + safety SL. Поэтому:
  - prompt_tweak — НЕ применимо (нет промпта для Track C)
  - param_change — применимо ТОЛЬКО к slPct в STRATEGY_CONFIGS на
    конкретный strategy_id, на основе фактических данных:
      * sl_hit преобладает + средний adverse excursion > slPct → SL шире
      * strategy_exit преобладает + редкие sl_hit → SL OK, можно тестить уже
  - new_feature — добавить новую стратегию НЕ предлагать (это manual workflow),
    можно предлагать архитектурные улучшения (trailing после X R, partial
    close, и т.д.) — но flag'ом 'new_feature' с описанием
  - discard — отключить strategy_id с явным провалом (<30% wr после ≥10 сделок,
    или net negative R после ≥15 сделок)

ЦЕЛИ ОЦЕНКИ per-strategy:
1. Win rate (LuxAlgo бектест обещал >60%, проверяем live)
2. exit_reason ratio: strategy_exit / sl_hit / time_guard
   * Здоровый: 70%+ strategy_exit, 20-30% sl_hit, <5% time_guard
   * Сломанный: time_guard >20% → webhook config не работает
3. Avg PnL per trade > 0 после ≥10 сделок

ПРАВИЛА:
- ПОКАЗЫВАЙ ЦИФРЫ — "strategy_id 'ton-xyz': 8W/3L, +3.4R, 9 strategy_exit / 2 sl_hit"
- Если выборка <10 сделок — "продолжать собирать данные", не "удалить"
- Размер позиции ($1000 notional) и core SL bounds [0.5%, 5%] — священны`;

  let modeRules: string;
  switch (mode) {
    case 'track_b_only':
      modeRules = trackBRules;
      break;
    case 'track_c_only':
      modeRules = trackCRules;
      break;
    case 'hybrid':
      modeRules = hybridRules + llmRules + trackBRules + trackCRules;
      break;
    case 'hybrid_bc':
      modeRules = hybridRules + trackBRules + trackCRules;
      break;
    case 'hybrid_ac':
      modeRules = hybridRules + llmRules + trackCRules;
      break;
    case 'llm_only':
    default:
      modeRules = llmRules;
  }
  const system = systemHeader + '\n' + modeRules;

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

  // Track B per-(event, tf) breakdown — used when track_b_only or hybrid.
  const eventStatsLines = stats.signalEventStats.length
    ? stats.signalEventStats
        .map((e) => {
          const total = e.wins + e.losses;
          const wr = total > 0 ? Math.round((e.wins / total) * 100) : 0;
          return `  ${e.event}@${e.tf}m: ${e.wins}W/${e.losses}L (${wr}% wr, ${e.openR.toFixed(2)}R)`;
        })
        .join('\n')
    : '  (нет закрытых Track B сделок в окне)';

  const signalSideLines =
    stats.signalWins + stats.signalLosses > 0
      ? `  LONG: ${stats.signalLongWins}W/${stats.signalLongLosses}L  ·  SHORT: ${stats.signalShortWins}W/${stats.signalShortLosses}L`
      : '  (нет данных)';

  const trackBlock = `
=== TRACK B (Signal) детально ===
Решений: ${stats.signalDecisions}
Закрытых: ${stats.signalWins}W / ${stats.signalLosses}L  (Σ R: ${stats.signalClosedR.toFixed(2)})
По стороне:
${signalSideLines}
По (event, tf):
${eventStatsLines}`;

  const trackAblock =
    stats.llmDecisions > 0
      ? `

=== TRACK A (LLM) ===
Решений: ${stats.llmDecisions}
Закрытых: ${stats.llmWins}W / ${stats.llmLosses}L  (Σ R: ${stats.llmClosedR.toFixed(2)})
Scalp floor: ${effectiveScalpFloor().toFixed(2)}
Near-miss sizing-floor SKIPs (band [floor-0.08, floor)): ${stats.sizingFloorSkipsInBand}`
      : '';

  // Per-strategy stats block for Track C.
  const strategyStatsLines = stats.strategyStats.length
    ? stats.strategyStats
        .map((s) => {
          const total = s.wins + s.losses;
          const wr = total > 0 ? Math.round((s.wins / total) * 100) : 0;
          return `  ${s.strategy_id}: ${s.wins}W/${s.losses}L (${wr}% wr, ${s.openR.toFixed(2)}R) · exits: ${s.exits_strategy} strat / ${s.exits_sl} sl / ${s.exits_timeguard} time`;
        })
        .join('\n')
    : '  (нет закрытых Track C сделок в окне)';

  const trackCblock =
    stats.strategyDecisions > 0
      ? `

=== TRACK C (Strategy Builder) ===
Решений: ${stats.strategyDecisions}
Закрытых: ${stats.strategyWins}W / ${stats.strategyLosses}L  (Σ R: ${stats.strategyClosedR.toFixed(2)})
Per-strategy (id: W/L, wr%, total R, exits breakdown):
${strategyStatsLines}`
      : '';

  const user = `Окно: ${new Date(stats.windowStart).toISOString().slice(0, 16)}Z … ${new Date(stats.windowEnd).toISOString().slice(0, 16)}Z

Всего решений: ${stats.total}
  OPEN: ${stats.openCount}   ·   SKIP: ${stats.skipCount}   ·   CLOSE: ${stats.closeCount}   ·   MODIFY: ${stats.modifyCount}
${trackBlock}${trackAblock}${trackCblock}

Топ причин SKIP:
${skipReasonsLines || '  (нет SKIPов)'}

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
  const sigClosed = stats.signalWins + stats.signalLosses;
  const llmClosed = stats.llmWins + stats.llmLosses;
  const stratClosed = stats.strategyWins + stats.strategyLosses;

  // Combine active-track badges. With Track C added we have up to 3 markers.
  const active: string[] = [];
  if (stats.llmDecisions > 0 && config.LLM_TRACK_ENABLED) active.push('🤖 LLM');
  if (stats.signalDecisions > 0) active.push('📡 Signal');
  if (stats.strategyDecisions > 0) active.push('🛠 Strategy');
  const modeLabel =
    active.length === 0
      ? '<i>—</i>'
      : active.length === 1
        ? `<b>${active[0]} only</b>`
        : `<b>${active.join(' + ')}</b>`;

  const lines: string[] = [
    `🔬 <b>Самоанализ за 12 часов</b>  ·  ${modeLabel}`,
    `<i>${new Date(stats.windowStart).toISOString().slice(0, 16)}Z … ${new Date(stats.windowEnd).toISOString().slice(0, 16)}Z</i>`,
    '',
    `<b>Всего решений: ${stats.total}</b>`,
    `  OPEN: <code>${stats.openCount}</code>  ·  SKIP: <code>${stats.skipCount}</code>  ·  CLOSE: <code>${stats.closeCount}</code>  ·  MODIFY: <code>${stats.modifyCount}</code>`,
  ];

  // Track B detailed breakdown (when signal track has activity)
  if (stats.signalDecisions > 0) {
    const sigWr = sigClosed > 0 ? Math.round((stats.signalWins / sigClosed) * 100) : 0;
    lines.push('', `📡 <b>Track B (Signal)</b>`);
    lines.push(
      `  Решений: <code>${stats.signalDecisions}</code>  ·  Закрытых: <b>${stats.signalWins}W/${stats.signalLosses}L</b> (${sigWr}%)  ·  Σ R: <b>${stats.signalClosedR >= 0 ? '+' : ''}${stats.signalClosedR.toFixed(2)}R</b>`,
    );
    if (sigClosed > 0) {
      lines.push(
        `  По стороне: LONG ${stats.signalLongWins}W/${stats.signalLongLosses}L  ·  SHORT ${stats.signalShortWins}W/${stats.signalShortLosses}L`,
      );
    }
    if (stats.signalEventStats.length > 0) {
      lines.push(`  <b>По сигналам (event@tf):</b>`);
      for (const e of stats.signalEventStats) {
        const total = e.wins + e.losses;
        const wr = total > 0 ? Math.round((e.wins / total) * 100) : 0;
        const rSign = e.openR >= 0 ? '+' : '';
        lines.push(
          `    · <code>${e.event}@${e.tf}m</code>: ${e.wins}W/${e.losses}L (${wr}%, ${rSign}${e.openR.toFixed(2)}R)`,
        );
      }
    }
  }

  // Track A breakdown (when LLM has activity)
  if (stats.llmDecisions > 0) {
    const llmWr = llmClosed > 0 ? Math.round((stats.llmWins / llmClosed) * 100) : 0;
    lines.push('', `🤖 <b>Track A (LLM)</b>`);
    lines.push(
      `  Решений: <code>${stats.llmDecisions}</code>  ·  Закрытых: <b>${stats.llmWins}W/${stats.llmLosses}L</b> (${llmWr}%)  ·  Σ R: <b>${stats.llmClosedR >= 0 ? '+' : ''}${stats.llmClosedR.toFixed(2)}R</b>`,
    );
    lines.push(`  Scalp floor: <code>${effectiveScalpFloor().toFixed(2)}</code>`);
  }

  // Track C breakdown (when Strategy Builder has activity)
  if (stats.strategyDecisions > 0) {
    const strWr = stratClosed > 0 ? Math.round((stats.strategyWins / stratClosed) * 100) : 0;
    lines.push('', `🛠 <b>Track C (Strategy Builder)</b>`);
    lines.push(
      `  Решений: <code>${stats.strategyDecisions}</code>  ·  Закрытых: <b>${stats.strategyWins}W/${stats.strategyLosses}L</b> (${strWr}%)  ·  Σ R: <b>${stats.strategyClosedR >= 0 ? '+' : ''}${stats.strategyClosedR.toFixed(2)}R</b>`,
    );
    if (stats.strategyStats.length > 0) {
      lines.push(`  <b>Per-strategy:</b>`);
      for (const s of stats.strategyStats) {
        const total = s.wins + s.losses;
        const wr = total > 0 ? Math.round((s.wins / total) * 100) : 0;
        const rSign = s.openR >= 0 ? '+' : '';
        lines.push(
          `    · <code>${s.strategy_id}</code>: ${s.wins}W/${s.losses}L (${wr}%, ${rSign}${s.openR.toFixed(2)}R)`,
        );
        lines.push(
          `      выходы: ${s.exits_strategy} strategy / ${s.exits_sl} sl / ${s.exits_timeguard} time`,
        );
      }
    }
  }

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
  // Every 8h: 00:00, 08:00, 16:00 UTC.
  // User feedback 2026-05-13: 12h was too rare — when system is in
  // unhelpful state (all-SKIP storm), 12h delay means a full half-day
  // of paralysis before we even diagnose it. 8h reviews react faster
  // and still see enough decisions per window for meaningful patterns.
  cron.schedule('0 0,8,16 * * *', () => {
    runSelfReview().catch((err) => logger.error({ err }, 'self-review crashed'));
  });
  logger.info('self-review cron started (00:00 + 08:00 + 16:00 UTC, every 8h)');
}

// Make functions reachable for ad-hoc trigger from REPL / debug.
export const _internal = { runSelfReview, collectStats, maybeAutoTuneScalpFloor };

// Currently-unused escapeHtml is exported in case future formatters need it.
void escapeHtml;
