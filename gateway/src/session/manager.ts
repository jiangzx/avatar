import { randomUUID } from 'node:crypto';
import type { SessionTokens } from '@anyidea/protocol';
import { log } from '../log.ts';
import type { SessionContext } from './context.ts';
import type { Session, Transport } from './session.ts';
import { TokenStore } from './tokens.ts';

/**
 * Session lifetime hooks. Plan B persists start/end (sessions table); Plan C runs end-of-session
 * work here, e.g. early extraction on 'owner_replaced'. Exceptions are caught and logged.
 */
export interface SessionLifecycle {
  /** The model session started (session.start succeeded). */
  started(sessionId: string, ctx: SessionContext): void;
  /** A started session was destroyed: client_end | grace_expired | owner_replaced | owner_deleted | shutdown. */
  ended(sessionId: string, ctx: SessionContext, reason: string): void;
}

interface Entry {
  session: Session;
  ctx: SessionContext;
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
    private readonly makeSession: (ctx: SessionContext, sessionId: string, noticePending?: boolean) => Session,
    private readonly graceMs = 60_000,
    /** Matches the connect token TTL: a session nobody connects to is dropped. */
    private readonly unclaimedMs = 5 * 60_000,
    private readonly startTimeoutMs = 10_000,
    private readonly lifecycle?: SessionLifecycle,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  /**
   * Invariant: an owner has at most one session. A new one ends the owner's previous session
   * first, whether it is live, in its reconnect grace period, or never claimed.
   */
  create(ctx: SessionContext, noticePending = false): SessionTokens {
    if (ctx.ownerId !== undefined) this.endOwner(ctx.ownerId, 'owner_replaced');
    const sessionId = randomUUID();
    // claim() clears this timer, like the disconnect grace timer.
    const grace = setTimeout(() => this.destroy(sessionId, 'unclaimed'), this.unclaimedMs);
    this.sessions.set(sessionId, { session: this.makeSession(ctx, sessionId, noticePending), ctx, started: false, starting: false, connId: 0, terminate: null, grace });
    log('session_created', { sessions: this.sessions.size });
    return this.tokens.issue(sessionId);
  }

  /** Ends every session of one owner and drops its socket. Returns how many were ended. */
  endOwner(ownerId: string, reason: string): number {
    let ended = 0;
    for (const [sessionId, entry] of [...this.sessions]) {
      if (entry.ctx.ownerId !== ownerId) continue;
      const terminate = entry.terminate;
      entry.session.flush();
      this.destroy(sessionId, reason);
      terminate?.(); // the socket's close event then finds no entry and is ignored
      ended++;
    }
    return ended;
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
        this.notify(() => this.lifecycle?.started(sessionId, current.ctx));
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
    entry.session.flush();
    entry.session.end();
    this.tokens.revoke(sessionId);
    this.sessions.delete(sessionId);
    if (entry.started) this.notify(() => this.lifecycle?.ended(sessionId, entry.ctx, reason));
    log('session_destroyed', { reason, sessions: this.sessions.size });
  }

  /** Lifecycle hooks must never break the session flow. */
  private notify(hook: () => void): void {
    try {
      hook();
    } catch {
      log('session_lifecycle_failed', {});
    }
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
