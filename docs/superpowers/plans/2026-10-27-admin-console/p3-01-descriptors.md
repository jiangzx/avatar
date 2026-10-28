# P3-T1: 说明卡、白名单与覆盖层键

**目标：** 定下「后台能改哪些配置、每一项怎么给小白解释」：覆盖层键的语法与落点、说明卡 schema、六个场景的说明卡文件、Qwen 下拉候选、单位换算和取值校验。本任务只做纯函数和配置文件，不接线、不改会话行为。

**实现的 spec 章节：** 「配置覆盖层」中的寻址；「说明卡与白名单」全部；决策 Q13、Q17、Q18、Q19（占位符部分）、Q34。

**前置：** 计划 2 已完成。开始前跑 `npm test -w gateway && npm run typecheck -w gateway`，确认全绿。

**Files:**
- Create: `gateway/src/config-store/keys.ts`（覆盖层键解析、落点、读基线值）
- Create: `gateway/src/config-store/descriptors.ts`（说明卡 schema、加载、展开）
- Create: `gateway/src/config-store/units.ts`（显示单位 ↔ 存储单位）
- Create: `gateway/src/config-store/options.ts`（`qwen-options.json` 加载）
- Create: `gateway/src/config-store/validate.ts`（单项取值校验，中文错误）
- Create: `gateway/config/admin/descriptors/{pacing,affect,memory,characters,copy,model}.json`
- Create: `gateway/config/admin/qwen-options.json`
- Test: `gateway/test/config-descriptors.test.ts`

**Interfaces:**
- Consumes：`@anyidea/protocol` 的 `CHARACTER_IDS`、`LANGUAGES`、`CharacterId`、`Language`；`gateway/src/i18n/types.ts` 的 `SilenceRules`；`gateway/src/i18n/load.ts` 的 `loadI18n`（只在测试里用）。
- Produces（P3-T2、P3-T5 依赖，名字和形状不能改）：

```ts
// keys.ts
export type OverlayValue = number | boolean | string | readonly string[];
export type Overlay = Readonly<Record<string, OverlayValue>>;
export const MODEL_FIELDS: readonly ['realtimeEndpoint', 'realtimeModel', 'textEndpoint', 'summarizerModel'];
export type ModelField = (typeof MODEL_FIELDS)[number];
export type ModelDefaults = Record<ModelField, string>;
export type OverlayTarget =
  | { kind: 'json'; file: string; path: readonly string[] }
  | { kind: 'text'; file: string }
  | { kind: 'characterEnabled'; characterId: CharacterId }
  | { kind: 'model'; field: ModelField };
export function parseOverlayKey(key: string): OverlayTarget;            // throws Error('overlay_key_invalid:<key>')
export function targetFiles(root: string, target: { file: string }): string[]; // expands one '*' language segment
export function getJsonPath(value: unknown, path: readonly string[]): unknown;
export function setJsonPath(value: unknown, path: readonly string[], next: OverlayValue): void; // throws Error('overlay_target_missing:<path>')
export function isOverlayValue(value: unknown): value is OverlayValue;
export function readTargetValue(root: string, target: OverlayTarget, models: ModelDefaults): OverlayValue;

// descriptors.ts
export const SCENE_IDS: readonly ['pacing', 'affect', 'memory', 'characters', 'copy', 'model'];
export type SceneId = (typeof SCENE_IDS)[number];
export type DescriptorItem = z.infer<typeof DescriptorItemSchema>;
export interface ConcreteItem extends DescriptorItem { descriptorKey: string; scene: SceneId; language: Language | null; character: CharacterId | null }
export interface ReadonlyNote { label: string; purpose: string; note: string }
export interface SceneDescriptor { id: SceneId; title: string; intro: string; order: number; items: readonly ConcreteItem[]; readonly: readonly ReadonlyNote[] }
export interface DescriptorCatalog { scenes(): readonly SceneDescriptor[]; scene(id: SceneId): SceneDescriptor; find(key: string): ConcreteItem | undefined; all(): readonly ConcreteItem[] }
export function loadDescriptorCatalog(dir: string, opts: { languages: readonly Language[]; characters: readonly CharacterId[] }): DescriptorCatalog;
export function extractPlaceholders(text: string): string[];

// units.ts
export function toDisplay(item: DescriptorItem, stored: OverlayValue): OverlayValue;
export function toStored(item: DescriptorItem, display: OverlayValue): OverlayValue;

// options.ts
export interface QwenOption { value: string; label: string }
export interface QwenOptions { realtimeModels: QwenOption[]; textModels: QwenOption[]; voices: Record<Language, QwenOption[]> }
export function loadQwenOptions(path: string): QwenOptions;
export function optionsFor(options: QwenOptions, ref: string, language: Language | null): readonly QwenOption[];

// validate.ts
export interface ValidateContext { baseline: OverlayValue; silence: Record<Language, SilenceRules>; options: QwenOptions }
export type ValidateResult = { ok: true; stored: OverlayValue } | { ok: false; message: string };
export function validateDisplayValue(item: ConcreteItem, value: unknown, ctx: ValidateContext): ValidateResult;
```

## 覆盖层键语法（本任务定稿）

一个键 = `<域>:<目标>`。JSON 路径用 `.` 分段，每段是字母开头的标识符或数字下标；`constructor`、`prototype`、`__proto__` 一律拒绝。

| 键形式 | 落到哪里 | 示例 |
|---|---|---|
| `pacing:<路径>` | `config/pacing.json` | `pacing:restReminder.firstAfterMs` |
| `memory:<路径>` | `config/memory.json` | `memory:retentionDays`、`memory:extractModel` |
| `affect:<路径>` | `config/affect.json` | `affect:care.maxAgeDays` |
| `emotion:<路径>` | `config/emotion.json` | `emotion:revertAfterMs` |
| `i18n:<语言>/<文件>.<路径>` | `config/i18n/<语言>/<文件>.json` | `i18n:zh/memory.restReminderText` |
| `role:<角色包>/<语言>/persona` | `roles/<角色包>/<语言>/persona.md`（整段文本） | `role:elder-companion/zh/persona` |
| `role:<角色包>/<语言或*>/director.<路径>` | `roles/<角色包>/<语言>/director.json`；`*` 表示该角色包 `role.json` 里的全部语言，同时写入 | `role:elder-companion/*/director.contextAfterMs` |
| `character:<角色 id>.enabled` | 不落文件；进快照的 `disabledCharacters` | `character:xiaonuan.enabled` |
| `character:<角色 id>.<路径>` | `characters/<角色 id>.json` | `character:xiaokai.voices.qwen.zh` |
| `model:qwen.<字段>` | 不落文件；覆盖 env 给出的模型设置。字段：`realtimeEndpoint`、`realtimeModel`、`textEndpoint`、`summarizerModel` | `model:qwen.realtimeModel` |

- 沉默阶梯的等待时间必须三种语言一致（`fileCatalog.ts` 的 `validateTimings`），所以时间类说明卡一律用 `*`。
- 整理记忆用的文本模型名已经在 `memory.json` 的 `extractModel`，不另设 `model:` 字段。
- 说明卡的 `key` 是模板：`{lang}` 按语言展开，`{char}` 按角色展开。展开后的具体键才进覆盖层。

## 白名单（本任务定稿，和 spec 的差异见末尾）

