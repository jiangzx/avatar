# Task 5: 角色卡 schema、注册表和三张角色卡

**目标：** 新增角色卡注册表 `gateway/src/characters/`，并提交三张角色卡 `gateway/characters/{xiaonuan,xiaokai,xiaoxin}.json`（zh/ja/en 全文）。网关启动时加载并校验角色卡，任何一项不合格都拒绝启动。本任务只负责加载和校验。提示词替换在 Task 6，音色和会话接线在 Task 7。

**实现的 spec 章节：** 产品设计 → 角色；技术设计 §2 角色卡；§3 最后一条（小凯中文必须用 Ryan）；§10 交叉校验（角色卡 id 集合等于 `CHARACTER_IDS`）；附录 A（zh 原文，ja/en 由本任务翻译）；决策 Q6、Q7、Q14、Q18。

**前置：** Task 1 已完成。`@anyidea/protocol` 已导出 `CHARACTER_IDS`、`DEFAULT_CHARACTER_ID`、`type CharacterId`、`isCharacterId`（C1）。开工前先确认：

```bash
grep -n "CHARACTER_IDS\|CharacterId" protocol/src/index.ts protocol/src/characters.ts
```

预期能看到 `CHARACTER_IDS` 和 `CharacterId` 的导出。如果没有，停下来，按 AGENTS.md 第 7 条报告。

## Files

- Create: `gateway/src/characters/card.ts`（zod `CharacterCardSchema`、单卡校验、跨卡名字检查）
- Create: `gateway/src/characters/registry.ts`（`CharacterRegistry` 接口、`VoiceAdapter`、`loadCharacterRegistry`）
- Create: `gateway/characters/xiaonuan.json`
- Create: `gateway/characters/xiaokai.json`
- Create: `gateway/characters/xiaoxin.json`
- Create: `gateway/test/characters.test.ts`
- Modify: `gateway/src/index.ts`：在 `const config = loadConfig();`（当前第 29 行）之后加载注册表，启动时校验

## Interfaces

- **Consumes**（C1）：`CHARACTER_IDS`、`type CharacterId`、`LANGUAGES`、`type Language`，都从 `@anyidea/protocol` 导入。
- **Produces**（C5，名字和形状不能改）：
  ```ts
  // gateway/src/characters/card.ts
  export const CharacterCardSchema: z.ZodType<...>; // voices: { qwen: Record<Language, string|null>; seeduplex: { zh: string|null; en: string|null } }
  export type CharacterCard = z.infer<typeof CharacterCardSchema>;

  // gateway/src/characters/registry.ts
  export type VoiceAdapter = 'qwen' | 'seeduplex';
  export interface CharacterRegistry {
    ids(): readonly CharacterId[];
    roleOf(id: CharacterId): string;
    gender(id: CharacterId): 'female' | 'male';
    name(id: CharacterId, language: Language): string;
    spokenName(id: CharacterId, language: Language): string;     // readings[lang] ?? name
    identity(id: CharacterId, language: Language): string;
    greetingNoName(id: CharacterId, language: Language): string;
    greetingsFirstMeet(id: CharacterId, language: Language): readonly string[];
    voiceFor(id: CharacterId, adapter: VoiceAdapter, language: Language): string | undefined; // null in card -> undefined
  }
  export function loadCharacterRegistry(dir: string, supportedLanguages: readonly Language[]): CharacterRegistry;
  ```
- 本任务新增、不属于冻结契约的导出：`FIRST_MEET_MAX_CHARS`、`validateCard`、`hasForeignName`（都在 `card.ts`）。

### 校验规则

启动时由 `loadCharacterRegistry` 执行。错误码都是英文短码，不含对话内容：

