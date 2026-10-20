import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { SeeduplexAdapter } from '../src/adapters/seeduplex.ts';

const config = { instructions: 'safe fixture', tools: [{ name: 'perform_action', description: 'fixture', parameters: { type: 'object' } }] };
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe('SeeduplexAdapter', () => {
  const servers: WebSocketServer[] = [];
  afterEach(async () => { for (const server of servers) { for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); } });

  it('maps documented session, audio, text, tool and cancel events without logging payloads', async () => {
    const server = new WebSocketServer({ port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const committed: string[] = [];
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as { type: string; text?: string };
      if (event.type === 'session.create') socket.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture' } }));
      if (event.type === 'speech_text_buffer.commit') {
        committed.push(event.text ?? '');
        socket.send(JSON.stringify({ type: 'response.output_audio.started', response_id: 'r1' }));
        socket.send(JSON.stringify({ type: 'response.output_text.delta', response_id: 'r1', delta: 'fixture text' }));
        socket.send(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'r1', delta: Buffer.from(new Int16Array([1, 2]).buffer).toString('base64') }));
        socket.send(JSON.stringify({ type: 'response.function_call_arguments.done', response_id: 'r1', items: [{ call_id: 'c1', name: 'perform_action', arguments: '{"action":"wave"}' }] }));
        socket.send(JSON.stringify({ type: 'response.output_audio.done', response_id: 'r1' }));
      }
      if (event.type === 'response.cancel') socket.send(JSON.stringify({ type: 'response.canceled', response_id: 'r1' }));
    }));
    const adapter = new SeeduplexAdapter({ apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture-voice' });
    const events: string[] = []; let samples = 0;
    adapter.on('responseStarted', (id) => events.push(`start:${id}`));
    adapter.on('textDelta', (_id, text) => events.push(`text:${text}`));
    adapter.on('audioDelta', (_id, pcm) => { samples += pcm.length; });
    adapter.on('toolCall', (_id, callId, name) => events.push(`tool:${callId}:${name}`));
    adapter.on('responseDone', (id) => events.push(`done:${id}`));
    adapter.on('responseCancelled', (id) => events.push(`cancel:${id}`));
    await adapter.connect(config); await wait(); adapter.createResponse({ cue: 'greeting', instruction: 'INTERNAL PROMPT DO NOT SPEAK', fallbackText: 'safe greeting' }); await wait();
    expect(events).toEqual(['start:r1', 'text:fixture text', 'tool:c1:perform_action', 'done:r1']);
    expect(samples).toBe(2);
    // speech_text_buffer.commit is direct TTS: only the spoken copy may be committed.
    expect(committed).toEqual(['safe greeting']);
    adapter.cancelResponse(); await wait();
    expect(events).toContain('cancel:r1');
    adapter.close();
  });

  it('emits a non-retryable error for malformed upstream JSON', async () => {
    const server = new WebSocketServer({ port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    server.on('connection', (socket) => socket.on('message', (raw) => {
      if (JSON.parse(raw.toString()).type === 'session.create') {
        socket.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture' } }));
        socket.send('{bad');
      }
    }));
    const adapter = new SeeduplexAdapter({ apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture-voice' });
    const errors: Array<[string, boolean]> = []; adapter.on('error', (code, retryable) => errors.push([code, retryable]));
    await adapter.connect(config); await wait();
    expect(errors).toEqual([['upstream_invalid_json', false]]);
    adapter.close();
  });

  it('maps input mute transitions to the documented keepalive events', async () => {
    const server = new WebSocketServer({ port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const types: string[] = [];
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as { type: string };
      types.push(event.type);
      if (event.type === 'session.create') socket.send(JSON.stringify({ type: 'session.created' }));
    }));
    const adapter = new SeeduplexAdapter({ apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture-voice' });
    await adapter.connect(config);
    adapter.setInputMuted(true);
    adapter.setInputMuted(false);
    await wait();
    expect(types).toEqual(['session.create', 'input_audio_mute.commit', 'input_audio_unmute.commit']);
    adapter.close();
  });
  it('does not become ready or send audio until session.created arrives', async () => {
    const server = new WebSocketServer({ port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    let acknowledge: () => void = () => {};
    let receivedCreate!: () => void;
    const created = new Promise<void>((resolve) => { receivedCreate = resolve; });
    const audio: string[] = [];
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'session.create') {
        acknowledge = () => socket.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture' } }));
        receivedCreate();
      }
      if (event.type === 'input_audio_buffer.append') audio.push(event.type);
    }));
    const adapter = new SeeduplexAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture' });
    try {
      let ready = false;
      const connecting = adapter.connect(config).then(() => { ready = true; });
      await created;
      adapter.sendAudio(new Int16Array(320));
      await wait();
      expect(ready).toBe(false);
      expect(audio).toEqual([]);
      acknowledge();
      await connecting;
      expect(ready).toBe(true);
    } finally { adapter.close(); }
  });

  it.each(['timeout', 'upstream_error', 'socket_close', 'intentional_close'] as const)(
    'rejects initialization on %s without a ready session', async (failure) => {
      const server = new WebSocketServer({ port: 0 }); servers.push(server);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as { port: number }).port;
      const adapter = new SeeduplexAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture', connectTimeoutMs: 100 });
      server.on('connection', (socket) => socket.on('message', (raw) => {
        if (JSON.parse(raw.toString()).type !== 'session.create') return;
        if (failure === 'upstream_error') socket.send(JSON.stringify({ type: 'error', error: { code: 'fixture_denied', message: 'must not propagate upstream content' } }));
        if (failure === 'socket_close') socket.close();
        if (failure === 'intentional_close') adapter.close();
      }));
      const closed: string[] = [];
      adapter.on('closed', () => closed.push('closed'));
      try {
        const expected = { timeout: 'seeduplex_connect_timeout', upstream_error: 'seeduplex_session_rejected', socket_close: 'seeduplex_connect_closed', intentional_close: 'seeduplex_connect_closed' }[failure];
        await expect(adapter.connect(config)).rejects.toThrow(expected);
        await wait();
        if (failure === 'intentional_close') expect(closed).toEqual([]);
      } finally { adapter.close(); }
    },
  );


  it('uses the per-session voice when the session config provides one', async () => {
    const server = new WebSocketServer({ port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const voices: unknown[] = [];
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as { type: string; session?: { audio?: { output?: { voice?: unknown } } } };
      if (event.type === 'session.create') {
        voices.push(event.session?.audio?.output?.voice);
        socket.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture' } }));
      }
    }));
    const adapter = new SeeduplexAdapter({ apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${port}`, voice: 'default-voice' });
    await adapter.connect({ ...config, voice: 'session-voice' }); await wait();
    adapter.close();
    expect(voices).toEqual(['session-voice']);
  });
});
