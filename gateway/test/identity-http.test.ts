import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { CharacterId, SessionTokens } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import { makeOriginCheck } from '../src/config.ts';
import type { Logger } from '../src/log/logger.ts';
import { DeviceRegistry, type IdentityLimits } from '../src/identity/registry.ts';
import { hashToken } from '../src/identity/tokens.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import { shippedCharacters } from './support/shipped.ts';
import { captureLogger } from './helpers/logCapture.ts';
import { devContextResolver, type SessionContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { SessionManager } from '../src/session/manager.ts';
import { Session } from '../src/session/session.ts';
import { createGatewayServer } from '../src/server/server.ts';

const SECRET = 'test-secret-0123456789';
const DEV_TOKEN = 'dev-token-0123456789abcdef';
const script: MockScript = { greeting: '你好', followup: '还在吗', fallbackReply: '我在听', turns: [] };
const director: DirectorConfig = {
  followupAfterMs: 60000, idleNoticeAfterMs: 60000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume', toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
};

interface BootOptions {
  identity?: boolean;
  limits?: Partial<IdentityLimits>;
  registerRateLimit?: { max: number; windowMs: number };
  sessionRateLimit?: { max: number; windowMs: number };
  devToken?: string;
  characterEnabled?: (id: CharacterId) => boolean;
  logger?: Logger;
}

let server: Server | null = null;
let manager: SessionManager | null = null;
let db: DatabaseSync | null = null;
const sockets: WebSocket[] = [];

async function boot(opts: BootOptions = {}) {
  const roles = fixedRoleCatalog('P', director);
  db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  const store = new SqliteMemoryStore(db);
  const registry = new DeviceRegistry({ store, roles, characters: shippedCharacters(), continuityGapMs: 600_000, limits: { maxOwners: 100, dailyCap: 100, orphanOwnerDays: 7, orphanCleanupBatch: 100, ...opts.limits } });
  const contexts: SessionContext[] = [];
  manager = new SessionManager((ctx) => {
    contexts.push(ctx);
    return new Session({
      adapterFactory: () => new MockAdapter({ script, replyDelayMs: 10, charMs: 20, chunkMs: 20, paceFactor: 1 }),
      summarizer: new MockSummarizer(),
      roles,
    }, ctx);
  }, 60_000, undefined, undefined, registry.lifecycle);
  const identityOn = opts.identity ?? true;
  server = createGatewayServer({
    manager,
    appSecret: SECRET,
    allowedOrigin: makeOriginCheck([]),
    allowDebugText: false,
    contextResolver: identityOn ? registry : devContextResolver(roles),
    identity: identityOn ? registry : undefined,
    registerRateLimit: opts.registerRateLimit,
    sessionRateLimit: opts.sessionRateLimit,
    devToken: opts.devToken,
    ...(opts.characterEnabled ? { characterEnabled: opts.characterEnabled } : {}),
    logger: opts.logger,
    ownerBanned: identityOn ? (ownerId: string) => store.isOwnerBanned(ownerId) : undefined,
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, store, contexts };
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  manager?.shutdown();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (db?.isOpen) db.close();
  server = null;
  manager = null;
  db = null;
});

interface CallOptions { body?: unknown; bearer?: string; secret?: string; devToken?: string }

async function call(base: string, method: string, path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-app-secret': opts.secret ?? SECRET };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.devToken) headers['x-dev-token'] = opts.devToken;
  const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

async function register(base: string): Promise<string> {
  const r = await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' } } });
  expect(r.status).toBe(200);
  return r.json!.deviceToken as string;
}

async function startSession(base: string, tokens: SessionTokens): Promise<void> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(tokens.connectToken)}`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const ready = new Promise<void>((resolve) => ws.on('message', (data, isBinary) => {
    if (!isBinary && (JSON.parse(data.toString()) as { type: string }).type === 'session.ready') resolve();
  }));
  ws.send(JSON.stringify({ type: 'session.start', clientInfo: { platform: 'test', audioPath: 'A' } }));
  await ready;
}

describe('device registration', () => {
  it('returns only a 43-char device token and requires the app secret', async () => {
    const { base } = await boot();
    const r = await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' } } });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json!)).toEqual(['deviceToken']);
    expect(r.json!.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' } }, secret: 'wrong-secret-0123456' })).status).toBe(401);
  });

  it('validates the register body and drops a legacy style field', async () => {
    const { base } = await boot();
    expect((await call(base, 'POST', '/device/register', { body: {} })).status).toBe(400);
    expect((await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'x'.repeat(33) } } })).status).toBe(400);
    expect((await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' }, style: 'pirate' } })).status).toBe(200);
  });

  it('rate limits registration in its own bucket', async () => {
    const { base } = await boot({ registerRateLimit: { max: 1, windowMs: 60_000 }, sessionRateLimit: { max: 1, windowMs: 60_000 } });
    await register(base);
    expect(await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' } } })).toEqual({ status: 429, json: { error: 'rate_limited' } });
    expect((await call(base, 'POST', '/session')).status).toBe(200); // separate bucket
    expect((await call(base, 'POST', '/session')).status).toBe(429);
  });

  it('enforces MAX_OWNERS', async () => {
    const capped = await boot({ limits: { maxOwners: 1 } });
    await register(capped.base);
    expect(await call(capped.base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' } } })).toEqual({ status: 503, json: { error: 'owner_capacity' } });
  });

  it('enforces the daily registration cap', async () => {
    const { base } = await boot({ limits: { dailyCap: 1 } });
    await register(base);
    expect(await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' } } })).toEqual({ status: 429, json: { error: 'register_daily_cap' } });
  });
});

describe('bearer sessions', () => {
  it('binds each device token and character to its own agent and rejects client-supplied ids', async () => {
    const { base, store, contexts } = await boot();
    const a = await register(base);
    const b = await register(base);
    const ownerA = store.findDevice(hashToken(a))!.ownerId;
    const ownerB = store.findDevice(hashToken(b))!.ownerId;
    expect(await call(base, 'POST', '/session', { bearer: a, body: { ownerId: ownerB, agentId: 'forged' } }))
      .toEqual({ status: 400, json: { error: 'unknown_character' } });
    expect(await call(base, 'POST', '/session', { bearer: a, body: { character: 'kai' } }))
      .toEqual({ status: 400, json: { error: 'unknown_character' } });
    expect((await call(base, 'POST', '/session', { bearer: a, body: { character: 'xiaokai' } })).status).toBe(200);
    expect((await call(base, 'POST', '/session', { bearer: a })).status).toBe(200);
    expect((await call(base, 'POST', '/session', { bearer: b, body: { character: 'xiaokai' } })).status).toBe(200);
    expect(contexts.map((c) => [c.ownerId, c.characterId])).toEqual([[ownerA, 'xiaokai'], [ownerA, 'xiaonuan'], [ownerB, 'xiaokai']]);
    expect(new Set(contexts.map((c) => c.agentId)).size).toBe(3);
    expect(contexts.every((c) => c.firstMeet)).toBe(true);
  });

  it('no longer serves PATCH /agent/style', async () => {
    const { base } = await boot();
    const a = await register(base);
    expect(await call(base, 'PATCH', '/agent/style', { bearer: a, body: { style: 'old-friend' } }))
      .toEqual({ status: 404, json: { error: 'not_found' } });
  });

  it('ends the previous session when the same owner opens a new one', async () => {
    const { base, store } = await boot();
    const a = await register(base);
    const ownerA = store.findDevice(hashToken(a))!.ownerId;
    const first = (await call(base, 'POST', '/session', { bearer: a })).json as unknown as SessionTokens;
    await startSession(base, first);
    expect((await call(base, 'POST', '/session', { bearer: a })).status).toBe(200);
    expect(manager!.size).toBe(1);
    expect(store.listSessions(ownerA)[0]?.endedAt).not.toBeNull();
    expect((await call(base, 'POST', '/session/resume', { body: { sessionId: first.sessionId, resumeToken: first.resumeToken } })).status).toBe(404);
  });

  it('rejects forged, malformed and missing bearers with 401', async () => {
    const { base } = await boot();
    const forged = randomBytes(32).toString('base64url');
    expect((await call(base, 'POST', '/session', { bearer: forged })).status).toBe(401);
    const malformed = await fetch(`${base}/session`, { method: 'POST', headers: { 'x-app-secret': SECRET, authorization: 'Bearer short' } });
    expect(malformed.status).toBe(401);
  });

  it('keeps the APP_SECRET-only dev mode working', async () => {
    const { base, contexts } = await boot();
    expect((await call(base, 'POST', '/session')).status).toBe(200);
    expect(contexts[0]!.ownerId).toBeUndefined();
    expect(contexts[0]!.characterId).toBe('xiaonuan');
  });

  it('hides identity routes when identity is disabled', async () => {
    const { base, contexts } = await boot({ identity: false });
    expect((await call(base, 'POST', '/device/register', { body: { clientInfo: { platform: 'test' } } })).status).toBe(404);
    expect((await call(base, 'PATCH', '/agent/style', { bearer: 'device-token-0123456789', body: { style: 'old-friend' } })).status).toBe(404);
    expect((await call(base, 'POST', '/session')).status).toBe(200);
    expect((await call(base, 'POST', '/session', { bearer: 'device-token-0123456789' })).status).toBe(401);
    expect(contexts).toHaveLength(1);
  });

  it('allows PATCH, DELETE and authorization in CORS preflight for loopback origins', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/session`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:39123' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type, x-app-secret, authorization');
  });
});

