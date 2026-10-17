import { randomUUID } from 'node:crypto';
import type { SessionTokens } from '@anyidea/protocol';
import { log } from '../log.ts';
import type { SessionContext } from './context.ts';
import type { Session, Transport } from './session.ts';
import { TokenStore } from './tokens.ts';

interface Entry {
  session: Session;
  started: boolean;
  starting: boolean;
  /** Id of the newest WS connection; 0 = none. Events from older connections are ignored. */
  connId: number;
  /** Drops the current socket when a newer connection supersedes it. */
  terminate: (() => void) | null;
  grace: NodeJS.Timeout | null;
}

export class SessionManager {
  readonly tokens = new TokenStore();
  private readonly sessions = new Map<string, Entry>();
  private nextConnId = 0;

  constructor(
    private readonly makeSession: (ctx: SessionContext) => Session,
    private readonly graceMs = 60_000,
    /** Matches the connect token TTL: a session nobody connects to is dropped. */
    private readonly unclaimedMs = 5 * 60_000,
    private readonly startTimeoutMs = 10_000,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  create(ctx: SessionContext): SessionTokens {
    const sessionId = randomUUID();
    // claim() clears this timer, like the disconnect grace timer.
    const grace = setTimeout(() => this.destroy(sessionId, 'unclaimed'), this.unclaimedMs);
    this.sessions.set(sessionId, { session: this.makeSession(ctx), started: false, starting: false, connId: 0, terminate: null, grace });
    log('session_created', { sessions: this.sessions.size });
    return this.tokens.issue(sessionId);
  }

  resume(sessionId: string, resumeToken: string): SessionTokens | null {
    if (!this.sessions.has(sessionId)) return null;
    return this.tokens.rotate(sessionId, resumeToken);
  }

  /**
   * A WS connection presents a (one-time) connect token. The newest connection always wins:
   * after a network change the previous socket may still look open here (half-open TCP).
   */
  claim(connectToken: string): { sessionId: string; connId: number } | null {
    const sessionId = this.tokens.consumeConnect(connectToken);
    if (!sessionId) return null;
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    if (entry.grace) {
      clearTimeout(entry.grace);
      entry.grace = null;
    }
    if (entry.connId !== 0) {
      const terminate = entry.terminate;
      entry.terminate = null;
      if (entry.started) entry.session.detachTransport();
      terminate?.();
      log('connection_superseded', {});
    }
    entry.connId = ++this.nextConnId;
    return { sessionId, connId: entry.connId };
  }

  attachSocket(sessionId: string, connId: number, terminate: () => void): void {
    const entry = this.sessions.get(sessionId);
    if (entry && entry.connId === connId) entry.terminate = terminate;
  }

  async begin(sessionId: string, connId: number, kind: 'start' | 'resume', transport: Transport): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.connId !== connId) return false;
    if (kind === 'start') {
      if (entry.started || entry.starting) return false;
      entry.starting = true;
      try {
        await this.startWithTimeout(entry.session, transport);
        const current = this.sessions.get(sessionId);
        if (!current) return false;
        current.started = true;
        if (current.connId !== connId) {
          current.session.detachTransport();
          return false;
        }
        transport.send({ type: 'session.ready', sessionId });
        return true;
      } catch (error) {
        this.destroy(sessionId, 'start_failed');
        throw error;
      } finally {
        entry.starting = false;
      }
    }
    if (!entry.started) return false;
    entry.session.attachTransport(transport);
    log('session_resumed', {});
    return true;
  }

  /** The session, but only for its current connection. */
  route(sessionId: string, connId: number): Session | null {
    const entry = this.sessions.get(sessionId);
    return entry && entry.connId === connId ? entry.session : null;
  }

  disconnected(sessionId: string, connId: number): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.connId !== connId) return; // unknown session or an older, superseded socket
    entry.connId = 0;
    entry.terminate = null;
    if (entry.started) entry.session.detachTransport();
    if (entry.grace) clearTimeout(entry.grace);
    entry.grace = setTimeout(() => this.destroy(sessionId, 'grace_expired'), this.graceMs);
  }

  end(sessionId: string): void {
    this.destroy(sessionId, 'client_end');
  }

  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.destroy(id, 'shutdown');
  }

  private destroy(sessionId: string, reason: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.grace) clearTimeout(entry.grace);
    entry.session.end();
    this.tokens.revoke(sessionId);
    this.sessions.delete(sessionId);
    log('session_destroyed', { reason, sessions: this.sessions.size });
  }

  private async startWithTimeout(session: Session, transport: Transport): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        session.start(transport),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('session_start_timeout')), this.startTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
