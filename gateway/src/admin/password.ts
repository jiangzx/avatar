import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** Security parameters, not operator knobs. The encoded hash carries them, so old hashes keep verifying. */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keyLen: 32, saltLen: 16 } as const;
const MAXMEM = 64 * 1024 * 1024;
const MIN_N = 16384;
const MAX_N = 1 << 20;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface ParsedPasswordHash { N: number; r: number; p: number; salt: Buffer; hash: Buffer }

function derive(password: string, salt: Buffer, N: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Async: a sync scrypt would stall the realtime audio in this process for ~100 ms.
    scrypt(password, salt, keyLen, { N, r, p, maxmem: MAXMEM }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string, salt: Buffer = randomBytes(SCRYPT_PARAMS.saltLen)): Promise<string> {
  if (salt.length !== SCRYPT_PARAMS.saltLen) {
    throw new Error(`salt must be ${SCRYPT_PARAMS.saltLen} bytes`);
  }
  const { N, r, p, keyLen } = SCRYPT_PARAMS;
  const key = await derive(password, salt, N, r, p, keyLen);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Rejects weak parameters so a swapped env value cannot downgrade the hash. */
export function parsePasswordHash(encoded: string): ParsedPasswordHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  if (![n, r, p].every((v) => /^[1-9][0-9]{0,7}$/.test(v)) || !B64.test(salt) || !B64.test(hash)) return null;
  const N = Number(n);
  const parsed = { N, r: Number(r), p: Number(p), salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') };
  const powerOfTwo = (N & (N - 1)) === 0;
  if (!powerOfTwo || N < MIN_N || N > MAX_N) return null;
  if (parsed.r < 8 || parsed.r > 32 || parsed.p < 1 || parsed.p > 16) return null;
  // OpenSSL needs 128*r*(N + p + 2) bytes; 128*N*r alone would let a hash that can never derive pass.
  if (128 * parsed.r * (N + parsed.p + 2) > MAXMEM) return null;
  if (parsed.salt.length < SCRYPT_PARAMS.saltLen || parsed.hash.length !== SCRYPT_PARAMS.keyLen) return null;
  return parsed;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;
  let key: Buffer;
  try {
    key = await derive(password, parsed.salt, parsed.N, parsed.r, parsed.p, parsed.hash.length);
  } catch {
    return false;
  }
  return timingSafeEqual(key, parsed.hash);
}
