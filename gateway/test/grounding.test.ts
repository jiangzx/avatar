import { describe, expect, it } from 'vitest';
import { grounded, normalizeForMatch, parsePhrase, sameUtterance } from '../src/memory/grounding.ts';

describe('grounding helpers', () => {
  it('compares utterances without punctuation or whitespace', () => {
    expect(normalizeForMatch('我明天，去 医院。')).toBe('我明天去医院');
    expect(sameUtterance('上次聊到哪儿了。', '上次聊到哪儿了')).toBe(true);
    expect(sameUtterance('「我喜欢喝茶」', '我喜欢喝茶！')).toBe(true);
    expect(sameUtterance('我喜欢喝茶', '我喜欢喝咖啡')).toBe(false);
  });

  it('parses the text field of a JSON reply, with or without a code fence', () => {
    expect(parsePhrase('```json\n{"text":" 好呀 "}\n```')).toBe('好呀');
    expect(parsePhrase('{"text":"  "}')).toBeNull();
    expect(parsePhrase('{"text":3}')).toBeNull();
    expect(parsePhrase('not json')).toBeNull();
  });

  it('rejects a new quoted title, a lost source, and a verbatim repeat', () => {
    const source = '我昨天看了咒怨';
    expect(grounded('啊，咒怨呀，那部电影挺吓人的～', source)).toBe(true);
    expect(grounded('咒怨呀，《午夜凶铃》也很吓人吧', source)).toBe(false);
    expect(grounded('那您后来还好吗', source)).toBe(false);
    expect(grounded('我昨天看了咒怨。', source)).toBe(false);
  });

  it('treats Latin words as whole tokens', () => {
    expect(grounded('Yoga every morning sounds lovely.', 'I do yoga every morning')).toBe(true);
    expect(grounded('That sounds lovely.', 'I do yoga every morning')).toBe(false);
  });
});
