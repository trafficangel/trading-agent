import Database from 'better-sqlite3';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const BACKUP_RE = /^trading-(\d{8}T\d{6}Z)\.sqlite$/;

export type SqliteBackupVerification = {
  quickCheck: 'ok';
  tables: number;
  migrations: number;
};

export type SqliteBackupResult = {
  path: string;
  bytes: number;
  createdAt: string;
  removed: string[];
  verification: SqliteBackupVerification;
};

export function sqliteBackupFilename(now: Date): string {
  return `trading-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.sqlite`;
}

export function backupFilesToRemove(files: string[], keep: number): string[] {
  return files
    .filter((file) => BACKUP_RE.test(file))
    .sort((a, b) => b.localeCompare(a))
    .slice(Math.max(1, keep));
}

export function verifySqliteBackup(path: string): SqliteBackupVerification {
  const check = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const quickRows = check.pragma('quick_check') as Record<string, unknown>[];
    const quickCheck = String(Object.values(quickRows[0] ?? {})[0] ?? 'missing');
    if (quickCheck !== 'ok') throw new Error(`SQLite quick_check failed: ${quickCheck}`);
    const tables = check.prepare<[], { n: number }>(`
      SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).get()?.n ?? 0;
    const hasMigrations = check.prepare<[], { n: number }>(`
      SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
    `).get()?.n ?? 0;
    const migrations = hasMigrations
      ? check.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n ?? 0
      : 0;
    if (tables === 0) throw new Error('SQLite backup contains no application tables');
    return { quickCheck: 'ok', tables, migrations };
  } finally {
    check.close();
  }
}

export async function createVerifiedSqliteBackup(args: {
  sourcePath: string;
  backupDir: string;
  keep: number;
  now?: Date;
}): Promise<SqliteBackupResult> {
  const now = args.now ?? new Date();
  const keep = Math.max(1, Math.floor(args.keep));
  mkdirSync(args.backupDir, { recursive: true, mode: 0o700 });
  const filename = sqliteBackupFilename(now);
  const finalPath = join(args.backupDir, filename);
  const tempPath = join(args.backupDir, `.backup-${process.pid}-${Date.now()}.tmp`);
  const drillPath = join(args.backupDir, `.restore-drill-${process.pid}-${Date.now()}.sqlite`);
  let source: Database.Database | null = null;
  try {
    source = new Database(args.sourcePath, { readonly: true, fileMustExist: true });
    source.pragma('busy_timeout = 10000');
    await source.backup(tempPath);
    source.close();
    source = null;

    const verification = verifySqliteBackup(tempPath);
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, finalPath);

    copyFileSync(finalPath, drillPath);
    const restored = verifySqliteBackup(drillPath);
    if (restored.tables !== verification.tables || restored.migrations !== verification.migrations) {
      throw new Error('Restore drill schema counts differ from the backup');
    }
    rmSync(drillPath, { force: true });

    const files = readdirSync(args.backupDir);
    const removed = backupFilesToRemove(files, keep);
    for (const old of removed) rmSync(join(args.backupDir, old), { force: true });

    const result: SqliteBackupResult = {
      path: finalPath,
      bytes: statSync(finalPath).size,
      createdAt: now.toISOString(),
      removed,
      verification,
    };
    const manifestTemp = join(args.backupDir, '.latest.json.tmp');
    writeFileSync(manifestTemp, `${JSON.stringify({ ...result, path: basename(finalPath) })}\n`, { mode: 0o600 });
    renameSync(manifestTemp, join(args.backupDir, 'latest.json'));
    return result;
  } finally {
    source?.close();
    rmSync(tempPath, { force: true });
    rmSync(drillPath, { force: true });
  }
}

export function readBackupManifest(path: string): { createdAt: string; path: string; bytes: number } {
  return JSON.parse(readFileSync(path, 'utf8')) as { createdAt: string; path: string; bytes: number };
}

export function restoreVerifiedSqliteBackup(backupPath: string, destinationPath: string): SqliteBackupVerification {
  if (existsSync(destinationPath)) throw new Error(`Restore destination already exists: ${destinationPath}`);
  verifySqliteBackup(backupPath);
  mkdirSync(dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.restore-${process.pid}.tmp`;
  try {
    copyFileSync(backupPath, tempPath);
    const verification = verifySqliteBackup(tempPath);
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, destinationPath);
    return verification;
  } finally {
    rmSync(tempPath, { force: true });
  }
}
