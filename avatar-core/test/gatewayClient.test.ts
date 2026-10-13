import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAME_AI, encodeAudioFrame, type ServerMessage } from '@anyidea/protocol';
import { GatewayClient, type ClientStatus, type WebSocketLike } from '../src/net/gatewayClient.ts';

class FakeWS implements WebSocketLike {
  static instances: FakeWS[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string | Uint8Array) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onclose?.(); }
  json(i: number) { return JSON.parse(this.sent[i] as string); }
}

const tokens = (n: number) => ({ sessionId: 's1', connectToken: `c${n}`, resumeToken: `r${n}` });

function setup(
  responses: Array<{ status: number; body: unknown }>,
  options: { requestTimeoutMs?: number; socketTimeoutMs?: number } = {},
) {
  FakeWS.instances = [];
  const calls: Array<{ url: string; body: unknown; secret: string | null }> = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null, secret: headers.get('x-app-secret') });
    const r = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  const messages: ServerMessage[] = [];
  const audio: Array<[number, number[]]> = [];
  const statuses: ClientStatus[] = [];
  const client = new GatewayClient(
    {
      baseUrl: 'http://gw.test',
      appSecret: 'sekret',
      clientInfo: { platform: 'android', audioPath: 'A' },
      fetchFn,
      WebSocketCtor: FakeWS,
      maxResumeMs: 10_000,
      ...options,
    },
    { onMessage: (m) => messages.push(m), onAudio: (s, p) => audio.push([s, Array.from(p)]), onStatus: (s) => statuses.push(s) },
  );
  return { client, calls, messages, audio, statuses };
}

