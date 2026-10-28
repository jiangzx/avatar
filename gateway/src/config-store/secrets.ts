import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../log/logger.ts';

export const SECRET_NAMES = ['DASHSCOPE_API_KEY'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export type SecretSource = 'admin' | 'env' | 'missing';
export interface SecretInfo { name: SecretName; source: SecretSource; last4: string | null; updatedAt: number | null; writable: boolean }

export class SecretStoreReadonlyError extends Error {
  constructor() { super('secret_store_readonly'); }
}
export class SecretValueInvalidError extends Error {
  constructor() { super('secret_value_invalid'); }
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
/** Printable ASCII without spaces, 8-256 chars: what provider API keys look like. */
const SECRET_VALUE = /^[\x21-\x7e]{8,256}$/;

/** ADMIN_SECRET_KEY: 32 random bytes, base64 (`openssl rand -base64 32`). Empty = key management is read-only. */
export function parseMasterKey(raw: string | undefined): Buffer | null {
  if (raw === undefined || raw === '') return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) throw new Error('ADMIN_SECRET_KEY must be 32 bytes, base64');
  return key;
}

export function isSecretName(value: string): value is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(value);
}

interface Row { name: string; ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array; last4: string; updated_at: number }

/** Provider keys saved from the admin page, encrypted at rest. Env stays the fallback. */
export class SqliteSecretStore {
  private readonly values = new Map<SecretName, { value: string; updatedAt: number }>();
  private readonly now: () => number;
  private counter = 0;

  constructor(private readonly opts: { db: DatabaseSync; masterKey: Buffer | null; env: Partial<Record<SecretName, string>>; logger: Logger; now?: () => number }) {
    this.now = opts.now ?? Date.now;
    // Without the master key stored rows cannot be read; env values keep the gateway running.
    if (!opts.masterKey) return;
    const rows = opts.db.prepare('SELECT name, ciphertext, iv, tag, last4, updated_at FROM secrets').all() as unknown as Row[];
    for (const row of rows) {
      if (!isSecretName(row.name)) continue;
      try {
        this.values.set(row.name, { value: decrypt(opts.masterKey, row), updatedAt: row.updated_at });
      } catch {
        // A wrong master key or a tampered row: name only, never ciphertext or plaintext.
        opts.logger.error('secret_decrypt_failed', { name: row.name });
      }
    }
  }

  writable(): boolean { return this.opts.masterKey !== null; }
  version(): number { return this.counter; }

  resolve(name: SecretName): string | undefined {
    const stored = this.values.get(name);
    if (stored) return stored.value;
    const env = this.opts.env[name];
    return env ? env : undefined;
  }

  info(name: SecretName): SecretInfo {
    const stored = this.values.get(name);
    if (stored) return { name, source: 'admin', last4: stored.value.slice(-4), updatedAt: stored.updatedAt, writable: this.writable() };
    const env = this.opts.env[name];
    return { name, source: env ? 'env' : 'missing', last4: env ? env.slice(-4) : null, updatedAt: null, writable: this.writable() };
  }

  put(name: SecretName, value: string, actor: string): SecretInfo {
    const key = this.opts.masterKey;
    if (!key) throw new SecretStoreReadonlyError();
    if (!SECRET_VALUE.test(value)) throw new SecretValueInvalidError();
    const iv = randomBytes(IV_BYTES); // fresh per write: never reuse a GCM nonce
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(name, 'utf8')); // ciphertext is bound to its secret name
    const plain = Buffer.from(value, 'utf8');
    let ciphertext: Buffer;
    try {
      ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    } finally {
      plain.fill(0);
    }
    const tag = cipher.getAuthTag();
    const updatedAt = this.now();
    this.opts.db.prepare(`INSERT INTO secrets (name, ciphertext, iv, tag, last4, updated_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
      last4 = excluded.last4, updated_at = excluded.updated_at, actor = excluded.actor`)
      .run(name, ciphertext, iv, tag, value.slice(-4), updatedAt, actor);
    this.values.set(name, { value, updatedAt });
    this.counter++;
    return this.info(name);
  }
}

/** AES-256-GCM. final() throws on a wrong key or tampered row; every plaintext buffer is zeroed either way. */
function decrypt(key: Buffer, row: Row): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(row.iv));
  decipher.setAAD(Buffer.from(row.name, 'utf8'));
  decipher.setAuthTag(Buffer.from(row.tag));
  const parts: Buffer[] = [];
  let merged: Buffer | undefined;
  try {
    parts.push(decipher.update(Buffer.from(row.ciphertext)));
    parts.push(decipher.final());
    merged = Buffer.concat(parts);
    return merged.toString('utf8');
  } finally {
    for (const part of parts) part.fill(0);
    merged?.fill(0);
  }
}
