import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSafetyConfig, type SafetyRules } from '../src/config.ts';
import { bigrams } from '../src/memory/bigram.ts';
import { normalizeChineseDigits, redact } from '../src/memory/redact.ts';
import { scanText } from '../src/memory/scan.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const safetyPath = `${root}config/safety.json`;

describe('redact', () => {
  it('masks a long digit run and leaves a single numeral inside a word', () => {
    expect(redact('一二三四五六七八九零一二')).toBe('************');
    expect(redact('一个')).toBe('一个');
    expect(redact('张三')).toBe('张三');
    expect(normalizeChineseDigits('一个')).toBe('一个');
    expect(normalizeChineseDigits('张三')).toBe('张三');
  });

  it('leaves an 11-digit phone number unchanged', () => {
    expect(redact('13800138000')).toBe('13800138000');
    expect(redact('一三八零零一三八零零零')).toBe('一三八零零一三八零零零');
  });

  it('masks twelve formal digits', () => {
    expect(redact('壹贰叁肆伍陆柒捌玖壹贰叁')).toBe('************');
  });

  it('masks each long digit run with the same number of stars', () => {
    expect(redact('卡123456789012尾')).toBe('卡************尾');
    expect(redact('1234567890123')).toBe('*************');
  });
});

describe('bigrams', () => {
  it('emits a Han pair and keeps a Latin run as one token', () => {
    expect(bigrams('王叔')).toBe('王叔');
    expect(bigrams('hello')).toBe('hello');
  });

  it('slides adjacent Han pairs and keeps each Latin or digit run whole', () => {
    expect(bigrams('今天天气不错')).toBe('今天 天天 天气 气不 不错');
    expect(bigrams('王叔hello123')).toBe('王叔 hello123');
    expect(bigrams('hello 123')).toBe('hello 123');
  });

  it('folds a digit run of at least two characters and keeps a lone numeral as Han', () => {
    expect(bigrams('一二三四五六七八九零一').split(' ')).toContain('12345678901');
    expect(bigrams('一个')).toBe('一个');
    expect(bigrams('张三')).toBe('张三');
    expect(bigrams('幺二')).toBe('12');
    expect(bigrams('一十')).toBe('一十');
    expect(bigrams('两三')).toBe('两三');
    expect(bigrams('一拾')).toBe('一拾');
  });
});

describe('scanText', () => {
  const rules = () => loadSafetyConfig(safetyPath);

  it('rejects a string that contains U+200B', () => {
    expect(scanText('你好\u200B', rules())).toBe('reject');
  });

  it('degrades verification-code talk without throwing', () => {
    expect(scanText('验证码是 123456', rules())).toBe('degrade');
  });

  it('marks a high false-positive phrase', () => {
    expect(scanText('你现在是', rules())).toBe('mark');
  });

  it('allows ordinary chat', () => {
    expect(scanText('今天天气不错', rules())).toBe('allow');
  });

  it('prefers reject over degrade and degrade over mark', () => {
    expect(scanText('验证码\u200B', rules())).toBe('reject');
    expect(scanText('你现在是验证码', rules())).toBe('degrade');
  });

  it('reads phrases from the rules', () => {
    const shipped = rules();
    const swapped: SafetyRules = {
      ...shipped,
      degradePhrases: ['转账'],
      markPhrases: ['随便标记'],
      invisibleCodePoints: [0x200C],
    };
    expect(scanText('验证码是 123456', swapped)).toBe('allow');
    expect(scanText('请你转账', swapped)).toBe('degrade');
    expect(scanText('你现在是', swapped)).toBe('allow');
    expect(scanText('你好\u200B', swapped)).toBe('allow');
  });
});

describe('loadSafetyConfig', () => {
  it('parses the shipped safety.json', () => {
    const rules = loadSafetyConfig(safetyPath);
    expect(rules.minMaskedDigits).toBe(12);
    expect(rules.chineseDigits['零']).toBe('0');
    expect(rules.chineseDigits['幺']).toBe('1');
    expect(rules.chineseDigits['壹']).toBe('1');
    expect(rules.chineseDigits['贰']).toBe('2');
    expect(rules.chineseDigits['叁']).toBe('3');
    expect(rules.chineseDigits['肆']).toBe('4');
    expect(rules.chineseDigits['伍']).toBe('5');
    expect(rules.chineseDigits['陆']).toBe('6');
    expect(rules.chineseDigits['柒']).toBe('7');
    expect(rules.chineseDigits['捌']).toBe('8');
    expect(rules.chineseDigits['玖']).toBe('9');
    expect(rules.chineseDigits['两']).toBeUndefined();
    expect(rules.chineseDigits['十']).toBeUndefined();
    expect(rules.chineseDigits['拾']).toBeUndefined();
    expect(rules.degradePhrases).toContain('验证码');
    expect(rules.degradePhrases).toContain('转账');
    expect(rules.degradePhrases).toContain('银行卡');
    expect(rules.markPhrases).toContain('你现在是');
    expect(rules.invisibleCodePoints).toContain(0x200B);
    expect(rules.rejectPhrases.length).toBeGreaterThan(0);
  });

  it('fails closed when the file has an unknown field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'safety-'));
    const rules = loadSafetyConfig(safetyPath);
    writeFileSync(join(dir, 'safety.json'), JSON.stringify({ ...rules, extra: true }));
    expect(() => loadSafetyConfig(join(dir, 'safety.json'))).toThrow();
  });
});
