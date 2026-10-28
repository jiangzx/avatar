import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Run from the repo root: node docs/testing/2026-10-27-config-isolation-smoke.mjs
// Mock adapter, temporary database, synthetic input only. Proves: a published config reaches the next
// session while a session that started earlier keeps its snapshot (spec: 配置覆盖层 → 生效).
// Prints counts and versions only; never prints the password, keys or any conversation text.

const APP_PORT = 8797;
const ADMIN_PORT = 8798;
const REST_KEY = 'pacing:restReminder.firstAfterMs';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function passwordHash(password) {
  const N = 16384, r = 8, p = 1;
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function until(test, label, tries = 150, stepMs = 20) {
  for (let n = 0; n < tries; n++) {
    if (await test()) return;
    await delay(stepMs);
  }
  throw new Error(`timeout: ${label}`);
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'avatar-config-isolation-'));
  const dbPath = join(temp, 'memory.db');
  const appSecret = randomBytes(16).toString('hex');
  const password = randomBytes(18).toString('base64url');
  let logs = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: fileURLToPath(new URL('../../gateway', import.meta.url)),
    env: {
      ...process.env,
      ADAPTER: 'mock',
      SUMMARIZER: 'mock',
      DASHSCOPE_API_KEY: '',
      QWEN_SUMMARIZER_ENDPOINT: '',
      MEMORY_DB_PATH: dbPath,
      APP_SECRET: appSecret,
      PORT: String(APP_PORT),
      ADMIN_PORT: String(ADMIN_PORT),
      ADMIN_PASSWORD_HASH: passwordHash(password),
      ADMIN_SECRET_KEY: randomBytes(32).toString('base64'),
      LOG_LEVEL: 'info',
      ENABLE_DEV_ENDPOINTS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const exited = once(child, 'exit');
  const sockets = [];
  const result = {};
  try {
    await until(() => logs.includes('gateway_listening') || child.exitCode !== null, 'gateway startup', 200, 50);
    assert(logs.includes('gateway_listening'), 'gateway did not start');

    const app = async (path, body = {}, bearer) => {
      const response = await fetch(`http://127.0.0.1:${APP_PORT}${path}`, {
        method: 'POST',
        headers: { 'x-app-secret': appSecret, 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
      return { status: response.status, body: await response.json() };
    };

    let cookie = '';
    let csrf = '';
    const admin = async (method, path, body) => {
      const response = await fetch(`http://127.0.0.1:${ADMIN_PORT}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(3000),
      });
      const setCookies = response.headers.getSetCookie();
      if (setCookies.length > 0) cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      return { status: response.status, body: parsed };
    };

    const open = async (tokens) => {
      const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}/ws?token=${tokens.connectToken}`);
      sockets.push(ws);
      const received = [];
      ws.on('message', (data, binary) => { if (!binary) received.push(JSON.parse(data.toString())); });
      await once(ws, 'open');
      ws.send(JSON.stringify({ type: 'session.start', clientInfo: { platform: 'test', audioPath: 'B', language: 'zh' } }));
      await until(() => received.some((m) => m.type === 'session.ready'), 'session ready');
      return { ws, received };
    };

    // 1. Device and session A start before the publish.
    const registration = await app('/device/register', { clientInfo: { platform: 'test' } });
    assert.equal(registration.status, 200);
    const token = registration.body.deviceToken;
    const first = await app('/session', { character: 'xiaonuan' }, token);
    assert.equal(first.status, 200);
    const sessionA = await open(first.body);

    // 2. Admin publishes a pacing change.
    await until(async () => {
      try { return (await admin('GET', '/admin/api/me')).status === 401; } catch { return false; }
    }, 'admin port', 100, 50);
    const login = await admin('POST', '/admin/api/login', { password });
    assert.equal(login.status, 200, 'admin login');
    csrf = login.body.csrfToken;
    const scene = await admin('GET', '/admin/api/config/scenes/pacing');
    assert.equal(scene.status, 200);
    const restItem = scene.body.items.find((item) => item.key === REST_KEY);
    assert(restItem, `${REST_KEY} is in the pacing scene`);
    const oldVersion = scene.body.activeVersion;
    // Display units: minutes (10-120, step 5).
    const newValue = restItem.current === 30 ? 40 : 30;
    const published = await admin('POST', '/admin/api/config/publish', { baseVersion: oldVersion, changes: [{ key: REST_KEY, value: newValue }], resets: [] });
    assert.equal(published.status, 200, 'publish');
    const newVersion = published.body.id;
    assert.notEqual(newVersion, oldVersion);

    // A stale baseVersion is refused.
    const stale = await admin('POST', '/admin/api/config/publish', { baseVersion: oldVersion, changes: [{ key: REST_KEY, value: restItem.current }], resets: [] });
    assert.equal(stale.status, 409, 'stale baseVersion');

    // 3. Session B (a second owner, so A is not replaced by the one-session-per-owner rule) starts after the publish.
    const registrationB = await app('/device/register', { clientInfo: { platform: 'test' } });
    assert.equal(registrationB.status, 200);
    const tokenB = registrationB.body.deviceToken;
    const second = await app('/session', { character: 'xiaokai' }, tokenB);
    assert.equal(second.status, 200);
    const sessionB = await open(second.body);

    // 4. Each session logged the snapshot version it started with.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const versionOf = (sid) => {
      const row = db.prepare("SELECT fields FROM log_events WHERE event = 'session_config' AND sid = ? ORDER BY id DESC LIMIT 1").get(sid);
      return row ? JSON.parse(row.fields).version : undefined;
    };
    await until(() => versionOf(first.body.sessionId) !== undefined && versionOf(second.body.sessionId) !== undefined, 'session_config rows', 200, 25);
    result.sessionA = versionOf(first.body.sessionId);
    result.sessionB = versionOf(second.body.sessionId);
    assert.equal(result.sessionA, oldVersion, 'session A keeps the old snapshot');
    assert.equal(result.sessionB, newVersion, 'session B uses the published config');

    // Session A is still alive after the publish, and no destroy was logged for it.
    assert.equal(sessionA.ws.readyState, WebSocket.OPEN, 'session A still connected');
    const destroyedA = db.prepare("SELECT count(*) AS n FROM log_events WHERE event = 'session_destroyed' AND sid = ?").get(first.body.sessionId);
    assert.equal(destroyedA.n, 0, 'session A not destroyed');

    // The admin timeline shows the same version for B.
    const timeline = await admin('GET', `/admin/api/sessions/${second.body.sessionId}/timeline`);
    assert.equal(timeline.status, 200);
    const config = timeline.body.items.find((item) => item.event === 'session_config');
    assert.equal(config?.fields.version, newVersion, 'timeline version');

    // 5. Nothing secret or conversational reached stdout.
    assert(!logs.includes(password), 'password leaked');
    assert(!logs.includes(token), 'device token leaked');
    assert(!logs.includes(tokenB), 'device token B leaked');
    assert(!/您好|我是小暖|我是小凯/.test(logs), 'conversation text leaked');
    db.close();
    sessionB.ws.close();
    result.ok = true;
    console.log(JSON.stringify({ oldVersion, newVersion, ...result }));
  } finally {
    for (const ws of sockets) ws.terminate();
    child.kill('SIGTERM');
    await Promise.race([exited, delay(5000)]);
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'smoke_failed');
  process.exit(1);
});
