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

export const LuxAlgoPayload = z.object({
  symbol: z
    .string()
    .min(1)
    .transform((s) => s.toUpperCase().replace(/\.P$/, '')),
  timeframe: z.string().min(1),
  source: LuxAlgoSource,
  event: z.string().min(1),
  direction: LuxAlgoDirection.optional(),
  price: z.coerce.number().positive().optional(),
  bar_time: BarTime,
});

export type LuxAlgoPayload = z.infer<typeof LuxAlgoPayload>;
