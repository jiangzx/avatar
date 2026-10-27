import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminConfigSchema, loadAdminConfig, loadAdminEnv } from '../src/log/adminConfig.ts';

const ADMIN_JSON = fileURLToPath(new URL('../config/admin.json', import.meta.url));
const shipped = () => JSON.parse(readFileSync(ADMIN_JSON, 'utf8')) as Record<string, unknown>;
const HASH = `scrypt$32768$8$1$${Buffer.alloc(16, 1).toString('base64')}$${Buffer.alloc(32, 2).toString('base64')}`;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function file(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'admin-config-'));
  dirs.push(dir);
  const path = join(dir, 'admin.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

// Full P1+P2 shape shipped in gateway/config/admin.json.
const valid = {
  retention: { usageDays: 180, logDays: 7, auditDays: 365 },
  logSink: { flushMs: 1000, maxBatch: 200 },
  usageSink: { flushMs: 1000, maxBatch: 100 },
  session: { idleMs: 1_800_000, absoluteMs: 43_200_000 },
  login: { maxFailures: 5, windowMs: 900_000, lockMs: 900_000 },
  alerts: { errorRate1h: 0.1, firstAudioP95Ms: 2000, minSamples: 5 },
  logLevelOverrideMs: 1_800_000,
  banCloseDelayMs: 250,
};

describe('admin.json', () => {
  it('ships the agreed defaults', () => {
    const config = loadAdminConfig(ADMIN_JSON);
    expect(config).toEqual(valid);
    // P1 values must stay unchanged.
    expect(config.retention).toEqual({ usageDays: 180, logDays: 7, auditDays: 365 });
    expect(config.logSink).toEqual({ flushMs: 1000, maxBatch: 200 });
    expect(config.usageSink).toEqual({ flushMs: 1000, maxBatch: 100 });
    // P2 additions.
    expect(config.session).toEqual({ idleMs: 1_800_000, absoluteMs: 43_200_000 });
    expect(config.login).toEqual({ maxFailures: 5, windowMs: 900_000, lockMs: 900_000 });
    expect(config.alerts).toEqual({ errorRate1h: 0.1, firstAudioP95Ms: 2000, minSamples: 5 });
    expect(config.logLevelOverrideMs).toBe(1_800_000);
    expect(config.banCloseDelayMs).toBe(250);
  });

  it('rejects unknown keys', () => {
    expect(() => loadAdminConfig(file({ ...valid, extra: 1 }))).toThrow();
    expect(() => loadAdminConfig(file({ ...valid, retention: { ...valid.retention, chatDays: 1 } }))).toThrow();
    expect(AdminConfigSchema.safeParse({ ...shipped(), extra: 1 }).success).toBe(false);
    expect(AdminConfigSchema.safeParse({ ...shipped(), login: { ...valid.login, extra: 1 } }).success).toBe(false);
  });

  it('rejects out-of-range values', () => {
    // P1 constraints.
    expect(() => AdminConfigSchema.parse({ ...valid, retention: { ...valid.retention, logDays: 0 } })).toThrow();
    expect(() => AdminConfigSchema.parse({ ...valid, retention: { ...valid.retention, logDays: 91 } })).toThrow();
    expect(() => AdminConfigSchema.parse({ ...valid, logSink: { flushMs: 50, maxBatch: 200 } })).toThrow();
    expect(() => AdminConfigSchema.parse({ ...valid, logSink: { flushMs: 1000, maxBatch: 0 } })).toThrow();
    expect(() => AdminConfigSchema.parse({ ...valid, usageSink: { flushMs: 1000, maxBatch: 0 } })).toThrow();
    expect(() => AdminConfigSchema.parse({ ...valid, retention: { ...valid.retention, usageDays: 1.5 } })).toThrow();
    // P2 constraints.
    const badAlerts = { ...shipped(), alerts: { errorRate1h: 1.5, firstAudioP95Ms: 2000, minSamples: 5 } };
    expect(AdminConfigSchema.safeParse(badAlerts).success).toBe(false);
    const badLogin = { ...shipped(), login: { maxFailures: 0, windowMs: 900_000, lockMs: 900_000 } };
    expect(AdminConfigSchema.safeParse(badLogin).success).toBe(false);
    expect(AdminConfigSchema.safeParse({ ...shipped(), banCloseDelayMs: 5_001 }).success).toBe(false);
    expect(AdminConfigSchema.safeParse({ ...shipped(), logLevelOverrideMs: 0 }).success).toBe(false);
  });

  it('requires the absolute session limit to cover the idle limit', () => {
    const bad = { ...shipped(), session: { idleMs: 3_600_000, absoluteMs: 1_800_000 } };
    const result = AdminConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('absoluteMs');
  });
});

describe('loadAdminEnv', () => {
  it('is disabled without ADMIN_PORT', () => {
    expect(loadAdminEnv({ ADMIN_PASSWORD_HASH: HASH })).toEqual({ enabled: false, reason: 'admin_port_unset' });
  });

  it('rejects a bad port', () => {
    for (const port of ['0', '80', '65536', 'abc', '8788.5']) {
      expect(loadAdminEnv({ ADMIN_PORT: port, ADMIN_PASSWORD_HASH: HASH })).toEqual({ enabled: false, reason: 'admin_port_invalid' });
    }
  });

  it('requires a well-formed password hash', () => {
    expect(loadAdminEnv({ ADMIN_PORT: '8788' })).toEqual({ enabled: false, reason: 'admin_password_hash_unset' });
    expect(loadAdminEnv({ ADMIN_PORT: '8788', ADMIN_PASSWORD_HASH: 'plain-password' })).toEqual({ enabled: false, reason: 'admin_password_hash_invalid' });
    const weak = `scrypt$1024$8$1$${Buffer.alloc(16, 1).toString('base64')}$${Buffer.alloc(32, 2).toString('base64')}`;
    expect(loadAdminEnv({ ADMIN_PORT: '8788', ADMIN_PASSWORD_HASH: weak })).toEqual({ enabled: false, reason: 'admin_password_hash_invalid' });
    // Parses under the naive 128*N*r cap but exceeds what scrypt can derive with maxmem = 64 MiB.
    const atCap = `scrypt$65536$8$1$${Buffer.alloc(16, 1).toString('base64')}$${Buffer.alloc(32, 2).toString('base64')}`;
    expect(loadAdminEnv({ ADMIN_PORT: '8788', ADMIN_PASSWORD_HASH: atCap })).toEqual({ enabled: false, reason: 'admin_password_hash_invalid' });
  });

  it('accepts a valid pair', () => {
    expect(loadAdminEnv({ ADMIN_PORT: '8788', ADMIN_PASSWORD_HASH: HASH })).toEqual({ enabled: true, port: 8788, passwordHash: HASH });
  });
});
