import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextModelClient } from '../src/memory/textClient.ts';
import type { SilenceDecisionConfig } from '../src/roles/types.ts';
import { createSilencePlanner } from '../src/session/silence.ts';

const config: SilenceDecisionConfig = {
  instruction: 'Return the silence decision as JSON.',
  speakInstruction: 'READ {continuation}',
  maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
  policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
};
const context = {
  stage: 'context' as const,
  userText: '今天走了很多路，脚有点酸。',
  assistantText: '今天走了不少地方。',
  previousTexts: [] as string[],
  memorySnapshot: '',
};
const signal = () => new AbortController().signal;
const client = (raw: string): TextModelClient => ({ complete: async () => raw });

describe('silence planner', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns no text when the model stays silent', async () => {
    const plan = createSilencePlanner(client('{"speak":false}'), config);
    expect(await plan(context, signal())).toEqual({ text: null });
  });

  it('passes the stage, exchange and previous lines as data and returns the validated line', async () => {
    let input!: Parameters<TextModelClient['complete']>[0];
    const plan = createSilencePlanner({ complete: async data => {
      input = data;
      return '{"speak":true,"text":"走累了，脚酸着也不好受。"}';
    } }, config);
    const checkContext = { ...context, stage: 'check' as const, previousTexts: ['走累了，脚酸着也不好受。'] };
    expect(await plan(checkContext, signal())).toEqual({ text: '走累了，脚酸着也不好受。' });
    expect(JSON.parse(input.user)).toEqual(checkContext);
    expect(input.maxTokens).toBe(128);
    expect(input.temperature).toBe(0.8);
  });

  it('closes the ladder only when the model reports a clear ending', async () => {
    const plan = createSilencePlanner(client('{"speak":false,"close":true}'), config);
    expect(await plan(context, signal())).toEqual({ text: null, close: true });
  });

  it.each([
    'not JSON', '{}', '{"speak":"false"}', '{"speak":false,"text":"不应播放"}',
    '{"speak":false,"close":"yes"}', '{"speak":true,"text":" "}', '{"speak":true,"text":123}',
    JSON.stringify({ speak: true, text: '长'.repeat(61) }),
  ])('stays quiet on an invalid model result: %s', async raw => {
    expect(await createSilencePlanner(client(raw), config)(context, signal())).toBeNull();
  });

  it('plans the opening from memory when the user has not spoken', async () => {
    let input!: Parameters<TextModelClient['complete']>[0];
    const line = '您好呀，又见面了。上次说的公园后来去了吗？';
    const plan = createSilencePlanner({ complete: async data => {
      input = data;
      return JSON.stringify({ speak: true, text: line });
    } }, config);
    const opening = { ...context, stage: 'greeting' as const, userText: '', assistantText: '', memorySnapshot: '上次聊到想去公园。' };
    expect(await plan(opening, signal())).toEqual({ text: line });
    expect(JSON.parse(input.user)).toEqual(opening);
  });

  it('keeps the check-in content and rejects a new topic instead', async () => {
    const checkin = '您还在听吗？不着急，您随时想聊都可以。';
    const good = createSilencePlanner(client(JSON.stringify({ speak: true, text: checkin })), config);
    expect(await good({ ...context, stage: 'checkin' }, signal())).toEqual({ text: checkin });
    const bad = createSilencePlanner(client(JSON.stringify({ speak: true, text: '您还在听吗？今天天气不错，您出门了吗？' })), config);
    expect(await bad({ ...context, stage: 'checkin' }, signal())).toBeNull();
  });

  it('rejects a rest line that asks a question, and a greeting without one', async () => {
    const rest = createSilencePlanner(client('{"speak":true,"text":"您今天出门走走吗？"}'), config);
    expect(await rest({ ...context, stage: 'rest' }, signal())).toBeNull();
    const greeting = createSilencePlanner(client('{"speak":true,"text":"您好，又见到您了。"}'), config);
    expect(await greeting({ ...context, stage: 'greeting', userText: '' }, signal())).toBeNull();
  });

  it('keeps the memory snapshot inside the input budget', async () => {
    let input!: Parameters<TextModelClient['complete']>[0];
    const line = '您好，又见到您了。今天想聊点什么？';
    const plan = createSilencePlanner({ complete: async data => {
      input = data;
      return JSON.stringify({ speak: true, text: line });
    } }, config);
    const opening = { ...context, stage: 'greeting' as const, userText: '', assistantText: '', memorySnapshot: '记'.repeat(7000) };
    expect(await plan(opening, signal())).toEqual({ text: line });
    expect((JSON.parse(input.user) as { memorySnapshot: string }).memorySnapshot).toHaveLength(6000);
  });

  it('does not send oversized exchanges for optional speech', async () => {
    let calls = 0;
    const plan = createSilencePlanner({ complete: async () => { calls++; return '{"speak":true,"text":"不应播放"}'; } }, config);
    expect(await plan({ ...context, userText: '长'.repeat(6001) }, signal())).toBeNull();
    expect(calls).toBe(0);
  });

  it('plans from the user turn when the adapter reports no assistant text', async () => {
    let calls = 0;
    const plan = createSilencePlanner({ complete: async () => { calls++; return '{"speak":true,"text":"您接着说。"}'; } }, config);
    expect(await plan({ ...context, assistantText: '' }, signal())).toEqual({ text: '您接着说。' });
    expect(calls).toBe(1);
  });

  it('bounds an unresponsive client, aborts its request and does not retry', async () => {
    let calls = 0;
    let taskSignal!: AbortSignal;
    const plan = createSilencePlanner({ complete: async input => {
      calls++; taskSignal = input.signal; return new Promise(() => {});
    } }, config);
    const result = plan(context, signal());
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBeNull();
    expect(taskSignal.aborted).toBe(true);
    expect(calls).toBe(1);
  });

  it('propagates cancellation and rejects a client result that arrives after abort', async () => {
    let finish!: (raw: string) => void;
    let taskSignal!: AbortSignal;
    const abort = new AbortController();
    const plan = createSilencePlanner({ complete: input => {
      taskSignal = input.signal; return new Promise(resolve => { finish = resolve; });
    } }, config);
    const result = plan(context, abort.signal);
    abort.abort();
    expect(taskSignal.aborted).toBe(true);
    finish('{"speak":true,"text":"走累了，脚酸着也不好受。"}');
    expect(await result).toBeNull();
  });

  it('never calls an external service after prior cancellation', async () => {
    let calls = 0;
    const abort = new AbortController(); abort.abort();
    const plan = createSilencePlanner({ complete: async () => { calls++; throw Error('unexpected_call'); } }, config);
    expect(await plan(context, abort.signal)).toBeNull();
    expect(calls).toBe(0);
  });
});
