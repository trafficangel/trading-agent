import type { Decision } from '../llm/decision.schema.js';
import type { AggregatedSentiment } from '../exchange/multi-exchange.js';
import type { LiquidationsSnapshot } from '../exchange/liquidations.js';

/**
 * Structured features extracted at decision time so we can later run
 * analyses like "trades citing POC have higher win-rate" or "confidence
 * 0.60-0.70 actually delivers what avg R?" without re-parsing
 * reasoning_full text per query.
 *
 * Stored as JSON in decisions.features_json (single column, schema-light
 * iteration). When we expand features, only this module changes — no
 * migration needed.
 */
export type DecisionFeatures = {
  /** Confidence bucket for calibration grouping */
  confidence_bucket: '<0.40' | '0.40-0.50' | '0.50-0.60' | '0.60-0.70' | '>=0.70';
  /** Which deterministic levels did the model cite in its reasoning?
   *  Used to compare win-rates by referenced level type. */
  cited_levels: string[];
  /** Liquidations cascade present at decision time */
  cascade: 'long' | 'short' | null;
  /** Funding state: crowded-long, crowded-short, or neutral */
  funding_state: 'crowded_long' | 'crowded_short' | 'neutral' | null;
  /** BTC alignment inferred from reasoning (text-based; rough but useful) */
  btc_alignment: 'aligned' | 'against' | 'neutral' | null;
  /** Cross-exchange funding divergence in % (max - min between exchanges) */
  funding_divergence_pct: number | null;
  /** Git short hash of prompt version at decision time; lets us A/B
   *  changes after commits */
  prompt_version: string;
  /** Was this a self-critique downgrade? Lets us measure if critique
   *  is saving us from real bad trades or just over-correcting. */
  critique_downgrade: boolean;
  /** Was this an LLM call at all, or short-circuited by gate (chop, etc.)? */
  llm_invoked: boolean;
  /** How the model wanted the trade entered. Stage-2 shadow doesn't act
   *  on this, but we capture it now so we can later analyze:
   *  "do limit-intent trades outperform market-intent in actual outcome?" */
  entry_type: 'market' | 'limit' | null;
};

function bucketize(conf: number): DecisionFeatures['confidence_bucket'] {
  if (conf < 0.4) return '<0.40';
  if (conf < 0.5) return '0.40-0.50';
  if (conf < 0.6) return '0.50-0.60';
  if (conf < 0.7) return '0.60-0.70';
  return '>=0.70';
}

// Keyword patterns for extracting which deterministic levels / concepts
// the model referenced. Russian + English variants because reasoning
// content is Russian but technical terms remain English.
const LEVEL_PATTERNS: { tag: string; re: RegExp }[] = [
  { tag: 'POC', re: /\bPOC\b/i },
  { tag: 'VWAP', re: /\bVWAP\b/i },
  { tag: 'VAH', re: /\bVAH\b/i },
  { tag: 'VAL', re: /\bVAL\b/i },
  { tag: 'wall', re: /стенк|wall|✓2x|✓3x/i },
  { tag: 'stop_cluster', re: /стоп.?кластер|stop.?cluster/i },
  { tag: 'swing', re: /свинг.?(хай|лоу|high|low)|\bswing\b/i },
  { tag: 'choch', re: /CHoCH|CHOCH/ },
  { tag: 'bos', re: /\bBOS\b/ },
  { tag: 'order_block', re: /order.?block|\bOB[+-]?\b/i },
  { tag: 'fvg', re: /\bFVG\b/i },
  { tag: 'funding', re: /funding|фандинг/i },
  { tag: 'cascade', re: /каскад|cascade/i },
  { tag: 'atr', re: /\bATR\b/i },
  { tag: 'divergence', re: /дивергенц|divergen/i },
  { tag: '4h_trend', re: /4H тренд|4H trend/i },
  { tag: 'btc_context', re: /\bBTC\b/ },
];

function extractCitedLevels(reasoning: Decision): string[] {
  const haystack = [
    reasoning.reasoning_short,
    reasoning.reasoning_full,
    reasoning.sl_reason ?? '',
    reasoning.tp_reason ?? '',
    reasoning.invalidation ?? '',
  ]
    .filter(Boolean)
    .join('\n');
  const found: string[] = [];
  for (const { tag, re } of LEVEL_PATTERNS) {
    if (re.test(haystack)) found.push(tag);
  }
  return found;
}

function fundingStateFrom(
  sent: AggregatedSentiment | null | undefined,
): DecisionFeatures['funding_state'] {
  if (!sent || sent.weightedFunding === null) return null;
  const wf = sent.weightedFunding;
  if (wf > 0.0004) return 'crowded_long';
  if (wf < -0.0004) return 'crowded_short';
  return 'neutral';
}

// Text-based BTC alignment heuristic. We DON'T have BTC's own 24h-change
// directly in the context object (only the SUBJECT symbol's), so we
// extract from reasoning text where the model commented on it. Crude
// but useful at scale.
function btcAlignmentFromText(reasoning: Decision): DecisionFeatures['btc_alignment'] {
  const t = reasoning.reasoning_full + ' ' + reasoning.reasoning_short;
  // Against patterns
  if (
    /BTC.{0,40}(против|headwind|медвеж|downward|dumping|пада|вниз)/i.test(t) ||
    /(против|headwind).{0,30}BTC/i.test(t)
  ) {
    return 'against';
  }
  // Aligned patterns
  if (
    /BTC.{0,40}(с нами|aligned|tailwind|тоже растёт|тоже пада|совпада|подтвержда|в одну сторону)/i.test(
      t,
    )
  ) {
    return 'aligned';
  }
  // Neutral mention
  if (/\bBTC\b/.test(t)) return 'neutral';
  return null;
}

export function extractFeatures(input: {
  decision: Decision;
  aggSentiment?: AggregatedSentiment | null;
  liquidations?: LiquidationsSnapshot | null;
  promptVersion: string;
  critiqueDowngrade: boolean;
  llmInvoked: boolean;
}): DecisionFeatures {
  return {
    confidence_bucket: bucketize(input.decision.confidence),
    cited_levels: extractCitedLevels(input.decision),
    cascade: input.liquidations?.cascade ?? null,
    funding_state: fundingStateFrom(input.aggSentiment),
    btc_alignment: btcAlignmentFromText(input.decision),
    funding_divergence_pct: input.aggSentiment?.fundingDivergence ?? null,
    prompt_version: input.promptVersion,
    critique_downgrade: input.critiqueDowngrade,
    llm_invoked: input.llmInvoked,
    entry_type: input.decision.entry_type ?? null,
  };
}
