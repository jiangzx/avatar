import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { DEFAULT_CHARACTER_ID, FRAME_AI, FRAME_MIC, MIC_FRAME_SAMPLES, decodeAudioFrame, encodeAudioFrame } from '@anyidea/protocol';
import type { IdentityService } from '../identity/registry.ts';
import { log } from '../log.ts';
import type { ContextResolver } from '../session/context.ts';
import type { SessionManager } from '../session/manager.ts';
import type { Transport } from '../session/session.ts';
import { safeEqual } from '../session/tokens.ts';
import { OwnerIdSchema, RegisterRequestSchema, ResumeRequestSchema, SessionCreateSchema, parseClientMessage } from './schemas.ts';

export interface GatewayServerOptions {
  manager: SessionManager;
  appSecret: string;
  /** Resolves the optional device bearer on POST /session into a session context. */
  contextResolver: ContextResolver;
  allowedOrigin: (origin: string) => boolean;
  allowDebugText: boolean;
  /** Uplink frames are 20 ms (50/s); allow bursts up to 2x. */
  maxFramesPerSecond?: number;
  /** WS ping interval; a socket silent for a whole interval (no pong, no message) is dropped. */
  heartbeatMs?: number;
  maxSessions?: number;
  sessionRateLimit?: { max: number; windowMs: number };
  /** Device registration. Absent = identity disabled: the identity routes answer 404. */
  identity?: IdentityService;
  /** Separate bucket from sessionRateLimit. */
  registerRateLimit?: { max: number; windowMs: number };
  /** Resume rotates tokens; give reconnects their own bucket so a flapping link cannot flood it. */
  resumeRateLimit?: { max: number; windowMs: number };
  /** Trust the first X-Forwarded-For hop. Enable only behind a proxy that overwrites the header. */
  trustProxy?: boolean;
  /** Set only when ENABLE_DEV_ENDPOINTS=1; DELETE /dev/owner/:id must carry it in x-dev-token. */
  devToken?: string;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]{16,128})$/;

/** undefined = no Authorization header; null = present but malformed. */
function bearerToken(req: IncomingMessage): string | undefined | null {
  const header = req.headers.authorization;
  if (header === undefined) return undefined;
  return BEARER.exec(header)?.[1] ?? null;
}