| 场景 | 说明卡（中文名） | 键模板 |
|---|---|---|
| 对话节奏 | 老人停下后多久接第一句 / 第二句再等多久 / 第三句再等多久 / 问「还在听吗」前再等多久 / 最后一句前再等多久 | `role:elder-companion/*/director.{context,check,leave,checkin,rest}AfterMs` |
| 对话节奏 | 第一句、第二句、第三句、问「还在听吗」、最后一句的备用话；实在没话时的「我在」；算作轻声答应的词 | `role:elder-companion/{lang}/director.{contextText,checkContextText,leaveText,checkinText,restText,presenceText,lightPhrases}` |
| 对话节奏 | 连续聊多久提醒休息 / 之后每隔多久再提醒 | `pacing:restReminder.{firstAfterMs,everyMs}` |
| 情绪与关怀 | 感受情绪与关怀开场 / 多难过才算情绪低落 / 关怀开场最多提起几天前的事 / 老人连着几次只答一两个字就换话题 / 形象表情保持多久 | `affect:enabled`、`affect:lowIntensity`、`affect:care.maxAgeDays`、`affect:exhausted.shortStreakTrigger`、`emotion:revertAfterMs` |
| 记忆 | 每次带进聊天的记忆有多长 / 问「你都记得我什么」时说几条 / 老人的原话保存多少天 | `memory:instructions.snapshotMaxChars`、`memory:listMaxItems`、`memory:retentionDays` |
| 角色 | 是否启用 / 性格描述 / 不知道称呼时的开场白 / 第一次知道称呼时的开场白 / 声音 | `character:{char}.enabled`、`character:{char}.identity.{lang}`、`character:{char}.greetingNoName.{lang}`、`character:{char}.greetingsFirstMeet.{lang}`、`character:{char}.voices.qwen.{lang}` |
| 角色 | 三个角色共用的人设 / 知道称呼后的开场白 | `role:elder-companion/{lang}/persona`、`role:elder-companion/{lang}/director.greetingNameTexts` |
| 文案 | 提醒休息时说的话 / 老人说「忘掉」后的回答 / 想不起上次聊什么时说的话 / 记住一件事后的回答 / 钉住的事太多时说的话 / 天气查不到时说的话 / 网络断了又连上时说的话 | `i18n:{lang}/memory.{restReminderText,forgetConfirmText,recall.emptyText,pin.confirmText,pin.fullText,weather.unavailableText}`、`role:elder-companion/{lang}/director.resumeText` |
| 模型与 Key | 通话用的模型 / 通话服务地址 / 整理记忆用的模型 / 总结聊天用的模型 / 文本服务地址 | `model:qwen.realtimeModel`、`model:qwen.realtimeEndpoint`、`memory:extractModel`、`model:qwen.summarizerModel`、`model:qwen.textEndpoint` |

Key 本身不走覆盖层，由 P3-T4 的 `SecretStore` 管，模型与 Key 页同时显示两者（P3-T9）。

## Steps

- [ ] **Step 1: 写失败测试**

新建 `gateway/test/config-descriptors.test.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, LANGUAGES } from '@anyidea/protocol';
import { loadDescriptorCatalog, extractPlaceholders, type ConcreteItem } from '../src/config-store/descriptors.ts';
import { getJsonPath, parseOverlayKey, readTargetValue, setJsonPath, targetFiles, type ModelDefaults } from '../src/config-store/keys.ts';
import { loadQwenOptions, optionsFor } from '../src/config-store/options.ts';
import { toDisplay, toStored } from '../src/config-store/units.ts';
import { validateDisplayValue } from '../src/config-store/validate.ts';
import { loadI18n } from '../src/i18n/load.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const models: ModelDefaults = {
  realtimeEndpoint: 'wss://example.invalid/api-ws/v1/realtime',
  realtimeModel: 'qwen3.8-omni-flash-realtime',
  textEndpoint: 'https://example.invalid/compatible-mode/v1/chat/completions',
  summarizerModel: 'qwen-flash',
};
const catalog = loadDescriptorCatalog(`${root}config/admin/descriptors`, { languages: LANGUAGES, characters: CHARACTER_IDS });
const options = loadQwenOptions(`${root}config/admin/qwen-options.json`);
const silence = loadI18n(`${root}config`).silence;

function baseline(item: ConcreteItem) {
  return readTargetValue(root, parseOverlayKey(item.key), models);
}

describe('overlay keys', () => {
  it('maps each domain to its file and path', () => {
    expect(parseOverlayKey('pacing:restReminder.firstAfterMs')).toEqual({ kind: 'json', file: 'config/pacing.json', path: ['restReminder', 'firstAfterMs'] });
    expect(parseOverlayKey('i18n:ja/memory.recall.emptyText')).toEqual({ kind: 'json', file: 'config/i18n/ja/memory.json', path: ['recall', 'emptyText'] });
    expect(parseOverlayKey('role:elder-companion/zh/persona')).toEqual({ kind: 'text', file: 'roles/elder-companion/zh/persona.md' });
    expect(parseOverlayKey('role:elder-companion/*/director.contextAfterMs')).toEqual({ kind: 'json', file: 'roles/elder-companion/*/director.json', path: ['contextAfterMs'] });
    expect(parseOverlayKey('character:xiaonuan.enabled')).toEqual({ kind: 'characterEnabled', characterId: 'xiaonuan' });
    expect(parseOverlayKey('character:xiaokai.voices.qwen.zh')).toEqual({ kind: 'json', file: 'characters/xiaokai.json', path: ['voices', 'qwen', 'zh'] });
    expect(parseOverlayKey('model:qwen.realtimeModel')).toEqual({ kind: 'model', field: 'realtimeModel' });
  });

  it('rejects malformed, unknown and prototype keys', () => {
    for (const bad of [
      'pacing', 'nope:x', 'pacing:', 'pacing:a..b', 'pacing:__proto__.x', 'pacing:constructor', 'memory:prototype',
      'role:elder-companion/*/persona', 'role:elder-companion/zh/persona.x', 'role:elder-companion/fr/director.a',
      'character:lily.enabled', 'model:qwen.apiKey', 'model:seeduplex.realtimeModel', 'i18n:zh/memory', 'i18n:zh/../x.a',
    ]) expect(() => parseOverlayKey(bad), bad).toThrow(/^overlay_key_invalid:/);
  });

  it('expands * to every language of the role pack', () => {
    expect(targetFiles(root, { file: 'roles/elder-companion/*/director.json' })).toEqual([
      'roles/elder-companion/zh/director.json', 'roles/elder-companion/ja/director.json', 'roles/elder-companion/en/director.json',
    ]);
  });

  it('gets and sets only existing own paths', () => {
    const doc = { a: { b: [1, 2] } };
    expect(getJsonPath(doc, ['a', 'b', '1'])).toBe(2);
    expect(getJsonPath(doc, ['a', 'toString'])).toBeUndefined();
    setJsonPath(doc, ['a', 'b'], ['x']);
    expect(doc.a.b).toEqual(['x']);
    expect(() => setJsonPath(doc, ['a', 'c'], 1)).toThrow(/^overlay_target_missing:/);
  });
});

describe('descriptor catalog', () => {
  it('has the six scenes in order', () => {
    expect(catalog.scenes().map((s) => s.id)).toEqual(['pacing', 'affect', 'memory', 'characters', 'copy', 'model']);
  });

  it('expands {lang} and {char} and keeps keys unique', () => {
    const keys = catalog.all().map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('character:xiaoxin.identity.ja');
    expect(keys).toContain('i18n:en/memory.restReminderText');
    expect(keys).toContain('character:xiaokai.enabled');
    expect(keys.some((k) => k.includes('{'))).toBe(false);
    const identity = catalog.find('character:xiaoxin.identity.ja')!;
    expect(identity.character).toBe('xiaoxin');
    expect(identity.language).toBe('ja');
    expect(identity.descriptorKey).toBe('character:{char}.identity.{lang}');
  });

  it('never whitelists technical or safety fields', () => {
    const forbidden = [/^pacing:(rebuild|tailGuardMs|slim|policies|push|output)/, /safety/, /_shared/, /director\.\w*Instruction/, /silenceDecision/, /bargeMiss/, /memoryNotice/, /pinMaxPerCharacter/];
    for (const item of catalog.all()) for (const pattern of forbidden) expect(item.key, item.key).not.toMatch(pattern);
  });

  it('every concrete key resolves to a baseline value that passes its own validation', () => {
    for (const item of catalog.all()) {
      const stored = baseline(item);
      const result = validateDisplayValue(item, toDisplay(item, stored), { baseline: stored, silence, options });
      expect(result, `${item.key}: ${result.ok ? '' : result.message}`).toEqual({ ok: true, stored });
    }
  });

  it('number ranges contain the baseline and step evenly', () => {
    for (const item of catalog.all().filter((i) => i.control === 'number')) {
      const shown = toDisplay(item, baseline(item)) as number;
      expect(shown, item.key).toBeGreaterThanOrEqual(item.min!);
      expect(shown, item.key).toBeLessThanOrEqual(item.max!);
      expect(Number.isInteger((item.max! - item.min!) / item.step!), item.key).toBe(true);
    }
  });

  it('caps rest reminders at 120 minutes (compliance)', () => {
    expect(catalog.find('pacing:restReminder.firstAfterMs')!.max).toBe(120);
    expect(catalog.find('pacing:restReminder.everyMs')!.max).toBe(120);
  });

  it('every high-risk item explains the consequence', () => {
    for (const item of catalog.all().filter((i) => i.risk === 'high')) expect(item.riskNote, item.key).toBeTruthy();
  });

  it('select items offer the current value', () => {
    for (const item of catalog.all().filter((i) => i.control === 'select')) {
      const values = optionsFor(options, item.options!, item.language).map((o) => o.value);
      expect(values, item.key).toContain(baseline(item));
    }
  });
});

describe('units', () => {
  it('converts ms to seconds and minutes and back', () => {
    const seconds = catalog.find('role:elder-companion/*/director.contextAfterMs')!;
    expect(toDisplay(seconds, 6000)).toBe(6);
    expect(toStored(seconds, 7)).toBe(7000);
    const minutes = catalog.find('pacing:restReminder.firstAfterMs')!;
    expect(toDisplay(minutes, 3_600_000)).toBe(60);
    expect(toStored(minutes, 90)).toBe(5_400_000);
  });
});

describe('validateDisplayValue', () => {
  const ctx = (item: ConcreteItem) => ({ baseline: baseline(item), silence, options });

  it('rejects out-of-range and off-step numbers in Chinese', () => {
    const item = catalog.find('pacing:restReminder.firstAfterMs')!;
    expect(validateDisplayValue(item, 125, ctx(item))).toEqual({ ok: false, message: '「连续聊多久提醒休息」最大 120 分钟。' });
    expect(validateDisplayValue(item, 5, ctx(item))).toEqual({ ok: false, message: '「连续聊多久提醒休息」最小 10 分钟。' });
    expect(validateDisplayValue(item, 62, ctx(item))).toEqual({ ok: false, message: '「连续聊多久提醒休息」要按 5 分钟一档调整。' });
    expect(validateDisplayValue(item, '60', ctx(item))).toEqual({ ok: false, message: '「连续聊多久提醒休息」需要填数字。' });
  });

  it('keeps every placeholder of the persona', () => {
    const item = catalog.find('role:elder-companion/zh/persona')!;
    const text = (baseline(item) as string).replaceAll('{{charIdentity}}', '');
    const result = validateDisplayValue(item, text, ctx(item));
    expect(result).toEqual({ ok: false, message: '「三个角色共用的人设」里少了 {{charIdentity}}，这是角色性格介绍的位置，请加回去。' });
  });

  it('rejects placeholders the baseline does not have', () => {
    const item = catalog.find('role:elder-companion/zh/persona')!;
    const result = validateDisplayValue(item, `${baseline(item) as string}\n{{owner}}`, ctx(item));
    expect(result).toEqual({ ok: false, message: '「三个角色共用的人设」里的 {{owner}} 无法识别，请删掉。' });
  });

  it('requires {name} in every first-meet line', () => {
    const item = catalog.find('character:xiaonuan.greetingsFirstMeet.zh')!;
    const result = validateDisplayValue(item, ['您好，我是小暖。'], ctx(item));
    expect(result).toEqual({ ok: false, message: '「第一次知道称呼时的开场白」第 1 条里少了 {name}，这是老人称呼的位置，请加回去。' });
  });

  it('applies the check-in content rule', () => {
    const item = catalog.find('role:elder-companion/zh/director.checkinText')!;
    expect(validateDisplayValue(item, '我先安静一会儿。', ctx(item))).toEqual({
      ok: false, message: '「问「还在听吗」的备用话」要问老人还在不在听，并说随时可以接着聊。',
    });
  });

  it('accepts only listed models and https/wss addresses', () => {
    const model = catalog.find('model:qwen.realtimeModel')!;
    expect(validateDisplayValue(model, 'gpt-x', ctx(model))).toEqual({ ok: false, message: '「通话用的模型」只能从列表里选。' });
    const ws = catalog.find('model:qwen.realtimeEndpoint')!;
    expect(validateDisplayValue(ws, 'http://example.com', ctx(ws))).toEqual({ ok: false, message: '地址必须以 wss:// 开头。' });
    const http = catalog.find('model:qwen.textEndpoint')!;
    expect(validateDisplayValue(http, 'ftp://example.com', ctx(http))).toEqual({ ok: false, message: '地址必须以 https:// 开头。' });
  });

  it('extracts both placeholder styles once each', () => {
    expect(extractPlaceholders('{{char}} {name} {{char}} {topic}')).toEqual(['{{char}}', '{name}', '{topic}']);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -w gateway -- test/config-descriptors.test.ts`
