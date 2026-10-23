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

  it('localizes perform_action copy for every language', () => {
    for (const language of ['zh', 'ja', 'en'] as const) {
      expect(i18n.memory[language].performAction.toolDescription.length).toBeGreaterThan(0);
      expect(i18n.memory[language].performAction.actionDescription).toContain('wave=');
    }
    expect(i18n.memory.zh.performAction.toolDescription).toBe('当用户请求虚拟人做动作时调用。只能做列出的动作；调用后用一句话自然回应，不要描述动作过程。');
    expect(i18n.memory.zh.performAction.actionDescription).toBe('wave=挥手, nod=点头, smile=微笑, turn=转身, heart=比心');
    expect(i18n.memory.ja.performAction.toolDescription).not.toBe(i18n.memory.zh.performAction.toolDescription);
    expect(i18n.memory.en.performAction.toolDescription).not.toBe(i18n.memory.zh.performAction.toolDescription);
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

  it('compiles said-frame query patterns for every language', () => {
    for (const language of ['zh', 'ja', 'en'] as const) {
      const patterns = i18n.memory[language].recall.queryFramePatterns;
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns.every((pattern) => pattern instanceof RegExp)).toBe(true);
    }
  });

  it('fails fast on a missing language file', () => {
    const dir = copyConfig();
    unlinkSync(join(dir, 'i18n', 'ja', 'memory.json'));
    expect(() => loadI18n(dir)).toThrow(/i18n_missing:ja:memory/);
  });

  it('fails fast when an exact vague pattern normalizes to nothing', () => {
    const dir = copyConfig();
    const path = join(dir, 'i18n', 'en', 'memory.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as { recall: { recentQueryExactPatterns: string[] } };
    value.recall.recentQueryExactPatterns = ['you know'];
    writeFileSync(path, JSON.stringify(value));
    expect(() => loadI18n(dir)).toThrow(/i18n_pattern_empty:en:recentQueryExactPatterns/);
  });

  it('fails fast on an invalid pattern', () => {
    const dir = copyConfig();
    const path = join(dir, 'i18n', 'en', 'memory.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as { addressingPatterns: string[] };
    value.addressingPatterns = ['(unclosed'];
    writeFileSync(path, JSON.stringify(value));
    expect(() => loadI18n(dir)).toThrow(/i18n_pattern_invalid:en:addressingPatterns/);
  });

  it('fails fast on an invalid query-frame pattern', () => {
    const dir = copyConfig();
    const path = join(dir, 'i18n', 'zh', 'memory.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as { recall: { queryFramePatterns: string[] } };
    value.recall.queryFramePatterns = ['(unclosed'];
    writeFileSync(path, JSON.stringify(value));
    expect(() => loadI18n(dir)).toThrow(/i18n_pattern_invalid:zh:queryFramePatterns/);
  });

  it('fails fast on an empty query-frame pattern list', () => {
    const dir = copyConfig();
    const path = join(dir, 'i18n', 'en', 'memory.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as { recall: { queryFramePatterns: string[] } };
    value.recall.queryFramePatterns = [];
    writeFileSync(path, JSON.stringify(value));
    expect(() => loadI18n(dir)).toThrow(/i18n_invalid:en:memory/);
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

describe('affect copy', () => {
  const i18n = loadI18n(config);
  const LANGS = ['zh', 'ja', 'en'] as const;

  it('loads affect copy for every language with the internal-reference tail', () => {
    expect(i18n.affect.zh.lines.tail).toContain('不要说出情绪名称');
    expect(i18n.affect.zh.lines.tail).toContain('用语气和内容表现');
    expect(i18n.affect.zh.lines.need.vent).toBe('想倾诉：多听，少提问。');
    expect(i18n.affect.zh.lines.strategy.reflect).toBe('用一句话点出感受，别逐字复述。');
    expect(i18n.affect.zh.lines.exhaustedHint).toContain('只换一次');
    expect(i18n.affect.zh.declinePhrases).toContain('不想聊这个');
    expect(i18n.affect.zh.solarTerms[0]).toEqual({ name: '小寒', month: 1, day: 5 });
    expect(i18n.affect.zh.solarTerms.find((term) => term.name === '冬至')).toEqual({ name: '冬至', month: 12, day: 21 });
    for (const language of LANGS) {
      const copy = i18n.affect[language];
      expect(copy.solarTerms).toHaveLength(24);
      expect(new Set(copy.solarTerms.map((term) => term.name)).size).toBe(24);
      expect(copy.solarTerms.map(({ month, day }) => [month, day]))
        .toEqual(i18n.affect.zh.solarTerms.map(({ month, day }) => [month, day]));
      expect(Object.keys(copy.seasons)).toEqual(['spring', 'summer', 'autumn', 'winter']);
      expect(Object.keys(copy.timeOfDay)).toEqual(['morning', 'noon', 'afternoon', 'evening', 'night']);
      expect(copy.declinePhrases.length).toBeGreaterThan(0);
    }
    expect(i18n.affect.ja.lines.tail).not.toBe(i18n.affect.zh.lines.tail);
    expect(i18n.affect.en.lines.tail).toContain('name emotions');
  });

  it('keeps the longest affect render inside the planned per-language budget', () => {
    // Guard until T3's startup check (maxAffectRender vs memory.json) exists. Seven '\n' separators included.
    const planned = { zh: 150, ja: 210, en: 250 } as const;
    const longest = (values: Record<string, string>) => Math.max(...Object.values(values).map((text) => text.length));
    for (const language of LANGS) {
      const { lines } = i18n.affect[language];
      const total = lines.crisis.length + longest(lines.mood) + longest(lines.trend) + longest(lines.need)
        + longest(lines.strategy) + lines.mismatch.length + lines.exhaustedHint.length + lines.tail.length + 7;
      expect(total, language).toBeLessThanOrEqual(planned[language]);
    }
  });

  it('fails fast on a missing affect pack', () => {
    const dir = copyConfig();
    unlinkSync(join(dir, 'i18n', 'ja', 'affect.json'));
    expect(() => loadI18n(dir)).toThrow(/i18n_missing:ja:affect/);
  });

  it('rejects solar-term dates that differ between languages', () => {
    const dir = copyConfig();
    const path = join(dir, 'i18n', 'en', 'affect.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as { solarTerms: { day: number }[] };
    value.solarTerms[3]!.day = 18;
    writeFileSync(path, JSON.stringify(value));
    expect(() => loadI18n(dir)).toThrow(/i18n_affect_parity:en:solarTerms/);
  });

  it('rejects impossible, out-of-order or duplicate solar terms', () => {
    const mutate = (edit: (terms: { name: string; month: number; day: number }[]) => void) => {
      const dir = copyConfig();
      const path = join(dir, 'i18n', 'zh', 'affect.json');
      const value = JSON.parse(readFileSync(path, 'utf8')) as { solarTerms: { name: string; month: number; day: number }[] };
      edit(value.solarTerms);
      writeFileSync(path, JSON.stringify(value));
      return dir;
    };
    expect(() => loadI18n(mutate((terms) => { terms[2] = { name: '立春', month: 2, day: 30 }; }))).toThrow(/i18n_invalid:zh:affect/);
    expect(() => loadI18n(mutate((terms) => { [terms[0], terms[1]] = [terms[1]!, terms[0]!]; }))).toThrow(/i18n_invalid:zh:affect/);
    expect(() => loadI18n(mutate((terms) => { terms[1]!.name = terms[0]!.name; }))).toThrow(/i18n_invalid:zh:affect/);
    expect(() => loadI18n(mutate((terms) => { terms.pop(); }))).toThrow(/i18n_invalid:zh:affect/);
  });

  it('rejects unknown keys and empty lines', () => {
    const dir = copyConfig();
    const path = join(dir, 'i18n', 'zh', 'affect.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as { lines: Record<string, unknown> };
    value.lines.extra = 'x';
    writeFileSync(path, JSON.stringify(value));
    expect(() => loadI18n(dir)).toThrow(/i18n_invalid:zh:affect/);

    const empty = copyConfig();
    const emptyPath = join(empty, 'i18n', 'ja', 'affect.json');
    const emptyValue = JSON.parse(readFileSync(emptyPath, 'utf8')) as { lines: { tail: string } };
    emptyValue.lines.tail = '';
    writeFileSync(emptyPath, JSON.stringify(emptyValue));
    expect(() => loadI18n(empty)).toThrow(/i18n_invalid:ja:affect/);
  });
});
