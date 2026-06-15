/**
 * Portfolio allocator (pure, testable) — turns a set of edges into capital
 * weights with two MM principles:
 *   1. Risk-parity: raw weight ∝ 1/risk (lower-drawdown edges get more
 *      capital, so each contributes ~equal risk).
 *   2. Cluster cap: correlated edges (e.g. the 8 maker mean-rev on alts, or
 *      the 5 Bollinger-MR) are ONE bet, not N — cap each cluster's total
 *      weight (waterfill the excess to other clusters). Without this, the
 *      low-DD maker cluster would swallow the whole book and a broad alt dip
 *      would hit everything at once.
 *
 * Returns weights summing to 1. Caller multiplies by deployable capital.
 */

export type AllocInput = { id: string; cluster: string; riskPct: number };
export type AllocOut = { id: string; cluster: string; weight: number };

export function allocatePortfolio(items: AllocInput[], opts: { clusterCap?: number } = {}): AllocOut[] {
  const cap = opts.clusterCap ?? 0.35;
  if (items.length === 0) return [];

  // Risk-parity raw weight per item.
  const raw = items.map((it) => ({ ...it, raw: it.riskPct > 0 ? 1 / it.riskPct : 0 }));
  const clusters = [...new Set(raw.map((r) => r.cluster))];
  const clusterRaw = new Map(clusters.map((c) => [c, raw.filter((r) => r.cluster === c).reduce((a, b) => a + b.raw, 0)]));

  // Cluster-level waterfill: cap clusters whose risk-parity share exceeds the
  // cap, freeze them, redistribute the remainder to the rest — repeat.
  const capped = new Set<string>();
  for (let iter = 0; iter < clusters.length + 1; iter++) {
    const free = clusters.filter((c) => !capped.has(c));
    const freeRaw = free.reduce((a, c) => a + (clusterRaw.get(c) ?? 0), 0) || 1;
    const remaining = Math.max(0, 1 - capped.size * cap);
    const newly = free.filter((c) => remaining * ((clusterRaw.get(c) ?? 0) / freeRaw) > cap + 1e-9);
    if (newly.length === 0) break;
    newly.forEach((c) => capped.add(c));
  }

  const free = clusters.filter((c) => !capped.has(c));
  const freeRaw = free.reduce((a, c) => a + (clusterRaw.get(c) ?? 0), 0) || 1;
  const remaining = Math.max(0, 1 - capped.size * cap);
  const clusterWeight = new Map<string, number>(
    clusters.map((c) => [c, capped.has(c) ? cap : remaining * ((clusterRaw.get(c) ?? 0) / freeRaw)]),
  );

  // Split each cluster's weight among its members by their risk-parity share.
  const out = raw.map((r) => {
    const cw = clusterWeight.get(r.cluster) ?? 0;
    const cr = clusterRaw.get(r.cluster) || 1;
    return { id: r.id, cluster: r.cluster, weight: cw * (r.raw / cr) };
  });
  // Renormalize (guards against the degenerate all-capped case rounding off).
  const tot = out.reduce((a, b) => a + b.weight, 0) || 1;
  return out.map((o) => ({ ...o, weight: o.weight / tot }));
}

/** Portfolio-level summary given the allocation + per-item expectancy/risk. */
export function portfolioSummary(
  alloc: AllocOut[],
  stats: Record<string, { expectancyPct: number; riskPct: number }>,
): { weightedExpectancyPct: number; weightedRiskPct: number; clusters: number } {
  let exp = 0, risk = 0;
  for (const a of alloc) {
    const s = stats[a.id];
    if (!s) continue;
    exp += a.weight * s.expectancyPct;
    risk += a.weight * s.riskPct;
  }
  return {
    weightedExpectancyPct: Math.round(exp * 1000) / 1000,
    weightedRiskPct: Math.round(risk * 10) / 10,
    clusters: new Set(alloc.map((a) => a.cluster)).size,
  };
}
