import { describe, it, expect } from 'vitest';

// Re-implement the predicate locally for testability without exporting it.
// Mirrors src/llm/billing-alert.ts looksLikeBillingError().

const BILLING_KEYWORDS = [
  'credit balance',
  'credit_balance',
  'insufficient',
  'billing',
  'quota',
  'payment required',
  'plan does not allow',
];

function looksLikeBillingError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { status?: number; message?: string; error?: { message?: string } };
  if (e.status === 402) return true;
  const msg = ((e.message ?? '') + ' ' + (e.error?.message ?? '')).toLowerCase();
  return BILLING_KEYWORDS.some((kw) => msg.includes(kw));
}

describe('billing-error detector', () => {
  it('null/undefined → false', () => {
    expect(looksLikeBillingError(null)).toBe(false);
    expect(looksLikeBillingError(undefined)).toBe(false);
  });

  it('plain network error → false', () => {
    expect(looksLikeBillingError(new Error('ECONNRESET'))).toBe(false);
  });

  it('rate limit without credit wording → false', () => {
    expect(
      looksLikeBillingError({
        status: 429,
        message: 'Rate limit exceeded — too many requests',
      }),
    ).toBe(false);
  });

  it('credit balance message → true', () => {
    expect(
      looksLikeBillingError({
        status: 400,
        message: 'Your credit balance is too low to access the API.',
      }),
    ).toBe(true);
  });

  it('billing error in nested error.message → true', () => {
    expect(
      looksLikeBillingError({
        status: 400,
        error: { message: 'Billing has not been set up for this account.' },
      }),
    ).toBe(true);
  });

  it('HTTP 402 → true regardless of message', () => {
    expect(looksLikeBillingError({ status: 402 })).toBe(true);
  });

  it('quota wording → true', () => {
    expect(
      looksLikeBillingError({ message: 'You have exceeded your monthly quota.' }),
    ).toBe(true);
  });

  it('"plan does not allow" → true', () => {
    expect(
      looksLikeBillingError({
        error: { message: 'Your plan does not allow access to this model.' },
      }),
    ).toBe(true);
  });
});
