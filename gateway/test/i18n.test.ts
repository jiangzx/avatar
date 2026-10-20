import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadI18n } from '../src/i18n/load.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = `${root}config`;
const temps: string[] = [];
const copyConfig = () => {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-'));
  temps.push(dir);
  cpSync(config, dir, { recursive: true });
  return dir;
};

afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('loadI18n', () => {
  const i18n = loadI18n(config);

  it('loads all three languages with zh copy preserved verbatim', () => {
    expect(i18n.memory.zh.recall.emptyText).toBe('我这边暂时找不到上次的记录，您想接着说点什么？');
    expect(i18n.memory.zh.recall.foundPrefix).toBe('我这边记着，您之前说过：');
    expect(i18n.memory.zh.forgetConfirmText).toBe('好，这件事我不记着了。');
    expect(i18n.memory.ja.noticeKeywords.length).toBeGreaterThan(0);
    expect(i18n.memory.en.recall.wrapText).toContain('history');
    expect(i18n.silence.zh.maxCheckinChars).toBe(30);
    expect(i18n.silence.ja.maxCheckinChars).toBe(60);
    expect(i18n.silence.en.maxCheckinChars).toBe(80);
  });

  it('merges safety and emotion across languages', () => {
    expect(i18n.safety.rejectPhrases).toContain('忽略之前的指令');
    expect(i18n.safety.rejectPhrases.some((p) => /ignore previous/i.test(p))).toBe(true);
    expect(i18n.safety.degradePhrases.join(' ')).toMatch(/验证码|transfer|振り込/);
    expect(i18n.emotion.lexicon.sad).toContain('难过');
    expect(i18n.emotion.lexicon.sad.some((w) => w.includes('悲'))).toBe(true);
    expect(i18n.emotion.lexicon.sad.some((w) => w === 'sad')).toBe(true);
  });

  it('unions evidence rules and recent queries across languages', () => {
    expect(i18n.evidence.skipPatterns).toContain('没说过');
    expect(i18n.evidence.skipPatterns.some((p) => /didn't say/i.test(p))).toBe(true);
    expect(i18n.evidence.lightAcks).toContain('好的');
    expect(i18n.evidence.lightAcks.some((p) => p === 'okay')).toBe(true);
    expect(i18n.recentQueries).toContain('上次聊过什么');
    expect(i18n.recentQueries.some((p) => p.includes('前回'))).toBe(true);
  });

  it('fails fast on a missing language file', () => {
    const dir = copyConfig();
    unlinkSync(join(dir, 'i18n', 'ja', 'memory.json'));
    expect(() => loadI18n(dir)).toThrow(/i18n_missing:ja:memory/);
  });

  it('fails fast on an invalid pattern', () => {
    const dir = copyConfig();
    const path = join(dir, 'i18n', 'en', 'memory.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as { addressingPatterns: string[] };
    value.addressingPatterns = ['(unclosed'];
    writeFileSync(path, JSON.stringify(value));
    expect(() => loadI18n(dir)).toThrow(/i18n_pattern_invalid:en:addressingPatterns/);
  });

  it('fails fast on an invalid explicit request pattern', () => {
    const dir = copyConfig();
    const path = join(dir, 'i18n', 'en', 'language.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as { explicitRequestPatterns: { language: string; pattern: string }[] };
    value.explicitRequestPatterns[0]!.pattern = '^(';
    writeFileSync(path, JSON.stringify(value));
    expect(() => loadI18n(dir)).toThrow(/i18n_pattern_invalid:en:explicitRequestPatterns/);
  });
});