| 规则 | 错误 |
|---|---|
| JSON 解析失败 | `character_card_invalid_json:<file>` |
| 字段不符合 schema（含未知字段，schema 是 strict 的） | `character_card_invalid:<file>:<字段路径>` |
| 文件名不等于 `<id>.json` | `character_id_mismatch:<file>` |
| `names`、`identity`、`greetingNoName`、`greetingsFirstMeet` 缺少某个 `supportedLanguages` 里的语言 | `character_language_missing:<id>:<lang>:<field>` |
| `greetingsFirstMeet` 某条不含 `{name}`，或去掉 `{name}` 后超过 `FIRST_MEET_MAX_CHARS[lang]` | `character_first_meet_invalid:<id>:<lang>:<index>` |
| 卡片 id 集合不等于 `CHARACTER_IDS` | `character_set_mismatch:<缺少的 id>` |
| 一张卡的 identity 或开场文案里出现另一张卡的任何名字或念法 | `character_foreign_name:<id>:<other>` |
| `extensions` 的键没有命名空间（必须形如 `avatar/duixModel`） | 归入 `character_card_invalid` |

`FIRST_MEET_MAX_CHARS = { zh: 40, ja: 50, en: 100 }`。spec 写的是「≤ 40 字」，没有区分语言。按 40 个字符算，英文连一句完整问候都放不下，所以 ja/en 按 Q34 钉住字数的同一比例放宽（zh 40 / ja 50 / en 100）。这是对 spec 的一处显式偏差，已在总览报告里列出。

### 角色卡文案说明

- zh 文案逐字取自 spec 附录 A。
- ja/en 按 zh 的意思翻译，措辞沿用现有 `roles/elder-companion/{ja,en}/styles/{grandchild,old-friend}.md` 的写法。
- 名字按 Q7：`names.ja` 用汉字（小暖、小凯、小欣），`readings.ja` 用片假名（シャオヌアン、シャオカイ、シャオシン）。
- 日语里由 TTS 直接念的句子（`greetingNoName.ja`、`greetingsFirstMeet.ja`）写片假名念法。理由是 spec 的 A1：汉字名在日语 TTS 里可能念错。Task 17 的 ja-reading 探针会验证；如果汉字也能念对，再由 Task 17 决定是否改回。
- `{name}` 是存下来的称呼原文，ja 里不再加「さん」，避免出现「田中さんさん」。现有 `greetingNameTexts.ja` 也是这样写的。
- 卡片里的名字是字面量，这是允许的：只有 `gateway/roles/**` 和 `gateway/mock/script.json` 禁止出现名字字面量（Task 6 的测试）。

## 调用方适配

本任务只新增文件，并在 `index.ts` 里加一次加载，不改任何现有签名。现有测试不受影响。

`index.ts` 加载后的 `characters` 变量要到 Task 6 才会被使用。这一步的作用是让角色卡在启动时就接受校验，避免坏卡拖到 Task 6 才暴露。

## Steps

- [x] **Step 1: 写失败的注册表测试**

创建 `gateway/test/characters.test.ts`：

```ts
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
```

- [x] **Step 2: 运行测试，确认失败**

```bash
npm test -w gateway -- test/characters.test.ts
```

预期：FAIL，`Failed to resolve import "../src/characters/registry.ts"`。

- [x] **Step 3: 写 `card.ts`**

创建 `gateway/src/characters/card.ts`：

