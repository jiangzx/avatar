import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { AI_SAMPLE_RATE, FRAME_AI, decodeAudioFrame } from '@anyidea/protocol';
import { SqliteMemoryStore } from '../../gateway/src/memory/store.ts';
import { renderSnapshot } from '../../gateway/src/memory/snapshot.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// Run from the repo root: node --import tsx docs/testing/plan3-mock-smoke.mjs
// zh regression smoke; multilingual behavior is covered by gateway/test/multilingual.test.ts.
// Synthetic inputs only; no model requests or retained database.
async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'avatar-resume-smoke-'));
  const secret = 'local-dev-secret-0123';
  const checks = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function run(identity) {
    let logs = '';
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: fileURLToPath(new URL('../../gateway', import.meta.url)),
      env: {
        ...process.env,
        ADAPTER: 'mock',
        SUMMARIZER: 'mock',
        DASHSCOPE_API_KEY: '',
        SEEDUPLEX_API_KEY: '',
        QWEN_SUMMARIZER_ENDPOINT: '',
        MEMORY_DB_PATH: identity ? join(temp, 'memory.db') : undefined,
        APP_SECRET: secret,
        PORT: '8797',
        ENABLE_DEV_ENDPOINTS: '0',
        ALLOW_DEBUG_TEXT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    const exited = once(child, 'exit');
    try {
      for (let n = 0; n < 100 && !logs.includes('gateway_listening') && child.exitCode === null; n++) await delay(50);
      assert(logs.includes('gateway_listening'), 'gateway startup');
      const call = async (path, method = 'POST', body = {}, bearer, appSecret = secret) => {
        const response = await fetch('http://127.0.0.1:8797' + path, {
          method,
          headers: {
            'x-app-secret': appSecret,
            'content-type': 'application/json',
            ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(3000),
        });
        return { status: response.status, body: await response.json() };
      };
      if (!identity) {
        assert.equal((await call('/session')).status, 200);
        assert.equal((await call('/session', 'POST', {}, 'device-token-0123456789')).status, 401);
        assert.equal((await call('/session', 'POST', {}, undefined, 'bad')).status, 401);
        assert.equal((logs.match(/"event":"instruction_budget"/g) ?? []).length, 1);
        assert(!/小暖|您来啦/.test(logs));
        checks.push({ identity: false, session: 200, fakeBearer: 401, wrongSecret: 401, instructionBudget: 1, contentLeaks: 0 });
      } else {
        const registration = await call('/device/register', 'POST', { clientInfo: { platform: 'test' }, style: 'old-friend' });
        assert.equal(registration.status, 200);
        const token = registration.body.deviceToken;
        assert.equal(token.length, 43);
        const first = await call('/session', 'POST', {}, token);
        assert.equal(first.status, 200);
        assert.equal((await call('/session', 'POST', {}, 'forged-device-token')).status, 401);
        const anonymous = await call('/session');
        checks.push({ identity: true, tokenLength: 43, bearerSession: 200, fakeBearer: 401, noBearer: anonymous.status, stylePatch: 200, devDelete: 404, dbMode: '600', tokenLeaks: 0 });
        assert.equal(anonymous.status, 200, 'identity-enabled no-bearer dev session');
        assert.equal((logs.match(/"event":"device_resolved"/g) ?? []).length, 2);
        assert(logs.includes('"enabled":true'));
        assert(logs.includes('"event":"orphan_cleanup_batch","deleted":0'));
        assert(logs.includes('"event":"memory_extract_unconfigured"'));
        const style = await call('/agent/style', 'PATCH', { style: 'grandchild' }, token);
        assert.equal(style.status, 200);
        assert.deepEqual(style.body, { style: 'grandchild' });
        assert.equal((await call('/dev/owner/unknown', 'DELETE')).status, 404);
        assert.equal(statSync(join(temp, 'memory.db')).mode & 0o777, 0o600);
        assert(!logs.includes(token));
        const db = new DatabaseSync(join(temp, 'memory.db'), { readOnly: true });
        assert.equal(db.prepare('SELECT count(*) AS n FROM owners').get().n, 1);
        assert.equal(db.prepare('SELECT style_id FROM agents').get().style_id, 'grandchild');
        const messages = () => db.prepare('SELECT role, text FROM messages ORDER BY rowid').all();
        const notified = () => db.prepare('SELECT notified_at FROM owners').get().notified_at;
        const until = async (test, label) => {
          for (let n = 0; n < 400; n++) { if (test()) return; await delay(20); }
          throw new Error('timeout: ' + label);
        };
        const sockets = [];
        const open = async tokens => {
          const ws = new WebSocket('ws://127.0.0.1:8797/ws?token=' + tokens.connectToken);
          sockets.push(ws);
          const received = [];
          const audioMs = new Map();
          ws.on('message', (data, binary) => {
            if (binary) {
              const frame = decodeAudioFrame(data);
              assert(frame && frame.kind === FRAME_AI);
              const duration = frame.pcm.length / AI_SAMPLE_RATE * 1000;
              audioMs.set(frame.responseSeq, (audioMs.get(frame.responseSeq) ?? 0) + duration);
            } else { received.push(JSON.parse(data.toString())); }
          });
          await once(ws, 'open');
          const send = msg => ws.send(JSON.stringify(msg));
          send({ type: 'session.start', clientInfo: { platform: 'test', audioPath: 'B', language: 'zh' } });
          await until(() => received.some(m => m.type === 'session.ready'), 'session ready');
          const done = seq => until(() => received.some(m => m.type === 'response.end' && m.responseSeq === seq), 'response end');
          const finish = seq => send({ type: 'playback.stopped', responseSeq: seq, playedMs: audioMs.get(seq) ?? 0, reason: 'ended' });
          return { ws, received, send, done, finish };
        };
        try {
          const one = await open(first.body);
          await one.done(1);
          assert.equal(messages().length, 0);
          assert.equal(notified(), null);
          one.finish(1);
          await one.done(2);
          assert.equal(messages().length, 0);
          assert.equal(notified(), null);
          one.finish(2);
          await until(() => notified() !== null, 'memory notice acknowledgement');
          const synthetic = '合成验收：我喜欢晨练';
          one.send({ type: 'debug.userText', text: synthetic });
          await one.done(3);
          one.finish(3);
          one.send({ type: 'debug.userText', text: '挥挥手' });
          await until(() => one.received.some(m => m.type === 'avatar.action' && m.action === 'wave'), 'tool action');
          await one.done(5);
          assert(logs.includes('"tool_calls":1'));
          assert.equal(one.received.filter(m => m.type === 'avatar.action' && m.action === 'wave').length, 1);
          one.finish(5);
          const next = await call('/session', 'POST', {}, token);
          assert.equal(next.status, 200);
          assert(messages().some(m => m.role === 'user' && m.text === synthetic));
          assert(messages().some(m => m.role === 'assistant'));
          assert.equal(db.prepare('SELECT count(*) AS n FROM sessions WHERE ended_at IS NULL').get().n, 0);
          const owner = db.prepare('SELECT id FROM owners').get().id;
          const agent = db.prepare('SELECT id FROM agents').get().id;
          const store = new SqliteMemoryStore(db);
          const snapshot = renderSnapshot({ facts: store.listFacts(owner), notes: store.listNotes(owner, agent), tail: store.snapshotRows(owner, agent), maxChars: 4000 });
          assert(snapshot.includes(synthetic));
          const two = await open(next.body);
          await two.done(1);
          two.send({ type: 'session.end' });
          await until(() => db.prepare('SELECT count(*) AS n FROM sessions WHERE ended_at IS NULL').get().n === 0, 'session end');
          assert(logs.includes('owner_replaced'));
          assert(!logs.includes(synthetic));
          assert(!/小暖|您来啦|嗯嗯，我在听|刚才聊到这儿/.test(logs));
          checks.push({ websocket: true, writesBeforeNotice: 0, notifiedAfterPlayback: true, replacementFlush: true, persistedTailInSnapshot: true, mockToolContinuation: true, contentLeaks: 0 });
        } finally {
          for (const ws of sockets) ws.terminate();
          db.close();
        }
      }
    } finally {
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 4000);
      const [code, signal] = await exited;
      clearTimeout(timeout);
      assert.equal(code, 0, 'gateway graceful shutdown');
      assert.equal(signal, null);
      assert(!/http_internal_error|memory_retention_failed|orphan_cleanup_failed|upstream_error/.test(logs));
      assert(logs.trim().split('\n').at(-1).includes('session_destroyed'));
    }
  }
  try { await run(false); await run(true); console.log(JSON.stringify({ checks, passed: true })); }
  catch (error) { console.log(JSON.stringify({ checks, passed: false, error: error.message })); process.exitCode = 1; }
  finally { rmSync(temp, { recursive: true, force: true }); }
}

await main();
