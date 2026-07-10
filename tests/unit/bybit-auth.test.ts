import { describe, expect, it } from 'vitest';
import { isBybitAuthFailure } from '../../src/lib/bybit-auth.js';

describe('Bybit authentication failure classification', () => {
  it.each([401, -2015, 33004, 10003, 10004, 10005, 10007, 10010])(
    'quarantines conclusive auth failure %i',
    (code) => {
      expect(isBybitAuthFailure(code)).toBe(true);
    },
  );

  it.each([-1, 403, 429, 10000, 10002, 10006, 110007])(
    'keeps transient or operational failure %i retryable',
    (code) => {
      expect(isBybitAuthFailure(code)).toBe(false);
    },
  );
});
