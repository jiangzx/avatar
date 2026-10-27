import { createHash, randomBytes } from 'node:crypto';
import { safeEqual } from '../session/tokens.ts';

export interface AdminSession { id: string; actor: string; csrfToken: string; createdAt: number; lastSeenAt: number }
type Stored = Omit<AdminSession, 'id'>;

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const newSecret = () => randomBytes(32).toString('base64url');
const keyOf = (id: string) => createHash('sha256').update(id).digest('hex');

/** In-memory admin sessions keyed by SHA-256(id). Restart = log in again. */
export class AdminSessionStore {
  private readonly sessions = new Map<string, Stored>();
  private readonly now: () => number;

  constructor(private readonly opts: { idleMs: number; absoluteMs: number; now?: () => number }) {
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  create(actor: string): AdminSession {
    this.sweep();
    const id = newSecret();
    const at = this.now();
    const stored: Stored = { actor, csrfToken: newSecret(), createdAt: at, lastSeenAt: at };
    this.sessions.set(keyOf(id), stored);
    return { id, ...stored };
  }

  get(id: string): AdminSession | null {
    if (!SESSION_ID_PATTERN.test(id)) return null;
    const key = keyOf(id);
    const stored = this.sessions.get(key);
    if (!stored) return null;
    const at = this.now();
    if (at >= this.expiry(stored)) {
      this.sessions.delete(key);
      return null;
    }
    stored.lastSeenAt = at;
    return { id, ...stored };
  }

  destroy(id: string): void {
    if (SESSION_ID_PATTERN.test(id)) this.sessions.delete(keyOf(id));
  }

  idleExpiresAt(session: AdminSession): number {
    return this.expiry(session);
  }

  private expiry(s: Pick<Stored, 'createdAt' | 'lastSeenAt'>): number {
    return Math.min(s.lastSeenAt + this.opts.idleMs, s.createdAt + this.opts.absoluteMs);
  }

  private sweep(): void {
    const at = this.now();
    for (const [key, stored] of this.sessions) if (at >= this.expiry(stored)) this.sessions.delete(key);
  }
}

export function csrfMatches(session: AdminSession, header: string | string[] | undefined): boolean {
  return typeof header === 'string' && header.length > 0 && safeEqual(header, session.csrfToken);
}
