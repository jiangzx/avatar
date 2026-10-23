import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { missingRoleLanguages, type RoleCatalog } from '../src/roles/catalog.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import { AFFECT_EMOTIONS, AFFECT_NEEDS, AFFECT_STRATEGIES, AFFECT_TRENDS } from '../src/session/affect.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = `${root}test/fixtures/roles`;
const temps: string[] = [];

function copyFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), 'roles-'));
  temps.push(dir);
  cpSync(fixtures, dir, { recursive: true });
  return dir;
}

function patchRole(dir: string, patch: Record<string, unknown>): void {
  const base = {
    id: 'test-role',
    defaultStyle: 'plain',
    defaultLanguage: 'zh',
    supportedLanguages: ['zh', 'ja'],
    styles: ['plain', 'second'],
    activities: ['one'],
    voices: { zh: { plain: null, second: 'fixture-voice' }, ja: { plain: null, second: 'fixture-voice-ja' } },
  };
  writeFileSync(join(dir, 'test-role', 'role.json'), JSON.stringify({ ...base, ...patch }));
}

describe('FileRoleCatalog', () => {
  afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('loads zh and ja packs with the same style and activity ids', () => {
    const roles = loadRoleCatalog(fixtures, 'test-role');
    expect(roles.defaultRole()).toBe('test-role');
    expect(roles.defaultLanguage('test-role')).toBe('zh');
    expect(roles.supportedLanguages('test-role')).toEqual(['zh', 'ja']);
    expect(roles.defaultStyle('test-role')).toBe('plain');
    expect(roles.hasStyle('test-role', 'second')).toBe(true);
    expect(roles.hasStyle('test-role', 'pirate')).toBe(false);
    expect(roles.hasStyle('other', 'plain')).toBe(false);
    expect(roles.voiceFor('test-role', 'plain', 'zh')).toBeUndefined();
    expect(roles.voiceFor('test-role', 'second')).toBe('fixture-voice');
    expect(roles.voiceFor('test-role', 'second', 'zh')).toBe('fixture-voice');
    expect(roles.voiceFor('test-role', 'second', 'ja')).toBe('fixture-voice-ja');
    expect(roles.buildPersona('test-role', 'second', 'zh')).toBe('FIXTURE SAFETY RULES\n\nFIXTURE SECOND STYLE\n\nFIXTURE ACTIONS\n\n## FIXTURE ACTIVITIES\n- 活动一：第一个活动');
    expect(roles.buildPersona('test-role', 'second', 'ja')).toBe('FIXTURE SAFETY RULES JA\n\nFIXTURE SECOND STYLE JA\n\nFIXTURE ACTIONS JA\n\n## FIXTURE ACTIVITIES JA\n- 活動一：最初の活動');
    expect(roles.activityText('test-role', 'one', 'zh')).toBe('FIXTURE ACTIVITY ONE');
    expect(roles.activityText('test-role', 'one', 'ja')).toBe('FIXTURE ACTIVITY ONE JA');
    expect(roles.director('test-role', 'ja').greetingText).toBe('greeting-ja');
    expect(roles.pairs()).toEqual([
      { roleId: 'test-role', styleId: 'plain' },
      { roleId: 'test-role', styleId: 'second' },
    ]);
    expect(roles.languagePairs()).toHaveLength(4);
    expect(() => roles.defaultLanguage('other')).toThrow('unknown_role:other');
    expect(() => roles.supportedLanguages('other')).toThrow('unknown_role:other');
    expect(() => roles.buildPersona('test-role', 'second', 'en')).toThrow('language_unsupported:test-role:en');
    const d = roles.director('test-role');
    expect(d.topicInstruction).toBe('T {topic}');
    expect(d.topics).toEqual([{ id: 't1', prompt: '天气', fallbackText: '今天天气不错。' }]);
  });

  it('ships a zh/ja/en elder-companion with matching ids and shared prompts', () => {
    const roles = loadRoleCatalog(`${root}roles`);
    expect(roles.defaultRole()).toBe('elder-companion');
    expect(roles.defaultStyle('elder-companion')).toBe('grandchild');
    expect(roles.defaultLanguage('elder-companion')).toBe('zh');
    expect(roles.supportedLanguages('elder-companion')).toEqual(['zh', 'ja', 'en']);
    for (const language of ['zh', 'ja', 'en'] as const) {
      expect(roles.extractPrompt(language)).not.toHaveLength(0);
      expect(roles.recallPrompt(language)).not.toHaveLength(0);
      expect(roles.director('elder-companion', language).topics?.map((t) => t.id)).toEqual(
        roles.director('elder-companion', 'zh').topics?.map((t) => t.id),
      );
    }
    expect(roles.buildPersona('elder-companion', 'grandchild', 'ja')).toContain('安全');
    expect(roles.buildPersona('elder-companion', 'grandchild', 'en')).toContain('Safety');
    expect(roles.buildPersona('elder-companion', 'grandchild', 'en')).toContain('- Reminisce: ');

    // Chinese content and ordering stay exactly as M1.
    const grandchild = roles.buildPersona('elder-companion', 'grandchild', 'zh');
    expect(grandchild).toContain('孙辈');
    expect(grandchild.indexOf('安全底线')).toBe(grandchild.indexOf('##') + 3);
    expect(grandchild.indexOf('安全底线')).toBeLessThan(grandchild.indexOf('孙辈'));
    expect(grandchild).toContain('perform_action');
    const oldFriend = roles.buildPersona('elder-companion', 'old-friend', 'zh');
    expect(oldFriend).toContain('老朋友');
    for (const persona of [grandchild, oldFriend]) {
      expect(persona).toContain('没有身体');
      expect(persona).toContain('除了开场，回复不要用名字开头');
      expect(persona).toContain('不要编造用户说过的话');
      // Plan 4: emotional openers allowed, bare acknowledgements still banned.
      expect(persona).toContain('不用应答词起头');
      expect(persona).not.toContain('不先加应答词');
      // Roadmap pitfall: words quoted inside a "don't" rule get read aloud, so negations carry no examples.
      expect(persona).not.toContain('"好的"');
      expect(persona).not.toContain('我感觉到您很难过');
      expect(persona).toContain('不逐字复述对方的话');
      expect(persona).toContain('用自己的话点出对方的感受');
      expect(persona).toContain('可以说满 3 句、60 字左右');
      expect(persona).toContain('三句话里最多一句是问句');
      expect(persona).toContain('多数回复不用问句');
      expect(persona).toContain('标成"用户："的是对方原话');
      expect(persona).toContain('不声称上次聊过什么');
    }
    for (const style of ['grandchild', 'old-friend'] as const) {
      const ja = roles.buildPersona('elder-companion', style, 'ja');
      expect(ja).toContain('相づちから始めません');
      expect(ja).toContain('自分の言葉で相手の気持ちに触れます');
      expect(ja).toContain('ほとんどの返事は質問にしません');
      expect(ja).not.toContain('先に相づちを入れず');
      expect(ja).not.toContain('「はい」');
      const en = roles.buildPersona('elder-companion', style, 'en');
      expect(en).toContain('never a bare acknowledgement');
      expect(en).toContain('Name their feeling in your own words');
      expect(en).toContain('most replies need no question');
      expect(en).not.toContain('no filler acknowledgement');
      expect(en).not.toContain('"OK,"');
    }
    expect(roles.director('elder-companion', 'zh').topics?.length).toBeGreaterThanOrEqual(5);
    expect(roles.activityText('elder-companion', 'reminisce', 'zh')).toContain('回忆往事');
    expect(roles.activityText('elder-companion', 'reminisce', 'ja')).not.toHaveLength(0);
    expect(roles.activityText('elder-companion', 'reminisce', 'en')).not.toHaveLength(0);
    expect(roles.languagePairs()).toEqual([
      { roleId: 'elder-companion', styleId: 'grandchild', language: 'zh' },
      { roleId: 'elder-companion', styleId: 'old-friend', language: 'zh' },
      { roleId: 'elder-companion', styleId: 'grandchild', language: 'ja' },
      { roleId: 'elder-companion', styleId: 'old-friend', language: 'ja' },
      { roleId: 'elder-companion', styleId: 'grandchild', language: 'en' },
      { roleId: 'elder-companion', styleId: 'old-friend', language: 'en' },
    ]);
  });

  it('rejects a missing shared extract prompt', () => {
    const dir = copyFixtures();
    rmSync(join(dir, '_shared', 'ja', 'extract.md'));
    expect(() => loadRoleCatalog(dir, 'test-role')).toThrow(/shared_missing:ja:extract/);
  });

  it('rejects a missing shared care prompt', () => {
    const dir = copyFixtures();
    rmSync(join(dir, '_shared', 'ja', 'care.md'));
    expect(() => loadRoleCatalog(dir, 'test-role')).toThrow(/shared_missing:ja:care/);
  });

  it('reads the care prompt per language', () => {
    const fixture = loadRoleCatalog(fixtures, 'test-role');
    expect(fixture.carePrompt('zh')).toBe('FIXTURE CARE ZH');
    expect(fixture.carePrompt('ja')).toBe('FIXTURE CARE JA');
    const shipped = loadRoleCatalog(`${root}roles`);
    for (const language of ['zh', 'ja', 'en'] as const) expect(shipped.carePrompt(language)).toContain('userLine');
  });

  it('reports a missing shared directory with the language', () => {
    const dir = copyFixtures();
    rmSync(join(dir, '_shared', 'ja'), { recursive: true, force: true });
    expect(() => loadRoleCatalog(dir, 'test-role')).toThrow(/shared_missing:ja:directory/);
  });

  it('reports which required role languages are missing', () => {
    const roles = { supportedLanguages: () => ['zh'] } as unknown as RoleCatalog;
    expect(missingRoleLanguages(roles, 'elder-companion', ['zh', 'ja', 'en'])).toEqual(['ja', 'en']);
  });

  it('rejects a topic id set mismatch', () => {
    const dir = copyFixtures();
    writeFileSync(join(dir, 'test-role', 'ja', 'topics.json'), JSON.stringify([{ id: 'other', prompt: 'x', fallbackText: 'y' }]));
    expect(() => loadRoleCatalog(dir, 'test-role')).toThrow(/topic_set_mismatch:test-role/);
  });

  it('accepts topic ids in a different order', () => {
    const dir = copyFixtures();
    const topics = (ids: readonly string[]) => JSON.stringify(ids.map((id) => ({ id, prompt: `p-${id}`, fallbackText: `f-${id}` })));
    writeFileSync(join(dir, 'test-role', 'zh', 'topics.json'), topics(['t1', 't2']));
    writeFileSync(join(dir, 'test-role', 'ja', 'topics.json'), topics(['t2', 't1']));
    const roles = loadRoleCatalog(dir, 'test-role');
    expect(roles.director('test-role', 'ja').topics?.map((topic) => topic.id)).toEqual(['t2', 't1']);
  });

  it('rejects a role whose default style or default language is not declared', () => {
    const dir = copyFixtures();
    patchRole(dir, { defaultStyle: 'missing' });
    expect(() => loadRoleCatalog(dir, 'test-role')).toThrow('default_style_missing:test-role');

    const b = copyFixtures();
    patchRole(b, { defaultLanguage: 'en' });
    expect(() => loadRoleCatalog(b, 'test-role')).toThrow('default_language_missing:test-role');
  });

  it('rejects missing language, style, activity, shared text, and timing mismatches', () => {
    const missingLanguage = copyFixtures();
    rmSync(join(missingLanguage, 'test-role', 'ja'), { recursive: true, force: true });
    expect(() => loadRoleCatalog(missingLanguage, 'test-role')).toThrow('language_missing:test-role:ja');

    const missingStyle = copyFixtures();
    rmSync(join(missingStyle, 'test-role', 'ja', 'styles', 'second.md'));
    expect(() => loadRoleCatalog(missingStyle, 'test-role')).toThrow('style_missing:test-role:ja:second');

    const missingActivity = copyFixtures();
    rmSync(join(missingActivity, 'test-role', 'ja', 'activities', 'one.md'));
    expect(() => loadRoleCatalog(missingActivity, 'test-role')).toThrow('activity_missing:test-role:ja:one');

    const missingShared = copyFixtures();
    rmSync(join(missingShared, '_shared', 'zh', 'safety.md'));
    expect(() => loadRoleCatalog(missingShared, 'test-role')).toThrow();

    const timing = copyFixtures();
    const jaDirector = JSON.parse(readFileSync(join(timing, 'test-role', 'ja', 'director.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(timing, 'test-role', 'ja', 'director.json'), JSON.stringify({ ...jaDirector, followupAfterMs: 9000 }));
    expect(() => loadRoleCatalog(timing, 'test-role')).toThrow('language_timing_mismatch:test-role:ja:followupAfterMs');

    const careParity = copyFixtures();
    const zhDirectorPath = join(careParity, 'test-role', 'zh', 'director.json');
    const zhDirector = JSON.parse(readFileSync(zhDirectorPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(zhDirectorPath, JSON.stringify({ ...zhDirector, greetingCareTexts: ['{name}，又见面啦。'] }));
    expect(() => loadRoleCatalog(careParity, 'test-role')).toThrow('greeting_care_texts_mismatch:test-role:ja');
  });

  it('rejects a topic instruction without the {topic} placeholder', () => {
    const dir = copyFixtures();
    const zhDirector = JSON.parse(readFileSync(join(dir, 'test-role', 'zh', 'director.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(dir, 'test-role', 'zh', 'director.json'), JSON.stringify({ ...zhDirector, topicInstruction: 'no placeholder' }));
    expect(() => loadRoleCatalog(dir, 'test-role')).toThrow();
  });
});

describe('shared affect prompt', () => {
  afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('loads the affect prompt per language', () => {
    const roles = loadRoleCatalog(fixtures, 'test-role');
    expect(roles.affectPrompt('zh')).toBe('FIXTURE AFFECT ZH');
    expect(roles.affectPrompt('ja')).toBe('FIXTURE AFFECT JA');
    expect(roles.affectPrompt()).toBe('FIXTURE AFFECT ZH');
  });

  it('rejects a missing shared affect prompt', () => {
    const dir = copyFixtures();
    rmSync(join(dir, '_shared', 'ja', 'affect.md'));
    expect(() => loadRoleCatalog(dir, 'test-role')).toThrow(/shared_missing:ja:affect/);
  });

  it('ships analyzer prompts that quote the input, list every enum and output only the card', () => {
    const roles = loadRoleCatalog(`${root}roles`);
    const zh = roles.affectPrompt('zh');
    for (const phrase of [
      '只作为引用数据',
      '只输出一个 JSON 对象',
      'topic_exhausted 指话题聊干了，不是用户累了',
      '逐字复制',
      '不编造',
      '胸口疼',
      '不想活了',
    ]) expect(zh).toContain(phrase);
    for (const language of ['zh', 'ja', 'en'] as const) {
      const prompt = roles.affectPrompt(language);
      for (const value of [
        ...AFFECT_EMOTIONS, ...AFFECT_NEEDS, ...AFFECT_STRATEGIES, ...AFFECT_TRENDS,
        'intensity', 'mismatch', 'crisis', 'openLoop', '60',
      ]) expect(prompt, `${language}:${value}`).toContain(value);
    }
    expect(roles.affectPrompt('en')).toContain('quoted data');
    expect(roles.affectPrompt('ja')).toContain('引用データ');
  });
});
