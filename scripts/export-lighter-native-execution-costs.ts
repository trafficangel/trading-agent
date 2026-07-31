/** Export a mature Native microstructure audit into scanner-compatible costs. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildLighterFrozenExecutionCosts,
  type LighterMicrostructureCostAudit,
} from '../src/lib/lighter-execution-calibration.js';

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const auditPath = resolve(
  flagValue('--audit')
    ?? process.env.LIGHTER_MICRO_AUDIT
    ?? 'data/lighter-native-microstructure-audit.json',
);
const outputPath = resolve(
  flagValue('--output')
    ?? process.env.LIGHTER_FROZEN_EXECUTION_COSTS
    ?? 'data/lighter-execution-costs-native-frozen.json',
);

if (!existsSync(auditPath)) throw new Error(`microstructure audit missing: ${auditPath}`);
const audit = JSON.parse(readFileSync(auditPath, 'utf8')) as LighterMicrostructureCostAudit;
const result = buildLighterFrozenExecutionCosts(audit);
if (result.status === 'not_ready') {
  console.log(JSON.stringify({ status: result.status, auditPath, failures: result.failures }, null, 2));
  if (process.argv.includes('--require-ready')) process.exit(1);
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(result.calibration, null, 2)}\n`);
  renameSync(temporaryPath, outputPath);
  console.log(JSON.stringify({ status: result.status, auditPath, outputPath, ...result.calibration }, null, 2));
}