describe('dev owner deletion', () => {
  it('is not reachable with the default configuration', async () => {
    const { base } = await boot();
    expect((await call(base, 'DELETE', `/dev/owner/${randomUUID()}`, { devToken: DEV_TOKEN })).status).toBe(404);
  });

  it('deletes an owner only with the app secret and dev token, ending its session', async () => {
    const { base, store } = await boot({ devToken: DEV_TOKEN });
    const a = await register(base);
    const b = await register(base);
    const ownerA = store.findDevice(hashToken(a))!.ownerId;
    await startSession(base, (await call(base, 'POST', '/session', { bearer: a })).json as unknown as SessionTokens);
    const path = `/dev/owner/${ownerA}`;
    expect((await call(base, 'DELETE', path, { devToken: DEV_TOKEN, secret: 'wrong-secret-0123456' })).status).toBe(401);
    expect((await call(base, 'DELETE', path)).status).toBe(401);
    expect((await call(base, 'DELETE', path, { devToken: 'wrong-dev-token-0123456789' })).status).toBe(401);
    expect((await call(base, 'DELETE', '/dev/owner/not-a-uuid', { devToken: DEV_TOKEN })).status).toBe(400);
    expect(await call(base, 'DELETE', path, { devToken: DEV_TOKEN })).toEqual({ status: 204, json: null });
    expect(manager!.size).toBe(0);
    expect((await call(base, 'POST', '/session', { bearer: a })).status).toBe(401);
    expect((await call(base, 'POST', '/session', { bearer: b })).status).toBe(200);
    expect(await call(base, 'DELETE', path, { devToken: DEV_TOKEN })).toEqual({ status: 404, json: { error: 'owner_not_found' } });
  });
});

