export type EdgexDepthLevel = {
  price?: unknown;
  size?: unknown;
};

export type EdgexDepthState = {
  bids: Map<number, number>;
  asks: Map<number, number>;
  version: bigint | null;
};

export type EdgexDepthApplyResult =
  | 'snapshot'
  | 'changed'
  | 'duplicate'
  | 'gap'
  | 'invalid';

function finitePositive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteNonNegative(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseVersion(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

function updateLevels(
  target: Map<number, number>,
  rows: readonly EdgexDepthLevel[] | undefined,
): void {
  for (const row of rows ?? []) {
    const price = finitePositive(row.price);
    const size = finiteNonNegative(row.size);
    if (price === null || size === null) continue;
    if (size === 0) target.delete(price);
    else target.set(price, size);
  }
}

export function applyEdgexDepthUpdate(
  state: EdgexDepthState,
  update: {
    dataType?: unknown;
    depthType?: unknown;
    startVersion?: unknown;
    endVersion?: unknown;
    bids?: readonly EdgexDepthLevel[];
    asks?: readonly EdgexDepthLevel[];
  },
): EdgexDepthApplyResult {
  const startVersion = parseVersion(update.startVersion);
  const endVersion = parseVersion(update.endVersion);
  if (
    startVersion === null
    || endVersion === null
    || endVersion < startVersion
  ) return 'invalid';

  const type = String(update.depthType ?? update.dataType ?? '').toUpperCase();
  if (type === 'SNAPSHOT') {
    state.bids.clear();
    state.asks.clear();
    updateLevels(state.bids, update.bids);
    updateLevels(state.asks, update.asks);
    if (!state.bids.size || !state.asks.size) {
      state.version = null;
      return 'invalid';
    }
    state.version = endVersion;
    return 'snapshot';
  }

  if (type !== 'CHANGED') return 'invalid';
  if (state.version === null) return 'gap';
  if (endVersion <= state.version) return 'duplicate';
  // edgeX deltas overlap the preceding snapshot/delta at startVersion.
  if (startVersion !== state.version) return 'gap';

  updateLevels(state.bids, update.bids);
  updateLevels(state.asks, update.asks);
  if (!state.bids.size || !state.asks.size) {
    state.version = null;
    return 'invalid';
  }
  state.version = endVersion;
  return 'changed';
}