export function createGatewayServer(opts: GatewayServerOptions): Server {
  const limiters: Limiters = {
    session: opts.sessionRateLimit ? new RateLimiter(opts.sessionRateLimit) : null,
    register: opts.registerRateLimit ? new RateLimiter(opts.registerRateLimit) : null,
    resume: opts.resumeRateLimit ? new RateLimiter(opts.resumeRateLimit) : null,
  };
  const server = createServer((req, res) => {
    handleHttp(req, res, opts, limiters).catch(() => {
      log('http_internal_error', {});
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !opts.allowedOrigin(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const claimed = opts.manager.claim(url.searchParams.get('token') ?? '');
    if (!claimed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // handleUpgrade may abort (bad handshake, dead socket) without calling back: start the grace timer then.
    let bound = false;
    socket.once('close', () => {
      if (!bound) opts.manager.disconnected(claimed.sessionId, claimed.connId);
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      bound = true;
      bindConnection(ws, claimed.sessionId, claimed.connId, opts);
    });
  });
  return server;
}

interface Limiters {
  session: RateLimiter | null;
  register: RateLimiter | null;
  resume: RateLimiter | null;
}

type Route =
  | { kind: 'session' }
  | { kind: 'resume' }
  | { kind: 'register'; identity: IdentityService }
  | { kind: 'deleteOwner'; identity: IdentityService; devToken: string; ownerId: string };

const DEV_OWNER_PATH = /^\/dev\/owner\/([^/]+)$/;

/** Unknown, disabled (identity off) and dev-only (dev endpoints off) routes all resolve to null → 404. */
function matchRoute(method: string | undefined, path: string, opts: GatewayServerOptions): Route | null {
  if (method === 'POST' && path === '/session') return { kind: 'session' };
  if (method === 'POST' && path === '/session/resume') return { kind: 'resume' };
  const identity = opts.identity;
  if (!identity) return null;
  if (method === 'POST' && path === '/device/register') return { kind: 'register', identity };
  const dev = DEV_OWNER_PATH.exec(path);
  if (method === 'DELETE' && dev && opts.devToken) return { kind: 'deleteOwner', identity, devToken: opts.devToken, ownerId: dev[1]! };
  return null;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, opts: GatewayServerOptions, limiters: Limiters): Promise<void> {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && opts.allowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-app-secret, authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, DELETE, OPTIONS');
  }
  res.setHeader('Cache-Control', 'no-store');
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'GET' && path === '/healthz') {
    json(res, 200, { ok: true });
    return;
  }
  const route = matchRoute(req.method, path, opts);
  if (!route) {
    json(res, 404, { error: 'not_found' });
    return;
  }
  const secret = req.headers['x-app-secret'];
  if (typeof secret !== 'string' || !safeEqual(secret, opts.appSecret)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  switch (route.kind) {
    case 'session':
      await createSession(req, res, opts, limiters.session);
      return;
    case 'resume':
      if (limiters.resume && !limiters.resume.allow(clientAddress(req, opts.trustProxy))) {
        json(res, 429, { error: 'rate_limited' });
        return;
      }
      await resumeSession(req, res, opts);
      return;
    case 'register':
      await registerDevice(req, res, route.identity, limiters.register, opts.trustProxy);
      return;
    case 'deleteOwner':
      deleteOwner(req, res, opts.manager, route);
      return;
  }
}

async function createSession(req: IncomingMessage, res: ServerResponse, opts: GatewayServerOptions, limiter: RateLimiter | null): Promise<void> {
  if (opts.maxSessions !== undefined && opts.manager.size >= opts.maxSessions) {
    json(res, 503, { error: 'session_capacity' });
    return;
  }
  if (limiter && !limiter.allow(clientAddress(req, opts.trustProxy))) {
    json(res, 429, { error: 'rate_limited' });
    return;
  }
  // The body names the character only; owner and agent come only from the bearer. No body = default character.
  const body = SessionCreateSchema.safeParse(await readJson(req, 1024, {}));
  if (!body.success) {
    log('session_rejected', { reason: 'unknown_character' });
    json(res, 400, { error: 'unknown_character' });
    return;
  }
  const characterId = body.data.character ?? DEFAULT_CHARACTER_ID;
  const bearer = bearerToken(req);
  const resolved = bearer === null ? null : opts.contextResolver.resolve(bearer, characterId);
  if (!resolved?.ok) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  // create() flushes the previous owner, but only after this function returns a context.
  // Flush first, then resolve again so the snapshot includes the last turn. Dev has no owner.
  let ctx = resolved.ctx;
  let noticePending = resolved.noticePending;
  if (ctx.ownerId !== undefined && typeof bearer === 'string') {
    opts.manager.endOwner(ctx.ownerId, 'owner_replaced');
    const again = opts.contextResolver.resolve(bearer, characterId);
    if (!again.ok) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    ctx = again.ctx;
    noticePending = again.noticePending;
  }
  json(res, 200, opts.manager.create(ctx, noticePending));
}

async function resumeSession(req: IncomingMessage, res: ServerResponse, opts: GatewayServerOptions): Promise<void> {
  const parsed = ResumeRequestSchema.safeParse(await readJson(req, 4096));
  if (!parsed.success) {
    json(res, 400, { error: 'bad_request' });
    return;
  }
  const tokens = opts.manager.resume(parsed.data.sessionId, parsed.data.resumeToken);
  if (!tokens) {
    json(res, 404, { error: 'session_gone' });
    return;
  }
  json(res, 200, tokens);
}

const REGISTER_ERROR_STATUS = { owner_capacity: 503, register_daily_cap: 429 } as const;

async function registerDevice(req: IncomingMessage, res: ServerResponse, identity: IdentityService, limiter: RateLimiter | null, trustProxy?: boolean): Promise<void> {
  if (limiter && !limiter.allow(clientAddress(req, trustProxy))) {
    json(res, 429, { error: 'rate_limited' });
    return;
  }
  const parsed = RegisterRequestSchema.safeParse(await readJson(req, 1024));
  if (!parsed.success) {
    json(res, 400, { error: 'bad_request' });
    return;
  }
  const result = identity.register();
  if (!result.ok) {
    json(res, REGISTER_ERROR_STATUS[result.error], { error: result.error });
    return;
  }
  json(res, 200, { deviceToken: result.deviceToken });
}

function deleteOwner(req: IncomingMessage, res: ServerResponse, manager: SessionManager, route: Extract<Route, { kind: 'deleteOwner' }>): void {
  const devToken = req.headers['x-dev-token'];
  if (typeof devToken !== 'string' || !safeEqual(devToken, route.devToken)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const id = OwnerIdSchema.safeParse(route.ownerId);
  if (!id.success) {
    json(res, 400, { error: 'bad_request' });
    return;
  }
  manager.endOwner(id.data, 'owner_deleted'); // first, so the session end is recorded before the cascade
  if (!route.identity.deleteOwner(id.data)) {
    json(res, 404, { error: 'owner_not_found' });
    return;
  }
  res.writeHead(204).end();
}

/** X-Forwarded-For is trusted only when the deployment says a proxy overwrites it. */
function clientAddress(req: IncomingMessage, trustProxy: boolean | undefined): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for'];
    const value = Array.isArray(header) ? header[0] : header;
    const first = value?.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return req.socket.remoteAddress ?? 'unknown';
}

class RateLimiter {
  private readonly attempts = new Map<string, number[]>();
  private calls = 0;

  constructor(private readonly opts: { max: number; windowMs: number }, private readonly now = Date.now) {}

  /** Visible for tests; expired buckets are swept periodically. */
  get size(): number {
    return this.attempts.size;
  }

  allow(source: string): boolean {
    const current = this.now();
    const cutoff = current - this.opts.windowMs;
    if (++this.calls % 256 === 0) {
      for (const [key, times] of this.attempts) {
        const recent = times.filter((t) => t > cutoff);
        if (recent.length === 0) this.attempts.delete(key);
        else this.attempts.set(key, recent);
      }
    }
    const recent = (this.attempts.get(source) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.opts.max) {
      this.attempts.set(source, recent);
      return false;
    }
    recent.push(current);
    this.attempts.set(source, recent);
    return true;
  }
}

function bindConnection(ws: WebSocket, sessionId: string, connId: number, opts: GatewayServerOptions): void {
  const { manager } = opts;
  const maxFrames = opts.maxFramesPerSecond ?? 100;
  let begun = false;
  let frames = 0;
  let windowStart = Date.now();
  let alive = true;
  const transport: Transport = {
    send: (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    sendAudio: (seq, pcm) => {
      if (ws.readyState === ws.OPEN) ws.send(encodeAudioFrame(FRAME_AI, seq, pcm));
    },
  };
  // ws emits protocol errors on the socket; without a listener Node throws and kills the gateway.
  ws.on('error', () => {
    log('ws_error', {});
    ws.terminate();
  });
  if (!manager.attachSocket(sessionId, connId, () => ws.terminate())) {
    ws.terminate(); // the session ended between claim and upgrade
    return;
  }
  const heartbeat = setInterval(() => {
    if (!alive) {
      log('ws_heartbeat_timeout', {});
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, opts.heartbeatMs ?? 10_000);
  ws.on('pong', () => {
    alive = true;
  });

  ws.on('message', (data, isBinary) => {
    alive = true;
    if (isBinary) {
      if (!begun) return;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        frames = 0;
      }
      if (++frames > maxFrames) return;
      const frame = decodeAudioFrame(toBytes(data));
      if (!frame || frame.kind !== FRAME_MIC || frame.pcm.length > 4 * MIC_FRAME_SAMPLES) return;
      manager.route(sessionId, connId)?.handleMicAudio(frame.pcm);
      return;
    }
    const msg = parseClientMessage(data.toString());
    if (!msg) {
      transport.send({ type: 'error', code: 'bad_message', retryable: false });
      return;
    }
    if (msg.type === 'session.start' || msg.type === 'session.resume') {
      if (begun) return;
      if (msg.type === 'session.resume' && msg.sessionId !== sessionId) {
        ws.close(4001, 'session_mismatch');
        return;
      }
      begun = true;
      manager
        .begin(
          sessionId,
          connId,
          msg.type === 'session.start' ? 'start' : 'resume',
          transport,
          msg.type === 'session.start' ? msg.clientInfo.language : undefined,
        )
        .then((ok) => {
          if (!ok) ws.close(4002, 'bad_state');
        })
        .catch((error: unknown) => {
          log('session_begin_failed', { code: error instanceof Error ? error.message : 'unknown' });
          ws.close(1011, 'internal');
        });
      return;
    }
    if (!begun) return;
    if (msg.type === 'debug.userText' && !opts.allowDebugText) return;
    if (msg.type === 'session.end') {
      if (manager.route(sessionId, connId)) manager.end(sessionId);
      ws.close(1000);
      return;
    }
    manager.route(sessionId, connId)?.handleClientMessage(msg);
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    manager.disconnected(sessionId, connId); // ignored if this socket was superseded or the session ended
  });
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

/** `emptyAs` is returned for an empty body; without it an empty body is invalid (null). */
function readJson(req: IncomingMessage, limit: number, emptyAs?: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0 && emptyAs !== undefined) {
        resolve(emptyAs);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
