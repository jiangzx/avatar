import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { QwenAdapter, RESPONSE_INSTRUCTIONS, SYSTEM_NOTE_PREFIX, proactiveEvents } from '../src/adapters/qwen.ts';

describe('QwenAdapter', () => {
  const servers: WebSocketServer[] = [];
  afterEach(async () => { for (const s of servers) { for (const ws of s.clients) ws.terminate(); await new Promise<void>((r) => s.close(() => r())); } });
  it('waits for configured session and maps real response.created and canceled completion', async () => {
    const server = new WebSocketServer({ port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    let acknowledge!: () => void;
    let updateSent!: () => void;
    const updated = new Promise<void>((resolve) => { updateSent = resolve; });
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'session.created' }));
      socket.on('message', (raw) => {
        const e = JSON.parse(raw.toString());
        if (e.type === 'session.update') {
          acknowledge = () => socket.send(JSON.stringify({ type: 'session.updated' }));
          updateSent();
        }
        if (e.type === 'response.create') {
          socket.send(JSON.stringify({ type: 'response.created', response: { id: 'real-shape' } }));
          socket.send(JSON.stringify({ type: 'response.audio.delta', response_id: 'real-shape', delta: Buffer.alloc(4).toString('base64') }));
          socket.send(JSON.stringify({ type: 'response.done', response: { id: 'real-shape', status: 'cancelled' } }));
        }
      });
    });
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, voice: 'fixture' });
    const seen: string[] = [];
    a.on('responseStarted', (id) => seen.push(`start:${id}`));
    a.on('audioDelta', (id) => seen.push(`audio:${id}`));
    a.on('responseCancelled', (id) => seen.push(`cancel:${id}`));
    let ready = false;
    const connecting = a.connect({ instructions: 'fixture', tools: [] }).then(() => { ready = true; });
    await updated;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ready).toBe(false);
    acknowledge();
    await connecting;
    a.createResponse();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual(['start:real-shape', 'audio:real-shape', 'cancel:real-shape']);
    a.close();
  });
  it('maps response audio, transcript and function call fixtures', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    s.on('connection', (ws) => ws.on('message', (raw) => { const e = JSON.parse(raw.toString()); if (e.type === 'session.update') { ws.send(JSON.stringify({ type: 'session.created' })); ws.send(JSON.stringify({ type: 'session.updated' })); ws.send(JSON.stringify({ type: 'response.audio.started', response_id: 'r' })); ws.send(JSON.stringify({ type: 'response.audio.delta', response_id: 'r', delta: Buffer.from(new Int16Array([1, 2]).buffer).toString('base64') })); ws.send(JSON.stringify({ type: 'response.audio_transcript.delta', response_id: 'r', delta: 'fixture' })); ws.send(JSON.stringify({ type: 'response.function_call_arguments.done', response_id: 'r', call_id: 'c', name: 'perform_action', arguments: '{"action":"wave"}' })); ws.send(JSON.stringify({ type: 'response.audio.done', response_id: 'r' })); ws.send(JSON.stringify({ type: 'response.done', response_id: 'r' })); } }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture' }); const seen: string[] = []; let bytes = 0; let done = 0;
    a.on('responseStarted', (id) => seen.push(`start:${id}`)); a.on('audioDelta', (_id, p) => { bytes += p.length; }); a.on('textDelta', (_id, t) => seen.push(`text:${t}`)); a.on('toolCall', (_id, c, n) => seen.push(`tool:${c}:${n}`)); a.on('responseDone', (id) => { done++; seen.push(`done:${id}`); });
    await a.connect({ instructions: 'fixture', tools: [{ name: 'perform_action', description: 'fixture', parameters: {} }] }); await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(['start:r', 'text:fixture', 'tool:c:perform_action', 'done:r']); expect(bytes).toBe(2); expect(done).toBe(1); a.close();
  });

  it('emits one responseStarted when both start events share an id', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s);
    await new Promise<void>((r) => s.once('listening', r));
    const port = (s.address() as { port: number }).port;
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (e.type === 'session.update') {
        ws.send(JSON.stringify({ type: 'session.created' }));
        ws.send(JSON.stringify({ type: 'session.updated' }));
        ws.send(JSON.stringify({ type: 'response.created', response: { id: 'same' } }));
        ws.send(JSON.stringify({ type: 'response.audio.started', response_id: 'same' }));
      }
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture' });
    const started: string[] = [];
    a.on('responseStarted', (id) => started.push(id));
    await a.connect({ instructions: 'fixture', tools: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual(['same']);
    a.close();
  });

  it('sends the tool result without starting its own response', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    const sent: Array<Record<string, unknown>> = [];
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as Record<string, unknown>;
      sent.push(e);
      if (e.type === 'session.update') { ws.send(JSON.stringify({ type: 'session.created' })); ws.send(JSON.stringify({ type: 'session.updated' })); }
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture' });
    await a.connect({ instructions: 'fixture', tools: [] });
    a.sendToolResult('call-1', { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const tail = sent.slice(1);
    // The session drives the single continuation; a bare response.create here would race it.
    expect(tail.map((e) => e.type)).toEqual(['conversation.item.create']);
    expect(tail[0]?.item).toMatchObject({ type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' });
    a.createResponse({ cue: 'toolContinue', instruction: '请直接说下面这句话，不要改写：好', fallbackText: '好' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent.slice(1).map((e) => e.type)).toEqual(['conversation.item.create', 'conversation.item.create', 'response.create']);
    a.close();
  });

  it('creates a response after sending debug user text', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    const types: string[] = [];
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()); types.push(e.type);
      if (e.type === 'session.update') { ws.send(JSON.stringify({ type: 'session.created' })); ws.send(JSON.stringify({ type: 'session.updated' })); }
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture' });
    await a.connect({ instructions: 'fixture', tools: [] });
    a.sendUserText('fixture user');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(types).toEqual(['session.update', 'conversation.item.create', 'response.create']);
    a.close();
  });

  it('changes the voice mid-session and falls back to the configured voice', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    const sent: Array<Record<string, unknown>> = [];
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as Record<string, unknown>;
      sent.push(e);
      if (e.type === 'session.update') { ws.send(JSON.stringify({ type: 'session.created' })); ws.send(JSON.stringify({ type: 'session.updated' })); }
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'voice-default' });
    await a.connect({ instructions: 'fixture', tools: [], voice: 'voice-en' });
    a.updateVoice('voice-zh');
    a.updateVoice(undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updates = sent.filter((e) => e.type === 'session.update').map((e) => e.session);
    expect(updates[0]).toMatchObject({ audio: { output: { voice: 'voice-en' } } });
    expect(updates[1]).toEqual({ audio: { output: { voice: 'voice-zh' } } });
    expect(updates[2]).toEqual({ audio: { output: { voice: 'voice-default' } } });
    a.close();
  });

  it('sends one partial session.update for a combined instructions and voice change', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    const sent: Array<Record<string, unknown>> = [];
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as Record<string, unknown>;
      sent.push(e);
      if (e.type === 'session.update' && sent.length === 1) { ws.send(JSON.stringify({ type: 'session.created' })); ws.send(JSON.stringify({ type: 'session.updated' })); }
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'voice-default' });
    await a.connect({ instructions: 'fixture', tools: [], voice: 'voice-en' });
    a.updateSession({ instructions: 'next', voice: { value: 'voice-zh' } });
    a.updateSession({ instructions: 'only instructions' });
    a.updateSession({ voice: { value: undefined } });
    a.updateSession({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updates = sent.filter((e) => e.type === 'session.update').map((e) => e.session);
    expect(updates.slice(1)).toEqual([
      { instructions: 'next', audio: { output: { voice: 'voice-zh' } } },
      { instructions: 'only instructions' },
      { audio: { output: { voice: 'voice-default' } } },
    ]);
    a.close();
  });

  it('waits for session.created before resolving or sending audio', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    let release!: () => void;
    const created = new Promise<void>((resolve) => { release = resolve; });
    let audioAppends = 0;
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString());
      if (e.type === 'session.update') { void created.then(() => { ws.send(JSON.stringify({ type: 'session.created' })); ws.send(JSON.stringify({ type: 'session.updated' })); }); }
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

  it('configures server-side speech detection and speaks a proactive request in the verified mode', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    let session: Record<string, unknown> | undefined;
    const sent: Array<Record<string, unknown>> = [];
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as Record<string, unknown>;
      sent.push(e);
      if (e.type === 'session.update' && !session) {
        session = e.session as Record<string, unknown>;
        ws.send(JSON.stringify({ type: 'session.created' }));
        ws.send(JSON.stringify({ type: 'session.updated' }));
      }
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture-voice' });
    await a.connect({ instructions: 'base', tools: [] });
    a.updateInstructions('updated');
    const request = { cue: 'greeting' as const, instruction: 'fixture instruction', fallbackText: 'unused' };
    a.createResponse(request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session?.turn_detection).toEqual({ type: 'semantic_vad', silence_duration_ms: 800 });
    expect(session?.input_audio_transcription).toEqual({ model: 'qwen3-asr-flash-realtime' });
    expect(session && 'max_response_output_tokens' in session).toBe(false);
    expect(sent.slice(2)).toEqual(proactiveEvents(RESPONSE_INSTRUCTIONS, 'updated', request));
    a.close();
  });

  it('uses the item fallback as the active mode pending the probe', () => {
    expect(RESPONSE_INSTRUCTIONS).toBe('item');
  });

  it('builds proactive events for each instruction mode', () => {
    const r = { cue: 'followup' as const, instruction: 'TASK', fallbackText: 'f' };
    expect(proactiveEvents('replace', 'BASE', r)).toEqual([{ type: 'response.create', response: { instructions: 'BASE\n\n## 本次任务\nTASK' } }]);
    expect(proactiveEvents('append', 'BASE', r)).toEqual([{ type: 'response.create', response: { instructions: 'TASK' } }]);
    expect(proactiveEvents('item', 'BASE', r)).toEqual([
      { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${SYSTEM_NOTE_PREFIX}TASK` }] } },
      { type: 'response.create' },
    ]);
  });

  it('sends the output cap only when configured and never turns context notes into user items', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    const sent: Array<Record<string, unknown>> = [];
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as Record<string, unknown>;
      sent.push(e);
      if (e.type === 'session.update') { ws.send(JSON.stringify({ type: 'session.created' })); ws.send(JSON.stringify({ type: 'session.updated' })); }
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture' });
    await a.connect({ instructions: 'fixture', tools: [], maxOutputTokens: 120 });
    a.injectContextNote('助手上一句只说到：「你好」，被用户打断。');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((sent[0]?.session as Record<string, unknown>).max_response_output_tokens).toBe(120);
    expect(sent).toHaveLength(1);
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

  it('uses the per-session voice when the session config provides one', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    const voices: unknown[] = [];
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as { type: string; session?: { audio?: { output?: { voice?: unknown } } } };
      if (e.type === 'session.update') {
        voices.push(e.session?.audio?.output?.voice);
        ws.send(JSON.stringify({ type: 'session.created' }));
        ws.send(JSON.stringify({ type: 'session.updated' }));
      }
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'default-voice' });
    await a.connect({ instructions: 'fixture', tools: [], voice: 'session-voice' });
    a.close();
    const b = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'default-voice' });
    await b.connect({ instructions: 'fixture', tools: [] });
    b.close();
    expect(voices).toEqual(['session-voice', 'default-voice']);
  });
  it('emits speech stop and token usage from server events', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as { type: string };
      if (e.type !== 'session.update') return;
      ws.send(JSON.stringify({ type: 'session.updated' }));
      ws.send(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'r1' } }));
      ws.send(JSON.stringify({ type: 'response.done', response: { id: 'r1', status: 'completed', usage: { input_tokens: 321, output_tokens: 45 } } }));
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture' });
    const seen: unknown[] = [];
    a.on('userSpeechStopped', () => seen.push('stopped'));
    a.on('responseUsage', (id, usage) => seen.push([id, usage]));
    await a.connect({ instructions: 'fixture', tools: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual(['stopped', ['r1', { inputTokens: 321, outputTokens: 45 }]]);
    a.close();
  });

  it('splits realtime usage into text and audio tokens', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as { type: string };
      if (e.type !== 'session.update') return;
      ws.send(JSON.stringify({ type: 'session.updated' }));
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'r1' } }));
      ws.send(JSON.stringify({ type: 'response.done', response: { id: 'r1', status: 'completed', usage: {
        input_tokens: 300, output_tokens: 90,
        input_tokens_details: { text_tokens: 260, audio_tokens: 40, cached_tokens: 0 },
        output_tokens_details: { text_tokens: 15, audio_tokens: 75 },
      } } }));
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'r2' } }));
      ws.send(JSON.stringify({ type: 'response.done', response: { id: 'r2', status: 'completed', usage: {
        input_tokens: 10, output_tokens: 5,
        input_token_details: { text_tokens: 8, audio_tokens: 2 },
        output_token_details: { text_tokens: 1, audio_tokens: 4 },
      } } }));
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture' });
    const seen: unknown[] = [];
    a.on('responseUsage', (id, usage) => seen.push([id, usage]));
    await a.connect({ instructions: 'fixture', tools: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([
      ['r1', { inputTokens: 300, outputTokens: 90, inputTextTokens: 260, inputAudioTokens: 40, cachedTokens: 0, outputTextTokens: 15, outputAudioTokens: 75 }],
      ['r2', { inputTokens: 10, outputTokens: 5, inputTextTokens: 8, inputAudioTokens: 2, outputTextTokens: 1, outputAudioTokens: 4 }],
    ]);
    a.close();
  });

  it('uses the configured turn detection and initial speech rate', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s);
    await new Promise<void>((r) => s.once('listening', r));
    const port = (s.address() as { port: number }).port;
    const updates: Array<Record<string, any>> = [];
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString());
      if (e.type === 'session.update') {
        updates.push(e.session);
        ws.send(JSON.stringify({ type: 'session.created' }));
        ws.send(JSON.stringify({ type: 'session.updated' }));
      }
    }));
    const a = new QwenAdapter({
      apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture',
      turnDetection: { type: 'server_vad', silenceDurationMs: 800 }, speechRate: 1,
    });
    await a.connect({ instructions: 'fixture', tools: [] });
    expect(updates[0]).toMatchObject({
      turn_detection: { type: 'server_vad', silence_duration_ms: 800 },
      speech_rate: 1,
    });
    a.close();
  });

  it('omits speech_rate when the model does not support it', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s);
    await new Promise<void>((r) => s.once('listening', r));
    const port = (s.address() as { port: number }).port;
    const updates: Array<Record<string, any>> = [];
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString());
      if (e.type === 'session.update') {
        updates.push(e.session);
        ws.send(JSON.stringify({ type: 'session.created' }));
        ws.send(JSON.stringify({ type: 'session.updated' }));
      }
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture', speechRate: null });
    await a.connect({ instructions: 'fixture', tools: [] });
    expect(updates[0]).not.toHaveProperty('speech_rate');
    a.close();
  });

  it('adds speech_rate to a partial session.update only when supported', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s);
    await new Promise<void>((r) => s.once('listening', r));
    const port = (s.address() as { port: number }).port;
    const sent: Array<Record<string, any>> = [];
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString());
      sent.push(e);
      if (e.type === 'session.update') {
        ws.send(JSON.stringify({ type: 'session.created' }));
        ws.send(JSON.stringify({ type: 'session.updated' }));
      }
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture', speechRate: 1 });
    await a.connect({ instructions: 'fixture', tools: [] });
    a.updateSession({ speechRate: 0.8 });
    a.updateSession({ instructions: 'next', speechRate: 0.6 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updates = sent.filter((e) => e.type === 'session.update').map((e) => e.session);
    expect(updates.slice(1)).toEqual([
      { speech_rate: 0.8 },
      { instructions: 'next', speech_rate: 0.6 },
    ]);
    a.close();
  });

  it('does not send voice updates on a connect-only model', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s);
    await new Promise<void>((r) => s.once('listening', r));
    const port = (s.address() as { port: number }).port;
    const sent: Array<Record<string, any>> = [];
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString());
      sent.push(e);
      if (e.type === 'session.update') {
        ws.send(JSON.stringify({ type: 'session.created' }));
        ws.send(JSON.stringify({ type: 'session.updated' }));
      }
    }));
    const a = new QwenAdapter({
      apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture', supportsVoiceUpdate: false,
    });
    await a.connect({ instructions: 'fixture', tools: [] });
    a.updateVoice('voice-two');
    a.updateSession({ voice: { value: 'voice-three' } });
    a.updateSession({ instructions: 'next' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updates = sent.filter((e) => e.type === 'session.update').map((e) => e.session);
    expect(updates).toEqual([expect.objectContaining({ instructions: 'fixture' }), { instructions: 'next' }]);
    a.close();
  });

  it('normalizes tool schemas so every function has required', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s);
    await new Promise<void>((r) => s.once('listening', r));
    const port = (s.address() as { port: number }).port;
    const updates: Array<Record<string, any>> = [];
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString());
      if (e.type === 'session.update') {
        updates.push(e.session);
        ws.send(JSON.stringify({ type: 'session.created' }));
        ws.send(JSON.stringify({ type: 'session.updated' }));
      }
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture' });
    await a.connect({
      instructions: 'fixture',
      tools: [
        { name: 'list_memory', description: 'x', parameters: { type: 'object', properties: {} } },
        { name: 'get_weather', description: 'x', parameters: { type: 'object', properties: { location: { type: 'string' } } } },
        { name: 'perform_action', description: 'x', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
      ],
    });
    const tools = updates[0]!.tools as Array<Record<string, any>>;
    expect(tools[0]!.parameters.required).toEqual([]);
    expect(tools[1]!.parameters.required).toEqual([]);
    expect(tools[2]!.parameters.required).toEqual(['action']);
    a.close();
  });
});
