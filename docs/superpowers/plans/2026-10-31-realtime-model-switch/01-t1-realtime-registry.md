# Task 1: 实时模型注册表与价格

**Files:**
- Create: `gateway/config/realtime.json`
- Create: `gateway/src/realtime/models.ts`
- Modify: `gateway/config/pricing.json`
- Test: `gateway/test/realtime-models.test.ts`

**Interfaces:**
- Consumes: `@anyidea/protocol` 的 `CHARACTER_IDS`、`LANGUAGES`、`CharacterId`、`Language`；`gateway/src/usage/pricing.ts` 的 `loadPricingBaseline`（只在测试里用）。
- Produces:
  - `TURN_DETECTION_TYPES`、`TurnDetectionType`、`TurnDetection`
  - `SpeechRateConfig`、`VoiceOption`、`RealtimeModel`、`RealtimeRegistry`
  - `loadRealtimeRegistry(path, opts?)`
  - `voiceFor(model, characterId, language)`
  - `missingRealtimePrices(registry, pricedModels)`

背景：这是唯一真源。后面的快照、适配器、管理端都从这里读模型能力、音色目录和基线音色。3.1 的音色是**待试听候选**，不是已验证结论。

- [x] **Step 1: 写失败测试**

`gateway/test/realtime-models.test.ts`：

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { CHARACTER_IDS, LANGUAGES } from '@anyidea/protocol';
import { loadRealtimeRegistry, missingRealtimePrices, voiceFor } from '../src/realtime/models.ts';
import { loadPricingBaseline } from '../src/usage/pricing.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const path = `${root}config/realtime.json`;
const tmp = mkdtempSync(join(tmpdir(), 'realtime-models-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function broken(mutate: (doc: Record<string, any>) => void): string {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  mutate(doc);
  const file = join(tmp, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

describe('realtime registry', () => {
  it('loads both shipped models and covers every character and language', () => {
    const registry = loadRealtimeRegistry(path, { defaultModel: 'qwen3.8-omni-flash-realtime' });
    expect(registry.ids).toEqual(['qwen3.8-omni-flash-realtime', 'qwen-audio-3.1-realtime-flash']);
    for (const id of registry.ids) {
      const model = registry.get(id);
      for (const language of LANGUAGES) {
        expect(model.voices.catalog[language].length).toBeGreaterThan(0);
        for (const characterId of CHARACTER_IDS) {
          const voice = model.voices.byCharacter[characterId]![language];
          expect(voice).toBeTruthy();
          expect(model.voices.catalog[language].some((option) => option.value === voice)).toBe(true);
        }
      }
    }
    expect(registry.get('qwen3.8-omni-flash-realtime').speechRate).toBeNull();
    expect(registry.get('qwen-audio-3.1-realtime-flash').speechRate).toMatchObject({ min: 0.5, max: 2, default: 1, low: 0.8 });
    expect(voiceFor(registry.get('qwen3.8-omni-flash-realtime'), 'xiaonuan', 'zh')).toBe('longanlingxin');
  });

  it('rejects an unknown default model', () => {
    expect(() => loadRealtimeRegistry(path, { defaultModel: 'nope' })).toThrow('realtime_model_unknown:nope');
  });

  it('rejects a character voice that is not in that model language catalog', () => {
    const file = broken((doc) => { doc.models['qwen-audio-3.1-realtime-flash'].voices.byCharacter.xiaonuan.zh = 'nope'; });
    expect(() => loadRealtimeRegistry(file, { defaultModel: 'qwen-audio-3.1-realtime-flash' })).toThrow(
      'realtime_voice_invalid:qwen-audio-3.1-realtime-flash:xiaonuan:zh',
    );
  });

  it('rejects speech rate bounds that ignore the model range', () => {
    // Keep the value inside the zod range but above default, so the cross-field check is what rejects it.
    const file = broken((doc) => { doc.models['qwen-audio-3.1-realtime-flash'].speechRate.low = 1.5; });
    expect(() => loadRealtimeRegistry(file)).toThrow('realtime_speech_rate_invalid:qwen-audio-3.1-realtime-flash');
  });

  it('reports models without a realtime audio price', () => {
    const registry = loadRealtimeRegistry(path);
    expect(missingRealtimePrices(registry, new Set(['qwen3.8-omni-flash-realtime']))).toEqual([
      'qwen-audio-3.1-realtime-flash',
    ]);
  });

  it('prices every shipped model', () => {
    const priced = new Set(loadPricingBaseline(`${root}config/pricing.json`).map((entry) => entry.model));
    expect(missingRealtimePrices(loadRealtimeRegistry(path), priced)).toEqual([]);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/realtime-models.test.ts`
Expected: FAIL，报找不到 `../src/realtime/models.ts`。

- [x] **Step 3: 写 `gateway/config/realtime.json`**

```json
{
  "models": {
    "qwen3.8-omni-flash-realtime": {
      "label": "Qwen3.8 Omni Flash 实时版",
      "turnDetection": { "type": "semantic_vad", "silenceDurationMs": 800 },
      "speechRate": null,
      "voiceUpdate": "live",
      "voices": {
        "catalog": {
          "zh": [
            { "value": "longanlingxin", "label": "龙安灵心（温柔女声）" },
            { "value": "Tina", "label": "Tina（女声）" },
            { "value": "Evan", "label": "Evan（男声）" },
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
        },
        "byCharacter": {
          "xiaokai": { "zh": "Evan", "ja": "Evan", "en": "Evan" },
          "xiaonuan": { "zh": "longanlingxin", "ja": "Tina", "en": "Tina" },
          "xiaoxin": { "zh": "Tina", "ja": "Tina", "en": "Tina" }
        }
      }
    },
    "qwen-audio-3.1-realtime-flash": {
      "label": "Qwen-Audio 3.1 Flash 实时版",
      "turnDetection": { "type": "server_vad", "silenceDurationMs": 800 },
      "speechRate": { "min": 0.5, "max": 2.0, "default": 1.0, "low": 0.8 },
      "voiceUpdate": "connect_only",
      "voices": {
        "catalog": {
          "zh": [
            { "value": "longanlingxin_v3.1", "label": "龙安灵心 v3.1（温柔女声，多语种）" },
            { "value": "longanqian_v3.1", "label": "龙安千 v3.1（女声，多语种）" },
            { "value": "xunanchuan_v3.1", "label": "徐南川 v3.1（男声候选，待试听）" }
          ],
          "ja": [
            { "value": "longanlingxin_v3.1", "label": "龙安灵心 v3.1（多语种）" },
            { "value": "longanqian_v3.1", "label": "龙安千 v3.1（多语种）" },
            { "value": "xunanchuan_v3.1", "label": "徐南川 v3.1（男声候选，待试听）" }
          ],
          "en": [
            { "value": "longanlingxin_v3.1", "label": "龙安灵心 v3.1（多语种）" },
            { "value": "longanqian_v3.1", "label": "龙安千 v3.1（多语种）" },
            { "value": "xunanchuan_v3.1", "label": "徐南川 v3.1（男声候选，待试听）" }
          ]
        },
        "byCharacter": {
          "xiaokai": { "zh": "xunanchuan_v3.1", "ja": "xunanchuan_v3.1", "en": "xunanchuan_v3.1" },
          "xiaonuan": { "zh": "longanlingxin_v3.1", "ja": "longanlingxin_v3.1", "en": "longanlingxin_v3.1" },
          "xiaoxin": { "zh": "longanqian_v3.1", "ja": "longanqian_v3.1", "en": "longanqian_v3.1" }
        }
      }
    }
  }
}
```

- [x] **Step 4: 写 `gateway/src/realtime/models.ts`**

```ts
import { readFileSync } from 'node:fs';
import { CHARACTER_IDS, LANGUAGES, type CharacterId, type Language } from '@anyidea/protocol';
import { z } from 'zod';

export const TURN_DETECTION_TYPES = ['semantic_vad', 'server_vad', 'smart_turn', 'smart_turn_v2'] as const;
export type TurnDetectionType = (typeof TURN_DETECTION_TYPES)[number];

export interface TurnDetection { type: TurnDetectionType; silenceDurationMs?: number }
export interface SpeechRateConfig { min: number; max: number; default: number; low: number }
export interface VoiceOption { value: string; label: string }

export interface RealtimeModel {
  id: string;
  label: string;
  turnDetection: TurnDetection;
  speechRate: SpeechRateConfig | null;
  voiceUpdate: 'live' | 'connect_only';
  voices: {
    catalog: Record<Language, VoiceOption[]>;
    byCharacter: Record<CharacterId, Record<Language, string>>;
  };
}

export interface RealtimeRegistry {
  models: Record<string, RealtimeModel>;
  ids: string[];
  defaultModel: string;
  get(id: string): RealtimeModel;
}

/** The selected model's capability plus its fully resolved voices for one session. */
export interface RealtimeConfig {
  model: string;
  turnDetection: TurnDetection;
  speechRate: SpeechRateConfig | null;
  voiceUpdate: 'live' | 'connect_only';
  voices: Record<CharacterId, Record<Language, string>>;
}

const ModelId = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/);
const VoiceOptionSchema = z.object({ value: z.string().min(1).max(64), label: z.string().min(1).max(40) }).strict();
const CatalogSchema = z.object({
  zh: z.array(VoiceOptionSchema).min(1),
  ja: z.array(VoiceOptionSchema).min(1),
  en: z.array(VoiceOptionSchema).min(1),
}).strict();
const ByLanguageVoiceSchema = z.object({
  zh: z.string().min(1),
  ja: z.string().min(1),
  en: z.string().min(1),
}).strict();
const SpeechRateSchema = z.object({
  min: z.number().min(0.5).max(2),
  max: z.number().min(0.5).max(2),
  default: z.number().min(0.5).max(2),
  low: z.number().min(0.5).max(2),
}).strict();
const TurnDetectionSchema = z.object({
  type: z.enum(TURN_DETECTION_TYPES),
  silenceDurationMs: z.number().int().positive().optional(),
}).strict();
const ModelSchema = z.object({
  label: z.string().min(1).max(40),
  turnDetection: TurnDetectionSchema,
  speechRate: SpeechRateSchema.nullable(),
  voiceUpdate: z.enum(['live', 'connect_only']),
  voices: z.object({
    catalog: CatalogSchema,
    byCharacter: z.record(z.enum(CHARACTER_IDS), ByLanguageVoiceSchema),
  }).strict(),
}).strict();
const RegistrySchema = z.object({ models: z.record(ModelId, ModelSchema) }).strict();

type ParsedModel = z.infer<typeof ModelSchema>;

/** Loads and cross-checks the realtime registry. Throws on the first invalid model. */
export function loadRealtimeRegistry(path: string, opts: { defaultModel?: string } = {}): RealtimeRegistry {
  const parsed = RegistrySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const models: Record<string, RealtimeModel> = {};
  for (const [id, model] of Object.entries(parsed.models)) {
    validateModel(id, model);
    models[id] = { ...model, id };
  }
  const ids = Object.keys(models);
  if (ids.length === 0) throw new Error('realtime_models_empty');
  if (opts.defaultModel !== undefined && !models[opts.defaultModel]) {
    throw new Error(`realtime_model_unknown:${opts.defaultModel}`);
  }
  return {
    models,
    ids,
    defaultModel: opts.defaultModel ?? ids[0]!,
    get(id) {
      const model = models[id];
      if (!model) throw new Error(`realtime_model_unknown:${id}`);
      return model;
    },
  };
}

function validateModel(id: string, model: ParsedModel): void {
  if (model.speechRate) {
    const r = model.speechRate;
    if (!(r.min <= r.low && r.low <= r.default && r.default <= r.max)) {
      throw new Error(`realtime_speech_rate_invalid:${id}`);
    }
  }
  for (const language of LANGUAGES) {
    const values = model.voices.catalog[language].map((option) => option.value);
    if (new Set(values).size !== values.length) throw new Error(`realtime_catalog_duplicate:${id}:${language}`);
    for (const characterId of CHARACTER_IDS) {
      const voice = model.voices.byCharacter[characterId]?.[language];
      if (!voice) throw new Error(`realtime_voice_missing:${id}:${characterId}:${language}`);
      if (!values.includes(voice)) throw new Error(`realtime_voice_invalid:${id}:${characterId}:${language}`);
    }
  }
}

export function voiceFor(model: RealtimeModel, characterId: CharacterId, language: Language): string {
  const voice = model.voices.byCharacter[characterId]?.[language];
  if (!voice) throw new Error(`realtime_voice_missing:${model.id}:${characterId}:${language}`);
  return voice;
}

/** Model ids that have no price entry; the startup check refuses to serve an unpriced realtime model. */
export function missingRealtimePrices(registry: RealtimeRegistry, pricedModels: ReadonlySet<string>): string[] {
  return registry.ids.filter((id) => !pricedModels.has(id));
}
```

- [x] **Step 5: 跑测试确认通过**

Run: `npm test -w gateway -- test/realtime-models.test.ts`
Expected: PASS。此时价格测试仍失败；继续下一步。

- [x] **Step 6: 加价格条目**

在 `gateway/config/pricing.json` 数组末尾加：

```json
{
  "model": "qwen-audio-3.1-realtime-flash",
  "effectiveFrom": 1767196800000,
  "inputText": 1500000,
  "inputAudio": 6000000,
  "outputText": 4500000,
  "outputAudio": 12000000,
  "cached": null,
  "source": "https://help.aliyun.com/zh/model-studio/qwen-audio-3-1-realtime-flash",
  "checkedAt": "2026-10-31"
}
```

- [x] **Step 7: 跑测试确认全部通过**

Run: `npm test -w gateway -- test/realtime-models.test.ts`
Expected: PASS。

Run: `npm run typecheck -w gateway`
Expected: 无输出。

- [x] **Step 8: 提交**

```bash
git add gateway/config/realtime.json gateway/src/realtime/models.ts gateway/config/pricing.json gateway/test/realtime-models.test.ts
git commit -m "feat(gateway): add the realtime model registry and pricing"
```
