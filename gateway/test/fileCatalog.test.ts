import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CHARACTER_IDS, LANGUAGES } from '@anyidea/protocol';
import { missingRoleLanguages, type RoleCatalog } from '../src/roles/catalog.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import { AFFECT_EMOTIONS, AFFECT_NEEDS, AFFECT_STRATEGIES, AFFECT_TRENDS } from '../src/session/affect.ts';
import { fixtureCharacters, shippedCharacters, shippedRoles } from './support/shipped.ts';

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
  const base = { id: 'test-role', defaultLanguage: 'zh', supportedLanguages: ['zh', 'ja'], activities: ['one'] };
  writeFileSync(join(dir, 'test-role', 'role.json'), JSON.stringify({ ...base, ...patch }));
}

describe('FileRoleCatalog', () => {
  afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('renders the fixture persona, director and prompts per character and language', () => {
    const roles = loadRoleCatalog(fixtures, fixtureCharacters());
    expect(roles.defaultRole()).toBe('test-role');
    expect(roles.defaultLanguage('test-role')).toBe('zh');
    expect(roles.supportedLanguages('test-role')).toEqual(['zh', 'ja']);
    expect(roles.buildPersona('xiaonuan', 'zh')).toBe('FIXTURE SAFETY RULES\n\nFIXTURE PERSONA 阿甲\nFIXTURE IDENTITY A ZH\n\nFIXTURE ACTIONS\n\n## FIXTURE ACTIVITIES\n- 活动一：第一个活动');
    expect(roles.buildPersona('xiaokai', 'ja')).toBe('FIXTURE SAFETY RULES JA\n\nFIXTURE PERSONA JA 阿乙（アオツ）\nFIXTURE IDENTITY B JA\n\nFIXTURE ACTIONS JA\n\n## FIXTURE ACTIVITIES JA\n- 活動一：最初の活動');
    expect(roles.buildPersona('xiaoxin')).toContain('FIXTURE IDENTITY C ZH');
    expect(roles.activityText('test-role', 'one', 'zh')).toBe('FIXTURE ACTIVITY ONE');
    expect(roles.activityText('test-role', 'one', 'ja')).toBe('FIXTURE ACTIVITY ONE JA');
    expect(roles.director('xiaonuan', 'ja').greetingText).toBe('greeting-ja');
    expect(roles.director('xiaonuan', 'zh').greetingInstruction).toBe('G 阿甲');
    expect(roles.director('xiaokai', 'zh').greetingInstruction).toBe('G 阿乙');
    expect(roles.recallPrompt('xiaokai', 'zh')).toBe('FIXTURE RECALL ZH 阿乙');
    expect(roles.characterLanguagePairs()).toHaveLength(6);
    expect(() => roles.defaultLanguage('other')).toThrow('unknown_role:other');
    expect(() => roles.supportedLanguages('other')).toThrow('unknown_role:other');
    expect(() => roles.buildPersona('xiaonuan', 'en')).toThrow('language_unsupported:test-role:en');
    const d = roles.director('xiaonuan');
    expect(d.topicInstruction).toBe('T {topic}');
    expect(d.topics).toEqual([{ id: 't1', prompt: '天气', fallbackText: '今天天气不错。' }]);
  });

  it('ships a zh/ja/en elder-companion rendered for all three characters', () => {
    const roles = shippedRoles();
    expect(roles.defaultRole()).toBe('elder-companion');
    expect(roles.defaultLanguage('elder-companion')).toBe('zh');
    expect(roles.supportedLanguages('elder-companion')).toEqual(['zh', 'ja', 'en']);
    expect(roles.characterLanguagePairs()).toHaveLength(9);
    for (const language of LANGUAGES) {
      expect(roles.extractPrompt(language)).not.toHaveLength(0);
      expect(roles.recallPrompt('xiaonuan', language)).not.toHaveLength(0);
      expect(roles.director('xiaonuan', language).topics?.map((t) => t.id)).toEqual(
        roles.director('xiaonuan', 'zh').topics?.map((t) => t.id),
      );
    }
    expect(roles.buildPersona('xiaonuan', 'ja')).toContain('安全');
    expect(roles.buildPersona('xiaonuan', 'en')).toContain('Safety');
    expect(roles.buildPersona('xiaonuan', 'en')).toContain('- Reminisce: ');

    // Safety still comes first; the relationship now lives in the card identity.
    const zh = (id: (typeof CHARACTER_IDS)[number]) => roles.buildPersona(id, 'zh');
    expect(zh('xiaonuan').indexOf('安全底线')).toBe(zh('xiaonuan').indexOf('##') + 3);
    expect(zh('xiaonuan').indexOf('安全底线')).toBeLessThan(zh('xiaonuan').indexOf('孙女'));
    expect(zh('xiaonuan')).toContain('撒个小娇');
    expect(zh('xiaokai')).toContain('孙子');
    expect(zh('xiaokai')).not.toContain('撒个小娇');
    expect(zh('xiaoxin')).toContain('老朋友');
    expect(zh('xiaoxin')).not.toContain('撒娇');
    for (const id of CHARACTER_IDS) {
      const persona = zh(id);
      expect(persona).toContain('perform_action');
      expect(persona).toContain('没有身体');
      expect(persona).toContain('除了开场，回复不要用名字开头');
      expect(persona).toContain('不要编造用户说过的话');
      expect(persona).toContain('不用应答词起头');
      expect(persona).not.toContain('不先加应答词');
      expect(persona).not.toContain('"好的"');
      expect(persona).not.toContain('我感觉到您很难过');
      expect(persona).toContain('不逐字复述对方的话');
      expect(persona).toContain('用自己的话点出对方的感受');
      expect(persona).toContain('可以说满 3 句、60 字左右');
      expect(persona).toContain('三句话里最多一句是问句');
      expect(persona).toContain('标成"用户："的是对方原话');
      expect(persona).toContain('不声称上次聊过什么');
      expect(persona).toContain('标成"基本情况："的是对方的基本资料');
      expect(persona).toContain('用户提到你不认识的名字时，当作用户认识的人来接话');
      const ja = roles.buildPersona(id, 'ja');
      expect(ja).toContain('相づちから始めません');
      expect(ja).toContain('自分の言葉で相手の気持ちに触れます');
      expect(ja).not.toContain('先に相づちを入れず');
      expect(ja).not.toContain('「はい」');
      expect(ja).toContain('「基本情報：」');
      expect(ja).toContain('ユーザーが知らない名前を口にしたら');
      const en = roles.buildPersona(id, 'en');
      expect(en).toContain('never a bare acknowledgement');
      expect(en).toContain('Name their feeling in your own words');
      expect(en).not.toContain('no filler acknowledgement');
      expect(en).not.toContain('"OK,"');
      expect(en).toContain('"Basic facts:"');
      expect(en).toContain("If the user mentions a name you don't know");
    }
    expect(roles.director('xiaonuan', 'zh').topics?.length).toBeGreaterThanOrEqual(5);
    expect(roles.activityText('elder-companion', 'reminisce', 'zh')).toContain('回忆往事');
    expect(roles.activityText('elder-companion', 'reminisce', 'ja')).not.toHaveLength(0);
    expect(roles.activityText('elder-companion', 'reminisce', 'en')).not.toHaveLength(0);
  });

  it('replaces every placeholder with the character name, reading and identity', () => {
    const roles = shippedRoles();
    const characters = shippedCharacters();
    for (const id of CHARACTER_IDS) {
      for (const language of LANGUAGES) {
        const texts = [
          roles.buildPersona(id, language),
          JSON.stringify(roles.director(id, language)),
          roles.recallPrompt(id, language),
          roles.affectPrompt(id, language),
        ];
        for (const text of texts) expect(text, `${id}:${language}`).not.toContain('{{');
        expect(roles.buildPersona(id, language)).toContain(characters.name(id, language));
        expect(roles.buildPersona(id, language)).toContain(characters.identity(id, language));
        for (const other of CHARACTER_IDS.filter((x) => x !== id)) {
          for (const text of texts) {
            expect(text, `${id}:${language}:${other}`).not.toContain(characters.name(other, language));
            expect(text, `${id}:${language}:${other}`).not.toContain(characters.spokenName(other, language));
          }
        }
      }
    }
    expect(roles.director('xiaokai', 'zh').greetingText).toBe('您好，我是小凯，来陪您说说话。您怎么称呼？');
    expect(roles.director('xiaonuan', 'ja').greetingText).toBe('こんにちは、シャオヌアンです。お話ししに来ました。どうお呼びすればいいですか？');
    expect(roles.director('xiaoxin', 'en').greetingText).toBe("Hello, I'm Xiaoxin. I came to keep you company. What should I call you?");
    expect(roles.recallPrompt('xiaoxin', 'en').startsWith('You are Xiaoxin,')).toBe(true);
    expect(roles.affectPrompt('xiaonuan', 'zh').startsWith('你是小暖的情绪分析器')).toBe(true);
    expect(roles.buildPersona('xiaokai', 'ja')).toContain('自分の名前を口にするときは「シャオカイ」と言います。');
    expect(roles.buildPersona('xiaoxin', 'en')).toContain('Xiaoxin is your name; never use it to address the user.');
    expect(roles.buildPersona('xiaokai', 'zh')).toContain('小凯是你的名字，不要用来称呼对方。');
  });

  it('fails on an unresolved or unknown placeholder', () => {
    const persona = copyFixtures();
    writeFileSync(join(persona, 'test-role', 'ja', 'persona.md'), 'FIXTURE {{charIdentity}} {{nickname}}');
    expect(() => loadRoleCatalog(persona, fixtureCharacters())).toThrow('placeholder_unresolved:xiaonuan:ja:persona');

    const extract = copyFixtures();
    writeFileSync(join(extract, '_shared', 'zh', 'extract.md'), 'EXTRACT {{char}}');
    expect(() => loadRoleCatalog(extract, fixtureCharacters())).toThrow('placeholder_unresolved:shared:zh:extract');

    const activity = copyFixtures();
    writeFileSync(join(activity, 'test-role', 'zh', 'activities', 'one.md'), 'ACTIVITY {{char}}');
    expect(() => loadRoleCatalog(activity, fixtureCharacters())).toThrow('placeholder_unresolved:test-role:zh:activity:one');
  });

  it('requires persona.md with the identity placeholder', () => {
    const missing = copyFixtures();
    rmSync(join(missing, 'test-role', 'ja', 'persona.md'));
    expect(() => loadRoleCatalog(missing, fixtureCharacters())).toThrow('persona_missing:test-role:ja');

    const noIdentity = copyFixtures();
    writeFileSync(join(noIdentity, 'test-role', 'zh', 'persona.md'), 'NO IDENTITY {{char}}');
    expect(() => loadRoleCatalog(noIdentity, fixtureCharacters())).toThrow('persona_identity_missing:test-role:zh');
  });

  it('rejects a character whose role pack does not exist', () => {
    expect(() => loadRoleCatalog(fixtures, shippedCharacters())).toThrow('character_role_missing:xiaonuan:elder-companion');
  });

  it('rejects a missing shared extract prompt', () => {
    const dir = copyFixtures();
    rmSync(join(dir, '_shared', 'ja', 'extract.md'));
    expect(() => loadRoleCatalog(dir, fixtureCharacters())).toThrow(/shared_missing:ja:extract/);
  });

  it('reports a missing shared directory with the language', () => {
    const dir = copyFixtures();
    rmSync(join(dir, '_shared', 'ja'), { recursive: true, force: true });
    expect(() => loadRoleCatalog(dir, fixtureCharacters())).toThrow(/shared_missing:ja:directory/);
  });

  it('reports which required role languages are missing', () => {
    const roles = { supportedLanguages: () => ['zh'] } as unknown as RoleCatalog;
    expect(missingRoleLanguages(roles, 'elder-companion', ['zh', 'ja', 'en'])).toEqual(['ja', 'en']);
  });

  it('rejects a topic id set mismatch', () => {
    const dir = copyFixtures();
    writeFileSync(join(dir, 'test-role', 'ja', 'topics.json'), JSON.stringify([{ id: 'other', prompt: 'x', fallbackText: 'y' }]));
    expect(() => loadRoleCatalog(dir, fixtureCharacters())).toThrow(/topic_set_mismatch:test-role/);
  });

  it('accepts topic ids in a different order', () => {
    const dir = copyFixtures();
    const topics = (ids: readonly string[]) => JSON.stringify(ids.map((id) => ({ id, prompt: `p-${id}`, fallbackText: `f-${id}` })));
    writeFileSync(join(dir, 'test-role', 'zh', 'topics.json'), topics(['t1', 't2']));
    writeFileSync(join(dir, 'test-role', 'ja', 'topics.json'), topics(['t2', 't1']));
    const roles = loadRoleCatalog(dir, fixtureCharacters());
    expect(roles.director('xiaonuan', 'ja').topics?.map((topic) => topic.id)).toEqual(['t2', 't1']);
  });

  it('rejects an undeclared default language and the removed style fields', () => {
    const language = copyFixtures();
    patchRole(language, { defaultLanguage: 'en' });
    expect(() => loadRoleCatalog(language, fixtureCharacters())).toThrow('default_language_missing:test-role');

    for (const removed of [{ styles: ['plain'] }, { defaultStyle: 'plain' }, { voices: {} }]) {
      const dir = copyFixtures();
      patchRole(dir, removed);
      expect(() => loadRoleCatalog(dir, fixtureCharacters())).toThrow();
    }
  });

  it('rejects missing language, activity, shared text, and timing mismatches', () => {
    const missingLanguage = copyFixtures();
    rmSync(join(missingLanguage, 'test-role', 'ja'), { recursive: true, force: true });
    expect(() => loadRoleCatalog(missingLanguage, fixtureCharacters())).toThrow('language_missing:test-role:ja');

    const missingActivity = copyFixtures();
    rmSync(join(missingActivity, 'test-role', 'ja', 'activities', 'one.md'));
    expect(() => loadRoleCatalog(missingActivity, fixtureCharacters())).toThrow('activity_missing:test-role:ja:one');

    const missingShared = copyFixtures();
    rmSync(join(missingShared, '_shared', 'zh', 'safety.md'));
    expect(() => loadRoleCatalog(missingShared, fixtureCharacters())).toThrow();

    const timing = copyFixtures();
    const jaDirector = JSON.parse(readFileSync(join(timing, 'test-role', 'ja', 'director.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(timing, 'test-role', 'ja', 'director.json'), JSON.stringify({ ...jaDirector, followupAfterMs: 9000 }));
    expect(() => loadRoleCatalog(timing, fixtureCharacters())).toThrow('language_timing_mismatch:test-role:ja:followupAfterMs');

    const careParity = copyFixtures();
    const zhDirectorPath = join(careParity, 'test-role', 'zh', 'director.json');
    const zhDirector = JSON.parse(readFileSync(zhDirectorPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(zhDirectorPath, JSON.stringify({ ...zhDirector, greetingCareTexts: ['{name}，又见面啦。'] }));
    expect(() => loadRoleCatalog(careParity, fixtureCharacters())).toThrow('greeting_care_texts_mismatch:test-role:ja');
  });

  it('rejects a topic instruction without the {topic} placeholder', () => {
    const dir = copyFixtures();
    const zhDirector = JSON.parse(readFileSync(join(dir, 'test-role', 'zh', 'director.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(dir, 'test-role', 'zh', 'director.json'), JSON.stringify({ ...zhDirector, topicInstruction: 'no placeholder' }));
    expect(() => loadRoleCatalog(dir, fixtureCharacters())).toThrow();
  });
});

describe('shared affect prompt', () => {
  afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('loads the affect prompt per language', () => {
    const roles = loadRoleCatalog(fixtures, fixtureCharacters());
    expect(roles.affectPrompt('xiaonuan', 'zh')).toBe('FIXTURE AFFECT ZH');
    expect(roles.affectPrompt('xiaonuan', 'ja')).toBe('FIXTURE AFFECT JA');
    expect(roles.affectPrompt('xiaonuan')).toBe('FIXTURE AFFECT ZH');
  });

  it('rejects a missing shared affect prompt', () => {
    const dir = copyFixtures();
    rmSync(join(dir, '_shared', 'ja', 'affect.md'));
    expect(() => loadRoleCatalog(dir, fixtureCharacters())).toThrow(/shared_missing:ja:affect/);
  });

  it('ships analyzer prompts that quote the input, list every enum and output only the card', () => {
    const roles = shippedRoles();
    const zh = roles.affectPrompt('xiaonuan', 'zh');
    for (const phrase of [
      '只作为引用数据',
      '只输出一个 JSON 对象',
      'topic_exhausted 指话题聊干了，不是用户累了',
      '逐字复制',
      '不编造',
      '胸口疼',
      '不想活了',
    ]) expect(zh).toContain(phrase);
    for (const language of LANGUAGES) {
      const prompt = roles.affectPrompt('xiaonuan', language);
      for (const value of [
        ...AFFECT_EMOTIONS, ...AFFECT_NEEDS, ...AFFECT_STRATEGIES, ...AFFECT_TRENDS,
        'intensity', 'mismatch', 'crisis', 'openLoop', '60',
      ]) expect(prompt, `${language}:${value}`).toContain(value);
    }
    expect(roles.affectPrompt('xiaonuan', 'en')).toContain('quoted data');
    expect(roles.affectPrompt('xiaonuan', 'ja')).toContain('引用データ');
  });
});
