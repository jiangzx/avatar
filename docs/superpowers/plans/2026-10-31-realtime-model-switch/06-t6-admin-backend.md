# Task 6: 管理端配置后端（`{model}` 描述符、选项、校验）

**Files:**
- Modify: `protocol/src/adminApi.ts`
- Modify: `gateway/src/config-store/options.ts`
- Modify: `gateway/src/config-store/descriptors.ts`
- Modify: `gateway/src/config-store/validate.ts`
- Modify: `gateway/src/admin/configApi.ts`
- Modify: `gateway/src/index.ts`
- Modify: `gateway/config/admin/descriptors/characters.json`
- Modify: `gateway/config/admin/qwen-options.json`
- Modify: `gateway/test/config-descriptors.test.ts`
- Modify: `gateway/test/config-snapshot.test.ts`
- Modify: `gateway/test/config-api.test.ts`
- Modify: `gateway/test/support/configAdmin.ts`

**Interfaces:**
- Consumes: T1 的 `loadRealtimeRegistry`；T2 的 `voice:` 目标。
- Produces:
  - `QwenOptions.voices: Record<string, Record<Language, QwenOption[]>>`
  - `optionsFor(options, ref, language, model?)`
  - `loadAdminOptions(gatewayRoot)`
  - `ConcreteItem.model: string | null`
  - `AdminConfigItem.model: string | null`
  - 描述符键 `voice:{model}/{char}.{lang}`

背景：管理端已经能通过 `model:qwen.realtimeModel` 切模型，但音色选项是全局的。这个任务把音色选项和存储改成按模型：描述符新增 `{model}` 展开，音色 key 自带模型，选项从该模型的 catalog 取。旧的 `character:{char}.voices.qwen.{lang}` 项移除，但旧覆盖仍可解析（T2）。

- [x] **Step 1: 写失败测试**

`gateway/test/config-descriptors.test.ts` 的导入和常量改为：

```ts
import { loadAdminOptions, optionsFor } from '../src/config-store/options.ts';
// ...
const options = loadAdminOptions(root);
const catalog = loadDescriptorCatalog(`${root}config/admin/descriptors`, {
  languages: LANGUAGES,
  characters: CHARACTER_IDS,
  models: options.realtimeModels.map((option) => option.value),
});
```

在 `describe('overlay keys')` 的映射断言里加：

```ts
expect(parseOverlayKey('voice:qwen-audio-3.1-realtime-flash/xiaonuan.zh')).toEqual({
  kind: 'voice', model: 'qwen-audio-3.1-realtime-flash', character: 'xiaonuan', language: 'zh',
});
```

在 `describe('descriptor catalog')` 里加：

```ts
it('expands {model} and resolves voices from that model catalog', () => {
  const item = catalog.find('voice:qwen-audio-3.1-realtime-flash/xiaonuan.zh')!;
  expect(item.model).toBe('qwen-audio-3.1-realtime-flash');
  expect(item.character).toBe('xiaonuan');
  expect(item.language).toBe('zh');
  expect(item.descriptorKey).toBe('voice:{model}/{char}.{lang}');
  expect(optionsFor(options, item.options!, 'zh', item.model).map((option) => option.value)).toContain('longanlingxin_v3.1');
  expect(catalog.find('character:xiaonuan.voices.qwen.zh')).toBeUndefined();
});
```

把 select 选项断言那一行改为：

```ts
const values = optionsFor(options, item.options!, item.language, item.model).map((o) => o.value);
```

在 `validateDisplayValue` 的测试区加：

```ts
it('accepts only voices in the model catalog', () => {
  const item = catalog.find('voice:qwen-audio-3.1-realtime-flash/xiaonuan.zh')!;
  const ctx = { baseline: baseline(item), silence, options };
  expect(validateDisplayValue(item, 'longanlingxin_v3.1', ctx).ok).toBe(true);
  expect(validateDisplayValue(item, 'Tina', ctx).ok).toBe(false);
});
```

`gateway/test/config-snapshot.test.ts` 的两处 `loadDescriptorCatalog` 加 `models: loadAdminOptions(root).realtimeModels.map((o) => o.value)`，并把 `loadQwenOptions(...)` 改为 `loadAdminOptions(root)`。为了不重复加载，在文件顶部加：

```ts
const adminOptions = loadAdminOptions(root);
const adminModels = adminOptions.realtimeModels.map((option) => option.value);
```

`gateway/test/support/configAdmin.ts`：