Expected: FAIL，报 `Failed to load url ../src/config-store/descriptors.ts`（文件还不存在）。

- [ ] **Step 3: 实现 `keys.ts`**

新建 `gateway/src/config-store/keys.ts`：

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHARACTER_IDS, type CharacterId, type Language } from '@anyidea/protocol';

/** Values an admin may store. Arrays are string lists only. */
export type OverlayValue = number | boolean | string | readonly string[];
/** Concrete overlay key -> stored (file-unit) value. */
export type Overlay = Readonly<Record<string, OverlayValue>>;

export const MODEL_FIELDS = ['realtimeEndpoint', 'realtimeModel', 'textEndpoint', 'summarizerModel'] as const;
export type ModelField = (typeof MODEL_FIELDS)[number];
/** Model settings from env (GatewayConfig); overlay `model:qwen.*` keys replace them. */
export type ModelDefaults = Record<ModelField, string>;

/** Where one overlay key lands. Files are relative to the gateway root. */
export type OverlayTarget =
  | { kind: 'json'; file: string; path: readonly string[] }
  | { kind: 'text'; file: string }
  | { kind: 'characterEnabled'; characterId: CharacterId }
  | { kind: 'model'; field: ModelField };

const CONFIG_FILES = {
  pacing: 'config/pacing.json',
  memory: 'config/memory.json',
  affect: 'config/affect.json',
  emotion: 'config/emotion.json',
} as const;
const SEGMENT = /^(?:[A-Za-z][A-Za-z0-9]*|\d+)$/;
const FORBIDDEN_SEGMENTS = new Set(['constructor', 'prototype', '__proto__']);

export function parseOverlayKey(key: string): OverlayTarget {
  const fail = (): never => { throw new Error(`overlay_key_invalid:${key}`); };
  const colon = key.indexOf(':');
  if (colon <= 0) return fail();
  const domain = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  const jsonPath = (text: string): string[] => {
    const parts = text.split('.');
    if (parts.some((part) => !SEGMENT.test(part) || FORBIDDEN_SEGMENTS.has(part))) fail();
    return parts;
  };
  switch (domain) {
    case 'pacing':
    case 'memory':
    case 'affect':
    case 'emotion':
      if (!rest) return fail();
      return { kind: 'json', file: CONFIG_FILES[domain], path: jsonPath(rest) };
    case 'i18n': {
      const match = /^(zh|ja|en)\/([a-z]+)\.(.+)$/.exec(rest);
      if (!match) return fail();
      return { kind: 'json', file: `config/i18n/${match[1]}/${match[2]}.json`, path: jsonPath(match[3]!) };
    }
    case 'role': {
      const match = /^([a-z][a-z0-9-]{0,39})\/(zh|ja|en|\*)\/(persona|director)(?:\.(.+))?$/.exec(rest);
      if (!match) return fail();
      const [, roleId, language, file, path] = match;
      if (file === 'persona') {
        if (path !== undefined || language === '*') return fail();
        return { kind: 'text', file: `roles/${roleId}/${language}/persona.md` };
      }
      if (path === undefined) return fail();
      return { kind: 'json', file: `roles/${roleId}/${language}/director.json`, path: jsonPath(path) };
    }
    case 'character': {
      const match = /^([a-z]+)\.(.+)$/.exec(rest);
      if (!match || !(CHARACTER_IDS as readonly string[]).includes(match[1]!)) return fail();
      const characterId = match[1] as CharacterId;
      if (match[2] === 'enabled') return { kind: 'characterEnabled', characterId };
      return { kind: 'json', file: `characters/${characterId}.json`, path: jsonPath(match[2]!) };
    }
    case 'model': {
      const match = /^qwen\.([A-Za-z]+)$/.exec(rest);
      if (!match || !(MODEL_FIELDS as readonly string[]).includes(match[1]!)) return fail();
      return { kind: 'model', field: match[1] as ModelField };
    }
    default:
      return fail();
  }
}

