import { z } from 'zod';

export const LuxAlgoSource = z.enum(['signals_overlays', 'pac', 'oscillator_matrix']);
export type LuxAlgoSource = z.infer<typeof LuxAlgoSource>;

export const LuxAlgoDirection = z.enum(['up', 'down', 'neutral']);
export type LuxAlgoDirection = z.infer<typeof LuxAlgoDirection>;

export const LuxAlgoPayload = z.object({
  symbol: z.string().min(1).transform((s) => s.toUpperCase()),
  timeframe: z.string().min(1),
  source: LuxAlgoSource,
  event: z.string().min(1),
  direction: LuxAlgoDirection.optional(),
  price: z.coerce.number().positive().optional(),
  bar_time: z.coerce.number().int().nonnegative(),
});

export type LuxAlgoPayload = z.infer<typeof LuxAlgoPayload>;
