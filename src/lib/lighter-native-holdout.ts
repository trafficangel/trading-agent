export type JsonReport = {
  file: string;
  content: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeHoldoutSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase().replace(/USDT$/, '');
  return normalized || null;
}

/**
 * Performance reports expose the tested universe through input.symbols.
 * Cost, funding and candle-readiness files intentionally do not count as a
 * performance exposure, so selecting a holdout by executability remains safe.
 */
export function performanceSymbols(report: unknown): string[] {
  const root = record(report);
  const input = record(root?.input);
  if (!Array.isArray(input?.symbols)) return [];
  return [...new Set(input.symbols
    .map(normalizeHoldoutSymbol)
    .filter((symbol): symbol is string => symbol != null))];
}

export function reservedHoldoutLeaks(
  reports: readonly JsonReport[],
  reservedSymbols: readonly string[],
): Record<string, string[]> {
  const reserved = new Set(reservedSymbols
    .map(normalizeHoldoutSymbol)
    .filter((symbol): symbol is string => symbol != null));
  const leaks = new Map<string, string[]>();
  for (const report of reports) {
    for (const symbol of performanceSymbols(report.content)) {
      if (!reserved.has(symbol)) continue;
      const files = leaks.get(symbol) ?? [];
      files.push(report.file);
      leaks.set(symbol, files);
    }
  }
  return Object.fromEntries([...leaks.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([symbol, files]) => [symbol, [...new Set(files)].sort()]));
}

/**
 * Once a sealed holdout is spent, every performance exposure must be declared
 * in the ledger. This keeps an opened holdout auditable without treating its
 * preregistered result artifacts as accidental leaks.
 */
export function undeclaredHoldoutLeaks(
  leaks: Readonly<Record<string, readonly string[]>>,
  declaredPerformanceFiles: readonly string[],
): Record<string, string[]> {
  const declared = new Set(declaredPerformanceFiles);
  return Object.fromEntries(Object.entries(leaks)
    .map(([symbol, files]) => [
      symbol,
      [...new Set(files.filter((file) => !declared.has(file)))].sort(),
    ] as const)
    .filter(([, files]) => files.length > 0)
    .sort(([left], [right]) => left.localeCompare(right)));
}
