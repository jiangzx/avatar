import { createHash, randomBytes } from 'node:crypto';

/** 32 CSPRNG bytes, base64url (43 chars). Returned to the device once; never stored or logged. */
export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex of a device token: the only form that is persisted. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** First 8 hex chars of SHA-256(id): the only form of an agent id allowed in logs. */
export function shortHash(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 8);
}
