import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadI18n } from '../src/i18n/load.ts';
import { detectLanguage, dominantLanguage, isLanguage, resolveLanguage } from '../src/session/language.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const rules = loadI18n(`${root}config`).language;

describe('detectLanguage', () => {
  it('detects the three scripts', () => {
    expect(detectLanguage('今天天气不错', undefined, rules)).toBe('zh');
    expect(detectLanguage('今日はいい天気ですね', undefined, rules)).toBe('ja');
    expect(detectLanguage('The weather is nice today', undefined, rules)).toBe('en');
  });

  it('treats kana as Japanese even with kanji', () => {
    expect(detectLanguage('東京は晴れです', undefined, rules)).toBe('ja');
  });

  it('keeps Japanese for pure-kanji text when the previous language is ja', () => {
    expect(detectLanguage('東京', 'ja', rules)).toBe('ja');
    expect(detectLanguage('東京', 'en', rules)).toBe('zh');
  });

  it('uses the dominant script for mixed text', () => {
    expect(detectLanguage('hello 你好', 'zh', rules)).toBe('en');
    expect(detectLanguage('OK 好的', 'en', rules)).toBe('en');
    expect(detectLanguage('你好 hello', 'ja', rules)).toBe('en');
  });

  it('keeps the previous language for short or empty utterances', () => {
    expect(detectLanguage('嗯', 'en', rules)).toBe('en');
    expect(detectLanguage('...', 'ja', rules)).toBe('ja');
    expect(detectLanguage('', 'zh', rules)).toBe('zh');
    expect(detectLanguage('OK', 'zh', rules)).toBe('zh');
    expect(detectLanguage('yes', 'zh', rules)).toBe('zh');
    expect(detectLanguage('はい', 'en', rules)).toBe('en');
  });

  it('ignores punctuation around a short acknowledgement', () => {
    expect(detectLanguage('OK!', 'zh', rules)).toBe('zh');
    expect(detectLanguage(' 好的。', 'en', rules)).toBe('en');
    expect(detectLanguage('はい。', 'en', rules)).toBe('en');
  });

  it('honours explicit language requests', () => {
    expect(detectLanguage('请用英语说', 'zh', rules)).toBe('en');
    expect(detectLanguage('说英语', 'zh', rules)).toBe('en');
    expect(detectLanguage('用日语', 'zh', rules)).toBe('ja');
    expect(detectLanguage('English please', 'zh', rules)).toBe('en');
    expect(detectLanguage('中文', 'en', rules)).toBe('zh');
    expect(detectLanguage('日本語でお願いします', 'zh', rules)).toBe('ja');
    expect(detectLanguage('日本語で', 'zh', rules)).toBe('ja');
    expect(detectLanguage('请说中文', 'en', rules)).toBe('zh');
    expect(detectLanguage('用普通话', 'ja', rules)).toBe('zh');
    expect(detectLanguage('speak in English', 'zh', rules)).toBe('en');
    expect(detectLanguage('switch to Japanese', 'zh', rules)).toBe('ja');
  });

  it('preserves the M1 explicit-request forms', () => {
    expect(detectLanguage('讲英语', 'zh', rules)).toBe('en');
    expect(detectLanguage('麻烦用英语', 'zh', rules)).toBe('en');
    expect(detectLanguage('麻烦说英语', 'zh', rules)).toBe('en');
    expect(detectLanguage('切换英语', 'zh', rules)).toBe('en');
    expect(detectLanguage('用英语回答', 'zh', rules)).toBe('en');
    expect(detectLanguage('请用英语跟我说话', 'zh', rules)).toBe('en');
    expect(detectLanguage('说英语跟我聊天', 'zh', rules)).toBe('en');
    expect(detectLanguage('please speak English', 'zh', rules)).toBe('en');
    expect(detectLanguage('talk English', 'zh', rules)).toBe('en');
    expect(detectLanguage('reply English', 'zh', rules)).toBe('en');
    expect(detectLanguage('switch English', 'zh', rules)).toBe('en');
    expect(detectLanguage('我在学英语', 'zh', rules)).toBe('zh');
  });

  it('does not switch on mere mentions of a language', () => {
    expect(detectLanguage('我在学英语', 'zh', rules)).toBe('zh');
    expect(detectLanguage('我英语不好', 'zh', rules)).toBe('zh');
    expect(detectLanguage('我在学日语', 'zh', rules)).toBe('zh');
    expect(detectLanguage('I am learning Chinese', 'en', rules)).toBe('en');
    expect(detectLanguage('这个用英语怎么说', 'zh', rules)).toBe('zh');
  });

  it('keeps the previous language for repeated acknowledgements', () => {
    expect(detectLanguage('嗯嗯', 'en', rules)).toBe('en');
    expect(detectLanguage('好好', 'en', rules)).toBe('en');
    expect(detectLanguage('对对', 'en', rules)).toBe('en');
    expect(detectLanguage('是是', 'en', rules)).toBe('en');
  });

  it('does not treat a language question as an explicit request', () => {
    expect(detectLanguage('你会说日语吗', 'zh', rules)).toBe('zh');
    expect(detectLanguage('你会说日语吗？', 'zh', rules)).toBe('zh');
  });

  it('validates and resolves language values', () => {
    expect(isLanguage('zh')).toBe(true);
    expect(isLanguage('fr')).toBe(false);
    expect(resolveLanguage('ja')).toBe('ja');
    expect(resolveLanguage('fr')).toBe('zh');
    expect(resolveLanguage(undefined, 'en')).toBe('en');
  });
});

describe('dominantLanguage', () => {
  it('picks ja on any kana, otherwise the dominant script', () => {
    expect(dominantLanguage(['東京', 'ひらがな'])).toBe('ja');
    expect(dominantLanguage(['東京', 'I like tea'])).toBe('en');
    expect(dominantLanguage(['今天天气不错', '東京'])).toBe('zh');
    expect(dominantLanguage([])).toBe('zh');
  });
});
