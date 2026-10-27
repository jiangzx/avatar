import { describe, expect, it } from 'vitest';
import { AdminAudit, expireAdminAudit } from '../src/admin/audit.ts';
import { createLogLevelControl } from '../src/log/levels.ts';
import { createLogger, type LogLine } from '../src/log/logger.ts';
import { openDatabase } from '../src/memory/db.ts';

function setup(now = 5_000) {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  const lines: LogLine[] = [];
  const logger = createLogger({ sinks: [{ write: (l) => lines.push(l) }], levels: createLogLevelControl('info'), strict: false });
  return { db, lines, audit: new AdminAudit(db, logger, () => now) };
}

describe('AdminAudit', () => {
  it('writes one content-free row and one log line', () => {
    const { db, lines, audit } = setup();
    audit.record({ actor: 'admin', action: 'owner_banned', target: 'abcdef012345', detail: { sessionsEnded: 1 } });
    expect(db.prepare('SELECT ts, actor, action, target, detail FROM admin_audit').all()).toEqual([
      { ts: 5_000, actor: 'admin', action: 'owner_banned', target: 'abcdef012345', detail: '{"sessionsEnded":1}' },
    ]);
    expect(lines.map((l) => [l.event, l.fields.action])).toContainEqual(['admin_audit', 'owner_banned']);
  });

  it('drops banned detail fields and says so', () => {
    const { db, lines, audit } = setup();
    audit.record({ actor: 'admin', action: 'config_published', detail: { promptText: 'secret words', changed: 2 } });
    const row = db.prepare('SELECT detail FROM admin_audit').get() as { detail: string };
    expect(JSON.parse(row.detail)).toEqual({ changed: 2 });
    expect(lines.some((l) => l.event === 'admin_audit_field_rejected' && l.fields.count === 1)).toBe(true);
  });

  it('expires rows older than the cutoff', () => {
    const { db } = setup();
    const insert = db.prepare("INSERT INTO admin_audit (ts, actor, action, target, detail) VALUES (?, 'admin', 'logout', NULL, '{}')");
    insert.run(100);
    insert.run(200);
    insert.run(300);
    expect(expireAdminAudit(db, 250)).toBe(2);
    expect((db.prepare('SELECT ts FROM admin_audit').all() as Array<{ ts: number }>).map((r) => r.ts)).toEqual([300]);
  });
});
