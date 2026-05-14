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

/** Track C — LuxAlgo AI Strategy Builder webhook. Distinct shape from
 *  event-alerts: carries `strategy_id` + explicit `action: 'entry'|'exit'`.
 *  TradingView alert template must include `"kind":"strategy"` so the
 *  webhook router can dispatch correctly. */
export const LuxAlgoStrategyPayload = z
  .object({
    kind: z.literal('strategy'),
    strategy_id: z.string().min(1).max(64),
    action: z.enum(['entry', 'exit']),
    symbol: SymbolField,
    timeframe: z.string().min(1),
    side: z.enum(['long', 'short']).optional(),
    price: z.coerce.number().positive().optional(),
    bar_time: BarTime,
  })
  .superRefine((v, ctx) => {
    if (v.action === 'entry' && !v.side) {
      ctx.addIssue({
        code: 'custom',
        path: ['side'],
        message: 'side is required when action="entry"',
      });
    }
  });
export type LuxAlgoStrategyPayload = z.infer<typeof LuxAlgoStrategyPayload>;

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
