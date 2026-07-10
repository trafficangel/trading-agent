import { resolve } from 'node:path';
import { config } from '../config.js';
import { restoreVerifiedSqliteBackup } from '../lib/sqlite-backup.js';
import { logger } from '../lib/logger.js';

const [backupArg, destinationArg] = process.argv.slice(2);
if (!backupArg || !destinationArg) {
  logger.fatal('usage: sqlite-restore <backup.sqlite> <new-destination.sqlite>');
  process.exitCode = 2;
} else {
  const backupPath = resolve(backupArg);
  const destinationPath = resolve(destinationArg);
  const livePath = resolve(config.DB_PATH);
  if (destinationPath === livePath) {
    logger.fatal({ destinationPath }, 'refusing to overwrite the configured live DB; restore to a new file first');
    process.exitCode = 2;
  } else {
    try {
      const verification = restoreVerifiedSqliteBackup(backupPath, destinationPath);
      logger.info({ backupPath, destinationPath, ...verification }, 'verified SQLite restore complete');
    } catch (err) {
      logger.fatal({ err, backupPath, destinationPath }, 'SQLite restore failed');
      process.exitCode = 1;
    }
  }
}