```ts
import { loadAdminOptions } from '../../src/config-store/options.ts';
// ...
const options = loadAdminOptions(root);
const catalog = loadDescriptorCatalog(`${root}config/admin/descriptors`, {
  languages: LANGUAGES, characters: CHARACTER_IDS, models: options.realtimeModels.map((o) => o.value),
});
```

`gateway/test/config-api.test.ts` 追加：

```ts
it('shows per-model voice rows with model-scoped options', () => {
  const scene = api.scene('characters');
  const item = scene.items.find((i) => i.key === 'voice:qwen-audio-3.1-realtime-flash/xiaonuan.zh')!;
  expect(item.model).toBe('qwen-audio-3.1-realtime-flash');
  expect(item.label).toContain('Qwen-Audio 3.1');
  expect(item.options.map((option) => option.value)).toContain('longanlingxin_v3.1');
  expect(scene.items.find((i) => i.key === 'character:xiaonuan.voices.qwen.zh')).toBeUndefined();
});

it('publishes a per-model voice and the next snapshot uses it', () => {
  const key = 'voice:qwen3.8-omni-flash-realtime/xiaonuan.zh';
  api.publish({ baseVersion: 0, changes: [{ key, value: 'Ryan' }], resets: [] }, 'admin');
  const item = api.scene('characters').items.find((i) => i.key === key)!;
  expect(item.current).toBe('Ryan');
  expect(store.snapshot().realtime.voices.xiaonuan.zh).toBe('Ryan');
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/config-descriptors.test.ts test/config-api.test.ts`
Expected: FAIL，`loadAdminOptions` 不存在、`{model}` 未展开。

- [x] **Step 3: 扩展协议类型**

`protocol/src/adminApi.ts` 的 `AdminConfigItem` 加：

```ts
model: string | null;
```

- [x] **Step 4: 改 `options.ts`**

替换文件为（保留 `QwenOption` / `QwenOptions` 类型）：

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Language } from '@anyidea/protocol';
import { loadRealtimeRegistry } from '../realtime/models.ts';

const OptionSchema = z.object({ value: z.string().min(1).max(64), label: z.string().min(1).max(40) }).strict();
const OptionList = z.array(OptionSchema).min(1);
const TextOptionsSchema = z.object({ textModels: OptionList }).strict();

export interface QwenOption { value: string; label: string }
export interface QwenOptions {
  realtimeModels: QwenOption[];
  textModels: QwenOption[];
  voices: Record<string, Record<Language, QwenOption[]>>;
}

/** Realtime models and their voice catalogs come from realtime.json; only text models stay in qwen-options.json. */
export function loadAdminOptions(gatewayRoot: string): QwenOptions {
  const text = TextOptionsSchema.parse(JSON.parse(readFileSync(join(gatewayRoot, 'config/admin/qwen-options.json'), 'utf8')));
  const registry = loadRealtimeRegistry(join(gatewayRoot, 'config/realtime.json'));
  const voices: QwenOptions['voices'] = {};
  for (const id of registry.ids) {
    const model = registry.get(id);
    voices[id] = { zh: model.voices.catalog.zh, ja: model.voices.catalog.ja, en: model.voices.catalog.en };
  }
  return {
    realtimeModels: registry.ids.map((id) => ({ value: id, label: registry.get(id).label })),
    textModels: text.textModels,
    voices,
  };
}

