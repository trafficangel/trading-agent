import { dirname, join, resolve } from 'node:path';
import { config } from '../config.js';
import { createVerifiedSqliteBackup } from '../lib/sqlite-backup.js';
import { logger } from '../lib/logger.js';

const sourcePath = resolve(config.DB_PATH);
const backupDir = resolve(process.env.DB_BACKUP_DIR ?? join(dirname(sourcePath), 'backups'));
const parsedKeep = Number(process.env.DB_BACKUP_KEEP ?? 12);
const keep = Number.isFinite(parsedKeep) ? Math.max(1, Math.floor(parsedKeep)) : 12;

try {
  const result = await createVerifiedSqliteBackup({ sourcePath, backupDir, keep });
  logger.info({
    sourcePath,
    backup: result.path,
    mb: +(result.bytes / 1024 / 1024).toFixed(1),
    keep,
    removed: result.removed.length,
    tables: result.verification.tables,
    migrations: result.verification.migrations,
  }, 'sqlite backup and restore drill complete');
} catch (err) {
  logger.fatal({ err, sourcePath, backupDir }, 'sqlite backup or restore drill failed');
  process.exitCode = 1;
}