describe('banned owners', () => {
  it('get 403 owner_banned on POST /session until unbanned', async () => {
    const { base, store } = await boot();
    const token = await register(base);
    expect((await call(base, 'POST', '/session', { bearer: token })).status).toBe(200);
    const ownerId = store.findDevice(hashToken(token))!.ownerId;
    store.setOwnerBanned(ownerId, Date.now());
    expect(await call(base, 'POST', '/session', { bearer: token })).toEqual({ status: 403, json: { error: 'owner_banned' } });
    store.setOwnerBanned(ownerId, null);
    expect((await call(base, 'POST', '/session', { bearer: token })).status).toBe(200);
  });

});

describe('disabled characters', () => {
  it('answers 409 for a disabled character, before auth, and follows the switch', async () => {
    const disabled = new Set<CharacterId>(['xiaoxin']);
    const { base, contexts } = await boot({ characterEnabled: (id) => !disabled.has(id) });
    const token = await register(base);
    expect(await call(base, 'POST', '/session', { bearer: token, body: { character: 'xiaoxin' } }))
      .toEqual({ status: 409, json: { error: 'character_disabled' } });
    expect(await call(base, 'POST', '/session', { body: { character: 'xiaoxin' } }))
      .toEqual({ status: 409, json: { error: 'character_disabled' } });
    expect(await call(base, 'POST', '/session', { body: { character: 'lily' } }))
      .toEqual({ status: 400, json: { error: 'unknown_character' } });
    expect((await call(base, 'POST', '/session', { bearer: token, body: { character: 'xiaokai' } })).status).toBe(200);
    disabled.delete('xiaoxin');
    expect((await call(base, 'POST', '/session', { bearer: token, body: { character: 'xiaoxin' } })).status).toBe(200);
    expect(contexts.map((c) => c.characterId)).toEqual(['xiaokai', 'xiaoxin']);
  });

  it('keeps a running session when its character is switched off', async () => {
    const disabled = new Set<CharacterId>();
    const { base } = await boot({ characterEnabled: (id) => !disabled.has(id) });
    const token = await register(base);
    const created = await call(base, 'POST', '/session', { bearer: token, body: { character: 'xiaoxin' } });
    expect(created.status).toBe(200);
    await startSession(base, created.json as unknown as SessionTokens);
    disabled.add('xiaoxin');
    expect(manager!.size).toBe(1);
    const resumed = await call(base, 'POST', '/session/resume', {
      body: { sessionId: (created.json as { sessionId: string }).sessionId, resumeToken: (created.json as { resumeToken: string }).resumeToken },
    });
    expect(resumed.status).toBe(200);
  });

  it('logs the rejection with the character id as a child binding, not a plain field', async () => {
    const cap = captureLogger();
    const { base } = await boot({ logger: cap.logger, characterEnabled: (id) => id !== 'xiaoxin' });
    expect(await call(base, 'POST', '/session', { body: { character: 'xiaoxin' } }))
      .toEqual({ status: 409, json: { error: 'character_disabled' } });
    const rejected = cap.events('session_rejected');
    expect(rejected).toHaveLength(1);
    // char is a reserved field; only a child binding survives. The line carries no conversation content.
    expect(rejected[0]).toMatchObject({ level: 'info', binding: { char: 'xiaoxin' }, fields: { reason: 'character_disabled' } });
    expect(rejected[0]!.binding).toEqual({ char: 'xiaoxin' });
    expect(rejected[0]!.fields).toEqual({ reason: 'character_disabled' });
  });

  it('treats every character as enabled when no switch is given', async () => {
    const { base } = await boot();
    const token = await register(base);
    expect((await call(base, 'POST', '/session', { bearer: token, body: { character: 'xiaoxin' } })).status).toBe(200);
  });
});
