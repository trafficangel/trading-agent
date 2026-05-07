import { createHash } from 'node:crypto';
import type { LuxAlgoPayload } from '../webhooks/luxalgo.schema.js';

export function makeDedupKey(p: LuxAlgoPayload): string {
  const raw = `${p.symbol}|${p.timeframe}|${p.event}|${p.direction ?? ''}|${p.bar_time}`;
  return createHash('sha1').update(raw).digest('hex');
}
