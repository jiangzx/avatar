import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextModelClient } from '../src/memory/textClient.ts';
import type { SilenceDecisionConfig } from '../src/roles/types.ts';
import { createSilencePlanner } from '../src/session/silence.ts';

const config: SilenceDecisionConfig = {
  instruction: 'Return the silence decision as JSON.',
  speakInstruction: 'READ {continuation}',
  maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60,
  policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
};
const context = { userText: '今天走了很多路，脚有点酸。', assistantText: '今天走了不少地方。' };
const signal = () => new AbortController().signal;
const client = (raw: string): TextModelClient => ({ complete: async () => raw });

describe('silence planner', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns silence without manufacturing a presence line', async () => {
    const plan = createSilencePlanner(client('{"speak":false}'), config, 'Persona');
    expect(await plan(context, signal())).toBeNull();
  });

  it('passes the actual exchange as data and returns the validated continuation', async () => {
    let input!: Parameters<TextModelClient['complete']>[0];
    const plan = createSilencePlanner({ complete: async data => {
      input = data;
      return '{"speak":true,"text":"走累了，脚酸着也不好受。"}';
    } }, config, 'Persona');
    expect(await plan(context, signal())).toBe('走累了，脚酸着也不好受。');
    expect(JSON.parse(input.user)).toEqual(context);
    expect(input.maxTokens).toBe(128);
  });

  it.each([
    'not JSON', '{}', '{"speak":"false"}', '{"speak":false,"text":"不应播放"}',
    '{"speak":true,"text":" "}', '{"speak":true,"text":123}',
    JSON.stringify({ speak: true, text: '长'.repeat(61) }),
  ])('stays quiet on an invalid model result: %s', async raw => {
    expect(await createSilencePlanner(client(raw), config, 'Persona')(context, signal())).toBeNull();
  });

  it('does not send oversized or incomplete exchanges for optional speech', async () => {
    let calls = 0;
    const plan = createSilencePlanner({ complete: async () => { calls++; return '{"speak":true,"text":"不应播放"}'; } }, config, 'Persona');
    expect(await plan({ userText: '长'.repeat(6001), assistantText: '好。' }, signal())).toBeNull();
    expect(await plan({ userText: '', assistantText: '好。' }, signal())).toBeNull();
    expect(await plan({ userText: '你好', assistantText: '' }, signal())).toBeNull();
    expect(calls).toBe(0);
  });

  it('bounds an unresponsive client, aborts its request and does not retry', async () => {
    let calls = 0;
    let taskSignal!: AbortSignal;
    const plan = createSilencePlanner({ complete: async input => {
      calls++; taskSignal = input.signal; return new Promise(() => {});
    } }, config, 'Persona');
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
    } }, config, 'Persona');
    const result = plan(context, abort.signal);
    abort.abort();
    expect(taskSignal.aborted).toBe(true);
    finish('{"speak":true,"text":"走累了，脚酸着也不好受。"}');
    expect(await result).toBeNull();
  });

  it('never calls an external service after prior cancellation', async () => {
    let calls = 0;
    const abort = new AbortController(); abort.abort();
    const plan = createSilencePlanner({ complete: async () => { calls++; throw Error('unexpected_call'); } }, config, 'Persona');
    expect(await plan(context, abort.signal)).toBeNull();
    expect(calls).toBe(0);
  });
});
