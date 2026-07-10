import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupFilesToRemove, restoreVerifiedSqliteBackup, sqliteBackupFilename } from '../../src/lib/sqlite-backup.js';

describe('SQLite backup retention', () => {
  it('uses UTC timestamps that sort chronologically', () => {
    expect(sqliteBackupFilename(new Date('2026-07-10T06:17:03.123Z'))).toBe('trading-20260710T061703Z.sqlite');
  });

  it('keeps the newest valid backup files only', () => {
    const files = [
      'trading-20260709T001700Z.sqlite',
      'trading-20260710T001700Z.sqlite',
      'latest.json',
      '.backup-1.tmp',
      'trading-20260710T061700Z.sqlite',
    ];
    expect(backupFilesToRemove(files, 2)).toEqual(['trading-20260709T001700Z.sqlite']);
  });

  it('always preserves at least the newest backup', () => {
    expect(backupFilesToRemove([
      'trading-20260710T001700Z.sqlite',
      'trading-20260710T061700Z.sqlite',
    ], 0)).toEqual(['trading-20260710T001700Z.sqlite']);
  });

  it('restores to a new verified file and refuses overwrite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-restore-test-'));
    const backup = join(dir, 'backup.sqlite');
    const restored = join(dir, 'restored.sqlite');
    try {
      const source = new Database(backup);
      source.exec('CREATE TABLE schema_migrations(version TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES (\'001.sql\'); CREATE TABLE trades(id INTEGER PRIMARY KEY)');
      source.close();

      expect(restoreVerifiedSqliteBackup(backup, restored)).toMatchObject({ quickCheck: 'ok', tables: 2, migrations: 1 });
      expect(readFileSync(restored).length).toBeGreaterThan(0);
      expect(() => restoreVerifiedSqliteBackup(backup, restored)).toThrow(/already exists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
