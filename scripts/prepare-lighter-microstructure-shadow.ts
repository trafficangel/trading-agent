/**
 * Freeze the prospective Shadow cohort after the immutable 21d selection.
 * This script records activation only; it never sends an order or enables Real.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { prepareMicrostructureShadowManifest } from '../src/lib/lighter-microstructure-shadow.js';

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, path);
}

const frozenPath = resolve(
  flagValue('--frozen') ?? 'data/lighter-native-microstructure-sweep.json',
);
const manifestPath = resolve(
  flagValue('--output') ?? 'data/lighter-native-microstructure-shadow-manifest.json',
);
if (!existsSync(frozenPath)) throw new Error(`frozen report missing: ${frozenPath}`);
const frozenReport = readJson(frozenPath);
const existing = existsSync(manifestPath) ? readJson(manifestPath) : null;
const result = prepareMicrostructureShadowManifest(frozenReport, existing, Date.now());
if (result.status === 'created') writeAtomic(manifestPath, result.manifest);
console.log(JSON.stringify(result, null, 2));
