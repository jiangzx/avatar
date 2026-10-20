import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { FRAME_AI, decodeAudioFrame, type ServerMessage, type SessionTokens } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import { makeOriginCheck } from '../src/config.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { devContextResolver, type ContextResolver, type SessionContext } from '../src/session/context.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { SessionManager } from '../src/session/manager.ts';
import { Session } from '../src/session/session.ts';
import { TokenStore } from '../src/session/tokens.ts';
import { createGatewayServer } from '../src/server/server.ts';

const SECRET = 'test-secret-0123456789';
const script: MockScript = { greeting: '你好', followup: '还在吗', fallbackReply: '我在听', turns: [] };
const director: DirectorConfig = {
  followupAfterMs: 60000, idleNoticeAfterMs: 60000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume', toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
};

let server: Server | null = null;
let manager: SessionManager | null = null;
const sockets: WebSocket[] = [];

async function boot(opts: { graceMs?: number; unclaimedMs?: number; allowDebugText?: boolean; heartbeatMs?: number; startTimeoutMs?: number; adapterConnect?: 'fail' | 'hang'; maxSessions?: number; sessionRateLimit?: { max: number; windowMs: number }; resumeRateLimit?: { max: number; windowMs: number }; trustProxy?: boolean; contextResolver?: ContextResolver; onContext?: (ctx: SessionContext) => void } = {}) {
  const roles = fixedRoleCatalog('P', director);
  manager = new SessionManager(
    (ctx) => {
      opts.onContext?.(ctx);
      return new Session({
        adapterFactory: () => {
          const adapter = new MockAdapter({ script, replyDelayMs: 10, charMs: 20, chunkMs: 20, paceFactor: 1 });
          if (opts.adapterConnect === 'fail') vi.spyOn(adapter, 'connect').mockRejectedValue(new Error('connect failed'));
          if (opts.adapterConnect === 'hang') vi.spyOn(adapter, 'connect').mockImplementation(() => new Promise<void>(() => {}));
          return adapter;
        },
        summarizer: new MockSummarizer(),
        roles,
      }, ctx);
    },
    opts.graceMs ?? 60_000,
    opts.unclaimedMs,
    opts.startTimeoutMs,
  );
  server = createGatewayServer({
    manager,
    appSecret: SECRET,
    contextResolver: opts.contextResolver ?? devContextResolver(roles),
    allowedOrigin: makeOriginCheck([]),
    allowDebugText: opts.allowDebugText ?? true,
    heartbeatMs: opts.heartbeatMs,
    maxSessions: opts.maxSessions,
    sessionRateLimit: opts.sessionRateLimit,
    resumeRateLimit: opts.resumeRateLimit,
    trustProxy: opts.trustProxy,
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  manager?.shutdown();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  manager = null;
});

async function post(base: string, path: string, body: unknown = {}, secret = SECRET, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-secret': secret, ...extraHeaders },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
  audioFrames: number;
  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
}

function connect(base: string, token: string, options: WebSocket.ClientOptions = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`, options);
    sockets.push(ws);
    const client: Client = {
      ws,
      messages: [],
      audioFrames: 0,
      waitFor: (pred, timeoutMs = 2000) =>
        new Promise((res, rej) => {
          const started = Date.now();
          const poll = () => {
            const hit = client.messages.find(pred);
            if (hit) return res(hit);
            if (Date.now() - started > timeoutMs) return rej(new Error('timeout'));
            setTimeout(poll, 10);
          };
          poll();
        }),
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const f = decodeAudioFrame(new Uint8Array(data as Buffer));
        if (f?.kind === FRAME_AI) client.audioFrames++;
      } else {
        client.messages.push(JSON.parse(data.toString()) as ServerMessage);
      }
    });
    ws.on('open', () => resolve(client));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`http_${res.statusCode}`)));
    ws.on('error', reject);
  });
}

const start = (c: Client) => c.ws.send(JSON.stringify({ type: 'session.start', clientInfo: { platform: 'test', audioPath: 'A' } }));

describe('gateway server', () => {
  it('requires the app secret to create a session', async () => {
    const base = await boot();
    expect((await post(base, '/session', {}, 'wrong-secret-0123456')).status).toBe(401);
    const ok = await post(base, '/session');
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.json).sort()).toEqual(['connectToken', 'resumeToken', 'sessionId']);
  });

  it('rejects malformed or unknown bearer tokens on /session', async () => {
    const base = await boot();
    for (const authorization of ['Bearer short', 'Basic abcdefghijklmnopqrstu', 'Bearer abcdefghijklmnopqrstuvwxyz012345']) {
      const res = await fetch(base + '/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-secret': SECRET, authorization }, body: '{}' });
      expect(res.status).toBe(401);
    }
  });

  it('flushes the previous owner before the snapshot used for the next session', async () => {
    const events: string[] = [];
    const seen: Array<string | undefined> = [];
    const ctx: SessionContext = { ownerId: 'o1', agentId: 'a1', roleId: 'elder-companion', styleId: 'grandchild' };
    const spy = vi.spyOn(Session.prototype, 'flush').mockImplementation(() => {
      events.push('flush');
    });
    try {
      const base = await boot({
        contextResolver: {
          resolve: () => {
            const flushed = events.includes('flush');
            events.push(flushed ? 'resolve-after-flush' : 'resolve-before-flush');
            return { ok: true, ctx: flushed ? { ...ctx, memorySnapshot: '称呼：王叔' } : ctx, noticePending: false };
          },
        },
        onContext: (c) => seen.push(c.memorySnapshot),
      });
      const headers = { 'content-type': 'application/json', 'x-app-secret': SECRET, authorization: 'Bearer device-token-0123456789' };
      expect((await fetch(base + '/session', { method: 'POST', headers, body: '{}' })).status).toBe(200);
      expect((await fetch(base + '/session', { method: 'POST', headers, body: '{}' })).status).toBe(200);
      expect(seen).toEqual([undefined, '称呼：王叔']);
      expect(events.indexOf('flush')).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('resolve-after-flush')).toBeGreaterThan(events.indexOf('flush'));
    } finally {
      spy.mockRestore();
    }
  });

  it('hands the resolved context to the session factory', async () => {
    const seen: SessionContext[] = [];
    const ctx: SessionContext = { ownerId: 'o1', agentId: 'a1', roleId: 'elder-companion', styleId: 'old-friend', voice: 'voice-old' };
    const base = await boot({
      contextResolver: { resolve: (b) => (b === 'device-token-0123456789' ? { ok: true, ctx, noticePending: false } : { ok: false }) },
      onContext: (c) => seen.push(c),
    });
    const res = await fetch(base + '/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-secret': SECRET, authorization: 'Bearer device-token-0123456789' }, body: '{}' });
    expect(res.status).toBe(200);
    expect(seen).toEqual([ctx]);
  });

  it('allows the authorization header in CORS preflight for loopback origins', async () => {
    const base = await boot();
    const res = await fetch(base + '/session', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:39123' } });
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('answers CORS preflight only for loopback origins', async () => {
    const base = await boot();
    const good = await fetch(`${base}/session`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:39123' } });
    expect(good.status).toBe(204);
    expect(good.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:39123');
    const bad = await fetch(`${base}/session`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects websocket upgrades from disallowed origins', async () => {
    const base = await boot();
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    await expect(connect(base, t.connectToken, { origin: 'https://evil.example' })).rejects.toThrow('http_403');
    expect(manager!.size).toBe(1);
  });

  it('rejects session creation when the session cap is reached', async () => {
    const base = await boot({ maxSessions: 1 });
    expect((await post(base, '/session')).status).toBe(200);
    const limited = await post(base, '/session');
    expect(limited.status).toBe(503);
    expect(limited.json).toEqual({ error: 'session_capacity' });
  });

  it('rate limits session creation per source address', async () => {
    const base = await boot({ sessionRateLimit: { max: 1, windowMs: 1000 } });
    expect((await post(base, '/session')).status).toBe(200);
    const limited = await post(base, '/session');
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: 'rate_limited' });
  });

  it('rate limits session resume separately from session creation', async () => {
    const base = await boot({ resumeRateLimit: { max: 1, windowMs: 1000 } });
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    expect((await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken })).status).toBe(200);
    expect((await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken })).status).toBe(429);
  });

  it('does not trust X-Forwarded-For by default', async () => {
    const base = await boot({ sessionRateLimit: { max: 1, windowMs: 1000 } });
    expect((await post(base, '/session', {}, SECRET, { 'x-forwarded-for': '1.1.1.1' })).status).toBe(200);
    expect((await post(base, '/session', {}, SECRET, { 'x-forwarded-for': '2.2.2.2' })).status).toBe(429);
  });

  it('uses X-Forwarded-For when trustProxy is enabled', async () => {
    const base = await boot({ sessionRateLimit: { max: 1, windowMs: 1000 }, trustProxy: true });
    expect((await post(base, '/session', {}, SECRET, { 'x-forwarded-for': '3.3.3.3' })).status).toBe(200);
    expect((await post(base, '/session', {}, SECRET, { 'x-forwarded-for': '4.4.4.4' })).status).toBe(200);
    expect((await post(base, '/session', {}, SECRET, { 'x-forwarded-for': '3.3.3.3' })).status).toBe(429);
  });

  it('rejects unknown and reused connect tokens', async () => {
    const base = await boot();
    await expect(connect(base, 'nope')).rejects.toThrow('http_401');
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    await connect(base, t.connectToken);
    await expect(connect(base, t.connectToken)).rejects.toThrow('http_401');
  });

  it('rejects a connect token issued before a resume rotation', async () => {
    const base = await boot();
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    expect((await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken })).status).toBe(200);
    await expect(connect(base, t.connectToken)).rejects.toThrow('http_401');
  });

  it('starts a session and streams the greeting', async () => {
    const base = await boot();
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    start(c);
    await c.waitFor((m) => m.type === 'session.ready');
    await c.waitFor((m) => m.type === 'response.start' && m.kind === 'greeting');
    await c.waitFor((m) => m.type === 'response.end');
    expect(c.audioFrames).toBeGreaterThan(0);
  });

  it('removes a session when adapter startup fails', async () => {
    const base = await boot({ adapterConnect: 'fail' });
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    const closed = new Promise<void>((resolve) => c.ws.once('close', () => resolve()));
    start(c);
    await closed;

    expect(manager!.size).toBe(0);
    expect(c.messages.some((message) => message.type === 'session.ready')).toBe(false);
    expect((await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken })).status).toBe(404);
  });

  it('removes a session when adapter startup times out', async () => {
    const base = await boot({ adapterConnect: 'hang', startTimeoutMs: 20 });
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    const closed = new Promise<void>((resolve) => c.ws.once('close', () => resolve()));
    start(c);
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 200))]);

    expect(manager!.size).toBe(0);
  });

  it('reports malformed client messages', async () => {
    const base = await boot();
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    start(c);
    c.ws.send('{"type":"nope"}');
    await c.waitFor((m) => m.type === 'error' && m.code === 'bad_message');
  });

  it('ignores debug text when disabled', async () => {
    const base = await boot({ allowDebugText: false });
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    start(c);
    await c.waitFor((m) => m.type === 'response.end');
    c.ws.send(JSON.stringify({ type: 'debug.userText', text: '你好' }));
    await new Promise((r) => setTimeout(r, 300));
    expect(c.messages.some((m) => m.type === 'transcript.user')).toBe(false);
  });

  it('resumes after a disconnect with rotated tokens', async () => {
    const base = await boot();
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    start(c);
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    const r1 = await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken });
    expect(r1.status).toBe(200);
    const reused = await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken });
    expect(reused.status).toBe(404);
    const t2 = r1.json as unknown as SessionTokens;
    const c2 = await connect(base, t2.connectToken);
    c2.ws.send(JSON.stringify({ type: 'session.resume', sessionId: t.sessionId }));
    await c2.waitFor((m) => m.type === 'session.resumed');
  });

  it('survives a malformed websocket frame and keeps the session resumable', async () => {
    const base = await boot();
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    start(c);
    await c.waitFor((m) => m.type === 'session.ready');
    const closed = new Promise<void>((resolve) => c.ws.once('close', () => resolve()));
    // Bypass the ws client's frame writer: a reserved opcode is a protocol error upstream.
    const socket = (c.ws as unknown as { _socket: { write(chunk: Buffer): void } })._socket;
    socket.write(Buffer.from([0x83, 0x81, 1, 2, 3, 4, 0x00]));
    await Promise.race([
      closed,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('socket stayed open')), 1000)),
    ]);
    // The gateway process must still be serving, and only this socket was dropped.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken })).status).toBe(200);
  });

  it('terminates open client sockets on shutdown so server.close can finish', async () => {
    const base = await boot();
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    start(c);
    await c.waitFor((m) => m.type === 'session.ready');
    const closed = new Promise<void>((resolve) => c.ws.once('close', () => resolve()));
    manager!.shutdown();
    await Promise.race([
      closed,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('socket stayed open')), 1000)),
    ]);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server.close did not finish')), 1000);
      server!.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    server = null;
    manager = null;
  });

  it('lets a new connection take over a half-open one', async () => {
    const base = await boot();
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c1 = await connect(base, t.connectToken);
    start(c1);
    await c1.waitFor((m) => m.type === 'session.ready');
    const c1Closed = new Promise<void>((r) => c1.ws.on('close', () => r()));
    // The phone switched networks: the old socket still looks open to the server.
    const r1 = await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken });
    expect(r1.status).toBe(200);
    const c2 = await connect(base, (r1.json as unknown as SessionTokens).connectToken);
    await c1Closed; // the server dropped the superseded socket
    c2.ws.send(JSON.stringify({ type: 'session.resume', sessionId: t.sessionId }));
    await c2.waitFor((m) => m.type === 'session.resumed');
    c2.ws.send(JSON.stringify({ type: 'debug.userText', text: '你好' }));
    await c2.waitFor((m) => m.type === 'transcript.user');
    expect(manager!.size).toBe(1);
  });

  it('drops a socket that stops answering pings and keeps the session for resume', async () => {
    const base = await boot({ heartbeatMs: 50 });
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken, { autoPong: false });
    start(c);
    await c.waitFor((m) => m.type === 'session.ready');
    await new Promise<void>((r) => c.ws.on('close', () => r()));
    expect((await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken })).status).toBe(200);
  });

  it('forgets sessions after the grace period', async () => {
    const base = await boot({ graceMs: 100 });
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    start(c);
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.close();
    await new Promise((r) => setTimeout(r, 250));
    expect((await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken })).status).toBe(404);
    expect(manager!.size).toBe(0);
  });

  it('reclaims sessions that are never connected', async () => {
    const base = await boot({ unclaimedMs: 100 });
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    expect(manager!.size).toBe(1);
    await new Promise((r) => setTimeout(r, 250));
    expect(manager!.size).toBe(0);
    await expect(connect(base, t.connectToken)).rejects.toThrow('http_401');
  });

  it('starts the grace timer when a claimed upgrade fails the WS handshake', async () => {
    const base = await boot({ graceMs: 100 });
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/ws?token=${encodeURIComponent(t.connectToken)}`, {
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'bad', 'Sec-WebSocket-Version': '13' },
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    await new Promise((r) => setTimeout(r, 500));
    expect(manager!.size).toBe(0);
  });

  it('keeps a session reconnected within the grace period', async () => {
    const base = await boot({ graceMs: 100 });
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    start(c);
    await c.waitFor((m) => m.type === 'session.ready');
    const closed = new Promise<void>((r) => c.ws.on('close', () => r()));
    c.ws.close();
    await closed;
    const r1 = await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken });
    const c2 = await connect(base, (r1.json as unknown as SessionTokens).connectToken);
    c2.ws.send(JSON.stringify({ type: 'session.resume', sessionId: t.sessionId }));
    await c2.waitFor((m) => m.type === 'session.resumed');
    await new Promise((r) => setTimeout(r, 250));
    expect(manager!.size).toBe(1);
    c2.ws.send(JSON.stringify({ type: 'debug.userText', text: '你好' }));
    await c2.waitFor((m) => m.type === 'transcript.user');
  });
});

describe('TokenStore', () => {
  it('expires connect tokens after the TTL', () => {
    let now = 1_000;
    const store = new TokenStore(1_000, () => now);
    const fresh = store.issue('s1');
    expect(store.consumeConnect(fresh.connectToken)).toBe('s1');
    const stale = store.issue('s1');
    now += 1_001;
    expect(store.consumeConnect(stale.connectToken)).toBeNull();
  });

  it('revokes the previous connect token when the resume token rotates', () => {
    const store = new TokenStore();
    const first = store.issue('s1');
    const second = store.rotate('s1', first.resumeToken)!;
    expect(store.consumeConnect(first.connectToken)).toBeNull();
    expect(store.consumeConnect(second.connectToken)).toBe('s1');
  });

  it('prunes expired connect tokens when issuing another', () => {
    let now = 1_000;
    const store = new TokenStore(1_000, () => now);
    store.issue('s1');
    expect(store.connectTokenCount).toBe(1);
    now += 1_001;
    store.issue('s2');
    expect(store.connectTokenCount).toBe(1);
  });
});