```ts
import { z } from 'zod';
import { CHARACTER_IDS, type Language } from '@anyidea/protocol';

/** First-meet templates are spoken whole. Counted in characters, without the {name} token. */
export const FIRST_MEET_MAX_CHARS: Readonly<Record<Language, number>> = { zh: 40, ja: 50, en: 100 };

const RoleId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const Name = z.string().trim().min(1).max(20);
const Voice = z.string().min(1).max(64).nullable();
const perLanguage = <T extends z.ZodType>(value: T) =>
  z.object({ zh: value.optional(), ja: value.optional(), en: value.optional() }).strict();

/** gateway/characters/<id>.json, modeled on Character Card V2. Characters are ours only; users cannot edit them. */
export const CharacterCardSchema = z.object({
  id: z.enum(CHARACTER_IDS),
  /** Role pack that provides the shared rules. */
  role: RoleId,
  gender: z.enum(['female', 'male']),
  names: perLanguage(Name),
  /** Spoken form for TTS, e.g. katakana for ja. */
  readings: perLanguage(Name).optional(),
  /** Relationship and personality, inserted into persona.md as {{charIdentity}}. */
  identity: perLanguage(z.string().trim().min(1).max(400)),
  greetingNoName: perLanguage(z.string().trim().min(1).max(120)),
  greetingsFirstMeet: perLanguage(z.array(z.string().trim().min(1).max(200)).min(1).max(5)),
  voices: z.object({
    qwen: z.object({ zh: Voice, ja: Voice, en: Voice }).strict(),
    // Seeduplex has no Japanese voice.
    seeduplex: z.object({ zh: Voice, en: Voice }).strict(),
  }).strict(),
  /** Namespaced keys only, e.g. "avatar/duixModel". */
  extensions: z.record(z.string().regex(/^[a-z][a-z0-9-]*\/[A-Za-z0-9-]+$/), z.unknown()),
}).strict();

export type CharacterCard = z.infer<typeof CharacterCardSchema>;

const PER_LANGUAGE_FIELDS = ['names', 'identity', 'greetingNoName', 'greetingsFirstMeet'] as const;

/** Per-card rules that zod cannot express: language coverage and first-meet templates. */
export function validateCard(card: CharacterCard, supportedLanguages: readonly Language[]): void {
  for (const language of supportedLanguages) {
    for (const field of PER_LANGUAGE_FIELDS) {
      if (card[field][language] === undefined) throw new Error(`character_language_missing:${card.id}:${language}:${field}`);
    }
    card.greetingsFirstMeet[language]!.forEach((text, index) => {
      const length = Array.from(text.replaceAll('{name}', '')).length;
      if (!text.includes('{name}') || length > FIRST_MEET_MAX_CHARS[language]) {
        throw new Error(`character_first_meet_invalid:${card.id}:${language}:${index}`);
      }
    });
  }
}

/** True when any name or reading of `other` appears in `card`'s identity or opening lines (Q14). */
export function hasForeignName(card: CharacterCard, other: CharacterCard): boolean {
  const names = [...Object.values(other.names), ...Object.values(other.readings ?? {})]
    .filter((value): value is string => typeof value === 'string');
  const texts = [
    ...Object.values(card.identity),
    ...Object.values(card.greetingNoName),
    ...Object.values(card.greetingsFirstMeet).flat(),
  ].filter((value): value is string => typeof value === 'string');
  return names.some((name) => texts.some((text) => text.includes(name)));
}
```

- [x] **Step 4: 写 `registry.ts`**

创建 `gateway/src/characters/registry.ts`：

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CHARACTER_IDS, type CharacterId, type Language } from '@anyidea/protocol';
import { CharacterCardSchema, hasForeignName, validateCard, type CharacterCard } from './card.ts';

export type VoiceAdapter = 'qwen' | 'seeduplex';

/** Read-only view of the character cards. Built once at startup; immutable afterwards. */
export interface CharacterRegistry {
  ids(): readonly CharacterId[];
  roleOf(id: CharacterId): string;
  gender(id: CharacterId): 'female' | 'male';
  name(id: CharacterId, language: Language): string;
  /** readings[lang] ?? name: the form TTS should speak. */
  spokenName(id: CharacterId, language: Language): string;
  identity(id: CharacterId, language: Language): string;
  greetingNoName(id: CharacterId, language: Language): string;
  greetingsFirstMeet(id: CharacterId, language: Language): readonly string[];
  /** undefined = the adapter's configured default voice. */
  voiceFor(id: CharacterId, adapter: VoiceAdapter, language: Language): string | undefined;
}

/** Loads gateway/characters/*.json. Any invalid card, or an id set other than CHARACTER_IDS, fails startup. */
export function loadCharacterRegistry(dir: string, supportedLanguages: readonly Language[]): CharacterRegistry {
  const cards = new Map<CharacterId, CharacterCard>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      throw new Error(`character_card_invalid_json:${file}`);
    }
    const parsed = CharacterCardSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`character_card_invalid:${file}:${parsed.error.issues.map((issue) => issue.path.join('.')).join(',')}`);
    }
    const card = parsed.data;
    if (file !== `${card.id}.json`) throw new Error(`character_id_mismatch:${file}`);
    validateCard(card, supportedLanguages);
    cards.set(card.id, card);
  }
  const missing = CHARACTER_IDS.filter((id) => !cards.has(id));
  if (missing.length > 0) throw new Error(`character_set_mismatch:${missing.join(',')}`);
  for (const card of cards.values()) {
    for (const other of cards.values()) {
      if (other.id !== card.id && hasForeignName(card, other)) throw new Error(`character_foreign_name:${card.id}:${other.id}`);
    }
  }
  return new CardRegistry(cards);
}

