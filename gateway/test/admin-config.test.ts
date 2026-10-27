import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminConfigSchema, loadAdminConfig } from '../src/log/adminConfig.ts';

const shipped = fileURLToPath(new URL('../config/admin.json', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function file(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'admin-config-'));
  dirs.push(dir);
  const path = join(dir, 'admin.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

const valid = { retention: { usageDays: 180, logDays: 7, auditDays: 365 }, logSink: { flushMs: 1000, maxBatch: 200 } };

describe('admin config', () => {
  it('ships the agreed retention and sink values', () => {
    expect(loadAdminConfig(shipped)).toEqual(valid);
  });

  it('rejects unknown keys', () => {
    expect(() => loadAdminConfig(file({ ...valid, extra: 1 }))).toThrow();
    expect(() => loadAdminConfig(file({ ...valid, retention: { ...valid.retention, chatDays: 1 } }))).toThrow();
  });

  it('rejects out-of-range values', () => {
    expect(() => AdminConfigSchema.parse({ ...valid, retention: { ...valid.retention, logDays: 0 } })).toThrow();
    expect(() => AdminConfigSchema.parse({ ...valid, retention: { ...valid.retention, logDays: 91 } })).toThrow();
    expect(() => AdminConfigSchema.parse({ ...valid, logSink: { flushMs: 50, maxBatch: 200 } })).toThrow();
    expect(() => AdminConfigSchema.parse({ ...valid, logSink: { flushMs: 1000, maxBatch: 0 } })).toThrow();
    expect(() => AdminConfigSchema.parse({ ...valid, retention: { ...valid.retention, usageDays: 1.5 } })).toThrow();
  });
});
