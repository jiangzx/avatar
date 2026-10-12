import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerMessage } from '@anyidea/protocol';
import { AppController, type AppConfig, type AppDeps, type ClientLike, type PlaybackLike } from '../src/app.ts';
import { PlaybackGate } from '../src/audio/playbackGate.ts';
import type { PlaybackEvents } from '../src/audio/player.ts';
import type { VadCallbacks } from '../src/audio/vad.ts';
import type { ToFlutter } from '../src/bridge.ts';
import type { GatewayClientEvents } from '../src/net/gatewayClient.ts';

const cfg: AppConfig = { gatewayUrl: 'http://127.0.0.1:8787', appSecret: 'x'.repeat(16), audioPath: 'A', avatarUrl: 'a.glb', echo: 'true' };

class FakePlayback implements PlaybackLike {
  readonly gate = new PlaybackGate();
  readonly calls: string[] = [];
  readonly played = new Map<number, number>();
  contextState: AudioContextState | 'none' = 'running';
  constructor(readonly ev: PlaybackEvents) {}
  get activeSeq() { return this.gate.active; }
  async init() { this.calls.push('init'); }
  async resume() {}
  onResponseStart(seq: number) { this.calls.push(`start:${seq}`); this.gate.start(seq); }
  push(seq: number) { if (this.gate.accepts(seq)) this.calls.push(`push:${seq}`); }
  end(seq: number) { this.calls.push(`end:${seq}`); }
  interrupt() {
    const seq = this.gate.active;
    if (seq === null) return null;
    this.gate.cancel(seq);
    this.calls.push(`interrupt:${seq}`);
    return { seq, playedMs: this.playedMsFor(seq) };
  }
  cancelled(seq: number) { this.calls.push(`cancelled:${seq}`); this.gate.cancel(seq); }
  resetAfterResume(last: number) { this.calls.push(`resetAfterResume:${last}`); this.gate.resetBelow(last); }
  resetForNewSession() { this.calls.push('resetForNewSession'); this.gate.reset(); this.played.clear(); }
  playedMsFor(seq: number) { return this.played.get(seq) ?? 0; }
}

function setup(opts: { startFails?: boolean } = {}) {
  const order: string[] = [];
  const posted: ToFlutter[] = [];
  const sent: ClientMessage[] = [];
  let playback!: FakePlayback;
  let clientEv!: GatewayClientEvents;
  let vadCb!: VadCallbacks;
  const client: ClientLike = {
    start: async () => { if (opts.startFails) throw new Error('http_503'); },
    send: (m) => { sent.push(m); },
    sendAudio: () => {},
    close: () => { order.push('client.close'); sent.push({ type: 'session.end' }); },
  };
  const vad = {
    aiPlaying: false,
    start: async (_s: MediaStream, cb: VadCallbacks) => { vadCb = cb; order.push('vad.start'); },
    destroy: async () => { order.push('vad.destroy'); },
  };
  const deps: AppDeps = {
    createPlayback: (ev) => (playback = new FakePlayback(ev)),
    capture: {
      start: async () => { order.push('capture.start'); return {} as MediaStream; },
      stop: async () => { order.push('capture.stop'); },
      setEnabled: () => {},
      settings: () => null,
    },
    vad,
    createAvatar: () => ({ load: async () => {}, talkingHead: {} as never, setMouth: () => {}, setEmotion: () => {}, enterState: () => {}, setRendering: () => {} }),
    createActions: () => ({ play: () => {}, stopAll: () => {}, nod: () => {} }),
    createClient: (_o, ev) => { clientEv = ev; return client; },
    post: (m) => posted.push(m),
    doc: { hidden: false, addEventListener: () => {} },
  };
  const app = new AppController({} as HTMLElement, cfg, deps);
  const server = (m: ServerMessage) => clientEv.onMessage(m);
  const audio = (seq: number) => clientEv.onAudio(seq, new Int16Array(240));
  const stopped = () => sent.filter((m) => m.type === 'playback.stopped');
  const states = () => posted.filter((m) => m.type === 'state').map((m) => (m as { state: string }).state);
  const subtitles = () => posted.filter((m) => m.type === 'subtitle' && m.role === 'assistant') as Array<Extract<ToFlutter, { type: 'subtitle' }>>;
  const metrics = () => posted.filter((m) => m.type === 'metric').map((m) => (m as { name: string }).name);
  return { app, deps, vad, order, posted, sent, server, audio, stopped, states, subtitles, metrics, pb: () => playback, vadCb: () => vadCb };
}

