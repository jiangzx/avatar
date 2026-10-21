import { describe, expect, it } from 'vitest';
import { containsPhrase } from '../src/i18n/text.ts';

describe('containsPhrase', () => {
  it('matches ASCII phrases case-insensitively at whole-word boundaries', () => {
    expect(containsPhrase('Hello! How are you today?', 'hello')).toBe(true);
    expect(containsPhrase('HELLO there', 'Hello')).toBe(true);
    expect(containsPhrase('No rush—we can talk anytime.', 'no rush')).toBe(true);
    expect(containsPhrase('Are you still there? We can talk anytime.', 'anytime')).toBe(true);
    expect(containsPhrase('This is a nice day', 'hi')).toBe(false);
    expect(containsPhrase('There is nothing here', 'no')).toBe(false);
  });

  it('keeps CJK phrases as substring matches', () => {
    expect(containsPhrase('您好，又见到您了', '您好')).toBe(true);
    expect(containsPhrase('まだ聞こえていますか', '聞こえ')).toBe(true);
    expect(containsPhrase('今日はいい天気ですね', '聞こえ')).toBe(false);
  });
});
