import { createHash } from 'node:crypto';

/** Stable, non-reversible owner label for logs and the admin console: sha256 hex, first 12 chars. */
export function ownerShortId(ownerId: string): string {
  return createHash('sha256').update(ownerId).digest('hex').slice(0, 12);
}
