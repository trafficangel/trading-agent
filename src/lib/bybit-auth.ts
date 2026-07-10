/**
 * Bybit responses that conclusively mean the stored API credentials cannot be
 * used until the user fixes or replaces them. Transient network/rate-limit
 * failures must never quarantine a healthy key.
 */
const BYBIT_AUTH_FAILURE_CODES = new Set([
  401, // HTTP: missing/invalid authentication
  -2015, // Spot API key expired
  33004, // Derivatives API key expired
  10003, // Invalid API key / wrong mainnet-testnet domain
  10004, // Invalid signature
  10005, // Permission denied
  10007, // User authentication failed
  10010, // API key IP allowlist mismatch
]);

export function isBybitAuthFailure(code: number): boolean {
  return BYBIT_AUTH_FAILURE_CODES.has(code);
}
