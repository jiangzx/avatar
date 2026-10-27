import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../log/logger.ts';

export function purgeOwnerLogs(db: DatabaseSync, oid: string): number {
  return Number(db.prepare('DELETE FROM log_events WHERE oid = ?').run(oid).changes);
}

/** The log sink batches writes: lines buffered before a delete can land after it. Sweep once more. */
export function scheduleLogPurge(db: DatabaseSync, oid: string, delayMs: number, logger: Logger): NodeJS.Timeout {
  const timer = setTimeout(() => {
    try {
      purgeOwnerLogs(db, oid);
    } catch {
      logger.error('admin_owner_log_purge_failed', {});
    }
  }, delayMs);
  timer.unref();
  return timer;
}
