import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FRAME_AI, decodeAudioFrame, type ServerMessage, type SessionTokens } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import { makeOriginCheck } from '../src/config.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { SessionManager } from '../src/session/manager.ts';
import { Session } from '../src/session/session.ts';
import { createGatewayServer } from '../src/server/server.ts';

const SECRET = 'test-secret-0123456789';
const script: MockScript = { greeting: '你好', followup: '还在吗', fallbackReply: '我在听', turns: [] };
const director: DirectorConfig = {
  followupAfterMs: 60000, idleNoticeAfterMs: 60000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', followupInstruction: 'F', idleNoticeInstruction: 'I', resumeInstruction: 'R',
};

let server: Server | null = null;
let manager: SessionManager | null = null;
const sockets: WebSocket[] = [];

async function boot(opts: { graceMs?: number; unclaimedMs?: number; allowDebugText?: boolean; heartbeatMs?: number } = {}) {
  manager = new SessionManager(
    () => new Session({
      adapterFactory: () => new MockAdapter({ script, replyDelayMs: 10, charMs: 20, chunkMs: 20, paceFactor: 1 }),
      summarizer: new MockSummarizer(),
      persona: 'P',
      director,
    }),
    opts.graceMs ?? 60_000,
    opts.unclaimedMs,
  );
  server = createGatewayServer({
    manager,
    appSecret: SECRET,
    allowedOrigin: makeOriginCheck([]),
    allowDebugText: opts.allowDebugText ?? true,
    heartbeatMs: opts.heartbeatMs,
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

async function post(base: string, path: string, body: unknown = {}, secret = SECRET) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-secret': secret },
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

  it('answers CORS preflight only for loopback origins', async () => {
    const base = await boot();
    const good = await fetch(`${base}/session`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:39123' } });
    expect(good.status).toBe(204);
    expect(good.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:39123');
    const bad = await fetch(`${base}/session`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects unknown and reused connect tokens', async () => {
    const base = await boot();
    await expect(connect(base, 'nope')).rejects.toThrow('http_401');
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    await connect(base, t.connectToken);
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
});
