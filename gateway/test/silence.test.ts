import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadI18n } from '../src/i18n/load.ts';
import type { SilenceRules } from '../src/i18n/types.ts';
import type { TextModelClient } from '../src/memory/textClient.ts';
import type { SilenceDecisionConfig } from '../src/roles/types.ts';
import { createSilencePlanner } from '../src/session/silence.ts';

const silence = loadI18n(`${fileURLToPath(new URL('..', import.meta.url))}config`).silence;
/** Frozen copy of the zh rules the four-stage ladder was validated with. */
const zhRules: SilenceRules = {
  greeting: ['您好', '你好', '好呀', '好啊', '好哇', '又见到', '又见面', '早上好', '上午好', '下午好', '晚上好', '早啊', '早安', '嗨', '哈喽', '来啦'],
  listening: ['还在听', '在听', '听着', '听到', '还在吗', '在吗'],
  anytime: ['随时', '都可以', '接着聊', '想聊', '都在'],
  maxCheckinChars: 30,
};
const jaRules = silence.ja;
const enRules = silence.en;

const config: SilenceDecisionConfig = {
  instruction: 'Return the silence decision as JSON.',
  speakInstruction: 'READ {continuation}',
  maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
  variationHints: { greeting: ['先问候再提问'], checkin: ['先确认还在听，再说随时可以聊'] },
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
  it('ships the frozen zh silence pack verbatim', () => {
    expect(silence.zh).toEqual(zhRules);
  });

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns no text when the model stays silent', async () => {
    const plan = createSilencePlanner(client('{"speak":false}'), config, zhRules);
    expect(await plan(context, signal())).toEqual({ text: null });
  });

  it('passes the stage, exchange and previous lines as data and returns the validated line', async () => {
    let input!: Parameters<TextModelClient['complete']>[0];
    const plan = createSilencePlanner({ complete: async data => {
      input = data;
      return '{"speak":true,"text":"走累了，脚酸着也不好受。"}';
    } }, config, zhRules);
    const checkContext = { ...context, stage: 'check' as const, previousTexts: ['走累了，脚酸着也不好受。'] };
    expect(await plan(checkContext, signal())).toEqual({ text: '走累了，脚酸着也不好受。' });
    expect(JSON.parse(input.user)).toEqual(checkContext);
    expect(input.maxTokens).toBe(128);
    expect(input.temperature).toBe(0.8);
    expect(input.jsonMode).toBe(true);
  });

  it('accepts a decision wrapped in a code fence', async () => {
    const plan = createSilencePlanner(client('```json\n{"speak":true,"text":"您接着说。"}\n```'), config, zhRules);
    expect(await plan(context, signal())).toEqual({ text: '您接着说。' });
  });

  it('closes the ladder only when the model reports a clear ending', async () => {
    const plan = createSilencePlanner(client('{"speak":false,"close":true}'), config, zhRules);
    expect(await plan(context, signal())).toEqual({ text: null, close: true });
  });

  it.each([
    'not JSON', '{}', '{"speak":"false"}', '{"speak":false,"text":"不应播放"}',
    '{"speak":false,"close":"yes"}', '{"speak":true,"text":" "}', '{"speak":true,"text":123}',
    JSON.stringify({ speak: true, text: '长'.repeat(61) }),
  ])('stays quiet on an invalid model result: %s', async raw => {
    expect(await createSilencePlanner(client(raw), config, zhRules)(context, signal())).toBeNull();
  });

  it('plans the opening from memory when the user has not spoken', async () => {
    let input!: Parameters<TextModelClient['complete']>[0];
    const line = '王叔好呀，又见面了。上次说的公园后来去了吗？';
    const plan = createSilencePlanner({ complete: async data => {
      input = data;
      return JSON.stringify({ speak: true, text: line });
    } }, config, zhRules);
    const opening = { ...context, stage: 'greeting' as const, userText: '', assistantText: '', memorySnapshot: '上次聊到想去公园。' };
    expect(await plan(opening, signal())).toEqual({ text: line });
    expect(JSON.parse(input.user)).toEqual(opening);
    expect(input.system).toContain('先问候再提问');
  });

  it('varies the check-in angle from configured hints', async () => {
    let system = '';
    const line = '您还在听吗？随时都能接着聊。';
    const plan = createSilencePlanner({ complete: async data => {
      system = data.system;
      return JSON.stringify({ speak: true, text: line });
    } }, config, zhRules);
    expect(await plan({ ...context, stage: 'checkin' }, signal())).toEqual({ text: line });
    expect(system).toContain('先确认还在听，再说随时可以聊');
  });

  it('keeps the check-in content and rejects a new topic instead', async () => {
    const checkin = '您还在听吗？不着急，您随时想聊都可以。';
    const good = createSilencePlanner(client(JSON.stringify({ speak: true, text: checkin })), config, zhRules);
    expect(await good({ ...context, stage: 'checkin' }, signal())).toEqual({ text: checkin });
    const bad = createSilencePlanner(client(JSON.stringify({ speak: true, text: '您还在听吗？今天天气不错，您出门了吗？' })), config, zhRules);
    expect(await bad({ ...context, stage: 'checkin' }, signal())).toBeNull();
  });

  it('accepts localized check-in lines and rejects new topics', async () => {
    const jaLine = 'まだ聞こえていますか？急がなくて大丈夫です。いつでもお話しできますよ。';
    const ja = createSilencePlanner(client(JSON.stringify({ speak: true, text: jaLine })), config, jaRules);
    expect(await ja({ ...context, stage: 'checkin' }, signal())).toEqual({ text: jaLine });
    const jaBad = createSilencePlanner(client(JSON.stringify({ speak: true, text: 'まだ聞こえていますか？今日はいい天気ですね。' })), config, jaRules);
    expect(await jaBad({ ...context, stage: 'checkin' }, signal())).toBeNull();
    const enLine = 'Are you still there? No rush—we can talk anytime.';
    const en = createSilencePlanner(client(JSON.stringify({ speak: true, text: enLine })), config, enRules);
    expect(await en({ ...context, stage: 'checkin' }, signal())).toEqual({ text: enLine });
  });

  it('matches capitalized en stage phrases and ignores hi inside another word', async () => {
    const greetingLine = 'Hello! How are you today?';
    const greeting = createSilencePlanner(client(JSON.stringify({ speak: true, text: greetingLine })), config, enRules);
    expect(await greeting({ ...context, stage: 'greeting', userText: '' }, signal())).toEqual({ text: greetingLine });

    const checkinLine = 'Are you there? We can talk anytime.';
    const checkin = createSilencePlanner(client(JSON.stringify({ speak: true, text: checkinLine })), config, enRules);
    expect(await checkin({ ...context, stage: 'checkin' }, signal())).toEqual({ text: checkinLine });

    // "hi" inside "This" must not count as a greeting.
    const falsePositive = "This is a nice day, isn't it?";
    const greetingBad = createSilencePlanner(client(JSON.stringify({ speak: true, text: falsePositive })), config, enRules);
    expect(await greetingBad({ ...context, stage: 'greeting', userText: '' }, signal())).toBeNull();
  });

  it('rejects a rest line that asks a question, and a greeting without one', async () => {
    const rest = createSilencePlanner(client('{"speak":true,"text":"您今天出门走走吗？"}'), config, zhRules);
    expect(await rest({ ...context, stage: 'rest' }, signal())).toBeNull();
    const greeting = createSilencePlanner(client('{"speak":true,"text":"您好，又见到您了。"}'), config, zhRules);
    expect(await greeting({ ...context, stage: 'greeting', userText: '' }, signal())).toBeNull();
  });

  it('keeps the memory snapshot inside the input budget', async () => {
    let input!: Parameters<TextModelClient['complete']>[0];
    const line = '您好，又见到您了。今天想聊点什么？';
    const plan = createSilencePlanner({ complete: async data => {
      input = data;
      return JSON.stringify({ speak: true, text: line });
    } }, config, zhRules);
    const opening = { ...context, stage: 'greeting' as const, userText: '', assistantText: '', memorySnapshot: '记'.repeat(7000) };
    expect(await plan(opening, signal())).toEqual({ text: line });
    expect((JSON.parse(input.user) as { memorySnapshot: string }).memorySnapshot).toHaveLength(6000);
  });

  it('does not send oversized exchanges for optional speech', async () => {
    let calls = 0;
    const plan = createSilencePlanner({ complete: async () => { calls++; return '{"speak":true,"text":"不应播放"}'; } }, config, zhRules);
    expect(await plan({ ...context, userText: '长'.repeat(6001) }, signal())).toBeNull();
    expect(calls).toBe(0);
  });

  it('passes the affect, open-loop and time fields to the planner as data', async () => {
    let input!: Parameters<TextModelClient['complete']>[0];
    const plan = createSilencePlanner({ complete: async data => {
      input = data;
      return '{"speak":true,"text":"走累了，脚酸着也不好受。"}';
    } }, config, zhRules);
    const withExtras = {
      ...context,
      affect: { emotion: 'sad' as const, intensity: 2 as const, trend: 'worse' as const, need: 'vent' as const, low: true, crisis: false },
      openLoop: '明天要去复查',
      timeOfDay: '下午',
      season: '秋天',
      solarTerm: '霜降',
    };
    expect(await plan(withExtras, signal())).toEqual({ text: '走累了，脚酸着也不好受。' });
    expect(JSON.parse(input.user)).toEqual(withExtras);
  });

  it('counts the new fields in the input budget and still trims only the memory snapshot', async () => {
    let input!: Parameters<TextModelClient['complete']>[0];
    const line = '您好，又见到您了。今天想聊点什么？';
    const plan = createSilencePlanner({ complete: async data => {
      input = data;
      return JSON.stringify({ speak: true, text: line });
    } }, config, zhRules);
    const extras = {
      affect: { emotion: 'happy' as const, intensity: 1 as const, trend: 'flat' as const, need: 'chat' as const, low: false, crisis: false },
      openLoop: '开'.repeat(100),
      timeOfDay: '下午',
      season: '秋天',
      solarTerm: '霜降',
    };
    const opening = { ...context, stage: 'greeting' as const, userText: '', assistantText: '', memorySnapshot: '记'.repeat(7000), ...extras };
    expect(await plan(opening, signal())).toEqual({ text: line });
    const used = JSON.stringify(extras.affect).length + 100 + 2 + 2 + 2;
    const sent = JSON.parse(input.user) as { memorySnapshot: string; openLoop: string };
    expect(sent.memorySnapshot).toHaveLength(6000 - used);
    expect(sent.openLoop).toBe(extras.openLoop);
  });

  it('skips optional speech when the new fields push the exchange over budget', async () => {
    let calls = 0;
    const plan = createSilencePlanner({ complete: async () => { calls++; return '{"speak":true,"text":"不应播放"}'; } }, config, zhRules);
    // userText 5990 + assistantText 9 fits on its own; the open loop tips it over 6000.
    expect(await plan({ ...context, userText: '长'.repeat(5990), openLoop: '开'.repeat(20) }, signal())).toBeNull();
    expect(calls).toBe(0);
  });

  it('plans from the user turn when the adapter reports no assistant text', async () => {
    let calls = 0;
    const plan = createSilencePlanner({ complete: async () => { calls++; return '{"speak":true,"text":"您接着说。"}'; } }, config, zhRules);
    expect(await plan({ ...context, assistantText: '' }, signal())).toEqual({ text: '您接着说。' });
    expect(calls).toBe(1);
  });

  it('bounds an unresponsive client, aborts its request and does not retry', async () => {
    let calls = 0;
    let taskSignal!: AbortSignal;
    const plan = createSilencePlanner({ complete: async input => {
      calls++; taskSignal = input.signal; return new Promise(() => {});
    } }, config, zhRules);
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
    } }, config, zhRules);
    const result = plan(context, abort.signal);
    abort.abort();
    expect(taskSignal.aborted).toBe(true);
    finish('{"speak":true,"text":"走累了，脚酸着也不好受。"}');
    expect(await result).toBeNull();
  });

  it('never calls an external service after prior cancellation', async () => {
    let calls = 0;
    const abort = new AbortController(); abort.abort();
    const plan = createSilencePlanner({ complete: async () => { calls++; throw Error('unexpected_call'); } }, config, zhRules);
    expect(await plan(context, abort.signal)).toBeNull();
    expect(calls).toBe(0);
  });
});
