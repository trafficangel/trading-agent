export type LinearModel = {
  means: number[];
  scales: number[];
  weights: number[];
};

type Sample = { features: number[]; target: number };

function solve(matrix: number[][], values: number[]): number[] | null {
  const n = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]!]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(augmented[pivot]![column]!) < 1e-12) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    const divisor = augmented[column]![column]!;
    for (let j = column; j <= n; j++) {
      augmented[column]![j] = augmented[column]![j]! / divisor;
    }
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      for (let j = column; j <= n; j++) {
        augmented[row]![j] = augmented[row]![j]! - factor * augmented[column]![j]!;
      }
    }
  }
  return augmented.map((row) => row[n]!);
}

export function fitRidgeLinear(samples: Sample[], ridge = 1): LinearModel | null {
  const width = samples[0]?.features.length ?? 0;
  if (samples.length < width * 3 || width === 0) return null;
  if (samples.some((sample) => sample.features.length !== width)) return null;
  const means = Array(width).fill(0) as number[];
  for (const sample of samples) {
    for (let j = 0; j < width; j++) means[j] = means[j]! + sample.features[j]!;
  }
  for (let j = 0; j < width; j++) means[j] = means[j]! / samples.length;
  const scales = Array(width).fill(0) as number[];
  for (const sample of samples) {
    for (let j = 0; j < width; j++) {
      const delta = sample.features[j]! - means[j]!;
      scales[j] = scales[j]! + delta * delta;
    }
  }
  for (let j = 0; j < width; j++) scales[j] = Math.sqrt(scales[j]! / samples.length) || 1;

  const dimension = width + 1;
  const xtx = Array.from({ length: dimension }, () => Array(dimension).fill(0) as number[]);
  const xty = Array(dimension).fill(0) as number[];
  for (const sample of samples) {
    const row = [1, ...sample.features.map((value, j) => (value - means[j]!) / scales[j]!)];
    for (let i = 0; i < dimension; i++) {
      xty[i] = xty[i]! + row[i]! * sample.target;
      for (let j = 0; j < dimension; j++) {
        xtx[i]![j] = xtx[i]![j]! + row[i]! * row[j]!;
      }
    }
  }
  for (let i = 1; i < dimension; i++) xtx[i]![i] = xtx[i]![i]! + ridge;
  const weights = solve(xtx, xty);
  return weights ? { means, scales, weights } : null;
}

export function predictLinear(model: LinearModel, features: number[]): number {
  if (features.length !== model.means.length) return Number.NaN;
  let result = model.weights[0]!;
  for (let j = 0; j < features.length; j++) {
    result += model.weights[j + 1]! * ((features[j]! - model.means[j]!) / model.scales[j]!);
  }
  return result;
}