/** Files one target writes. `roles/<role>/*/x` expands to every language in that role's role.json. */
export function targetFiles(root: string, target: { file: string }): string[] {
  if (!target.file.includes('/*/')) return [target.file];
  const roleId = target.file.split('/')[1]!;
  const role = JSON.parse(readFileSync(join(root, 'roles', roleId, 'role.json'), 'utf8')) as { supportedLanguages: Language[] };
  return role.supportedLanguages.map((language) => target.file.replace('/*/', `/${language}/`));
}

export function getJsonPath(value: unknown, path: readonly string[]): unknown {
  let node: unknown = value;
  for (const segment of path) {
    if (Array.isArray(node) && /^\d+$/.test(segment)) node = node[Number(segment)];
    else if (node !== null && typeof node === 'object' && !Array.isArray(node) && Object.hasOwn(node, segment)) node = (node as Record<string, unknown>)[segment];
    else return undefined;
  }
  return node;
}

/** Replaces an existing value. A path the baseline does not have is an error, never a new key. */
export function setJsonPath(value: unknown, path: readonly string[], next: OverlayValue): void {
  const parent = getJsonPath(value, path.slice(0, -1));
  const last = path[path.length - 1]!;
  if (getJsonPath(value, path) === undefined || parent === null || typeof parent !== 'object') {
    throw new Error(`overlay_target_missing:${path.join('.')}`);
  }
  const copy = Array.isArray(next) ? [...next] : next;
  if (Array.isArray(parent)) parent[Number(last)] = copy;
  else (parent as Record<string, unknown>)[last] = copy;
}

export function isOverlayValue(value: unknown): value is OverlayValue {
  return typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string'
    || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

/** Current file value of a target. For a `*` target the first language is read (validateTimings keeps them equal). */
export function readTargetValue(root: string, target: OverlayTarget, models: ModelDefaults): OverlayValue {
  switch (target.kind) {
    case 'characterEnabled':
      return true;
    case 'model':
      return models[target.field];
    case 'text':
      return readFileSync(join(root, target.file), 'utf8').trim();
    case 'json': {
      const file = targetFiles(root, target)[0]!;
      const value = getJsonPath(JSON.parse(readFileSync(join(root, file), 'utf8')), target.path);
      if (!isOverlayValue(value)) throw new Error(`overlay_target_missing:${file}:${target.path.join('.')}`);
      return value;
    }
  }
}
```

- [ ] **Step 4: 实现 `descriptors.ts`、`units.ts`、`options.ts`**

新建 `gateway/src/config-store/descriptors.ts`：

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CharacterId, Language } from '@anyidea/protocol';

export const SCENE_IDS = ['pacing', 'affect', 'memory', 'characters', 'copy', 'model'] as const;
export type SceneId = (typeof SCENE_IDS)[number];

const PerLanguageInt = z.object({
  zh: z.number().int().positive(),
  ja: z.number().int().positive(),
  en: z.number().int().positive(),
}).strict();

export const DescriptorItemSchema = z.object({
  /** Template; `{lang}` and `{char}` expand to concrete overlay keys. */
  key: z.string().min(3).max(120),
  label: z.string().min(2).max(24),
  /** What the elder notices, in plain words. */
  purpose: z.string().min(4).max(90),
  impact: z.object({
    characters: z.enum(['all', 'each']),
    stage: z.string().min(2).max(12),
    effective: z.literal('next_session'),
  }).strict(),
  control: z.enum(['number', 'switch', 'text', 'textarea', 'list', 'select']),
  unit: z.enum(['second', 'minute', 'day', 'count', 'char', 'level']).optional(),
  storageUnit: z.enum(['ms', 'day', 'count', 'char', 'level']).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  maxChars: PerLanguageInt.optional(),
  minItems: z.number().int().min(0).max(50).optional(),
  maxItems: z.number().int().min(1).max(50).optional(),
  itemMaxChars: PerLanguageInt.optional(),
  /** Literal tokens every text (or every list item) must keep, e.g. "{name}". */
  requiredTokens: z.array(z.string().min(1)).optional(),
  /** 'auto': keep every placeholder found in the baseline text and allow no new one. */
  placeholders: z.literal('auto').optional(),
  /** Path into qwen-options.json: realtimeModels | textModels | voices.{lang}. */
  options: z.string().optional(),
  pattern: z.enum(['wss_url', 'https_url']).optional(),
  rule: z.enum(['checkin']).optional(),
  complianceNote: z.string().max(90).nullable(),
  risk: z.enum(['low', 'medium', 'high']),
  riskNote: z.string().max(90).nullable(),
}).strict().superRefine((item, ctx) => {
  const need = (ok: boolean, message: string) => { if (!ok) ctx.addIssue({ code: 'custom', message: `${item.key}: ${message}` }); };
  if (item.control === 'number') need(item.unit !== undefined && item.storageUnit !== undefined && item.min !== undefined && item.max !== undefined && item.step !== undefined, 'number needs unit, storageUnit, min, max, step');
  if (item.control === 'text' || item.control === 'textarea') need(item.maxChars !== undefined, 'text needs maxChars');
  if (item.control === 'list') need(item.maxItems !== undefined && item.itemMaxChars !== undefined, 'list needs maxItems and itemMaxChars');
  if (item.control === 'select') need(item.options !== undefined, 'select needs options');
  if (item.risk === 'high') need(item.riskNote !== null, 'high risk needs riskNote');
  need(item.key.includes('{char}') === (item.impact.characters === 'each'), '{char} keys must use impact.characters=each');
});

export type DescriptorItem = z.infer<typeof DescriptorItemSchema>;

const ReadonlySchema = z.object({ label: z.string().min(2).max(30), purpose: z.string().min(4).max(90), note: z.string().min(2).max(120) }).strict();

const SceneFileSchema = z.object({
  scene: z.enum(SCENE_IDS),
  title: z.string().min(2).max(12),
  intro: z.string().min(4).max(80),
  order: z.number().int().min(1).max(20),
  items: z.array(DescriptorItemSchema).min(1),
  readonly: z.array(ReadonlySchema),
}).strict();

export interface ConcreteItem extends DescriptorItem {
  descriptorKey: string;
  scene: SceneId;
  language: Language | null;
  character: CharacterId | null;
}
export interface ReadonlyNote { label: string; purpose: string; note: string }
export interface SceneDescriptor {
  id: SceneId;
  title: string;
  intro: string;
  order: number;
  items: readonly ConcreteItem[];
  readonly: readonly ReadonlyNote[];
}
export interface DescriptorCatalog {
  scenes(): readonly SceneDescriptor[];
  scene(id: SceneId): SceneDescriptor;
  find(key: string): ConcreteItem | undefined;
  all(): readonly ConcreteItem[];
}

/** Loads gateway/config/admin/descriptors/*.json. Anything without a card is not editable from the admin. */
export function loadDescriptorCatalog(
  dir: string,
  opts: { languages: readonly Language[]; characters: readonly CharacterId[] },
): DescriptorCatalog {
  const scenes: SceneDescriptor[] = [];
  const byKey = new Map<string, ConcreteItem>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const parsed = SceneFileSchema.parse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    if (file !== `${parsed.scene}.json`) throw new Error(`descriptor_scene_mismatch:${file}`);
    const items: ConcreteItem[] = [];
    for (const item of parsed.items) {
      const languages: Array<Language | null> = item.key.includes('{lang}') ? [...opts.languages] : [null];
      const characters: Array<CharacterId | null> = item.key.includes('{char}') ? [...opts.characters] : [null];
      for (const character of characters) {
        for (const language of languages) {
          let key = item.key;
          if (language) key = key.replaceAll('{lang}', language);
          if (character) key = key.replaceAll('{char}', character);
          if (byKey.has(key)) throw new Error(`descriptor_key_duplicate:${key}`);
          const concrete: ConcreteItem = { ...item, key, descriptorKey: item.key, scene: parsed.scene, language, character };
          byKey.set(key, concrete);
          items.push(concrete);
        }
      }
    }
    scenes.push({ id: parsed.scene, title: parsed.title, intro: parsed.intro, order: parsed.order, items, readonly: parsed.readonly });
  }
  scenes.sort((a, b) => a.order - b.order);
  const ids = scenes.map((scene) => scene.id);
  if (ids.length !== SCENE_IDS.length || SCENE_IDS.some((id) => !ids.includes(id))) throw new Error(`descriptor_scene_set_mismatch:${ids.join(',')}`);
  return {
    scenes: () => scenes,
    scene: (id) => {
      const scene = scenes.find((candidate) => candidate.id === id);
      if (!scene) throw new Error(`descriptor_scene_unknown:${id}`);
      return scene;
    },
    find: (key) => byKey.get(key),
    all: () => [...byKey.values()],
  };
}

