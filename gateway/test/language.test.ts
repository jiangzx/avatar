import { describe, expect, it } from 'vitest';
import { detectLanguage, isLanguage, resolveLanguage } from '../src/session/language.ts';

describe('detectLanguage', () => {
  it('detects the three scripts', () => {
    expect(detectLanguage('今天天气不错')).toBe('zh');
    expect(detectLanguage('今日はいい天気ですね')).toBe('ja');
    expect(detectLanguage('The weather is nice today')).toBe('en');
  });

  it('treats kana as Japanese even with kanji', () => {
    expect(detectLanguage('東京は晴れです')).toBe('ja');
  });

  it('keeps Japanese for pure-kanji text when the previous language is ja', () => {
    expect(detectLanguage('東京', 'ja')).toBe('ja');
    expect(detectLanguage('東京', 'en')).toBe('zh');
  });

  it('uses the dominant script for mixed text', () => {
    expect(detectLanguage('hello 你好', 'zh')).toBe('en');
    expect(detectLanguage('OK 好的', 'en')).toBe('en');
    expect(detectLanguage('你好 hello', 'ja')).toBe('en');
  });

  it('keeps the previous language for short or empty utterances', () => {
    expect(detectLanguage('嗯', 'en')).toBe('en');
    expect(detectLanguage('...', 'ja')).toBe('ja');
    expect(detectLanguage('', 'zh')).toBe('zh');
    expect(detectLanguage('OK', 'zh')).toBe('en');
    expect(detectLanguage('はい', 'en')).toBe('ja');
  });

  it('honours explicit language requests', () => {
    expect(detectLanguage('请用英语说', 'zh')).toBe('en');
    expect(detectLanguage('日本語でお願いします', 'zh')).toBe('ja');
    expect(detectLanguage('请说中文', 'en')).toBe('zh');
    expect(detectLanguage('你会说日语吗', 'zh')).toBe('zh');
  });

  it('validates and resolves language values', () => {
    expect(isLanguage('zh')).toBe(true);
    expect(isLanguage('fr')).toBe(false);
    expect(resolveLanguage('ja')).toBe('ja');
    expect(resolveLanguage('fr')).toBe('zh');
    expect(resolveLanguage(undefined, 'en')).toBe('en');
  });
});