async function started(opts?: { startFails?: boolean }) {
  const t = setup(opts);
  await t.app.start();
  t.server({ type: 'session.ready', sessionId: 's1' });
  return t;
}

/** A response that has started playing (first audio heard). */
function playing(t: ReturnType<typeof setup>, seq: number) {
  t.server({ type: 'response.start', responseSeq: seq, kind: 'reply' });
  t.audio(seq);
  t.pb().ev.onFirstAudio(seq);
}

describe('AppController', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reports exactly one playback.stopped(ended) when a response drains', async () => {
    const t = await started();
    playing(t, 1);
    t.server({ type: 'response.end', responseSeq: 1 });
    t.pb().gate.finish(1);
    t.pb().ev.onEnded(1, 900);
    t.pb().ev.onEnded(1, 900); // duplicate drained must be ignored
    expect(t.stopped()).toEqual([{ type: 'playback.stopped', responseSeq: 1, playedMs: 900, reason: 'ended' }]);
    expect(t.states().at(-1)).toBe('idle');
  });

  it('still reports ended for a response without audio', async () => {
    const t = await started();
    t.server({ type: 'response.start', responseSeq: 1, kind: 'followup' });
    t.server({ type: 'response.end', responseSeq: 1 });
    expect(t.pb().calls).toContain('end:1');
    t.pb().ev.onEnded(1, 0); // the worklet answers 'end' for an unknown seq with drained(0)
    expect(t.stopped()).toEqual([{ type: 'playback.stopped', responseSeq: 1, playedMs: 0, reason: 'ended' }]);
  });

  it('a barge-in reports exactly one interrupted stop and ignores later worklet events for that seq', async () => {
    const t = await started();
    playing(t, 1);
    t.pb().played.set(1, 400);
    t.vadCb().onStart(performance.now());
    t.pb().ev.onEnded(1, 500);
    t.pb().ev.onStopped(1, 420);
    t.pb().ev.onProgress(1, 450);
    t.pb().ev.onProgress(1, 460);
    expect(t.stopped()).toEqual([{ type: 'playback.stopped', responseSeq: 1, playedMs: 400, reason: 'interrupted' }]);
    expect(t.sent.filter((m) => m.type === 'playback.progress')).toEqual([]);
    expect(t.metrics()).toContain('interrupt_stop_ms');
  });

  it('late audio of an interrupted response does not flip listening back to speaking', async () => {
    const t = await started();
    playing(t, 1);
    t.vadCb().onStart(performance.now());
    expect(t.states().at(-1)).toBe('listening');
    t.audio(1);
    t.pb().ev.onFirstAudio(1);
    expect(t.states().at(-1)).toBe('listening');
    expect(t.pb().calls.filter((c) => c === 'push:1')).toHaveLength(1);
  });

  it('applies a supersede as cancelled(old) then start(new)', async () => {
    const t = await started();
    playing(t, 1);
    t.server({ type: 'response.cancelled', responseSeq: 1 });
    t.server({ type: 'response.start', responseSeq: 2, kind: 'reply' });
    const c = t.pb().calls;
    expect(c.indexOf('cancelled:1')).toBeLessThan(c.indexOf('start:2'));
    expect(t.pb().activeSeq).toBe(2);
    t.audio(1);
    expect(c.filter((x) => x === 'push:1')).toHaveLength(1); // only the frame before the cancel
    expect(t.vad.aiPlaying).toBe(true);
  });

  it('drops audio of responses before the resume point', async () => {
    const t = await started();
    playing(t, 1);
    t.server({ type: 'session.resumed', lastResponseSeq: 1 });
    t.server({ type: 'response.start', responseSeq: 1, kind: 'reply' });
    t.audio(1);
    t.pb().ev.onEnded(1, 100);
    t.server({ type: 'transcript.assistant', responseSeq: 1, text: 'old' });
    expect(t.pb().calls.filter((c) => c === 'push:1')).toHaveLength(1); // only the pre-resume frame
    expect(t.stopped()).toEqual([]);
    t.server({ type: 'response.start', responseSeq: 2, kind: 'followup' });
    t.audio(2);
    expect(t.pb().calls).toContain('push:2');
  });

  it('session.ready resets sequence filtering for a fresh session', async () => {
    const t = await started();
    playing(t, 1);
    t.server({ type: 'session.resumed', lastResponseSeq: 3 });
    t.server({ type: 'session.ready', sessionId: 's2' });
    expect(t.pb().calls.filter((c) => c === 'resetForNewSession')).toHaveLength(2);
    playing(t, 1);
    expect(t.pb().calls.filter((c) => c === 'push:1')).toHaveLength(2);
    t.pb().ev.onEnded(1, 300);
    expect(t.stopped()).toEqual([{ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' }]);
  });

  it('re-sends the mute state after session.resumed and session.ready', async () => {
    const t = await started();
    t.app.handleFlutter({ type: 'mute', muted: true });
    t.sent.length = 0;
    t.server({ type: 'session.resumed', lastResponseSeq: 0 });
    t.server({ type: 'session.ready', sessionId: 's2' });
    expect(t.sent.filter((m) => m.type === 'client.mute')).toEqual([
      { type: 'client.mute', muted: true },
      { type: 'client.mute', muted: true },
    ]);
  });

  it('shuts down VAD, then the mic, then the session', async () => {
    const t = await started();
    t.app.handleFlutter({ type: 'end' });
    await vi.runAllTimersAsync();
    expect(t.order.slice(-3)).toEqual(['vad.destroy', 'capture.stop', 'client.close']);
  });

  it('releases mic and VAD and posts an error when start fails', async () => {
    const t = setup({ startFails: true });
    await expect(t.app.start()).rejects.toThrow('http_503');
    expect(t.order.slice(-3)).toEqual(['vad.destroy', 'capture.stop', 'client.close']);
    expect(t.posted).toContainEqual({ type: 'error', code: 'http_503' });
  });

  it('posts an audio status when the AudioContext is still not running', async () => {
    const t = setup();
    const deps = t.deps;
    const orig = deps.createPlayback;
    deps.createPlayback = (ev) => { const p = orig(ev) as FakePlayback; p.contextState = 'suspended'; return p; };
    const app = new AppController({} as HTMLElement, cfg, deps);
    await app.start();
    expect(t.posted).toContainEqual({ type: 'status', status: 'audio_suspended' });
  });

  it('debug text interrupts without an interrupt_stop_ms metric', async () => {
    const t = await started();
    playing(t, 1);
    t.app.handleFlutter({ type: 'debugText', text: 'hi' });
    expect(t.stopped()).toEqual([{ type: 'playback.stopped', responseSeq: 1, playedMs: 0, reason: 'interrupted' }]);
    expect(t.metrics()).not.toContain('interrupt_stop_ms');
  });

  it('finalizes an in-flight assistant subtitle on resume, new session and end', async () => {
    for (const finish of ['resumed', 'ready', 'end'] as const) {
      const t = await started();
      playing(t, 1);
      t.server({ type: 'transcript.assistant', responseSeq: 1, text: '你好呀朋友' });
      t.pb().played.set(1, 0);
      if (finish === 'resumed') t.server({ type: 'session.resumed', lastResponseSeq: 1 });
      else if (finish === 'ready') t.server({ type: 'session.ready', sessionId: 's2' });
      else { t.app.handleFlutter({ type: 'end' }); await vi.runAllTimersAsync(); }
      const subs = t.subtitles();
      expect(subs.at(-1)?.final, finish).toBe(true);
      expect(subs.filter((s) => s.final), finish).toHaveLength(1);
    }
  });
});