/** `{{x}}` and `{x}` placeholders, first-seen order, each once. */
export function extractPlaceholders(text: string): string[] {
  return [...new Set(text.match(/\{\{[A-Za-z]+\}\}|\{[A-Za-z]+\}/g) ?? [])];
}
```

新建 `gateway/src/config-store/units.ts`：

```ts
import type { DescriptorItem } from './descriptors.ts';
import type { OverlayValue } from './keys.ts';

/** Stored units per display unit. Only ms needs converting; days, counts and chars are stored as shown. */
function factor(item: DescriptorItem): number {
  if (item.storageUnit !== 'ms') return 1;
  if (item.unit === 'second') return 1_000;
  if (item.unit === 'minute') return 60_000;
  throw new Error(`descriptor_unit_unsupported:${item.key}`);
}

export function toDisplay(item: DescriptorItem, stored: OverlayValue): OverlayValue {
  return item.control === 'number' && typeof stored === 'number' ? stored / factor(item) : stored;
}

export function toStored(item: DescriptorItem, display: OverlayValue): OverlayValue {
  return item.control === 'number' && typeof display === 'number' ? Math.round(display * factor(item)) : display;
}
```

新建 `gateway/src/config-store/options.ts`：

```ts
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Language } from '@anyidea/protocol';

const OptionSchema = z.object({ value: z.string().min(1).max(64), label: z.string().min(1).max(30) }).strict();
const OptionList = z.array(OptionSchema).min(1);
const QwenOptionsSchema = z.object({
  realtimeModels: OptionList,
  textModels: OptionList,
  voices: z.object({ zh: OptionList, ja: OptionList, en: OptionList }).strict(),
}).strict();

export interface QwenOption { value: string; label: string }
export interface QwenOptions { realtimeModels: QwenOption[]; textModels: QwenOption[]; voices: Record<Language, QwenOption[]> }

export function loadQwenOptions(path: string): QwenOptions {
  return QwenOptionsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** ref: realtimeModels | textModels | voices.{lang} (resolved with the item's language). */
export function optionsFor(options: QwenOptions, ref: string, language: Language | null): readonly QwenOption[] {
  if (ref === 'realtimeModels') return options.realtimeModels;
  if (ref === 'textModels') return options.textModels;
  if (ref === 'voices.{lang}' && language) return options.voices[language];
  throw new Error(`descriptor_options_unknown:${ref}`);
}
```

- [ ] **Step 5: 实现 `validate.ts`**

新建 `gateway/src/config-store/validate.ts`：

```ts
import type { Language } from '@anyidea/protocol';
import type { SilenceRules } from '../i18n/types.ts';
import { extractPlaceholders, type ConcreteItem } from './descriptors.ts';
import type { OverlayValue } from './keys.ts';
import { optionsFor, type QwenOptions } from './options.ts';
import { toStored } from './units.ts';

export interface ValidateContext { baseline: OverlayValue; silence: Record<Language, SilenceRules>; options: QwenOptions }
export type ValidateResult = { ok: true; stored: OverlayValue } | { ok: false; message: string };

const UNIT_WORDS: Record<string, string> = { second: '秒', minute: '分钟', day: '天', count: '条', char: '字', level: '级' };
/** What a placeholder stands for, in words an admin understands. */
const TOKEN_MEANINGS: Record<string, string> = {
  '{name}': '老人称呼',
  '{{char}}': '角色名字',
  '{{charSpoken}}': '角色名字的读音',
  '{{charIdentity}}': '角色性格介绍',
  '{topic}': '话题',
  '{utterance}': '老人原话',
};

const chars = (text: string) => Array.from(text).length;
const meaning = (token: string) => TOKEN_MEANINGS[token] ?? '程序要用的内容';

export function validateDisplayValue(item: ConcreteItem, value: unknown, ctx: ValidateContext): ValidateResult {
  const fail = (message: string): ValidateResult => ({ ok: false, message });
  const label = `「${item.label}」`;
  const language = item.language ?? 'zh';
  switch (item.control) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`${label}需要填数字。`);
      const unit = UNIT_WORDS[item.unit!] ?? '';
      if (value > item.max!) return fail(`${label}最大 ${item.max} ${unit}。`);
      if (value < item.min!) return fail(`${label}最小 ${item.min} ${unit}。`);
      const steps = (value - item.min!) / item.step!;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) return fail(`${label}要按 ${item.step} ${unit}一档调整。`);
      return { ok: true, stored: toStored(item, value) };
    }
    case 'switch':
      return typeof value === 'boolean' ? { ok: true, stored: value } : fail(`${label}只能是开或关。`);
    case 'select': {
      if (typeof value !== 'string') return fail(`${label}只能从列表里选。`);
      const allowed = optionsFor(ctx.options, item.options!, item.language).map((option) => option.value);
      return allowed.includes(value) ? { ok: true, stored: value } : fail(`${label}只能从列表里选。`);
    }
    case 'text':
    case 'textarea': {
      if (typeof value !== 'string' || !value.trim()) return fail(`${label}不能为空。`);
      const text = value.trim();
      const max = item.maxChars![language];
      if (chars(text) > max) return fail(`${label}最多 ${max} 个字，现在 ${chars(text)} 个。`);
      if (item.pattern === 'wss_url' && !isUrl(text, 'wss:')) return fail('地址必须以 wss:// 开头。');
      if (item.pattern === 'https_url' && !isUrl(text, 'https:')) return fail('地址必须以 https:// 开头。');
      for (const token of item.requiredTokens ?? []) {
        if (!text.includes(token)) return fail(`${label}里少了 ${token}，这是${meaning(token)}的位置，请加回去。`);
      }
      if (item.placeholders === 'auto' && typeof ctx.baseline === 'string') {
        const expected = extractPlaceholders(ctx.baseline);
        for (const token of expected) {
          if (!text.includes(token)) return fail(`${label}里少了 ${token}，这是${meaning(token)}的位置，请加回去。`);
        }
        const unknown = extractPlaceholders(text).find((token) => !expected.includes(token));
        if (unknown) return fail(`${label}里的 ${unknown} 无法识别，请删掉。`);
      }
      if (item.rule === 'checkin' && !passesCheckin(text, ctx.silence[language])) {
        return fail(`${label}要问老人还在不在听，并说随时可以接着聊。`);
      }
      return { ok: true, stored: text };
    }
    case 'list': {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return fail(`${label}格式不对。`);
      const list = (value as string[]).map((entry) => entry.trim());
      const min = item.minItems ?? 1;
      if (list.length < min) return fail(`${label}至少要有 ${min} 条。`);
      if (list.length > item.maxItems!) return fail(`${label}最多 ${item.maxItems} 条。`);
      if (new Set(list).size !== list.length) return fail(`${label}里有重复的内容。`);
      const max = item.itemMaxChars![language];
      for (const [index, entry] of list.entries()) {
        if (!entry) return fail(`${label}第 ${index + 1} 条是空的。`);
        if (chars(entry) > max) return fail(`${label}第 ${index + 1} 条最多 ${max} 个字。`);
        for (const token of item.requiredTokens ?? []) {
          if (!entry.includes(token)) return fail(`${label}第 ${index + 1} 条里少了 ${token}，这是${meaning(token)}的位置，请加回去。`);
        }
      }
      return { ok: true, stored: list };
    }
  }
}

function isUrl(text: string, protocol: string): boolean {
  try {
    return new URL(text).protocol === protocol;
  } catch {
    return false;
  }
}

