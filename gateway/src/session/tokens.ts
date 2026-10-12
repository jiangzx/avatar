import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { SessionTokens } from '@anyidea/protocol';

const newToken = () => randomBytes(24).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface ConnectEntry {
  sessionId: string;
  expiresAt: number;
}

export class TokenStore {
  private readonly connect = new Map<string, ConnectEntry>();
  private readonly resume = new Map<string, string>();

  constructor(
    private readonly connectTtlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(sessionId: string): SessionTokens {
    const connectToken = newToken();
    const resumeToken = newToken();
    this.connect.set(connectToken, { sessionId, expiresAt: this.now() + this.connectTtlMs });
    this.resume.set(sessionId, resumeToken);
    return { sessionId, connectToken, resumeToken };
  }

  /** One-time use. Returns the session id or null. */
  consumeConnect(token: string): string | null {
    const entry = this.connect.get(token);
    this.connect.delete(token);
    if (!entry || entry.expiresAt < this.now()) return null;
    return entry.sessionId;
  }

  /** Validates and rotates the resume token; the old one stops working. */
  rotate(sessionId: string, resumeToken: string): SessionTokens | null {
    const current = this.resume.get(sessionId);
    if (!current || !safeEqual(current, resumeToken)) return null;
    return this.issue(sessionId);
  }

  revoke(sessionId: string): void {
    this.resume.delete(sessionId);
    for (const [token, entry] of this.connect) if (entry.sessionId === sessionId) this.connect.delete(token);
  }
}
