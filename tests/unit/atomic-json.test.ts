import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeJsonAtomicSync } from '../../src/lib/atomic-json.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('writeJsonAtomicSync', () => {
  it('replaces a snapshot and leaves no unique temporary file behind', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-json-'));
    temporaryDirectories.push(directory);
    const target = join(directory, 'snapshot.json');

    writeJsonAtomicSync(target, { status: 'healthy' });

    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ status: 'healthy' });
    expect(readdirSync(directory)).toEqual(['snapshot.json']);
  });

  it('ignores a stale fixed-name temporary file from an older writer', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-json-'));
    temporaryDirectories.push(directory);
    const target = join(directory, 'snapshot.json');
    const stale = `${target}.tmp`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(stale, 'stale');

    writeJsonAtomicSync(target, { status: 'recovered' });

    expect(existsSync(stale)).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ status: 'recovered' });
  });
});
