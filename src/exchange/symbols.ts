/**
 * Symbol normalization across exchanges.
 *
 * Canonical form: Bybit-style "BASEQUOTE" without separator (e.g. "TONUSDT").
 * That's what TradingView alerts send us and what we store in DB. Each
 * exchange adapter accepts the canonical form and converts internally.
 *
 * Supported quote currencies: USDT, USDC, USD. Anything else throws.
 */

export type Exchange = 'bybit' | 'binance' | 'okx';

const QUOTES = ['USDT', 'USDC', 'USD'] as const;

/** Split a canonical symbol into [base, quote]. */
export function splitSymbol(canonical: string): [string, string] {
  for (const q of QUOTES) {
    if (canonical.endsWith(q)) {
      const base = canonical.slice(0, canonical.length - q.length);
      if (base.length > 0) return [base, q];
    }
  }
  throw new Error(`unsupported symbol "${canonical}" — must end with USDT/USDC/USD`);
}

/**
 * Convert a canonical symbol to the form expected by the named exchange's
 * REST API for USDT/USDC perpetual futures.
 *   Bybit:   TONUSDT     (passthrough)
 *   Binance: TONUSDT     (passthrough; USDS-M perps share the format)
 *   OKX:     TON-USDT-SWAP
 */
export function normalizeSymbol(canonical: string, exchange: Exchange): string {
  const [base, quote] = splitSymbol(canonical);
  switch (exchange) {
    case 'bybit':
    case 'binance':
      return `${base}${quote}`;
    case 'okx':
      return `${base}-${quote}-SWAP`;
  }
}
