/**
 * Heartbeat registry for cron jobs and long-running tasks.
 *
 * Each job calls markTick('name') on every successful completion. The health
 * cron (src/jobs/health.ts) periodically reads these timestamps and alerts
 * if any job hasn't ticked within its expected window.
 *
 * In-memory only — on restart the map clears, which is correct behavior:
 * the health cron will see "never ticked" on the next pass and that's
 * accurate until first tick.
 */

const ticks = new Map<string, number>();

export function markTick(name: string): void {
  ticks.set(name, Date.now());
}

export function getLastTick(name: string): number | null {
  return ticks.get(name) ?? null;
}

export function getAllTicks(): ReadonlyMap<string, number> {
  return ticks;
}
