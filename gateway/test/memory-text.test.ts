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
  it('normalizes Chinese numerals, then masks a run of 12 digits', () => {
    expect(normalizeChineseDigits('一二三四五六七八九零一二')).toBe('123456789012');
    expect(redact('一二三四五六七八九零一二')).toBe('************');
  });

  it('leaves an 11-digit phone number unchanged', () => {
    expect(redact('13800138000')).toBe('13800138000');
    expect(redact('一三八零零一三八零零零')).toBe('13800138000');
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
