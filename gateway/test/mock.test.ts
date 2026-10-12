import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';

const script: MockScript = {
  greeting: '你好',
  followup: '还在吗',
  fallbackReply: '我在听',
  turns: [
    { user: '吃了饺子', reply: '真香啊' },
    { match: '挥', user: '挥挥手', reply: '好呀', tool: { name: 'perform_action', args: { action: 'wave' } } },
  ],
};
const loud = () => new Int16Array(320).fill(3000);
const quiet = () => new Int16Array(320);

function collect(m: MockAdapter) {
  const events: string[] = [];
  let text = '';
  let audioSamples = 0;
  m.on('userSpeechStarted', () => events.push('speech'));
  m.on('userTranscript', (t, final) => events.push(`asr:${final ? 'final' : 'partial'}:${t}`));
  m.on('responseStarted', (id) => events.push(`start:${id}`));
  m.on('textDelta', (_id, t) => { text += t; });
  m.on('audioDelta', (_id, pcm) => { audioSamples += pcm.length; });
  m.on('toolCall', (_id, _c, name, args) => events.push(`tool:${name}:${JSON.stringify(args)}`));
  m.on('responseDone', (id) => events.push(`done:${id}`));
  m.on('responseCancelled', (id) => events.push(`cancelled:${id}`));
  return { events, text: () => text, audio: () => audioSamples };
}

describe('MockAdapter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const make = () => new MockAdapter({ script, replyDelayMs: 100, charMs: 200, chunkMs: 100, paceFactor: 1 });

  it('detects a spoken turn, emits transcripts and streams the scripted reply', async () => {
    const m = make();
    const c = collect(m);
    await m.connect({ instructions: 'x', tools: [] });
    for (let i = 0; i < 10; i++) m.sendAudio(loud());
    for (let i = 0; i < 40; i++) m.sendAudio(quiet()); // 800 ms of silence ends the turn
    expect(c.events).toEqual(['speech', 'asr:partial:吃了', 'asr:final:吃了饺子']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.events).toContain('start:mock-1');
    expect(c.events).toContain('done:mock-1');
    expect(c.text()).toBe('真香啊');
    expect(c.audio()).toBe(600 * 24); // 3 chars × 200 ms at 24 kHz
  });

  it('cancels mid-stream and stops emitting audio', async () => {
    const m = make();
    const c = collect(m);
    m.sendUserText('随便说点');
    await vi.advanceTimersByTimeAsync(250);
    const before = c.audio();
    m.cancelResponse();
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.events).toContain('cancelled:mock-1');
    expect(c.events).not.toContain('done:mock-1');
    expect(c.audio()).toBe(before);
  });

  it('emits a tool call for matching text', async () => {
    const m = make();
    const c = collect(m);
    m.sendUserText('跟我挥挥手吧');
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.events).toContain('tool:perform_action:{"action":"wave"}');
    expect(c.text()).toBe('好呀');
  });

  it('answers the first createResponse with the greeting, later ones with the follow-up', async () => {
    const m = make();
    const c = collect(m);
    m.createResponse('greet');
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('你好');
    m.createResponse('follow');
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('你好还在吗');
  });

  it('uses the scripted line mapped to a known Director instruction', async () => {
    const m = new MockAdapter({
      script, replyDelayMs: 100, charMs: 200, chunkMs: 100, paceFactor: 1,
      instructionReplies: new Map([['IDLE', '我在呢']]),
    });
    const c = collect(m);
    m.createResponse('IDLE');
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('我在呢');
    m.createResponse('unknown');
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('我在呢还在吗'); // a mapped reply still counts as the first response
  });

  it('records context notes, instructions and tool results', async () => {
    const m = make();
    await m.connect({ instructions: 'v1', tools: [] });
    m.updateInstructions('v2');
    m.injectContextNote('note');
    m.sendToolResult('c1', { ok: true });
    expect(m.instructions).toBe('v2');
    expect(m.notes).toEqual(['note']);
    expect(m.toolResults).toEqual([{ callId: 'c1', result: { ok: true } }]);
  });

  it('simulateDrop emits error then closed', () => {
    const m = make();
    const seen: string[] = [];
    m.on('error', (code, retryable) => seen.push(`${code}:${retryable}`));
    m.on('closed', () => seen.push('closed'));
    m.simulateDrop();
    expect(seen).toEqual(['mock_drop:true', 'closed']);
  });
});
