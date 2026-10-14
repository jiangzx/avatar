import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { SeeduplexAdapter } from '../src/adapters/seeduplex.ts';

const config = { instructions: 'safe fixture', tools: [{ name: 'perform_action', description: 'fixture', parameters: { type: 'object' } }] };
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe('SeeduplexAdapter', () => {
  const servers: WebSocketServer[] = [];
  afterEach(async () => { for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('maps documented session, audio, text, tool and cancel events without logging payloads', async () => {
    const server = new WebSocketServer({ port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as { type: string };
      if (event.type === 'session.create') socket.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture' } }));
      if (event.type === 'speech_text_buffer.commit') {
        socket.send(JSON.stringify({ type: 'response.output_audio.started', response_id: 'r1' }));
        socket.send(JSON.stringify({ type: 'response.output_text.delta', response_id: 'r1', delta: 'fixture text' }));
        socket.send(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'r1', delta: Buffer.from(new Int16Array([1, 2]).buffer).toString('base64') }));
        socket.send(JSON.stringify({ type: 'response.function_call_arguments.done', response_id: 'r1', items: [{ call_id: 'c1', name: 'perform_action', arguments: '{"action":"wave"}' }] }));
        socket.send(JSON.stringify({ type: 'response.output_audio.done', response_id: 'r1' }));
      }
      if (event.type === 'response.cancel') socket.send(JSON.stringify({ type: 'response.canceled', response_id: 'r1' }));
    }));
    const adapter = new SeeduplexAdapter({ apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture-voice', proactiveTexts: new Map([['G', 'safe greeting']]) });
    const events: string[] = []; let samples = 0;
    adapter.on('responseStarted', (id) => events.push(`start:${id}`));
    adapter.on('textDelta', (_id, text) => events.push(`text:${text}`));
    adapter.on('audioDelta', (_id, pcm) => { samples += pcm.length; });
    adapter.on('toolCall', (_id, callId, name) => events.push(`tool:${callId}:${name}`));
    adapter.on('responseDone', (id) => events.push(`done:${id}`));
    adapter.on('responseCancelled', (id) => events.push(`cancel:${id}`));
    await adapter.connect(config); await wait(); adapter.createResponse('G'); await wait();
    expect(events).toEqual(['start:r1', 'text:fixture text', 'tool:c1:perform_action', 'done:r1']);
    expect(samples).toBe(2);
    adapter.cancelResponse(); await wait();
    expect(events).toContain('cancel:r1');
    adapter.close();
  });

  it('emits a non-retryable error for malformed upstream JSON', async () => {
    const server = new WebSocketServer({ port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    server.on('connection', (socket) => socket.on('message', () => socket.send('{bad')));
    const adapter = new SeeduplexAdapter({ apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture-voice' });
    const errors: Array<[string, boolean]> = []; adapter.on('error', (code, retryable) => errors.push([code, retryable]));
    await adapter.connect(config); await wait();
    expect(errors).toEqual([['upstream_invalid_json', false]]);
    adapter.close();
  });
});
