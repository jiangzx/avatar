import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SafetyRules } from '../src/config.ts';
import type { TextModelClient } from '../src/memory/textClient.ts';
import type { AffectCard } from '../src/session/affect.ts';
import {
  createFollowUpPlanner,
  followUpSkipCode,
  followUpTrigger,
  hasQuestionMark,
} from '../src/session/empathyFollowUp.ts';

const card = (over: Partial<AffectCard> = {}): AffectCard => ({
  emotion: 'neutral', intensity: 1, trend: 'flat', need: 'chat', strategy: 'reflect', mismatch: false, crisis: false, ...over,
});

const safety: SafetyRules = {
  minMaskedDigits: 6,
  chineseDigits: {},
  invisibleCodePoints: [0x200b],
  rejectPhrases: ['禁止'],
  degradePhrases: [],
  markPhrases: [],
};

const config = { enabled: true, delayMs: 400, maxPerSession: 1, timeoutMs: 50, maxChars: 40, maxTokens: 60, temperature: 0.3 };

function clientReply(raw: string, seen?: Array<Record<string, unknown>>): TextModelClient {
  return {
    complete: async (input) => {
      if (seen) seen.push(JSON.parse(input.user) as Record<string, unknown>);
      return raw;
    },
  };
}

describe('followUpTrigger', () => {
  it('prioritizes crisis, then low, then share_joy, trend better, help', () => {
    expect(followUpTrigger(card({ crisis: true }), 2)).toBeNull();
    expect(followUpTrigger(card({ emotion: 'sad', intensity: 2, need: 'share_joy' }), 2)).toBe('low');
    expect(followUpTrigger(card({ need: 'share_joy' }), 2)).toBe('share_joy');
    expect(followUpTrigger(card({ trend: 'better', need: 'chat' }), 2)).toBe('trend_better');
    expect(followUpTrigger(card({ need: 'help' }), 2)).toBe('help');
    expect(followUpTrigger(card({ need: 'vent' }), 2)).toBeNull();
    expect(followUpTrigger(card({ need: 'chat' }), 2)).toBeNull();
  });
});

describe('followUpSkipCode', () => {
  const base = {
    trigger: 'share_joy' as const,
    cardTurn: 2,
    userTurn: 2,
    mainReplyHasQuestion: false,
    userSpeaking: false,
    ended: false,
    interrupted: false,
    used: 0,
    maxPerSession: 1,
  };

  it('returns the first blocking guard in order', () => {
    expect(followUpSkipCode({ ...base, ended: true })).toBe('ended');
    expect(followUpSkipCode({ ...base, userSpeaking: true })).toBe('user_speech');
    expect(followUpSkipCode({ ...base, interrupted: true })).toBe('interrupted');
    expect(followUpSkipCode({ ...base, used: 1 })).toBe('limit');
    expect(followUpSkipCode({ ...base, cardTurn: 1 })).toBe('stale');
    expect(followUpSkipCode({ ...base, mainReplyHasQuestion: true })).toBe('already_asked');
    expect(followUpSkipCode(base)).toBeNull();
  });

  it('allows a low companionship line even when the main reply asked a question', () => {
    expect(followUpSkipCode({ ...base, trigger: 'low', mainReplyHasQuestion: true })).toBeNull();
  });
});

describe('hasQuestionMark', () => {
  it('detects both Chinese and ASCII question marks', () => {
    expect(hasQuestionMark('您好吗？')).toBe(true);
    expect(hasQuestionMark('How are you?')).toBe(true);
    expect(hasQuestionMark('我在听。')).toBe(false);
  });
});

describe('createFollowUpPlanner', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('parses one JSON line and passes only enums plus the user line to the model', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const planner = createFollowUpPlanner({
      client: clientReply('{"text":"后来呢？"}', seen),
      config,
      prompt: () => 'FIXTURE FOLLOWUP',
      safety,
    });
    const text = await planner({ language: 'zh', trigger: 'share_joy', userText: '孙子考上研究生了', card: card({ need: 'share_joy', openLoop: '不该出现的原话' }) }, new AbortController().signal);
    expect(text).toBe('后来呢？');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ trigger: 'share_joy', userText: '孙子考上研究生了' });
    expect(seen[0]?.card).toBeDefined();
    expect(seen[0]?.card).not.toHaveProperty('openLoop');
  });

  it('rejects a low line that asks a question', async () => {
    const planner = createFollowUpPlanner({ client: clientReply('{"text":"您想说说吗？"}'), config, prompt: () => 'P', safety });
    await expect(planner({ language: 'zh', trigger: 'low', userText: '心里难受', card: card({ emotion: 'sad', intensity: 2 }) }, new AbortController().signal)).resolves.toBeNull();
  });

  it('accepts a low companionship statement', async () => {
    const planner = createFollowUpPlanner({ client: clientReply('{"text":"我陪您坐一会儿。"}'), config, prompt: () => 'P', safety });
    await expect(planner({ language: 'zh', trigger: 'low', userText: '心里难受', card: card({ emotion: 'sad', intensity: 2 }) }, new AbortController().signal))
      .resolves.toBe('我陪您坐一会儿。');
  });

  it('rejects too long and unsafe lines', async () => {
    const long = createFollowUpPlanner({ client: clientReply(`{"text":"${'长'.repeat(41)}"}`), config, prompt: () => 'P', safety });
    await expect(long({ language: 'zh', trigger: 'help', userText: '膝盖疼', card: card({ need: 'help' }) }, new AbortController().signal)).resolves.toBeNull();
    const unsafe = createFollowUpPlanner({ client: clientReply('{"text":"禁止的内容"}'), config, prompt: () => 'P', safety });
    await expect(unsafe({ language: 'zh', trigger: 'help', userText: '膝盖疼', card: card({ need: 'help' }) }, new AbortController().signal)).resolves.toBeNull();
  });

  it('returns null at the planner deadline', async () => {
    vi.useFakeTimers();
    const client: TextModelClient = { complete: () => new Promise<string>(() => {}) };
    const planner = createFollowUpPlanner({ client, config, prompt: () => 'P', safety });
    const pending = planner({ language: 'zh', trigger: 'share_joy', userText: '好消息', card: card({ need: 'share_joy' }) }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toBeNull();
  });
});