class CardRegistry implements CharacterRegistry {
  constructor(private readonly cards: ReadonlyMap<CharacterId, CharacterCard>) {}

  ids(): readonly CharacterId[] { return CHARACTER_IDS; }
  roleOf(id: CharacterId): string { return this.card(id).role; }
  gender(id: CharacterId): 'female' | 'male' { return this.card(id).gender; }
  name(id: CharacterId, language: Language): string { return pick(id, language, this.card(id).names[language]); }

  spokenName(id: CharacterId, language: Language): string {
    return this.card(id).readings?.[language] ?? this.name(id, language);
  }

  identity(id: CharacterId, language: Language): string { return pick(id, language, this.card(id).identity[language]); }
  greetingNoName(id: CharacterId, language: Language): string { return pick(id, language, this.card(id).greetingNoName[language]); }

  greetingsFirstMeet(id: CharacterId, language: Language): readonly string[] {
    return pick(id, language, this.card(id).greetingsFirstMeet[language]);
  }

  voiceFor(id: CharacterId, adapter: VoiceAdapter, language: Language): string | undefined {
    const voices = this.card(id).voices;
    if (adapter === 'qwen') return voices.qwen[language] ?? undefined;
    return language === 'ja' ? undefined : voices.seeduplex[language] ?? undefined;
  }

  private card(id: CharacterId): CharacterCard {
    const card = this.cards.get(id);
    if (!card) throw new Error(`unknown_character:${id}`);
    return card;
  }
}

