import { describe, expect, it } from 'vitest';
import { fitRidgeLinear, predictLinear } from '../../src/lib/hft-linear-model.js';

describe('HFT ridge linear model', () => {
  it('recovers a stable linear relationship with an intercept', () => {
    const samples = Array.from({ length: 200 }, (_, index) => {
      const x = index / 20 - 5;
      const z = Math.sin(index / 7);
      return { features: [x, z], target: 1.5 + 2 * x - 0.75 * z };
    });
    const model = fitRidgeLinear(samples, 0.0001);
    expect(model).not.toBeNull();
    expect(predictLinear(model!, [1.2, -0.4])).toBeCloseTo(4.2, 3);
  });

  it('rejects insufficient and inconsistent samples', () => {
    expect(fitRidgeLinear([{ features: [1, 2], target: 3 }])).toBeNull();
    expect(
      fitRidgeLinear([
        { features: [1], target: 1 },
        { features: [1, 2], target: 1 },
        { features: [2], target: 2 },
      ]),
    ).toBeNull();
  });
});