/** Same content rule the Director applies to planned check-ins (listening + anytime words, length cap). */
function passesCheckin(text: string, rules: SilenceRules): boolean {
  const lower = text.toLowerCase();
  const has = (words: readonly string[]) => words.some((word) => lower.includes(word.toLowerCase()));
  return chars(text) <= rules.maxCheckinChars && has(rules.listening) && has(rules.anytime);
}
```

- [ ] **Step 6: 写 Qwen 下拉候选**

新建 `gateway/config/admin/qwen-options.json`。只放仓库里正在用的值和 env 默认值；以后要加新的模型或音色，先按官方文档确认名字再加（不要凭记忆加）：

```json
{
  "realtimeModels": [
    { "value": "qwen3.8-omni-flash-realtime", "label": "Qwen3.8 Omni Flash 实时版" }
  ],
  "textModels": [
    { "value": "qwen-plus", "label": "通义千问 Plus" },
    { "value": "qwen-flash", "label": "通义千问 Flash" }
  ],
  "voices": {
    "zh": [
      { "value": "longanlingxin", "label": "龙安灵心（温柔女声）" },
      { "value": "Tina", "label": "Tina（女声）" },
      { "value": "Ryan", "label": "Ryan（男声）" }
    ],
    "ja": [
      { "value": "Tina", "label": "Tina（女声）" },
      { "value": "Evan", "label": "Evan（男声）" }
    ],
    "en": [
      { "value": "Tina", "label": "Tina（女声）" },
      { "value": "Evan", "label": "Evan（男声）" }
    ]
  }
}
```

- [ ] **Step 7: 写六个场景的说明卡**

新建 `gateway/config/admin/descriptors/pacing.json`：

```json
{
  "scene": "pacing",
  "title": "对话节奏",
  "intro": "老人不说话时，AI 什么时候开口、实在想不出话时说什么。改完下一通电话生效。",
  "order": 1,
  "items": [
    {
      "key": "role:elder-companion/*/director.contextAfterMs",
      "label": "老人停下后多久接第一句",
      "purpose": "老人说完话安静下来，AI 等这么久，再顺着刚才的话轻轻接一句。",
      "impact": { "characters": "all", "stage": "沉默接话", "effective": "next_session" },
      "control": "number", "unit": "second", "storageUnit": "ms", "min": 3, "max": 20, "step": 1,
      "complianceNote": null, "risk": "medium",
      "riskNote": "太短像在催老人，太长老人会以为 AI 走神了。"
    },
    {
      "key": "role:elder-companion/*/director.checkAfterMs",
      "label": "第二句再等多久",
      "purpose": "第一句说完老人还没开口，AI 再等这么久，换个角度问个小问题。",
      "impact": { "characters": "all", "stage": "沉默接话", "effective": "next_session" },
      "control": "number", "unit": "second", "storageUnit": "ms", "min": 4, "max": 30, "step": 1,
      "complianceNote": null, "risk": "medium",
      "riskNote": "太短会连着追问，老人可能觉得被催。"
    },
    {
      "key": "role:elder-companion/*/director.leaveAfterMs",
      "label": "第三句再等多久",
      "purpose": "第二句之后老人仍没开口，AI 再等这么久，留个话头、给老人一点空间。",
      "impact": { "characters": "all", "stage": "沉默接话", "effective": "next_session" },
      "control": "number", "unit": "second", "storageUnit": "ms", "min": 5, "max": 60, "step": 1,
      "complianceNote": null, "risk": "medium",
      "riskNote": "太短会连着追问，老人可能觉得被催。"
    },
    {
      "key": "role:elder-companion/*/director.checkinAfterMs",
      "label": "问「还在听吗」前再等多久",
      "purpose": "第三句之后老人仍没开口，AI 再等这么久，轻声问一句还在不在听。",
      "impact": { "characters": "all", "stage": "沉默接话", "effective": "next_session" },
      "control": "number", "unit": "second", "storageUnit": "ms", "min": 5, "max": 60, "step": 1,
      "complianceNote": null, "risk": "medium",
      "riskNote": "太短会显得不耐烦。"
    },
    {
      "key": "role:elder-companion/*/director.restAfterMs",
      "label": "最后一句前再等多久",
      "purpose": "问过「还在听吗」老人还是没回，AI 再等这么久，说一句让老人放心歇着，之后不再主动说话。",
      "impact": { "characters": "all", "stage": "沉默接话", "effective": "next_session" },
      "control": "number", "unit": "minute", "storageUnit": "ms", "min": 1, "max": 10, "step": 1,
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "role:elder-companion/{lang}/director.contextText",
      "label": "第一句的备用话",
      "purpose": "AI 平时会根据刚才聊的内容自己想一句；只有想不出来（比如网络慢）时，才说这句。",
      "impact": { "characters": "all", "stage": "沉默接话", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 40, "ja": 60, "en": 120 },
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "role:elder-companion/{lang}/director.checkContextText",
      "label": "第二句的备用话",
      "purpose": "AI 想不出第二句时说这句。",
      "impact": { "characters": "all", "stage": "沉默接话", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 40, "ja": 60, "en": 120 },
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "role:elder-companion/{lang}/director.leaveText",
      "label": "第三句的备用话",
      "purpose": "AI 想不出第三句时说这句。这句是给老人空间，不要问问题。",
      "impact": { "characters": "all", "stage": "沉默接话", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 40, "ja": 60, "en": 120 },
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "role:elder-companion/{lang}/director.checkinText",
      "label": "问「还在听吗」的备用话",
      "purpose": "AI 想不出怎么问时说这句。",
      "impact": { "characters": "all", "stage": "沉默接话", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 30, "ja": 60, "en": 80 }, "rule": "checkin",
      "complianceNote": null, "risk": "medium",
      "riskNote": "这句必须问老人还在不在听，并说随时可以接着聊，否则不能保存。"
    },
    {
      "key": "role:elder-companion/{lang}/director.restText",
      "label": "最后一句的备用话",
      "purpose": "AI 想不出最后一句时说这句。说完 AI 就不再主动说话，不要问问题。",
      "impact": { "characters": "all", "stage": "沉默接话", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 40, "ja": 60, "en": 120 },
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "role:elder-companion/{lang}/director.presenceText",
      "label": "实在没话时的「我在」",
      "purpose": "还没聊起来、AI 又想不出话时，只轻轻说这一句，让老人知道它还在。",
      "impact": { "characters": "all", "stage": "沉默接话", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 10, "ja": 16, "en": 24 },
      "complianceNote": null, "risk": "medium",
      "riskNote": "这句很短是有意的；改成长句会让老人觉得 AI 在敷衍。"
    },
    {
      "key": "role:elder-companion/{lang}/director.lightPhrases",
      "label": "算作轻声答应的词",
      "purpose": "老人只说这些词时，AI 当他还在听，不当成开了新话题。",
      "impact": { "characters": "all", "stage": "沉默接话", "effective": "next_session" },
      "control": "list", "minItems": 1, "maxItems": 30, "itemMaxChars": { "zh": 6, "ja": 8, "en": 16 },
      "complianceNote": null, "risk": "medium",
      "riskNote": "别加「吃饭」「医院」这类有内容的词，否则 AI 会忽略老人真正想说的事。"
    },
    {
      "key": "pacing:restReminder.firstAfterMs",
      "label": "连续聊多久提醒休息",
      "purpose": "老人连续聊到这么久，AI 会温和地提醒他起来活动、喝口水。",
      "impact": { "characters": "all", "stage": "休息提醒", "effective": "next_session" },
      "control": "number", "unit": "minute", "storageUnit": "ms", "min": 10, "max": 120, "step": 5,
      "complianceNote": "监管要求连续使用不超过 2 小时就要提醒，所以最多 120 分钟。",
      "risk": "low",
      "riskNote": "提醒的话里写着「一个钟头」，改了时间记得到「文案」里一起改。"
    },
    {
      "key": "pacing:restReminder.everyMs",
      "label": "之后每隔多久再提醒",
      "purpose": "第一次提醒之后老人还在聊，每隔这么久再提醒一次。",
      "impact": { "characters": "all", "stage": "休息提醒", "effective": "next_session" },
      "control": "number", "unit": "minute", "storageUnit": "ms", "min": 30, "max": 120, "step": 5,
      "complianceNote": "监管要求连续使用不超过 2 小时就要提醒，所以最多 120 分钟。",
      "risk": "low",
      "riskNote": "不能短于「连续聊多久提醒休息」的一半。"
    }
  ],
  "readonly": [
    { "label": "沉默接话的顺序", "purpose": "老人一直不说话时，AI 依次说：三句接话、问一句还在不在听、几分钟后一句收尾，然后不再主动说话。", "note": "顺序固定，这里只能改等待时间和备用话。" },
    { "label": "每一句说什么", "purpose": "每一句由 AI 根据刚才聊的内容和记得的事自己想，不会照念备用话。", "note": "怎么想由开发人员维护的提示词决定，这里不能改。" }
  ]
}
```

新建 `gateway/config/admin/descriptors/affect.json`：

```json
{
  "scene": "affect",
  "title": "情绪与关怀",
  "intro": "AI 怎么察觉老人的心情、什么时候放慢陪伴、开场要不要关心老人前几天说过的事。",
  "order": 2,
  "items": [
    {
      "key": "affect:enabled",
      "label": "感受情绪与关怀开场",
      "purpose": "打开后，AI 会留意老人的心情；开场时会关心老人前几天说过的烦心事。",
      "impact": { "characters": "all", "stage": "情绪与开场", "effective": "next_session" },
      "control": "switch",
      "complianceNote": null, "risk": "medium",
      "riskNote": "关掉后，AI 不再察觉老人情绪低落，也不会在开场关心老人前几天说过的事。"
    },
    {
      "key": "affect:lowIntensity",
      "label": "多难过才算情绪低落",
      "purpose": "数字越小越敏感：1 表示老人有一点难过 AI 就放慢、多陪伴；3 表示很难过时才这样做。",
      "impact": { "characters": "all", "stage": "情绪识别", "effective": "next_session" },
      "control": "number", "unit": "level", "storageUnit": "level", "min": 1, "max": 3, "step": 1,
      "complianceNote": null, "risk": "medium",
      "riskNote": "调到 3 时，老人有些难过 AI 也会照常找新话题。"
    },
    {
      "key": "affect:care.maxAgeDays",
      "label": "关怀开场最多提起几天前的事",
      "purpose": "开场时，AI 只会关心老人这几天内说过的事，太久以前的不再提。",
      "impact": { "characters": "all", "stage": "关怀开场", "effective": "next_session" },
      "control": "number", "unit": "day", "storageUnit": "day", "min": 1, "max": 14, "step": 1,
      "complianceNote": null, "risk": "high",
      "riskNote": "这也决定这些原话保存多久；调小后，更早的会在当晚清理中删除，删除后找不回来。"
    },
    {
      "key": "affect:exhausted.shortStreakTrigger",
      "label": "连着几次只答一两个字就换话题",
      "purpose": "老人连着这么多次只回「嗯」「好」，AI 就知道这个话题聊不下去了，换一个。",
      "impact": { "characters": "all", "stage": "话题", "effective": "next_session" },
      "control": "number", "unit": "count", "storageUnit": "count", "min": 2, "max": 6, "step": 1,
      "complianceNote": null, "risk": "medium",
      "riskNote": "太小会频繁换话题，老人可能跟不上。"
    },
    {
      "key": "emotion:revertAfterMs",
      "label": "形象表情保持多久",
      "purpose": "AI 说到开心或难过的话时，手机上的形象换成对应表情，保持这么久再恢复。",
      "impact": { "characters": "all", "stage": "形象表情", "effective": "next_session" },
      "control": "number", "unit": "second", "storageUnit": "ms", "min": 2, "max": 20, "step": 1,
      "complianceNote": null, "risk": "low", "riskNote": null
    }
  ],
  "readonly": [
    { "label": "危机时的处理", "purpose": "老人流露出轻生等危险念头时，AI 不起新话题，只陪着并劝他联系家人。", "note": "安全规则由开发人员维护，这里不能改。" }
  ]
}
```

新建 `gateway/config/admin/descriptors/memory.json`：

```json
{
  "scene": "memory",
  "title": "记忆",
  "intro": "AI 每次聊天带着多少记忆、老人的原话保存多久。后台看不到记忆内容。",
  "order": 3,
  "items": [
    {
      "key": "memory:instructions.snapshotMaxChars",
      "label": "每次带进聊天的记忆有多长",
      "purpose": "每通电话开始时，AI 会带上一段关于老人的记忆（称呼、喜好、上次聊的事），最长这么多字。",
      "impact": { "characters": "all", "stage": "记忆", "effective": "next_session" },
      "control": "number", "unit": "char", "storageUnit": "char", "min": 200, "max": 600, "step": 50,
      "complianceNote": null, "risk": "medium",
      "riskNote": "调短后 AI 记得的事变少，老人可能觉得它忘了上次聊的。"
    },
    {
      "key": "memory:listMaxItems",
      "label": "问「你都记得我什么」时说几条",
      "purpose": "老人问 AI 记得他什么时，AI 最多念这么多条。",
      "impact": { "characters": "all", "stage": "记忆", "effective": "next_session" },
      "control": "number", "unit": "count", "storageUnit": "count", "min": 1, "max": 10, "step": 1,
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "memory:retentionDays",
      "label": "老人的原话保存多少天",
      "purpose": "聊天时老人说过的原话保存这么多天，AI 靠它回忆「上次聊到哪」。",
      "impact": { "characters": "all", "stage": "记忆", "effective": "next_session" },
      "control": "number", "unit": "day", "storageUnit": "day", "min": 7, "max": 365, "step": 1,
      "complianceNote": null, "risk": "high",
      "riskNote": "调短后，更早的原话会在当晚自动清理中删除，删除后找不回来。"
    }
  ],
  "readonly": [
    { "label": "钉住记忆的上限", "purpose": "老人可以让每个角色专门记住最多 10 件事。", "note": "暂不能在这里改：调小会让已经钉住的内容放不下。" },
    { "label": "查看和删除记忆", "purpose": "老人在手机设置里可以自己查看、删除每个角色记得的事。", "note": "后台只显示条数，不显示内容。" }
  ]
}
```

新建 `gateway/config/admin/descriptors/characters.json`：

```json
{
  "scene": "characters",
  "title": "角色",
  "intro": "三个角色各自的性格、开场白和声音，以及三人共用的人设。",
  "order": 4,
  "items": [
    {
      "key": "character:{char}.enabled",
      "label": "启用这个角色",
      "purpose": "关掉后，老人在手机上选不了这个角色，会看到「暂时休息中」。",
      "impact": { "characters": "each", "stage": "选择角色", "effective": "next_session" },
      "control": "switch",
      "complianceNote": null, "risk": "medium",
      "riskNote": "正在聊的不受影响；至少要留一个角色开着。"
    },
    {
      "key": "character:{char}.identity.{lang}",
      "label": "性格描述",
      "purpose": "这个角色和老人是什么关系、说话什么味道。AI 会照着这段说话。",
      "impact": { "characters": "each", "stage": "说话方式", "effective": "next_session" },
      "control": "textarea", "maxChars": { "zh": 200, "ja": 300, "en": 400 },
      "complianceNote": null, "risk": "medium",
      "riskNote": "写得太夸张 AI 会变得做作；不要写其他角色的名字。"
    },
    {
      "key": "character:{char}.greetingNoName.{lang}",
      "label": "不知道称呼时的开场白",
      "purpose": "还不知道怎么称呼老人时，AI 用这句自我介绍并问称呼。",
      "impact": { "characters": "each", "stage": "开场", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 40, "ja": 60, "en": 120 },
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "character:{char}.greetingsFirstMeet.{lang}",
      "label": "第一次知道称呼时的开场白",
      "purpose": "老人在别的角色那里说过称呼、第一次见这个角色时，AI 从这几句里挑一句打招呼。",
      "impact": { "characters": "each", "stage": "开场", "effective": "next_session" },
      "control": "list", "minItems": 1, "maxItems": 5, "itemMaxChars": { "zh": 40, "ja": 50, "en": 100 },
      "requiredTokens": ["{name}"],
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "character:{char}.voices.qwen.{lang}",
      "label": "声音",
      "purpose": "这个角色说话用的声音。",
      "impact": { "characters": "each", "stage": "声音", "effective": "next_session" },
      "control": "select", "options": "voices.{lang}",
      "complianceNote": null, "risk": "medium",
      "riskNote": "换了声音，老人可能一下子认不出是谁。"
    },
    {
      "key": "role:elder-companion/{lang}/persona",
      "label": "三个角色共用的人设",
      "purpose": "AI 陪老人聊天的总体要求：怎么说话、什么不能说。三个角色都用这段。",
      "impact": { "characters": "all", "stage": "说话方式", "effective": "next_session" },
      "control": "textarea", "maxChars": { "zh": 1600, "ja": 2000, "en": 3500 }, "placeholders": "auto",
      "complianceNote": null, "risk": "high",
      "riskNote": "改坏了 AI 可能说错话。安全底线在别处，不会被这里改掉。"
    },
    {
      "key": "role:elder-companion/{lang}/director.greetingNameTexts",
      "label": "知道称呼后的开场白",
      "purpose": "已经知道怎么称呼老人时，AI 从这几句里挑一句开场。",
      "impact": { "characters": "all", "stage": "开场", "effective": "next_session" },
      "control": "list", "minItems": 1, "maxItems": 5, "itemMaxChars": { "zh": 30, "ja": 50, "en": 100 },
      "requiredTokens": ["{name}"],
      "complianceNote": null, "risk": "medium",
      "riskNote": "不要写「上次您说……」这类具体的事，AI 会把没聊过的事说成聊过。"
    }
  ],
  "readonly": [
    { "label": "角色的名字", "purpose": "小暖、小凯、小欣的名字和读音。", "note": "名字和手机上的形象绑定，不能在这里改。" }
  ]
}
```

新建 `gateway/config/admin/descriptors/copy.json`：

```json
{
  "scene": "copy",
  "title": "文案",
  "intro": "AI 在固定场合说的原话。三种语言分开改。",
  "order": 5,
  "items": [
    {
      "key": "i18n:{lang}/memory.restReminderText",
      "label": "提醒休息时说的话",
      "purpose": "连续聊久了，AI 用这句提醒老人起来活动、喝口水。",
      "impact": { "characters": "all", "stage": "休息提醒", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 60, "ja": 90, "en": 160 },
      "complianceNote": null, "risk": "low",
      "riskNote": "里面提到的时长要和「对话节奏」里的提醒时间一致。"
    },
    {
      "key": "i18n:{lang}/memory.forgetConfirmText",
      "label": "老人说「忘掉」后的回答",
      "purpose": "老人让 AI 别记某件事，AI 删掉后用这句回答。",
      "impact": { "characters": "all", "stage": "记忆", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 30, "ja": 50, "en": 100 },
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "i18n:{lang}/memory.recall.emptyText",
      "label": "想不起上次聊什么时说的话",
      "purpose": "老人问上次聊过什么、AI 又找不到记录时，用这句如实说找不到。",
      "impact": { "characters": "all", "stage": "回忆", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 40, "ja": 60, "en": 120 },
      "complianceNote": null, "risk": "medium",
      "riskNote": "不要写成「您上次说过……」；找不到记录时 AI 只能如实承认。"
    },
    {
      "key": "i18n:{lang}/memory.pin.confirmText",
      "label": "记住一件事后的回答",
      "purpose": "老人让 AI 专门记住一件事，记好后用这句回答。",
      "impact": { "characters": "all", "stage": "记忆", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 30, "ja": 50, "en": 80 },
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "i18n:{lang}/memory.pin.fullText",
      "label": "钉住的事太多时说的话",
      "purpose": "专门记住的事已经满了，AI 用这句请老人先去设置里删掉一些。",
      "impact": { "characters": "all", "stage": "记忆", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 40, "ja": 60, "en": 120 },
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "i18n:{lang}/memory.weather.unavailableText",
      "label": "天气查不到时说的话",
      "purpose": "老人问天气、AI 一时查不到时用这句。",
      "impact": { "characters": "all", "stage": "天气", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 30, "ja": 50, "en": 100 },
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "role:elder-companion/{lang}/director.resumeText",
      "label": "网络断了又连上时说的话",
      "purpose": "通话中网络断开又连上后，AI 用这句接上刚才的话。",
      "impact": { "characters": "all", "stage": "断线恢复", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 30, "ja": 50, "en": 100 },
      "complianceNote": null, "risk": "low", "riskNote": null
    }
  ],
  "readonly": [
    { "label": "没听清时的回答", "purpose": "咳嗽或杂音打断 AI 时，AI 只说「没听清，您再说一遍。」", "note": "这句固定不变，改了容易让 AI 接错话。" },
    { "label": "记忆告知和安全提示", "purpose": "第一次告诉老人「聊过的事会记着」，以及危机时劝老人联系家人的话。", "note": "和合规有关，由开发人员维护。" }
  ]
}
```

新建 `gateway/config/admin/descriptors/model.json`：

```json
{
  "scene": "model",
  "title": "模型与 Key",
  "intro": "通话和整理记忆用哪个通义千问模型、连哪个地址。Key 在本页下方单独管理。",
  "order": 6,
  "items": [
    {
      "key": "model:qwen.realtimeModel",
      "label": "通话用的模型",
      "purpose": "老人和 AI 实时语音聊天用的模型。",
      "impact": { "characters": "all", "stage": "通话", "effective": "next_session" },
      "control": "select", "options": "realtimeModels",
      "complianceNote": null, "risk": "high",
      "riskNote": "选错或没开通，所有新通话都会连不上。"
    },
    {
      "key": "model:qwen.realtimeEndpoint",
      "label": "通话服务地址",
      "purpose": "实时语音服务的地址，来自阿里云百炼控制台。",
      "impact": { "characters": "all", "stage": "通话", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 300, "ja": 300, "en": 300 }, "pattern": "wss_url",
      "complianceNote": null, "risk": "high",
      "riskNote": "地址填错，所有新通话都会连不上。"
    },
    {
      "key": "memory:extractModel",
      "label": "整理记忆用的模型",
      "purpose": "通话后整理老人说过的事、开场关怀和主动接话时用的文本模型。",
      "impact": { "characters": "all", "stage": "记忆与接话", "effective": "next_session" },
      "control": "select", "options": "textModels",
      "complianceNote": null, "risk": "medium",
      "riskNote": "换成更便宜的模型，记忆可能整理得不准，主动接话也可能变生硬。"
    },
    {
      "key": "model:qwen.summarizerModel",
      "label": "总结聊天用的模型",
      "purpose": "一通电话聊得很长时，用它把前面的内容压缩成摘要。",
      "impact": { "characters": "all", "stage": "长对话", "effective": "next_session" },
      "control": "select", "options": "textModels",
      "complianceNote": null, "risk": "low", "riskNote": null
    },
    {
      "key": "model:qwen.textEndpoint",
      "label": "文本服务地址",
      "purpose": "整理记忆和总结聊天用的服务地址，来自阿里云百炼控制台。",
      "impact": { "characters": "all", "stage": "记忆与接话", "effective": "next_session" },
      "control": "text", "maxChars": { "zh": 300, "ja": 300, "en": 300 }, "pattern": "https_url",
      "complianceNote": null, "risk": "high",
      "riskNote": "地址填错，记忆整理和主动接话都会失败（通话本身不受影响）。"
    }
  ],
  "readonly": [
    { "label": "模型厂商", "purpose": "通话和整理记忆都用阿里云百炼（通义千问）。", "note": "本后台不支持切换到其他厂商。" },
    { "label": "运行参数", "purpose": "同时通话上限、限流、会话超时等。", "note": "由部署时的环境变量决定，改了要重启。" }
  ]
}
```

- [ ] **Step 8: 运行测试，确认通过**

Run: `npm test -w gateway -- test/config-descriptors.test.ts`
Expected: PASS（全部用例）。

若「baseline passes its own validation」失败：说明某个基线值超出了说明卡的范围或字数。**不要改基线文件**，按报错把说明卡的上限放宽到能容纳基线（字数类取基线长度 + 50% 向上取整到 10），并在提交说明里写明。若某个 ja/en 的 `checkinText` 基线不满足 checkin 规则，停下报告（那说明运行时规则和文件已经不一致，属于高风险区）。

- [ ] **Step 9: 全量回归并提交**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部 PASS，typecheck 无输出。

```bash
git add gateway/src/config-store/keys.ts gateway/src/config-store/descriptors.ts gateway/src/config-store/units.ts \
  gateway/src/config-store/options.ts gateway/src/config-store/validate.ts \
  gateway/config/admin/qwen-options.json gateway/config/admin/descriptors/pacing.json gateway/config/admin/descriptors/affect.json \
  gateway/config/admin/descriptors/memory.json gateway/config/admin/descriptors/characters.json \
  gateway/config/admin/descriptors/copy.json gateway/config/admin/descriptors/model.json \
  gateway/test/config-descriptors.test.ts
git commit -m "feat(config-store): add admin descriptors, overlay keys and value checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 与 spec 白名单的差异（已在总览契约范围内，执行者照本任务做）

| spec 白名单 | 本任务处理 | 原因 |
|---|---|---|
| 记忆：钉住上限 | 只读说明，不可改 | 钉住内容进提示词时不截断（已踩过的坑 14、`pinnedMaxCharsFor`）。调小上限后，已有的超额钉住会超出预留预算 |
| 对话节奏：各步的「指令」（config-admin-later 的「第一步的指令、第二步随上下文变化的指令」） | 不可改，只改备用话 | 四段式现在由规划器生成每一句（已踩过的坑 8、9），各步指令只是旧路径；把指令交给后台会碰到「指令里放可照读例句」的坑 3 |
| 角色：director 提示词 | 只开放 `greetingNameTexts`；`*Instruction`、`silenceDecision` 不开放 | 同上，属于高风险区（坑 3、5、8） |
| 「没听清」与记忆告知原话 | 只读说明 | 坑 9；记忆告知受 `memory_notice_keyword` 启动校验约束，属于合规文案 |
