import { z } from 'zod';

export const LuxAlgoSource = z.enum(['signals_overlays', 'pac', 'oscillator_matrix']);
export type LuxAlgoSource = z.infer<typeof LuxAlgoSource>;

export const LuxAlgoDirection = z.enum(['up', 'down', 'neutral']);
export type LuxAlgoDirection = z.infer<typeof LuxAlgoDirection>;

const BarTime = z.union([
  z.coerce.number().int().nonnegative(),
  z.string().transform((s, ctx) => {
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) {
      ctx.addIssue({ code: 'custom', message: `bar_time: not a parseable datetime: ${s}` });
      return z.NEVER;
    }
    return ms;
  }),
]);

/** Normalise the raw TradingView ticker string to our internal form,
 *  e.g. `BYBIT:TONUSDT.P` → `TONUSDT`. */
const SymbolField = z
  .string()
  .min(1)
  .transform((s) => s.toUpperCase().replace(/^BYBIT:/, '').replace(/\.P$/, ''));

/** Legacy event-alert payload (used by Track A and Track B). All existing
 *  TradingView alerts conform to this — no migration needed when Track C
 *  is added on top via discriminated union. */
export const LuxAlgoEventPayload = z.object({
  symbol: SymbolField,
  timeframe: z.string().min(1),
  source: LuxAlgoSource,
  event: z.string().min(1),
  direction: LuxAlgoDirection.optional(),
  price: z.coerce.number().positive().optional(),
  bar_time: BarTime,
});
export type LuxAlgoEventPayload = z.infer<typeof LuxAlgoEventPayload>;

/** Back-compat alias — older imports use `LuxAlgoPayload`. */
export const LuxAlgoPayload = LuxAlgoEventPayload;
export type LuxAlgoPayload = LuxAlgoEventPayload;

/** Strategy event as emitted by LuxAlgo's `[[strategy_event]]` placeholder.
 *  Used by the AI Strategy Builder alert template. Server derives
 *  action+side from this value (see deriveActionSide below). */
/**
 * LuxAlgo's `{{strategy.order.action}}` placeholder emits values with
 * a SPACE — e.g. "exit long" / "exit short" (NOT "exit_long" with
 * underscore as the docs suggested). Discovered after STRAT-001's
 * first live signal: entry "short" succeeded but every subsequent
 * "exit long" payload was rejected by this schema, and the position
 * closed by our internal 24h time-guard instead of the strategy's
 * built-in exit. Costly bug — we should have caught it before launch.
 *
 * Preprocess any "exit foo" form into "exit_foo" before enum validation
 * so the wire format becomes irrelevant. Both forms accepted forever.
 */
export const StrategyEvent = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, '_') : v),
  z.enum(['long', 'short', 'exit_long', 'exit_short']),
);
export type StrategyEvent = z.infer<typeof StrategyEvent>;

/** Track C — LuxAlgo AI Strategy Builder webhook.
 *
 *  TWO accepted shapes (Strategy Builder UI uses option B):
 *    A) Explicit form: { action: 'entry'|'exit', side?: 'long'|'short' }
 *       — manual / curl testing
 *    B) LuxAlgo-native form: { strategy_event: 'long'|'short'|'exit_long'|'exit_short' }
 *       — what {{strategy_event}} placeholder substitutes to in the alert
 *
 *  Server normalises B → A via deriveActionSide() before routing to trader. */
export const LuxAlgoStrategyPayload = z
  .object({
    kind: z.literal('strategy'),
    strategy_id: z.string().min(1).max(64),
    // Form A — explicit
    action: z.enum(['entry', 'exit']).optional(),
    side: z.enum(['long', 'short']).optional(),
    // Form B — LuxAlgo native
    strategy_event: StrategyEvent.optional(),
    // Common fields
    symbol: SymbolField,
    timeframe: z.string().min(1),
    price: z.coerce.number().positive().optional(),
    bar_time: BarTime,
  })
  .superRefine((v, ctx) => {
    // Must have either action (form A) or strategy_event (form B)
    if (!v.action && !v.strategy_event) {
      ctx.addIssue({
        code: 'custom',
        path: ['action'],
        message: 'either action or strategy_event is required',
      });
      return;
    }
    // Form A: side required for entry
    if (v.action === 'entry' && !v.side) {
      ctx.addIssue({
        code: 'custom',
        path: ['side'],
        message: 'side is required when action="entry"',
      });
    }
  });
export type LuxAlgoStrategyPayload = z.infer<typeof LuxAlgoStrategyPayload>;

/** Translate LuxAlgo's strategy_event values into our internal action+side.
 *  - 'long'        → entry long
 *  - 'short'       → entry short
 *  - 'exit_long'   → exit (closing a previously-long position; side here is
 *                    informational — exit handler uses the active row's side)
 *  - 'exit_short'  → exit (mirror)
 *  Returns {action, side?} ready for the trader. */
export function deriveActionSide(p: LuxAlgoStrategyPayload): {
  action: 'entry' | 'exit';
  side?: 'long' | 'short';
} {
  // Form A — already explicit
  if (p.action) return { action: p.action, side: p.side };
  // Form B — derive from strategy_event
  switch (p.strategy_event) {
    case 'long':
      return { action: 'entry', side: 'long' };
    case 'short':
      return { action: 'entry', side: 'short' };
    case 'exit_long':
      return { action: 'exit', side: 'long' };
    case 'exit_short':
      return { action: 'exit', side: 'short' };
    default:
      // Unreachable — superRefine guarantees one of action / strategy_event.
      return { action: 'exit' };
  }
}

/** Webhook router input — discriminated by `kind`. Default 'event' if the
 *  field is absent (back-compat with 28 existing TV alerts).
 *
 *  z.discriminatedUnion doesn't compose with .superRefine (Strategy payload
 *  needs cross-field validation: "side is required when action='entry'"),
 *  so we parse the discriminator manually and pick the matching schema.
 *  The result type is a tagged union the caller narrows via `.kind`. */
export type LuxAlgoWebhookPayload =
  | ({ kind: 'event' } & LuxAlgoEventPayload)
  | ({ kind: 'strategy' } & LuxAlgoStrategyPayload);

export type ParseResult =
  | { success: true; data: LuxAlgoWebhookPayload }
  | { success: false; issues: z.ZodIssue[] };

export function parseLuxAlgoWebhook(raw: unknown): ParseResult {
  const kind =
    typeof raw === 'object' && raw !== null && 'kind' in (raw as Record<string, unknown>)
      ? (raw as { kind?: unknown }).kind
      : 'event';

  if (kind === 'strategy') {
    const r = LuxAlgoStrategyPayload.safeParse(raw);
    if (!r.success) return { success: false, issues: r.error.issues };
    // r.data already has kind:'strategy' (literal in schema)
    return { success: true, data: r.data };
  }
  // Default / legacy path — event payload doesn't carry `kind`, so add it.
  const r = LuxAlgoEventPayload.safeParse(raw);
  if (!r.success) return { success: false, issues: r.error.issues };
  return { success: true, data: { kind: 'event' as const, ...r.data } };
}
