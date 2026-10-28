import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SecretStoreReadonlyError, SecretValueInvalidError, SqliteSecretStore, isSecretName, parseMasterKey,
} from '../src/config-store/secrets.ts';
import { createLogLevelControl } from '../src/log/levels.ts';
import { createLogger, type LogLine } from '../src/log/logger.ts';
import { openDatabase } from '../src/memory/db.ts';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const VALUE = 'sk-test-abcdefghijklmnop1234';
let db: DatabaseSync;
let lines: LogLine[];
let clock = 5_000;

function logger() {
  return createLogger({ sinks: [{ write: (line) => lines.push(line) }], levels: createLogLevelControl('debug'), strict: true });
}
function store(masterKey: Buffer | null = KEY, env: { DASHSCOPE_API_KEY?: string } = { DASHSCOPE_API_KEY: 'env-key-00001111' }) {
  return new SqliteSecretStore({ db, masterKey, env, logger: logger(), now: () => clock });
}

beforeEach(() => { db = openDatabase(':memory:', { busyTimeoutMs: 1000 }); lines = []; clock = 5_000; });
afterEach(() => { if (db.isOpen) db.close(); });

describe('parseMasterKey', () => {
  it('accepts exactly 32 bytes of canonical base64 and treats empty as absent', () => {
    expect(parseMasterKey(undefined)).toBeNull();
    expect(parseMasterKey('')).toBeNull();
    expect(parseMasterKey(KEY.toString('base64'))!.equals(KEY)).toBe(true);
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow('ADMIN_SECRET_KEY must be 32 bytes, base64');
    expect(() => parseMasterKey('not base64 !!')).toThrow('ADMIN_SECRET_KEY must be 32 bytes, base64');
  });
});

describe('SqliteSecretStore', () => {
  it('falls back to env until the admin saves a key', () => {
    const s = store();
    expect(s.resolve('DASHSCOPE_API_KEY')).toBe('env-key-00001111');
    expect(s.info('DASHSCOPE_API_KEY')).toEqual({ name: 'DASHSCOPE_API_KEY', source: 'env', last4: '1111', updatedAt: null, writable: true });
  });

  it('reports missing when neither the admin nor env has a key', () => {
    expect(store(KEY, {}).info('DASHSCOPE_API_KEY')).toEqual({ name: 'DASHSCOPE_API_KEY', source: 'missing', last4: null, updatedAt: null, writable: true });
  });

  it('encrypts on put and serves the new value', () => {
    const s = store();
    clock = 6_000;
    expect(s.put('DASHSCOPE_API_KEY', VALUE, 'admin')).toEqual({ name: 'DASHSCOPE_API_KEY', source: 'admin', last4: '1234', updatedAt: 6_000, writable: true });
    expect(s.resolve('DASHSCOPE_API_KEY')).toBe(VALUE);
    const row = db.prepare('SELECT ciphertext, iv, tag, last4, actor FROM secrets WHERE name = ?').get('DASHSCOPE_API_KEY') as { ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array; last4: string; actor: string };
    expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain('abcdefgh');
    expect(row.iv.length).toBe(12);
    expect(row.tag.length).toBe(16);
    expect(row.last4).toBe('1234');
    expect(row.actor).toBe('admin');
  });

  it('uses a fresh IV for every write and bumps the version', () => {
    const s = store();
    expect(s.version()).toBe(0);
    s.put('DASHSCOPE_API_KEY', VALUE, 'admin');
    const first = (db.prepare('SELECT iv FROM secrets').get() as { iv: Uint8Array }).iv;
    s.put('DASHSCOPE_API_KEY', VALUE, 'admin');
    const second = (db.prepare('SELECT iv FROM secrets').get() as { iv: Uint8Array }).iv;
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
    expect(s.version()).toBe(2);
  });

  it('decrypts after a restart with the same master key', () => {
    store().put('DASHSCOPE_API_KEY', VALUE, 'admin');
    expect(store().resolve('DASHSCOPE_API_KEY')).toBe(VALUE);
  });

  it('falls back to env and logs only the name when decryption fails', () => {
    store().put('DASHSCOPE_API_KEY', VALUE, 'admin');
    lines = [];
    const wrong = store(OTHER_KEY);
    expect(wrong.resolve('DASHSCOPE_API_KEY')).toBe('env-key-00001111');
    expect(lines.map((l) => [l.level, l.event, l.fields])).toEqual([['error', 'secret_decrypt_failed', { name: 'DASHSCOPE_API_KEY' }]]);
    db.prepare('UPDATE secrets SET ciphertext = ?').run(Buffer.from('tampered-bytes'));
    expect(store().resolve('DASHSCOPE_API_KEY')).toBe('env-key-00001111');
  });

  it('is read-only without a master key and ignores stored rows', () => {
    store().put('DASHSCOPE_API_KEY', VALUE, 'admin');
    const s = store(null);
    expect(s.writable()).toBe(false);
    expect(s.resolve('DASHSCOPE_API_KEY')).toBe('env-key-00001111');
    expect(s.info('DASHSCOPE_API_KEY').writable).toBe(false);
    expect(() => s.put('DASHSCOPE_API_KEY', VALUE, 'admin')).toThrow(SecretStoreReadonlyError);
  });

  it('rejects values that are not 8-256 printable ASCII characters', () => {
    const s = store();
    for (const bad of ['short', 'has space inside', 'x'.repeat(257), '中文密钥中文密钥中文', `${VALUE}\n`]) {
      expect(() => s.put('DASHSCOPE_API_KEY', bad, 'admin'), bad).toThrow(SecretValueInvalidError);
    }
  });

  it('never writes key material to logs', () => {
    const s = store();
    s.put('DASHSCOPE_API_KEY', VALUE, 'admin');
    s.resolve('DASHSCOPE_API_KEY');
    expect(JSON.stringify(lines)).not.toContain('abcdefgh');
  });

  it('knows its secret names', () => {
    expect(isSecretName('DASHSCOPE_API_KEY')).toBe(true);
    expect(isSecretName('SEEDUPLEX_API_KEY')).toBe(false);
  });
});
