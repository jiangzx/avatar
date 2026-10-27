import { describe, expect, it } from 'vitest';
import {
  claimsPastConversation,
  mentionsOnlyOwnName,
  pinIntentVerdict,
  sourceRate,
} from '../scripts/lib/multi-character-verdicts.ts';

describe('multi-character probe verdicts', () => {
  it('accepts a reply that names only the expected character', () => {
    expect(mentionsOnlyOwnName('我叫小凯，陪您聊天。', '小凯', ['小暖', '小欣'])).toBe(true);
    expect(mentionsOnlyOwnName('我是小暖呀。', '小凯', ['小暖', '小欣'])).toBe(false);
    expect(mentionsOnlyOwnName('您好呀。', '小凯', ['小暖', '小欣'])).toBe(false);
  });

  it('flags replies that claim an earlier conversation', () => {
    expect(claimsPastConversation('上次您跟我说过老家在山东。', ['上次', '之前您说', '您跟我说过'])).toBe(true);
    expect(claimsPastConversation('听说您老家在山东，那儿的煎饼好吃。', ['上次', '之前您说', '您跟我说过'])).toBe(false);
  });

  it('does not treat a missing-record sentence as a claim', () => {
    const markers = ['上次', '之前您说', '您跟我说过'];
    expect(claimsPastConversation('我这边暂时找不到上次的聊天记录，您想接着聊什么都可以。', markers)).toBe(false);
    expect(claimsPastConversation('我不记得上次聊过什么了。咱们说点别的吧。', markers)).toBe(false);
    // The denial must not hide a real claim in another sentence.
    expect(claimsPastConversation('找不到之前的记录了。上次您跟我说过老家在山东。', markers)).toBe(true);
  });

  it('computes the pin intent verdict', () => {
    const v = pinIntentVerdict([
      { expect: 'this', got: 'this' },
      { expect: 'previous', got: 'previous' },
      { expect: 'none', got: null },
      { expect: 'this', got: null },
    ]);
    expect(v).toEqual({ total: 4, correct: 3, falsePins: 0, rate: 0.75 });
  });

  it('counts false pins separately', () => {
    const v = pinIntentVerdict([{ expect: 'none', got: 'this' }]);
    expect(v.falsePins).toBe(1);
    expect(v.correct).toBe(0);
  });

  it('computes the share of facts with valid sources', () => {
    expect(sourceRate([{ sources: ['m1'] }, { sources: [] }, { sources: ['m2', 'm3'] }, { sources: ['m4'] }])).toEqual({ facts: 4, withSources: 3, rate: 0.75 });
    expect(sourceRate([])).toEqual({ facts: 0, withSources: 0, rate: 0 });
  });
});
