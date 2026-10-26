import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CHARACTER_IDS, LANGUAGES, type CharacterId } from '@anyidea/protocol';
import { loadCharacterRegistry } from '../src/characters/registry.ts';

const shipped = fileURLToPath(new URL('../characters', import.meta.url));
const temps: string[] = [];

function copyCards(): string {
  const dir = mkdtempSync(join(tmpdir(), 'characters-'));
  temps.push(dir);
  cpSync(shipped, dir, { recursive: true });
  return dir;
}

function patchCard(dir: string, id: string, patch: (card: Record<string, any>) => void): void {
  const path = join(dir, `${id}.json`);
  const card = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  patch(card);
  writeFileSync(path, JSON.stringify(card));
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('character registry', () => {
  it('loads the three shipped cards in protocol order', () => {
    const r = loadCharacterRegistry(shipped, LANGUAGES);
    expect(r.ids()).toEqual(CHARACTER_IDS);
    expect(r.ids().map((id) => r.name(id, 'zh'))).toEqual(['小暖', '小凯', '小欣']);
    expect(r.ids().map((id) => r.name(id, 'ja'))).toEqual(['小暖', '小凯', '小欣']);
    expect(r.ids().map((id) => r.name(id, 'en'))).toEqual(['Xiaonuan', 'Xiaokai', 'Xiaoxin']);
    expect(r.ids().map((id) => r.spokenName(id, 'ja'))).toEqual(['シャオヌアン', 'シャオカイ', 'シャオシン']);
    expect(r.spokenName('xiaonuan', 'zh')).toBe('小暖');
    expect(r.spokenName('xiaokai', 'en')).toBe('Xiaokai');
    expect(r.ids().map((id) => r.gender(id))).toEqual(['female', 'male', 'female']);
    for (const id of r.ids()) expect(r.roleOf(id)).toBe('elder-companion');
    expect(r.greetingNoName('xiaonuan', 'zh')).toBe('您好，我是小暖，来陪您说说话。您怎么称呼？');
    expect(r.greetingNoName('xiaokai', 'zh')).toBe('您好，我是小凯，来陪您聊聊天。您怎么称呼？');
    expect(r.greetingNoName('xiaoxin', 'zh')).toBe('您好，我是小欣，来陪您说说话。您怎么称呼？');
    expect(r.identity('xiaonuan', 'zh')).toContain('孙女');
    expect(r.identity('xiaokai', 'zh')).toContain('孙子');
    expect(r.identity('xiaoxin', 'zh')).toContain('老朋友');
    for (const id of r.ids()) {
      for (const language of LANGUAGES) {
        const lines = r.greetingsFirstMeet(id, language);
        expect(lines.length).toBeGreaterThanOrEqual(1);
        for (const line of lines) expect(line).toContain('{name}');
        expect(r.identity(id, language)).not.toHaveLength(0);
      }
    }
  });

  it('resolves voices per character, adapter and language', () => {
    const r = loadCharacterRegistry(shipped, LANGUAGES);
    expect(LANGUAGES.map((l) => r.voiceFor('xiaonuan', 'qwen', l))).toEqual(['longanlingxin', 'Tina', 'Tina']);
    // Chinese must be Ryan: Evan reads ～ as a dash (roadmap, probe 2026-10-25).
    expect(LANGUAGES.map((l) => r.voiceFor('xiaokai', 'qwen', l))).toEqual(['Ryan', 'Evan', 'Evan']);
    expect(LANGUAGES.map((l) => r.voiceFor('xiaoxin', 'qwen', l))).toEqual(['longanlingxin', 'Tina', 'Tina']);
    expect(r.voiceFor('xiaokai', 'seeduplex', 'zh')).toBe('zh_male_xiaotian_jupiter_bigtts');
    expect(r.voiceFor('xiaokai', 'seeduplex', 'en')).toBe('en_male_tim_uranus_bigtts');
    // Seeduplex has no Japanese; null in the card means the adapter default.
    expect(r.voiceFor('xiaokai', 'seeduplex', 'ja')).toBeUndefined();
    expect(r.voiceFor('xiaonuan', 'seeduplex', 'zh')).toBeUndefined();
    expect(r.voiceFor('xiaoxin', 'seeduplex', 'en')).toBeUndefined();
  });

  it('rejects a card that misses a supported language', () => {
    const dir = copyCards();
    patchCard(dir, 'xiaonuan', (card) => { delete card.identity.ja; });
    expect(() => loadCharacterRegistry(dir, LANGUAGES)).toThrow('character_language_missing:xiaonuan:ja:identity');
    // The same card is fine when Japanese is not required.
    expect(() => loadCharacterRegistry(dir, ['zh', 'en'])).not.toThrow();
  });

  it('rejects first-meet templates without {name} or over the length limit', () => {
    const noName = copyCards();
    patchCard(noName, 'xiaokai', (card) => { card.greetingsFirstMeet.zh = ['您好，我是小凯。']; });
    expect(() => loadCharacterRegistry(noName, LANGUAGES)).toThrow('character_first_meet_invalid:xiaokai:zh:0');

    const tooLong = copyCards();
    patchCard(tooLong, 'xiaoxin', (card) => { card.greetingsFirstMeet.zh = ['{name}', `{name}${'好'.repeat(41)}`]; });
    expect(() => loadCharacterRegistry(tooLong, LANGUAGES)).toThrow('character_first_meet_invalid:xiaoxin:zh:1');

    const atLimit = copyCards();
    patchCard(atLimit, 'xiaoxin', (card) => { card.greetingsFirstMeet.zh = [`{name}${'好'.repeat(40)}`]; });
    expect(() => loadCharacterRegistry(atLimit, LANGUAGES)).not.toThrow();
  });

  it("rejects another character's name in identity or greetings", () => {
    const identity = copyCards();
    patchCard(identity, 'xiaokai', (card) => { card.identity.zh = `${card.identity.zh}你和小暖是好朋友。`; });
    expect(() => loadCharacterRegistry(identity, LANGUAGES)).toThrow('character_foreign_name:xiaokai:xiaonuan');

    const reading = copyCards();
    patchCard(reading, 'xiaonuan', (card) => { card.greetingNoName.ja = 'こんにちは、シャオシンです。'; });
    expect(() => loadCharacterRegistry(reading, LANGUAGES)).toThrow('character_foreign_name:xiaonuan:xiaoxin');
  });

  it('rejects extension keys without a namespace and unknown fields', () => {
    const extension = copyCards();
    patchCard(extension, 'xiaonuan', (card) => { card.extensions = { duixModel: 'lily' }; });
    expect(() => loadCharacterRegistry(extension, LANGUAGES)).toThrow(/character_card_invalid:xiaonuan\.json/);

    const namespaced = copyCards();
    patchCard(namespaced, 'xiaonuan', (card) => { card.extensions = { 'avatar/duixModel': 'lily' }; });
    expect(() => loadCharacterRegistry(namespaced, LANGUAGES)).not.toThrow();

    const unknown = copyCards();
    patchCard(unknown, 'xiaoxin', (card) => { card.style = 'old-friend'; });
    expect(() => loadCharacterRegistry(unknown, LANGUAGES)).toThrow(/character_card_invalid:xiaoxin\.json/);
  });

  it('rejects a missing card, a renamed file and a bad id', () => {
    const missing = copyCards();
    rmSync(join(missing, 'xiaoxin.json'));
    expect(() => loadCharacterRegistry(missing, LANGUAGES)).toThrow('character_set_mismatch:xiaoxin');

    const renamed = copyCards();
    cpSync(join(renamed, 'xiaonuan.json'), join(renamed, 'extra.json'));
    expect(() => loadCharacterRegistry(renamed, LANGUAGES)).toThrow('character_id_mismatch:extra.json');

    const badId = copyCards();
    patchCard(badId, 'xiaokai', (card) => { card.id = 'kai'; });
    expect(() => loadCharacterRegistry(badId, LANGUAGES)).toThrow(/character_card_invalid:xiaokai\.json/);

    const broken = copyCards();
    writeFileSync(join(broken, 'xiaokai.json'), '{');
    expect(() => loadCharacterRegistry(broken, LANGUAGES)).toThrow('character_card_invalid_json:xiaokai.json');
  });

  it('throws for unknown ids and languages a card does not carry', () => {
    const dir = copyCards();
    patchCard(dir, 'xiaonuan', (card) => { delete card.names.en; });
    const r = loadCharacterRegistry(dir, ['zh', 'ja']);
    expect(() => r.name('xiaonuan', 'en')).toThrow('character_language_unsupported:xiaonuan:en');
    expect(() => r.name('nobody' as CharacterId, 'zh')).toThrow('unknown_character:nobody');
  });
});
