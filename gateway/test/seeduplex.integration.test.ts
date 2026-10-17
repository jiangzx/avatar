import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { FRAME_AI, decodeAudioFrame } from '@anyidea/protocol';
import { SeeduplexAdapter } from '../src/adapters/seeduplex.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import { makeOriginCheck } from '../src/config.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session } from '../src/session/session.ts';
import { SessionManager } from '../src/session/manager.ts';
import { createGatewayServer } from '../src/server/server.ts';

const SECRET = 'integration-secret-012345';
const upstreams: WebSocketServer[] = [];
let gateway: Server | null = null;
let manager: SessionManager | null = null;
const clients: WebSocket[] = [];

describe('Seeduplex gateway integration', () => {
  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    manager?.shutdown();
    await new Promise<void>((resolve) => (gateway ? gateway.close(() => resolve()) : resolve()));
    gateway = null;
    manager = null;
    for (const upstream of upstreams.splice(0)) {
      for (const client of upstream.clients) client.terminate();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('streams a Seeduplex greeting through the frozen gateway protocol', async () => {
    const upstream = new WebSocketServer({ port: 0 });
    upstreams.push(upstream);
    await new Promise<void>((resolve) => upstream.once('listening', resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    upstream.on('connection', (socket) => socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as { type?: string };
      if (event.type === 'session.create') socket.send(JSON.stringify({ type: 'session.created' }));
      if (event.type === 'speech_text_buffer.commit') {
        socket.send(JSON.stringify({ type: 'response.output_audio.started', response_id: 'fixture-response' }));
        socket.send(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'fixture-response', delta: Buffer.from(new Int16Array([1, 2]).buffer).toString('base64') }));
        socket.send(JSON.stringify({ type: 'response.output_audio.done', response_id: 'fixture-response' }));
      }
      if (event.type === 'session.close') socket.send(JSON.stringify({ type: 'session.closed' }));
    }));

    const director = {
      followupAfterMs: 60000, idleNoticeAfterMs: 60000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
      quietPhrases: [], greetingInstruction: 'greeting-instruction', greetingText: 'greeting-text',
      followupInstruction: 'followup-instruction', followupText: 'followup-text',
      idleNoticeInstruction: 'idle-instruction', idleNoticeText: 'idle-text',
      resumeInstruction: 'resume-instruction', resumeText: 'resume-text',
    };
    manager = new SessionManager(() => new Session({
      adapterFactory: () => new SeeduplexAdapter({
        apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${upstreamPort}`, voice: 'fixture',
      }),
      summarizer: new MockSummarizer(), roles: fixedRoleCatalog('P', director),
    }));
    gateway = createGatewayServer({ manager, appSecret: SECRET, allowedOrigin: makeOriginCheck([]), allowDebugText: false });
    await new Promise<void>((resolve) => gateway!.listen(0, '127.0.0.1', resolve));
    const port = (gateway.address() as AddressInfo).port;
    const created = await fetch(`http://127.0.0.1:${port}/session`, { method: 'POST', headers: { 'x-app-secret': SECRET, 'content-type': 'application/json' }, body: '{}' });
    const tokens = await created.json() as { connectToken: string };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(tokens.connectToken)}`);
    clients.push(ws);
    const messages: Array<{ type?: string; kind?: string }> = [];
    let audioFrames = 0;
    ws.on('message', (data, binary) => {
      if (binary) { if (decodeAudioFrame(new Uint8Array(data as Buffer))?.kind === FRAME_AI) audioFrames++; }
      else messages.push(JSON.parse(data.toString()) as { type?: string; kind?: string });
    });
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'session.start', clientInfo: { platform: 'integration', audioPath: 'A' } }));
    const deadline = Date.now() + 2000;
    while ((!messages.some((message) => message.type === 'response.end') || audioFrames === 0) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messages.some((message) => message.type === 'session.ready')).toBe(true);
    expect(messages.some((message) => message.type === 'response.start' && message.kind === 'greeting')).toBe(true);
    expect(messages.some((message) => message.type === 'response.end')).toBe(true);
    expect(audioFrames).toBeGreaterThan(0);
  });
});
