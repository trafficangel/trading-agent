import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * Replace a JSON snapshot atomically without sharing a predictable temporary
 * filename with another invocation. A stale root-owned `<target>.tmp` must not
 * be able to block a service running as the unprivileged `trader` user.
 */
export function writeJsonAtomicSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
