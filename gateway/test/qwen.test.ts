import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { QwenAdapter } from '../src/adapters/qwen.ts';

describe('QwenAdapter', () => {
  const servers: WebSocketServer[] = [];
  afterEach(async () => { for (const s of servers) { for (const ws of s.clients) ws.terminate(); await new Promise<void>((r) => s.close(() => r())); } });
  it('maps response audio, transcript and function call fixtures', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    s.on('connection', (ws) => ws.on('message', (raw) => { const e = JSON.parse(raw.toString()); if (e.type === 'session.update') { ws.send(JSON.stringify({ type: 'session.created' })); ws.send(JSON.stringify({ type: 'response.audio.started', response_id: 'r' })); ws.send(JSON.stringify({ type: 'response.audio.delta', response_id: 'r', delta: Buffer.from(new Int16Array([1, 2]).buffer).toString('base64') })); ws.send(JSON.stringify({ type: 'response.audio_transcript.delta', response_id: 'r', delta: 'fixture' })); ws.send(JSON.stringify({ type: 'response.function_call_arguments.done', response_id: 'r', item: { call_id: 'c', name: 'perform_action', arguments: '{"action":"wave"}' } })); ws.send(JSON.stringify({ type: 'response.audio.done', response_id: 'r' })); ws.send(JSON.stringify({ type: 'response.done', response_id: 'r' })); } }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture' }); const seen: string[] = []; let bytes = 0; let done = 0;
    a.on('responseStarted', (id) => seen.push(`start:${id}`)); a.on('audioDelta', (_id, p) => { bytes += p.length; }); a.on('textDelta', (_id, t) => seen.push(`text:${t}`)); a.on('toolCall', (_id, c, n) => seen.push(`tool:${c}:${n}`)); a.on('responseDone', (id) => { done++; seen.push(`done:${id}`); });
    await a.connect({ instructions: 'fixture', tools: [{ name: 'perform_action', description: 'fixture', parameters: {} }] }); await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(['start:r', 'text:fixture', 'tool:c:perform_action', 'done:r']); expect(bytes).toBe(2); expect(done).toBe(1); a.close();
  });

  it('waits for session.created before resolving or sending audio', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    let release!: () => void;
    const created = new Promise<void>((resolve) => { release = resolve; });
    let audioAppends = 0;
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString());
      if (e.type === 'session.update') { void created.then(() => ws.send(JSON.stringify({ type: 'session.created' }))); }
      if (e.type === 'input_audio_buffer.append') audioAppends++;
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture', connectTimeoutMs: 200 });
    let ready = false;
    const connecting = a.connect({ instructions: 'fixture', tools: [] }).then(() => { ready = true; });
    await new Promise((r) => setTimeout(r, 20));
    a.sendAudio(new Int16Array(320));
    expect(ready).toBe(false);
    expect(audioAppends).toBe(0);
    release();
    await connecting;
    expect(ready).toBe(true);
    a.close();
  });

  it.each(['timeout', 'upstream_error', 'socket_close', 'intentional_close'] as const)('rejects initialization on %s', async (failure) => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture', connectTimeoutMs: 100 });
    s.on('connection', (ws) => ws.on('message', (raw) => {
      if (JSON.parse(raw.toString()).type !== 'session.update') return;
      if (failure === 'upstream_error') ws.send(JSON.stringify({ type: 'error', error: { code: 'fixture_denied' } }));
      if (failure === 'socket_close') ws.close();
      if (failure === 'intentional_close') a.close();
    }));
    const expected = { timeout: 'qwen_connect_timeout', upstream_error: 'qwen_session_rejected', socket_close: 'qwen_connect_closed', intentional_close: 'qwen_connect_closed' }[failure];
    await expect(a.connect({ instructions: 'fixture', tools: [] })).rejects.toThrow(expected);
    a.close();
  });
});
