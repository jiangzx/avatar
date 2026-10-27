import { describe, expect, it } from 'vitest';
import { SCRYPT_PARAMS, hashPassword, parsePasswordHash, verifyPassword } from '../src/admin/password.ts';

describe('admin password', () => {
  it('round-trips and rejects a wrong password', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    expect(encoded).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('correct horse battery staple', encoded)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', encoded)).toBe(false);
    expect(await verifyPassword('', encoded)).toBe(false);
  });

  it('uses a fresh salt each time', async () => {
    const a = await hashPassword('same password here');
    const b = await hashPassword('same password here');
    expect(a).not.toBe(b);
  });

  it('is deterministic for a given salt', async () => {
    const salt = Buffer.alloc(SCRYPT_PARAMS.saltLen, 7);
    expect(await hashPassword('pw-0123456789', salt)).toBe(await hashPassword('pw-0123456789', salt));
  });

  it('refuses weak or malformed hashes', async () => {
    const salt = Buffer.alloc(16, 1).toString('base64');
    const hash = Buffer.alloc(32, 2).toString('base64');
    for (const bad of [
      'plain',
      `bcrypt$32768$8$1$${salt}$${hash}`,
      `scrypt$1024$8$1$${salt}$${hash}`,          // N too small
      `scrypt$30000$8$1$${salt}$${hash}`,         // N not a power of two
      `scrypt$32768$4$1$${salt}$${hash}`,         // r too small
      `scrypt$32768$8$0$${salt}$${hash}`,         // p too small
      `scrypt$32768$8$1$${Buffer.alloc(8).toString('base64')}$${hash}`, // short salt
      `scrypt$32768$8$1$${salt}$${Buffer.alloc(16).toString('base64')}`, // short hash
      `scrypt$2097152$8$1$${salt}$${hash}`,       // N above the memory cap
    ]) {
      expect(parsePasswordHash(bad)).toBeNull();
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });
});