describe('GatewayClient', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('creates a session and sends session.start on open', async () => {
    const t = setup([{ status: 200, body: tokens(1) }]);
    await t.client.start();
    expect(t.calls[0]).toEqual({ url: 'http://gw.test/session', body: {}, secret: 'sekret' });
    const ws = FakeWS.instances[0];
    expect(ws.url).toBe('ws://gw.test/ws?token=c1');
    expect(ws.binaryType).toBe('arraybuffer');
    ws.open();
    expect(ws.json(0)).toEqual({ type: 'session.start', clientInfo: { platform: 'android', audioPath: 'A' } });
    expect(t.statuses).toEqual(['connecting', 'open']);
  });

  it('routes text and audio frames', async () => {
    const t = setup([{ status: 200, body: tokens(1) }]);
    await t.client.start();
    const ws = FakeWS.instances[0];
    ws.open();
    ws.onmessage?.({ data: JSON.stringify({ type: 'response.start', responseSeq: 1, kind: 'greeting' }) });
    const frame = encodeAudioFrame(FRAME_AI, 1, Int16Array.from([5, -5]));
    ws.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
    expect(t.messages).toEqual([{ type: 'response.start', responseSeq: 1, kind: 'greeting' }]);
    expect(t.audio).toEqual([[1, [5, -5]]]);
  });

  it('ignores malformed text frames without throwing', async () => {
    const t = setup([{ status: 200, body: tokens(1) }]);
    await t.client.start();
    const ws = FakeWS.instances[0];
    ws.open();

    expect(() => ws.onmessage?.({ data: '{not-json' })).not.toThrow();
    expect(t.messages).toEqual([]);
  });

  it('ignores messages from a superseded socket', async () => {
    const t = setup([{ status: 200, body: tokens(1) }, { status: 200, body: tokens(2) }]);
    await t.client.start();
    const first = FakeWS.instances[0];
    first.open();
    first.onmessage?.({ data: JSON.stringify({ type: 'session.ready', sessionId: 's1' }) });
    first.drop();
    await vi.advanceTimersByTimeAsync(500);
    const second = FakeWS.instances[1];

    first.onmessage?.({ data: JSON.stringify({ type: 'session.ready', sessionId: 'stale' }) });
    expect(t.messages).toHaveLength(1);
    second.open();
    second.onmessage?.({ data: JSON.stringify({ type: 'session.resumed', lastResponseSeq: 0 }) });
    expect(t.messages).toHaveLength(2);
    expect(t.messages.at(-1)).toEqual({ type: 'session.resumed', lastResponseSeq: 0 });
  });

  it('only sends when open', async () => {
    const t = setup([{ status: 200, body: tokens(1) }]);
    await t.client.start();
    const ws = FakeWS.instances[0];
    t.client.send({ type: 'client.mute', muted: true });
    t.client.sendAudio(new Int16Array(320));
    expect(ws.sent).toEqual([]);
    ws.open();
    t.client.sendAudio(new Int16Array(320));
    expect(ws.sent[1]).toBeInstanceOf(Uint8Array);
  });

  it('resumes after an unexpected drop', async () => {
    const t = setup([{ status: 200, body: tokens(1) }, { status: 200, body: tokens(2) }]);
    await t.client.start();
    FakeWS.instances[0].open();
    FakeWS.instances[0].onmessage?.({ data: JSON.stringify({ type: 'session.ready', sessionId: 's1' }) });
    FakeWS.instances[0].drop();
    expect(t.statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(t.calls[1]).toEqual({ url: 'http://gw.test/session/resume', body: { sessionId: 's1', resumeToken: 'r1' }, secret: 'sekret' });
    const ws2 = FakeWS.instances[1];
    expect(ws2.url).toBe('ws://gw.test/ws?token=c2');
    ws2.open();
    expect(ws2.json(0)).toEqual({ type: 'session.resume', sessionId: 's1' });
  });

  it('starts a fresh session when the old one is gone', async () => {
    const t = setup([
      { status: 200, body: tokens(1) },
      { status: 404, body: { error: 'session_gone' } },
      { status: 200, body: tokens(3) },
    ]);
    await t.client.start();
    FakeWS.instances[0].open();
    FakeWS.instances[0].drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(t.calls.map((c) => c.url)).toEqual(['http://gw.test/session', 'http://gw.test/session/resume', 'http://gw.test/session']);
    const ws = FakeWS.instances[1];
    ws.open();
    expect(ws.json(0).type).toBe('session.start');
  });

  it('backs off while the gateway is unreachable, then falls back to a fresh session after maxResumeMs', async () => {
    const t = setup([{ status: 200, body: tokens(1) }, ...Array.from({ length: 5 }, () => ({ status: 503, body: {} })), { status: 200, body: tokens(9) }]);
    await t.client.start();
    FakeWS.instances[0].open();
    FakeWS.instances[0].drop();
    const resumes = () => t.calls.filter((c) => c.url.endsWith('/session/resume')).length;
    // Retries at 0.5, 1.5, 3.5, 7.5 s (backoff 500/1000/2000/4000 ms).
    await vi.advanceTimersByTimeAsync(7_500);
    expect(resumes()).toBe(4);
    expect(FakeWS.instances).toHaveLength(1);
    // 5th retry at 11.5 s fails; 11.5 s > maxResumeMs (10 s), so the client creates a fresh session instead of a 6th retry.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(resumes()).toBe(5);
    expect(t.calls.map((c) => c.url).at(-1)).toBe('http://gw.test/session');
    expect(FakeWS.instances).toHaveLength(2);
    const ws = FakeWS.instances[1];
    expect(ws.url).toBe('ws://gw.test/ws?token=c9');
    ws.open();
    expect(ws.json(0).type).toBe('session.start');
    expect(t.statuses.at(-1)).toBe('open');
  });

  it('falls back to a fresh session when post-open closes repeat without session.ready', async () => {
    const t = setup([{ status: 200, body: tokens(1) }, ...Array.from({ length: 30 }, (_, i) => ({ status: 200, body: tokens(i + 2) }))]);
    await t.client.start();
    // Upgrade aborts after the connect token was claimed: session.start never reached the gateway.
    FakeWS.instances[0].drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(t.calls[1].url).toBe('http://gw.test/session/resume');
    const ws2 = FakeWS.instances[1];
    ws2.open();
    // The session never started, so the new socket must start it rather than resume.
    expect(ws2.json(0).type).toBe('session.start');
    // From here the gateway closes every socket right after open (e.g. 4002 bad_state).
    for (let i = 0; i < 40 && !t.calls.slice(1).some((c) => c.url === 'http://gw.test/session'); i++) {
      FakeWS.instances.at(-1)!.open();
      FakeWS.instances.at(-1)!.drop();
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(t.calls.slice(1).some((c) => c.url === 'http://gw.test/session')).toBe(true);
    expect(FakeWS.instances.length).toBeLessThan(12);
    expect(t.calls.length).toBeLessThan(12);
    const fresh = FakeWS.instances.at(-1)!;
    fresh.open();
    expect(fresh.json(0).type).toBe('session.start');
    fresh.onmessage?.({ data: JSON.stringify({ type: 'session.ready', sessionId: 's1' }) });
    expect(t.statuses.at(-1)).toBe('open');
  });

  it('resets backoff only after session.resumed, then resumes again on the next drop', async () => {
    const t = setup([{ status: 200, body: tokens(1) }, { status: 200, body: tokens(2) }, { status: 200, body: tokens(3) }]);
    await t.client.start();
    const ws1 = FakeWS.instances[0];
    ws1.open();
    ws1.onmessage?.({ data: JSON.stringify({ type: 'session.ready', sessionId: 's1' }) });
    ws1.drop();
    await vi.advanceTimersByTimeAsync(500);
    const ws2 = FakeWS.instances[1];
    ws2.open();
    expect(ws2.json(0)).toEqual({ type: 'session.resume', sessionId: 's1' });
    ws2.onmessage?.({ data: JSON.stringify({ type: 'session.resumed', lastResponseSeq: 0 }) });
    ws2.drop();
    // Backoff was reset by session.resumed, so the next retry fires after the base delay.
    await vi.advanceTimersByTimeAsync(500);
    expect(t.calls.map((c) => c.url)).toEqual(['http://gw.test/session', 'http://gw.test/session/resume', 'http://gw.test/session/resume']);
    FakeWS.instances[2].open();
    expect(FakeWS.instances[2].json(0).type).toBe('session.resume');
  });

  it('close() during an in-flight reconnect POST opens no new socket', async () => {
    const t = setup([{ status: 200, body: tokens(1) }, { status: 200, body: tokens(2) }]);
    await t.client.start();
    FakeWS.instances[0].open();
    FakeWS.instances[0].drop();
    // Fire the retry timer; the resume POST is now pending.
    vi.advanceTimersByTime(500);
    expect(t.calls).toHaveLength(2);
    t.client.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(t.client.isOpen).toBe(false);
    expect(t.statuses.at(-1)).toBe('closed');
  });

  it('close() while reconnecting emits closed', async () => {
    const t = setup([{ status: 200, body: tokens(1) }]);
    await t.client.start();
    FakeWS.instances[0].open();
    FakeWS.instances[0].drop();
    expect(t.statuses.at(-1)).toBe('reconnecting');
    t.client.close();
    expect(t.statuses.at(-1)).toBe('closed');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.calls).toHaveLength(1);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('close() ends the session without reconnecting', async () => {
    const t = setup([{ status: 200, body: tokens(1) }]);
    await t.client.start();
    const ws = FakeWS.instances[0];
    ws.open();
    t.client.close();
    expect(ws.json(0).type).toBe('session.start');
    expect(ws.json(1)).toEqual({ type: 'session.end' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(t.statuses.at(-1)).toBe('closed');
  });

  it('close() is idempotent', async () => {
    const t = setup([{ status: 200, body: tokens(1) }]);
    await t.client.start();
    const ws = FakeWS.instances[0];
    ws.open();
    t.client.close();
    t.client.close();

    expect(ws.sent.filter((data) => typeof data === 'string' && JSON.parse(data).type === 'session.end')).toHaveLength(1);
    expect(t.statuses.filter((status) => status === 'closed')).toHaveLength(1);
  });

  it('aborts a session request that exceeds the request timeout', async () => {
    FakeWS.instances = [];
    let aborted = false;
    const fetchFn = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
    ) as unknown as typeof fetch;
    const client = new GatewayClient(
      {
        baseUrl: 'http://gw.test',
        appSecret: 'sekret',
        clientInfo: { platform: 'android', audioPath: 'A' },
        fetchFn,
        WebSocketCtor: FakeWS,
        requestTimeoutMs: 1000,
      },
      { onMessage: () => {}, onAudio: () => {}, onStatus: () => {} },
    );

    const result = expect(client.start()).rejects.toThrow('gateway_request_timeout');
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(aborted).toBe(true);
  });

  it('closes a socket that never opens and schedules reconnect', async () => {
    const t = setup([{ status: 200, body: tokens(1) }], { socketTimeoutMs: 1000 });
    await t.client.start();
    const ws = FakeWS.instances[0];

    await vi.advanceTimersByTimeAsync(1000);

    expect(ws.readyState).toBe(3);
    expect(t.statuses.at(-1)).toBe('reconnecting');
  });
});
