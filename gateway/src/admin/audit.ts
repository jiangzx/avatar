import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { AdminAuditRow, AdminPage } from '@anyidea/protocol';
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

export function listAudit(db: DatabaseSync, f: { action: string | null; from: number; to: number; cursor: number | null; limit: number }): AdminPage<AdminAuditRow> {
  const rows = db.prepare(`SELECT id, ts, actor, action, target, detail FROM admin_audit
    WHERE ($action IS NULL OR action = $action) AND ts >= $from AND ts < $to AND ($cursor IS NULL OR id < $cursor)
    ORDER BY id DESC LIMIT $limit`).all({ action: f.action, from: f.from, to: f.to, cursor: f.cursor, limit: f.limit + 1 }) as Array<Record<string, unknown>>;
  const items: AdminAuditRow[] = rows.slice(0, f.limit).map((r) => {
    let detail: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(String(r.detail)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>;
    } catch {
      // keep {}
    }
    return { id: Number(r.id), ts: Number(r.ts), actor: String(r.actor), action: String(r.action), target: (r.target as string | null) ?? null, detail };
  });
  return { items, nextCursor: rows.length > f.limit ? String(items.at(-1)!.id) : null };
}
