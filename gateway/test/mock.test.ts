import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAdapter, loadMockScript, withCharacterName, type MockScript } from '../src/adapters/mock.ts';

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

  it('inserts silence after cancel so the next reply is not the same waveform', async () => {
    const speech = Int16Array.from({ length: 24000 }, (_, i) => 1000 + (i % 997));
    const m = new MockAdapter({
      script,
      speech,
      replyDelayMs: 0,
      charMs: 200,
      chunkMs: 100,
      paceFactor: 1,
      cancelGapMs: 100,
    });
    const chunks: Int16Array[] = [];
    m.on('audioDelta', (_id, pcm) => chunks.push(Int16Array.from(pcm)));
    m.sendUserText('随便说点');
    await vi.advanceTimersByTimeAsync(0);
    expect(chunks.length).toBeGreaterThan(0);
    const seam = Int16Array.from(speech.subarray(chunks[0]!.length, chunks[0]!.length + 50));
    m.cancelResponse();
    chunks.length = 0;
    m.sendUserText('再来一句');
    await vi.advanceTimersByTimeAsync(0);
    expect(chunks[0]?.every((sample) => sample === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    const afterGap = chunks.at(-1);
    expect(afterGap?.subarray(0, 50)).not.toEqual(seam);
  });

  it('emits a tool call for matching text', async () => {
    const m = make();
    const c = collect(m);
    m.sendUserText('跟我挥挥手吧');
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.events).toContain('tool:perform_action:{"action":"wave"}');
    expect(c.text()).toBe('好呀');
  });

  it('answers bare createResponse calls with the greeting first, then the follow-up', async () => {
    const m = make();
    const c = collect(m);
    m.createResponse();
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('你好');
    m.createResponse();
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('你好还在吗');
  });

  it('speaks the scripted line for each Director cue', async () => {
    const m = new MockAdapter({ script: { ...script, idleNotice: '我在呢' }, replyDelayMs: 100, charMs: 200, chunkMs: 100, paceFactor: 1 });
    const c = collect(m);
    m.createResponse({ cue: 'idleNotice', instruction: 'IDLE', fallbackText: 'unused' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('我在呢');
    m.createResponse({ cue: 'resume', instruction: 'R', fallbackText: 'unused' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('我在呢还在吗'); // no scripted resume line: falls back to the follow-up
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

  it('records combined session updates and applies them', async () => {
    const m = make();
    await m.connect({ instructions: 'v1', tools: [], voice: 'voice-en' });
    m.updateSession({ instructions: 'v2', voice: { value: 'voice-zh' } });
    m.updateSession({ voice: { value: undefined } });
    expect(m.sessionUpdates).toEqual([
      { instructions: 'v2', voice: { value: 'voice-zh' } },
      { voice: { value: undefined } },
    ]);
    expect(m.instructions).toBe('v2');
    expect(m.voice).toBeUndefined();
  });

  it('simulateDrop emits error then closed', () => {
    const m = make();
    const seen: string[] = [];
    m.on('error', (code, retryable) => seen.push(`${code}:${retryable}`));
    m.on('closed', () => seen.push('closed'));
    m.simulateDrop();
    expect(seen).toEqual(['mock_drop:true', 'closed']);
  });

  it('rejects malformed mock scripts before runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anyidea-mock-'));
    const path = join(dir, 'script.json');
    try {
      writeFileSync(path, JSON.stringify({ greeting: 'hi', followup: '', fallbackReply: 'x', turns: [] }));
      expect(() => loadMockScript(path)).toThrow(/MOCK_SCRIPT_INVALID/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('withCharacterName', () => {
  it('fills {{char}} in every scripted line and leaves the input untouched', () => {
    const script: MockScript = {
      greeting: '我是{{char}}', followup: '{{char}}在', fallbackReply: '嗯', memoryNotice: '{{char}}记着',
      turns: [{ user: 'u', reply: '{{char}}说' }],
    };
    expect(withCharacterName(script, '小凯')).toEqual({
      greeting: '我是小凯', followup: '小凯在', fallbackReply: '嗯', memoryNotice: '小凯记着',
      turns: [{ user: 'u', reply: '小凯说' }],
    });
    expect(script.greeting).toBe('我是{{char}}');
  });
});