/** ref: realtimeModels | textModels | voices.{lang} (resolved with the item's language and model). */
export function optionsFor(
  options: QwenOptions,
  ref: string,
  language: Language | null,
  model: string | null = null,
): readonly QwenOption[] {
  if (ref === 'realtimeModels') return options.realtimeModels;
  if (ref === 'textModels') return options.textModels;
  if (ref === 'voices.{lang}' && language && model) return options.voices[model]?.[language] ?? [];
  throw new Error(`descriptor_options_unknown:${ref}`);
}
```

`gateway/config/admin/qwen-options.json` 改为：

```json
{
  "textModels": [
    { "value": "qwen-plus", "label": "通义千问 Plus" },
    { "value": "qwen-flash", "label": "通义千问 Flash" }
  ]
}
```

- [x] **Step 5: 改 `descriptors.ts`**

`ConcreteItem` 加：

```ts
model: string | null;
```

`loadDescriptorCatalog` 的 opts 类型加：

```ts
models: readonly string[];
```

展开循环改为：

```ts
const languages: Array<Language | null> = item.key.includes('{lang}') ? [...opts.languages] : [null];
const characters: Array<CharacterId | null> = item.key.includes('{char}') ? [...opts.characters] : [null];
const models: Array<string | null> = item.key.includes('{model}') ? [...opts.models] : [null];
for (const model of models) {
  for (const character of characters) {
    for (const language of languages) {
      let key = item.key;
      if (model) key = key.replaceAll('{model}', model);
      if (language) key = key.replaceAll('{lang}', language);
      if (character) key = key.replaceAll('{char}', character);
      if (byKey.has(key)) throw new Error(`descriptor_key_duplicate:${key}`);
      const concrete: ConcreteItem = {
        ...item, key, descriptorKey: item.key, scene: parsed.scene, language, character, model,
      };
      byKey.set(key, concrete);
      items.push(concrete);
    }
  }
}
```

在 `SceneFileSchema` 的 `superRefine` 里加一条：

```ts
if (item.key.includes('{model}')) need(item.key.includes('{char}'), '{model} keys must be per character');
```

- [x] **Step 6: 改 `validate.ts`**

```ts
const allowed = optionsFor(ctx.options, item.options!, item.language, item.model).map((option) => option.value);
```

- [x] **Step 7: 改 `configApi.ts`**

两处 `optionsFor` 调用加 `item.model`：

```ts
options: item.options
  ? optionsFor(this.deps.options, item.options, item.language, item.model)
      .map((option) => ({ ...option, priceNote: this.priceNote(item, option.value) }))
  : [],
```

`display` 里的 select：

```ts
case 'select':
  return optionsFor(this.deps.options, item.options!, item.language, item.model)
    .find((o) => o.value === value)?.label ?? String(value);
```

`itemView` 的 `label` 用新 helper，并加 `model`：

```ts
label: this.itemLabel(item),
// ...
model: item.model,
```

加 helper：

```ts
private itemLabel(item: ConcreteItem): string {
  if (!item.model) return item.label;
  const model = this.deps.options.realtimeModels.find((option) => option.value === item.model)?.label ?? item.model;
  return `${item.label}（${model}）`;
}
```

`lineLabel` 改为：

```ts
return `${this.itemLabel(item)}${who}${language}`;
```

- [x] **Step 8: 改描述符 JSON**

`gateway/config/admin/descriptors/characters.json` 里删掉键为 `character:{char}.voices.qwen.{lang}` 的项，换成：

```json
{
  "key": "voice:{model}/{char}.{lang}",
  "label": "声音",
  "purpose": "这个角色在这个模型下说话用的声音。",
  "impact": { "characters": "each", "stage": "声音", "effective": "next_session" },
  "control": "select",
  "options": "voices.{lang}",
  "complianceNote": null,
  "risk": "medium",
  "riskNote": "换了声音，老人可能一下子认不出是谁。"
}
```

- [x] **Step 9: 改 `index.ts` 与测试支持**

`index.ts` 导入 `loadAdminOptions`，在 `ConfigAdminApi` 之前：

```ts
const adminOptions = loadAdminOptions(root);
```

构造里：

```ts
catalog: loadDescriptorCatalog(`${root}config/admin/descriptors`, {
  languages: LANGUAGES, characters: CHARACTER_IDS,
  models: adminOptions.realtimeModels.map((option) => option.value),
}),
options: adminOptions,
```

- [x] **Step 10: 跑测试与 typecheck**

Run: `npm test -w gateway -- test/config-descriptors.test.ts test/config-api.test.ts test/config-snapshot.test.ts`
Expected: PASS。

Run: `npm run typecheck -w gateway`
Expected: 无输出。

Run: `npm run typecheck -w protocol`
Expected: 无输出。

说明：admin 工作区的 typecheck 会在 T7 更新测试夹具后通过；本任务先不跑 admin。

- [x] **Step 11: 提交**

```bash
git add protocol/src/adminApi.ts gateway/src/config-store/options.ts gateway/src/config-store/descriptors.ts gateway/src/config-store/validate.ts gateway/src/admin/configApi.ts gateway/src/index.ts gateway/config/admin/descriptors/characters.json gateway/config/admin/qwen-options.json gateway/test/config-descriptors.test.ts gateway/test/config-snapshot.test.ts gateway/test/config-api.test.ts gateway/test/support/configAdmin.ts
git commit -m "feat(admin): model-scoped realtime voices in the config console"
```
