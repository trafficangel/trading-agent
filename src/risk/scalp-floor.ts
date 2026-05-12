import { getRuntimeNumber, RUNTIME_KEYS } from '../db/repos/runtime-config.js';
import {
  SIZING_FLOOR_SCALP_DEFAULT,
  SIZING_FLOOR_SCALP_MIN,
  SIZING_FLOOR_SCALP_MAX,
} from './sizing.js';

/**
 * The effective scalp confidence floor — what the actual decide-step uses
 * RIGHT NOW. Self-review job can adjust this between [0.40, 0.55] without
 * a deploy by writing to `runtime_config['scalp.confidence_floor']`.
 *
 * This lives in a SEPARATE module from sizing.ts so that sizing.ts stays
 * pure (no DB imports → loadable in test env without env-var ceremony).
 * decide.ts imports both: pure sizing logic from sizing.ts, runtime floor
 * lookup from here, and passes the floor in as an explicit parameter.
 */
export function effectiveScalpFloor(): number {
  const tuned = getRuntimeNumber(RUNTIME_KEYS.scalpConfidenceFloor);
  if (tuned === null) return SIZING_FLOOR_SCALP_DEFAULT;
  return Math.max(SIZING_FLOOR_SCALP_MIN, Math.min(SIZING_FLOOR_SCALP_MAX, tuned));
}
