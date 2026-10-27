import type { DatabaseSync } from 'node:sqlite';

/** Deletes at most `limit` usage rows older than `olderThan`. Returns rows deleted; callers loop until < limit. */
export function purgeExpiredUsage(db: DatabaseSync, olderThan: number, limit: number): number {
  const result = db.prepare('DELETE FROM usage_events WHERE id IN (SELECT id FROM usage_events WHERE ts < ? ORDER BY id LIMIT ?)').run(olderThan, limit);
  return Number(result.changes);
}
