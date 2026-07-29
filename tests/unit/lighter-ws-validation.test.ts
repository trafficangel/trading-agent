import { describe, expect, it } from 'vitest';
import {
  lighterValidationMode,
} from '../../src/lib/lighter-ws-validation.js';

describe('lighterValidationMode', () => {
  it('accepts a fresh independently matching ticker', () => {
    expect(lighterValidationMode({
      tickerFresh: true,
      tickerMatches: true,
      validatedChain: false,
    })).toBe('ticker');
  });

  it('carries a previously validated nonce-contiguous delta chain', () => {
    expect(lighterValidationMode({
      tickerFresh: false,
      tickerMatches: false,
      validatedChain: true,
    })).toBe('nonce_chain');
  });

  it('never carries through a fresh ticker mismatch', () => {
    expect(lighterValidationMode({
      tickerFresh: true,
      tickerMatches: false,
      validatedChain: true,
    })).toBe('invalid');
  });

  it('rejects an unvalidated chain without a fresh ticker', () => {
    expect(lighterValidationMode({
      tickerFresh: false,
      tickerMatches: false,
      validatedChain: false,
    })).toBe('invalid');
  });
});
