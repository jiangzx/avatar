import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { guardFields } from '../log/fieldGuard.ts';
import type { LogFields, Logger } from '../log/logger.ts';

export type AdminAuditAction =
  | 'login_succeeded' | 'login_failed' | 'logout'
  | 'config_published' | 'config_rolled_back' | 'config_reset'
  | 'secret_updated' | 'secret_revealed' | 'price_added'
  | 'owner_banned' | 'owner_unbanned' | 'owner_deleted' | 'log_level_changed';

export interface AdminAuditEntry { actor: string; action: AdminAuditAction; target?: string | null; detail?: LogFields }

/** Content-free audit trail. Kept for auditDays; owner deletion does not remove it (spec Q35). */
export class AdminAudit {
  private readonly insert: StatementSync;

  constructor(db: DatabaseSync, private readonly logger: Logger, private readonly now: () => number = Date.now) {
    this.insert = db.prepare('INSERT INTO admin_audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)');
  }

  record(entry: AdminAuditEntry): void {
    const { fields, rejected } = guardFields(entry.action, entry.detail ?? {}, false);
    if (rejected.length > 0) this.logger.warn('admin_audit_field_rejected', { action: entry.action, count: rejected.length });
    try {
      this.insert.run(this.now(), entry.actor, entry.action, entry.target ?? null, JSON.stringify(fields));
    } catch {
      // The action already happened; say so loudly instead of failing the request.
      this.logger.error('admin_audit_failed', { action: entry.action });
      return;
    }
    this.logger.info('admin_audit', { action: entry.action });
  }
}

export function expireAdminAudit(db: DatabaseSync, olderThan: number): number {
  return Number(db.prepare('DELETE FROM admin_audit WHERE ts < ?').run(olderThan).changes);
}