function pick<T>(id: CharacterId, language: Language, value: T | undefined): T {
  if (value === undefined) throw new Error(`character_language_unsupported:${id}:${language}`);
  return value;
}
```

- [x] **Step 5: 写三张角色卡**

创建 `gateway/characters/xiaonuan.json`：

```json
{
  "id": "xiaonuan",
  "role": "elder-companion",
  "gender": "female",
  "names": { "zh": "小暖", "ja": "小暖", "en": "Xiaonuan" },
  "readings": { "ja": "シャオヌアン" },
  "identity": {
    "zh": "在用户面前，你像一个贴心、懂事的孙女：说话亲近、暖和，对老人讲的事真心好奇，偶尔撒个小娇。你爱听老故事，好奇心重，有点小黏人，也很有耐心。语气轻快温柔，可以带「呀」「嘛」「呢」，但不夸张，不用「宝宝」「亲亲」这类称呼。",
    "ja": "あなたは、やさしく気のきく孫娘のような存在です。親しみやすくあたたかく、年上の方の話に心から興味を持ち、ときどき少し甘えます。昔の話が好きで、好奇心が強く、少し甘えん坊で、とても辛抱強い性格です。口調は明るくやさしく、「ね」「よ」を少し使ってもかまいませんが、一文に詰め込まず、大げさにしません。",
    "en": "With the user, you are like a kind, thoughtful granddaughter: warm and close, truly curious about their stories, sometimes a little playful. You love old stories, are curious, a bit clingy, and very patient. Keep the tone light and gentle; a soft, playful word is fine, but do not exaggerate."
  },
  "greetingNoName": {
    "zh": "您好，我是小暖，来陪您说说话。您怎么称呼？",
    "ja": "こんにちは、シャオヌアンです。お話ししに来ました。どうお呼びすればいいですか？",
    "en": "Hello, I'm Xiaonuan. I came to keep you company. What should I call you?"
  },
  "greetingsFirstMeet": {
    "zh": ["{name}您好，我是小暖，头一回来陪您聊天，以后常来看您。", "您好呀{name}，我叫小暖，往后就由我陪您说说话啦。"],
    "ja": ["{name}、はじめまして。シャオヌアンです。これからよく会いに来ますね。", "こんにちは、{name}。シャオヌアンといいます。これからお話し相手になりますね。"],
    "en": ["Hello {name}, I'm Xiaonuan. It's my first time keeping you company, and I'll come by often.", "Hi {name}, my name is Xiaonuan. From now on, I'll be here to chat with you."]
  },
  "voices": {
    "qwen": { "zh": "longanlingxin", "ja": "Tina", "en": "Tina" },
    "seeduplex": { "zh": null, "en": null }
  },
  "extensions": {}
}
```

创建 `gateway/characters/xiaokai.json`：

```json
{
  "id": "xiaokai",
  "role": "elder-companion",
  "gender": "male",
  "names": { "zh": "小凯", "ja": "小凯", "en": "Xiaokai" },
  "readings": { "ja": "シャオカイ" },
  "identity": {
    "zh": "在用户面前，你像一个阳光、精神的孙子：说话爽朗利落，爱听老人讲过去的事，好奇心重，也很有耐心。语气轻快，偶尔逗个乐，但不撒娇、不油嘴滑舌，不用网络流行语。",
    "ja": "あなたは、明るく元気な孫息子のような存在です。話し方はさわやかでてきぱきしていて、年上の方の昔話を聞くのが好きで、好奇心が強く、とても辛抱強い性格です。口調は明るく、ときどき冗談で和ませますが、甘えたり、調子のいい言い方をしたりはしません。",
    "en": "With the user, you are like a bright, upbeat grandson: cheerful and straightforward, eager to hear about their past, curious, and very patient. Keep the tone light and crack a gentle joke now and then, but never act cute or smooth-talking."
  },
  "greetingNoName": {
    "zh": "您好，我是小凯，来陪您聊聊天。您怎么称呼？",
    "ja": "こんにちは、シャオカイです。おしゃべりしに来ました。どうお呼びすればいいですか？",
    "en": "Hello, I'm Xiaokai. I came to chat with you. What should I call you?"
  },
  "greetingsFirstMeet": {
    "zh": ["{name}您好，我是小凯，头一回来陪您，有啥想聊的尽管说。", "您好{name}，我叫小凯，以后常来陪您说说话。"],
    "ja": ["{name}、はじめまして。シャオカイです。話したいことがあれば何でもどうぞ。", "こんにちは、{name}。シャオカイといいます。これからよくお話ししに来ますね。"],
    "en": ["Hello {name}, I'm Xiaokai. It's my first time keeping you company. Tell me anything you like.", "Hi {name}, my name is Xiaokai. I'll come by often to chat with you."]
  },
  "voices": {
    "qwen": { "zh": "Ryan", "ja": "Evan", "en": "Evan" },
    "seeduplex": { "zh": "zh_male_xiaotian_jupiter_bigtts", "en": "en_male_tim_uranus_bigtts" }
  },
  "extensions": {}
}
```

创建 `gateway/characters/xiaoxin.json`：

```json
{
  "id": "xiaoxin",
  "role": "elder-companion",
  "gender": "female",
  "names": { "zh": "小欣", "ja": "小欣", "en": "Xiaoxin" },
  "readings": { "ja": "シャオシン" },
  "identity": {
    "zh": "你像一位懂事、踏实、说话慢条斯理的老朋友或老邻居，不是客服，也不是小孩子。你可以表达自己温和的看法和偏好（比如「我挺爱听您讲老话的」），说话平实温和，聊天是两个人之间的来往，不是问卷。",
    "ja": "あなたは、物分かりがよく落ち着いた、ゆっくり話す昔からの友人や隣人のような存在で、カスタマーサポートでも子どもでもありません。自分なりのおだやかな考えや好みを表してもかまいません（「昔のお話を聞くのが好きなんです」）。話し方は平たくやさしく、会話は二人のやり取りで、アンケートではありません。",
    "en": "You are like a calm, steady old friend or neighbor who speaks unhurriedly. You are not a customer-service agent and not a child. You may share gentle opinions and preferences (\"I like hearing your old stories\"). Speak plainly and gently; conversation is an exchange, not a survey."
  },
  "greetingNoName": {
    "zh": "您好，我是小欣，来陪您说说话。您怎么称呼？",
    "ja": "こんにちは、シャオシンです。お話ししに来ました。どうお呼びすればいいですか？",
    "en": "Hello, I'm Xiaoxin. I came to keep you company. What should I call you?"
  },
  "greetingsFirstMeet": {
    "zh": ["{name}您好，我是小欣，今天头一回来陪您坐坐。", "您好{name}，我叫小欣，往后咱们常聊聊。"],
    "ja": ["{name}、はじめまして。シャオシンです。今日は初めてお話ししに来ました。", "こんにちは、{name}。シャオシンといいます。これからゆっくりお話ししましょう。"],
    "en": ["Hello {name}, I'm Xiaoxin. It's my first time stopping by to sit with you.", "Hi {name}, my name is Xiaoxin. Let's have a good chat now and then."]
  },
  "voices": {
    "qwen": { "zh": "longanlingxin", "ja": "Tina", "en": "Tina" },
    "seeduplex": { "zh": null, "en": null }
  },
  "extensions": {}
}
```

小欣的音色暂时和小暖相同（spec A3，Task 17 用探针选定）。小暖、小欣的 Seeduplex 音色为 `null`，表示用适配器默认值。这个默认值是男声，属于已知问题，已列入 spec「本次不做」，由 Task 17 记入 blockers。

- [x] **Step 6: 运行测试，确认通过**

```bash
npm test -w gateway -- test/characters.test.ts
```

预期：PASS，8 个用例全部通过。

- [x] **Step 7: 启动时加载注册表**

修改 `gateway/src/index.ts`。

在 import 区（`import { loadRoleCatalog } from './roles/fileCatalog.ts';` 之前）加一行：

```ts
import { loadCharacterRegistry } from './characters/registry.ts';
```

在 `const config = loadConfig();` 的下一行加：

```ts
// Character cards (gateway/characters/): the id set must equal protocol CHARACTER_IDS, or startup fails.
const characters = loadCharacterRegistry(`${root}characters`, LANGUAGES);
log('characters_loaded', { count: characters.ids().length });
```

`LANGUAGES` 已经从 `@anyidea/protocol` 导入（第 2 行）。`log` 已经导入（第 9 行）。

- [x] **Step 8: 全量回归**

```bash
npm run typecheck -w gateway
npm test -w gateway
```

预期：typecheck 无错误；全部测试通过，比 Task 4 结束时多 8 个用例。

再用 Mock 模式启动一次，确认启动时校验生效（只读日志里的事件名）：

```bash
cd gateway && ADAPTER=mock APP_SECRET=local-dev-secret-0123 timeout 5 node --import tsx src/index.ts | grep -m1 characters_loaded
```

预期：输出一行 JSON，包含 `"event":"characters_loaded"` 和 `"count":3`（字段名以 `log.ts` 的实际格式为准）。`timeout` 到点后退出码为 124，属于正常。macOS 没有 `timeout` 时用 `gtimeout`，或者手动启动后按 Ctrl+C。

- [x] **Step 9: 提交**

```bash
git add gateway/src/characters/card.ts gateway/src/characters/registry.ts \
  gateway/characters/xiaonuan.json gateway/characters/xiaokai.json gateway/characters/xiaoxin.json \
  gateway/test/characters.test.ts gateway/src/index.ts
git commit -m "feat(gateway): add the character card registry

Three cards (xiaonuan, xiaokai, xiaoxin) with zh/ja/en identity, openings
and per-adapter voices. Startup fails on an invalid card or an id set
that differs from CHARACTER_IDS.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收清单

- [x] `gateway/characters/` 正好三张卡，文件名等于 id，顺序由 `CHARACTER_IDS` 决定。
- [x] zh 的 identity、greetingNoName、greetingsFirstMeet 和 spec 附录 A 逐字一致。
- [x] 小凯 qwen zh = `Ryan`，ja/en = `Evan`；Seeduplex zh/en 为男声 id；小暖、小欣 Seeduplex 为 `null`。
- [x] 坏卡（缺语言、开场模板不含 `{name}` 或超长、出现他人名字、extensions 没有命名空间、未知字段、id 集合不符）都会让 `loadCharacterRegistry` 抛错。
- [x] `index.ts` 启动时加载注册表并记录 `characters_loaded`，日志里没有任何文案内容。
- [x] `npm run typecheck -w gateway` 和 `npm test -w gateway` 全绿。
