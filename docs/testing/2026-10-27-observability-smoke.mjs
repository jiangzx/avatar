import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Run from the repo root:
//   node --import tsx docs/testing/2026-10-27-observability-smoke.mjs            # Mock, no model calls
//   node --import tsx docs/testing/2026-10-27-observability-smoke.mjs --qwen     # real Qwen, needs gateway/.env
// Synthetic input only. The temporary database is deleted at the end.
const qwen = process.argv.includes('--qwen');
const PORT = 8797;
const secret = 'local-dev-secret-0123';
const synthetic = '合成验收：我喜欢晨练';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shortId = (ownerId) => createHash('sha256').update(ownerId).digest('hex').slice(0, 12);

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'avatar-observability-smoke-'));
  const dbPath = join(temp, 'memory.db');
  const checks = {};
  let logs = '';
  const gatewayDir = fileURLToPath(new URL('../../gateway', import.meta.url));
  const env = {
    ...process.env,
    MEMORY_DB_PATH: dbPath,
    APP_SECRET: secret,
    PORT: String(PORT),
    ENABLE_DEV_ENDPOINTS: '0',
    ALLOW_DEBUG_TEXT: '1',
    LOG_LEVEL: 'info',
    ...(qwen
      ? { ADAPTER: 'qwen' }
      : { ADAPTER: 'mock', SUMMARIZER: 'mock', DASHSCOPE_API_KEY: '', QWEN_SUMMARIZER_ENDPOINT: '' }),
  };
  delete env.ADMIN_PORT;
  const args = qwen ? ['--env-file=.env', '--import', 'tsx', 'src/index.ts'] : ['--import', 'tsx', 'src/index.ts'];
  const child = spawn(process.execPath, args, { cwd: gatewayDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const exited = once(child, 'exit');
  const until = async (test, label, tries = 600) => {
    for (let n = 0; n < tries; n++) { if (test()) return; await delay(50); }
    throw new Error(`timeout: ${label}`);
  };
  let db = null;
  let deviceToken = '';
  let ownerId = '';
  let sessionId = '';
  try {
    await until(() => logs.includes('gateway_listening') || child.exitCode !== null, 'gateway startup', 200);
    assert(logs.includes('gateway_listening'), 'gateway startup');
    const call = async (path, body, bearer) => {
      const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
        method: 'POST',
        headers: { 'x-app-secret': secret, 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    };
    const registration = await call('/device/register', { clientInfo: { platform: 'test' } });
    assert.equal(registration.status, 200, 'register');
    deviceToken = registration.body.deviceToken;
    const created = await call('/session', {}, deviceToken);
    assert.equal(created.status, 200, 'create session');

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${created.body.connectToken}`);
    const received = [];
    const audioMs = new Map();
    ws.on('message', (data, binary) => {
      if (binary) {
        // 24 kHz PCM16 after a small header; only the duration matters here.
        const seq = data.readUInt32BE(1);
        audioMs.set(seq, (audioMs.get(seq) ?? 0) + ((data.length - 5) / 2 / 24000) * 1000);
      } else received.push(JSON.parse(data.toString()));
    });
    await once(ws, 'open');
    const send = (msg) => ws.send(JSON.stringify(msg));
    send({ type: 'session.start', clientInfo: { platform: 'test', audioPath: 'B', language: 'zh' } });
    await until(() => received.some((m) => m.type === 'session.ready'), 'session ready');
    sessionId = received.find((m) => m.type === 'session.ready').sessionId;
    const done = (seq) => until(() => received.some((m) => m.type === 'response.end' && m.responseSeq === seq), `response.end ${seq}`, 1200);
    const finish = (seq) => send({ type: 'playback.stopped', responseSeq: seq, playedMs: Math.round(audioMs.get(seq) ?? 300), reason: 'ended' });
    // 1 = greeting, 2 = memory notice (new owner), 3 = reply to the synthetic line.
    await done(1); finish(1);
    await done(2); finish(2);
    send({ type: 'debug.userText', text: synthetic });
    await done(3); finish(3);
    send({ type: 'session.end' });

    db = new DatabaseSync(dbPath, { readOnly: true });
    ownerId = db.prepare('SELECT id FROM owners').get().id;
    const oid = shortId(ownerId);
    await until(() => db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(sessionId)?.ended_at != null, 'session row ended');
    // usageSink.flushMs and logSink.flushMs are 1000 ms; wait for at least one flush.
    await until(() => db.prepare("SELECT count(*) AS n FROM usage_events WHERE kind = 'realtime_reply' AND session_id = ?").get(sessionId).n >= 3, 'usage rows');
    await until(() => db.prepare('SELECT count(*) AS n FROM log_events WHERE sid = ?').get(sessionId).n > 0, 'log rows');

    // sessions
    const session = db.prepare('SELECT adapter, end_reason FROM sessions WHERE id = ?').get(sessionId);
    assert.deepEqual({ ...session }, { adapter: qwen ? 'qwen' : 'mock', end_reason: 'client_end' });
    checks.session = { ...session };

    // usage_events: realtime replies billed to this owner, session and character
    const replies = db.prepare("SELECT * FROM usage_events WHERE kind = 'realtime_reply' AND session_id = ? ORDER BY id").all(sessionId);
    for (const row of replies) {
      assert.equal(row.owner_id, ownerId);
      assert.equal(row.character_id, 'xiaonuan');
      assert.equal(row.adapter, qwen ? 'qwen' : 'mock');
      if (qwen) {
        assert.equal(row.model, 'qwen3.8-omni-flash-realtime');
        assert(row.output_tokens > 0, 'qwen output tokens');
        assert.equal(row.estimated, row.output_audio_tokens === null ? 1 : 0);
        assert(row.cost_micro_yuan > 0, 'qwen reply priced');
      } else {
        assert.equal(row.model, 'mock');
        assert.equal(row.estimated, 1);
        assert.equal(row.price_id, null);
        assert.equal(row.cost_micro_yuan, null);
        assert(row.output_audio_tokens > 0, 'mock audio tokens');
      }
    }
    checks.realtimeRows = replies.length;
    checks.realtimeCostMicroYuan = replies.reduce((sum, r) => sum + (r.cost_micro_yuan ?? 0), 0);
    const textRows = db.prepare("SELECT kind, model, count(*) AS n, sum(cost_micro_yuan) AS cost FROM usage_events WHERE adapter = 'text' GROUP BY kind, model").all();
    checks.textRows = textRows.map((r) => ({ ...r }));
    if (!qwen) assert.equal(textRows.length, 0, 'mock runs make no text-model calls');

    // The per-owner SQL the admin page will use.
    const perOwner = db.prepare('SELECT owner_id, count(*) AS calls, sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)) AS tokens FROM usage_events GROUP BY owner_id').all();
    assert.equal(perOwner.length, 1);
    assert.equal(perOwner[0].owner_id, ownerId);
    checks.perOwner = { calls: perOwner[0].calls, tokens: perOwner[0].tokens };

    // log_events: session timeline with the short owner id only
    const timeline = db.prepare('SELECT ts, level, event, oid, char, seq, fields FROM log_events WHERE sid = ? ORDER BY ts, id').all(sessionId);
    for (const row of timeline) {
      assert.equal(row.oid, oid, `log oid ${row.event}`);
      assert(['info', 'warn', 'error'].includes(row.level), `no debug rows in the table (${row.level})`);
    }
    checks.timelineEvents = [...new Set(timeline.map((r) => r.event))];
    const allLogText = JSON.stringify(db.prepare('SELECT * FROM log_events').all());
    assert(!allLogText.includes(ownerId), 'raw owner id in log_events');
    assert(!allLogText.includes(synthetic), 'synthetic text in log_events');
    assert(!allLogText.includes(deviceToken), 'device token in log_events');

    // stdout: levels, tagged short id, no content
    assert(logs.includes('"level":"info"'), 'stdout level field');
    assert(logs.includes(`"oid":"{E}${oid}"`), 'stdout tagged short owner id');
    assert(!logs.includes(ownerId), 'raw owner id in stdout');
    assert(!logs.includes(synthetic), 'synthetic text in stdout');
    assert(!logs.includes(deviceToken), 'device token in stdout');
    assert(!/log_field_rejected|usage_write_failed|usage_record_failed/.test(logs), 'guard or usage failures');
    checks.contentLeaks = 0;
    ws.terminate();
  } finally {
    db?.close();
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
    const [code] = await exited;
    clearTimeout(timeout);
    checks.exitCode = code;
  }
  assert.equal(checks.exitCode, 0, 'graceful shutdown');
  // Shutdown flushed every queued row; nothing for this session was lost.
  const after = new DatabaseSync(dbPath, { readOnly: true });
  try {
    checks.usageRowsAfterShutdown = after.prepare('SELECT count(*) AS n FROM usage_events WHERE session_id = ?').get(sessionId).n;
    assert(checks.usageRowsAfterShutdown >= checks.realtimeRows);
  } finally {
    after.close();
    rmSync(temp, { recursive: true, force: true });
  }
  return checks;
}

try {
  const checks = await main();
  console.log(JSON.stringify({ mode: qwen ? 'qwen' : 'mock', passed: true, checks }));
} catch (error) {
  console.log(JSON.stringify({ mode: qwen ? 'qwen' : 'mock', passed: false, error: error.message }));
  process.exitCode = 1;
}
