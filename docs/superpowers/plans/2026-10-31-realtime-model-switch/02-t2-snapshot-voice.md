# Task 2: 快照、音色优先级与 `voice:` 覆盖层

**Files:**
- Modify: `gateway/src/config-store/keys.ts`
- Modify: `gateway/src/config-store/materialize.ts`
- Modify: `gateway/src/session/configSnapshot.ts`
- Modify: `gateway/src/session/session.ts`（只加 `SessionDeps.realtime` 可选字段）
- Modify: `gateway/src/session/snapshotDeps.ts`
- Modify: `gateway/src/index.ts`
- Modify: `gateway/test/config-snapshot.test.ts`、`gateway/test/snapshot-deps.test.ts`、`gateway/test/journey-runner.test.ts`、`gateway/test/intent-copy.test.ts`、`gateway/test/proactivity-config.test.ts`、`gateway/test/support/configAdmin.ts`（补 `voiceDefaults`）
- Test: `gateway/test/realtime-snapshot.test.ts`

**Interfaces:**
- Consumes: T1 的 `RealtimeRegistry`、`RealtimeModel`、`loadRealtimeRegistry`、`voiceFor`。
- Produces:
  - `OverlayTarget` 新成员 `{ kind: 'voice'; model: string; character: CharacterId; language: Language }`
  - `SnapshotInput.voiceDefaults: Record<Language, string>`
  - `ConfigSnapshot.realtime: RealtimeConfig`
  - `SessionDeps.realtime?: RealtimeConfig`
  - `SnapshotSessionKey` 包含 `'realtime'`

背景：覆盖层 `voice:` 必须在快照之前实现，否则快照测试无法验证新音色。T6 只做管理端描述符/选项/校验，不再改这里的解析和物化。

- [x] **Step 1: 写失败测试**

`gateway/test/realtime-snapshot.test.ts`：

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { ConfigInvalidError } from '../src/config-store/errors.ts';
import { parseOverlayKey, readTargetValue, type ModelDefaults, type Overlay } from '../src/config-store/keys.ts';
import { buildConfigSnapshot } from '../src/session/configSnapshot.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = loadConfig({ APP_SECRET: 'test-secret-0123456789' });
const models: ModelDefaults = {
  realtimeEndpoint: 'wss://example.invalid/realtime',
  realtimeModel: 'qwen3.8-omni-flash-realtime',
  textEndpoint: 'https://example.invalid/chat',
  summarizerModel: 'qwen-flash',
};
const voiceDefaults = { zh: 'env-zh', ja: 'env-ja', en: 'env-en' };
const tmpRoot = mkdtempSync(join(tmpdir(), 'realtime-snapshot-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function build(overlay: Overlay) {
  return buildConfigSnapshot({
    gatewayRoot: root, overlay, version: 1, ledger: env.ledger,
    sessionStartTimeoutMs: env.sessionStartTimeoutMs, models, voiceDefaults, tmpRoot,
  });
}

describe('realtime snapshot', () => {
  it('defaults to 3.8 with its turn detection, live voice updates and baseline voices', () => {
    const snap = build({});
    expect(snap.realtime.model).toBe('qwen3.8-omni-flash-realtime');
    expect(snap.realtime.turnDetection).toEqual({ type: 'semantic_vad', silenceDurationMs: 800 });
    expect(snap.realtime.speechRate).toBeNull();
    expect(snap.realtime.voiceUpdate).toBe('live');
    expect(snap.realtime.voices.xiaonuan.zh).toBe('longanlingxin');
    expect(snap.realtime.voices.xiaokai.zh).toBe('Evan');
  });

  it('switches model in the snapshot and uses that model capability and voices', () => {
    const snap = build({ 'model:qwen.realtimeModel': 'qwen-audio-3.1-realtime-flash' });
    expect(snap.realtime.model).toBe('qwen-audio-3.1-realtime-flash');
    expect(snap.realtime.turnDetection).toEqual({ type: 'server_vad', silenceDurationMs: 800 });
    expect(snap.realtime.speechRate).toMatchObject({ low: 0.8, default: 1 });
    expect(snap.realtime.voiceUpdate).toBe('connect_only');
    expect(snap.realtime.voices.xiaonuan.zh).toBe('longanlingxin_v3.1');
  });

  it('applies a per-model voice overlay', () => {
    const snap = build({
      'model:qwen.realtimeModel': 'qwen-audio-3.1-realtime-flash',
      'voice:qwen-audio-3.1-realtime-flash/xiaonuan.zh': 'longanqian_v3.1',
    });
    expect(snap.realtime.voices.xiaonuan.zh).toBe('longanqian_v3.1');
  });

  it('keeps an old character voice overlay on the env default model, but the new overlay wins', () => {
    const old = build({ 'character:xiaonuan.voices.qwen.zh': 'Ryan' });
    expect(old.realtime.voices.xiaonuan.zh).toBe('Ryan');
    const both = build({
      'character:xiaonuan.voices.qwen.zh': 'Ryan',
      'voice:qwen3.8-omni-flash-realtime/xiaonuan.zh': 'Evan',
    });
    expect(both.realtime.voices.xiaonuan.zh).toBe('Evan');
  });

  it('ignores the old character voice overlay on a non-default model', () => {
    const snap = build({
      'model:qwen.realtimeModel': 'qwen-audio-3.1-realtime-flash',
      'character:xiaonuan.voices.qwen.zh': 'Ryan',
    });
    expect(snap.realtime.voices.xiaonuan.zh).toBe('longanlingxin_v3.1');
  });

  it('rejects an unknown model with a Chinese startup message', () => {
    expect(() => build({ 'model:qwen.realtimeModel': 'nope' })).toThrow(ConfigInvalidError);
    try {
      build({ 'model:qwen.realtimeModel': 'nope' });
    } catch (error) {
      expect((error as ConfigInvalidError).issues[0]?.message).toContain('通话模型不存在');
    }
  });

  it('parses and reads the per-model voice target', () => {
    const target = parseOverlayKey('voice:qwen-audio-3.1-realtime-flash/xiaonuan.zh');
    expect(target).toEqual({
      kind: 'voice', model: 'qwen-audio-3.1-realtime-flash', character: 'xiaonuan', language: 'zh',
    });
    expect(readTargetValue(root, target, models)).toBe('longanlingxin_v3.1');
  });

  it('rejects a bad character or language in the voice key', () => {
    expect(() => parseOverlayKey('voice:qwen-audio-3.1-realtime-flash/nope.zh')).toThrow('overlay_key_invalid');
    expect(() => parseOverlayKey('voice:qwen-audio-3.1-realtime-flash/xiaonuan.fr')).toThrow('overlay_key_invalid');
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/realtime-snapshot.test.ts`
Expected: FAIL，报 `voice:` 键无法解析或 `snap.realtime` 不存在。

- [x] **Step 3: 在 `keys.ts` 加 `voice` 目标**

在 `OverlayTarget` 联合类型加：

```ts
export type OverlayTarget =
  | { kind: 'json'; file: string; path: readonly string[] }
  | { kind: 'text'; file: string }
  | { kind: 'characterEnabled'; characterId: CharacterId }
  | { kind: 'model'; field: ModelField }
  | { kind: 'voice'; model: string; character: CharacterId; language: Language };
```

在 `parseOverlayKey` 的 `switch` 里加：

```ts
case 'voice': {
  const match = /^([A-Za-z0-9][A-Za-z0-9.-]*)\/([a-z]+)\.(zh|ja|en)$/.exec(rest);
  if (!match) return fail();
  const [, model, character, language] = match;
  if (!(CHARACTER_IDS as readonly string[]).includes(character!)) return fail();
  return { kind: 'voice', model: model!, character: character as CharacterId, language: language as Language };
}
```

在 `readTargetValue` 的 `switch` 里加：

```ts
case 'voice': {
  const file = join(root, 'config/realtime.json');
  const doc = JSON.parse(readFileSync(file, 'utf8')) as {
    models?: Record<string, { voices?: { byCharacter?: Record<string, Record<string, unknown>> } }>;
  };
  const value = doc.models?.[target.model]?.voices?.byCharacter?.[target.character]?.[target.language];
  if (!isOverlayValue(value)) {
    throw new Error(`overlay_target_missing:voice:${target.model}/${target.character}.${target.language}`);
  }
  return value;
}
```

- [x] **Step 4: 在 `materialize.ts` 加 `voice` 物化**

在 `materializeConfigTree` 里，`edits` 声明后加：

```ts
const voiceEdits: Array<{ key: string; model: string; character: CharacterId; language: Language; value: string }> = [];
```

在遍历 `overlay` 的分支里加：

```ts
} else if (target.kind === 'voice') {
  if (typeof value !== 'string') throw new Error(`overlay_value_invalid:${key}`);
  voiceEdits.push({ key, ...target, value });
}
```

在写 JSON edits 的循环之后、`return` 之前加：

```ts
if (voiceEdits.length > 0) {
  const file = join(root, 'config/realtime.json');
  const doc = JSON.parse(readFileSync(file, 'utf8')) as {
    models?: Record<string, { voices?: { byCharacter?: Record<string, Record<string, unknown>> } }>;
  };
  for (const edit of voiceEdits) {
    const node = doc.models?.[edit.model]?.voices?.byCharacter?.[edit.character];
    if (!node || !Object.hasOwn(node, edit.language)) throw new Error(`overlay_target_missing:${edit.key}`);
    node[edit.language] = edit.value;
  }
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}
```

`materialize.ts` 需要在顶部导入 `Language` 类型（`import type { CharacterId, Language } from '@anyidea/protocol';`）。

- [x] **Step 5: 在 `configSnapshot.ts` 加载注册表并解析音色**

顶部加：

```ts
import { loadRealtimeRegistry, type RealtimeConfig, type RealtimeModel } from '../realtime/models.ts';
```

`ConfigSnapshot` 加：

```ts
realtime: RealtimeConfig;
```

`SnapshotInput` 加：

```ts
voiceDefaults: Record<Language, string>;
```

在 `buildConfigSnapshot` 里、`return` 之前构造：

```ts
const registry = loadRealtimeRegistry(`${root}/config/realtime.json`, { defaultModel: input.models.realtimeModel });
const activeId = virtual.models.realtimeModel;
const active = registry.get(activeId);
const realtime: RealtimeConfig = {
  model: activeId,
  turnDetection: active.turnDetection,
  speechRate: active.speechRate,
  voiceUpdate: active.voiceUpdate,
  voices: resolveVoices(active, input, characters, registry.defaultModel),
};
```

`return` 的对象加 `realtime,`。

在文件底部加：

```ts
/** New voice overlay wins; the old character-card overlay stays effective only on the env default model. */
function resolveVoices(
  model: RealtimeModel,
  input: SnapshotInput,
  characters: CharacterRegistry,
  defaultModel: string,
): Record<CharacterId, Record<Language, string>> {
  const out = {} as Record<CharacterId, Record<Language, string>>;
  for (const characterId of CHARACTER_IDS) {
    out[characterId] = {} as Record<Language, string>;
    for (const language of LANGUAGES) {
      const newKey = `voice:${model.id}/${characterId}.${language}`;
      const oldKey = `character:${characterId}.voices.qwen.${language}`;
      const cardVoice = characters.voiceFor(characterId, 'qwen', language);
      const baseline = model.voices.byCharacter[characterId]?.[language];
      const useOld = !Object.hasOwn(input.overlay, newKey)
        && model.id === defaultModel
        && Object.hasOwn(input.overlay, oldKey)
        && cardVoice !== undefined;
      out[characterId][language] = useOld
        ? cardVoice!
        : baseline ?? cardVoice ?? input.voiceDefaults[language];
    }
  }
  return out;
}
```

在 `CODE_MESSAGES` 加：

```ts
[/^realtime_model_unknown/, '后台选择的通话模型不存在，请重新选择。'],
[/^realtime_voice_invalid/, '角色音色不属于当前模型的音色列表。'],
[/^realtime_voice_missing/, '当前模型缺少某个角色的音色配置。'],
[/^realtime_speech_rate_invalid/, '语速配置超出允许范围。'],
```

- [x] **Step 6: 在 `session.ts` 和 `snapshotDeps.ts` 加字段**

`session.ts` 顶部加 `import type { RealtimeConfig } from '../realtime/models.ts';`，`SessionDeps` 加：

```ts
/** Current model capability and resolved voices; undefined in bare unit tests. */
realtime?: RealtimeConfig;
```

`snapshotDeps.ts` 的 `SnapshotSessionKey` 加 `'realtime'`，`sessionDepsFromSnapshot` 返回对象加：

```ts
realtime: snapshot.realtime,
```

- [x] **Step 7: 在 `index.ts` 接线**

`buildSnapshot` 的 `buildConfigSnapshot` 参数加：

```ts
voiceDefaults: config.qwenVoices,
```

`voiceFor` 改为：

```ts
voiceFor: (snapshot, characterId, language) => config.adapter === 'qwen'
  ? snapshot.realtime.voices[characterId]?.[language]
  : undefined,
```

在 `pricingBaseline` / `prices` 之后加启动价格检查（放在 `const prices = ...` 之后）：

```ts
const realtimeRegistry = loadRealtimeRegistry(`${root}config/realtime.json`, { defaultModel: config.qwenModel });
const audioPriced = new Set(
  [...pricingBaseline, ...(prices?.list() ?? [])]
    .filter((entry) => entry.inputAudio !== null && entry.outputAudio !== null)
    .map((entry) => entry.model),
);
const missingPrices = missingRealtimePrices(realtimeRegistry, audioPriced);
if (missingPrices.length > 0) throw new Error(`realtime_price_missing:${missingPrices.join(',')}`);
```

`index.ts` 顶部导入 `loadRealtimeRegistry, missingRealtimePrices`。

- [x] **Step 8: 更新所有 `buildConfigSnapshot` 调用**

给以下文件的调用补 `voiceDefaults`（测试用 `{ zh: 'longanlingxin', ja: 'Tina', en: 'Tina' }`，`configAdmin.ts` 用 `env.qwenVoices`）：

- `gateway/test/config-snapshot.test.ts`
- `gateway/test/snapshot-deps.test.ts`
- `gateway/test/journey-runner.test.ts`
- `gateway/test/intent-copy.test.ts`
- `gateway/test/proactivity-config.test.ts`
- `gateway/test/support/configAdmin.ts`

Run: `npm run typecheck -w gateway`
Expected: 报出所有漏掉 `voiceDefaults` 的调用；逐个补。

- [x] **Step 9: 跑测试确认通过**

Run: `npm test -w gateway -- test/realtime-snapshot.test.ts`
Expected: PASS。

Run: `npm test -w gateway -- test/config-snapshot.test.ts test/snapshot-deps.test.ts`
Expected: PASS。

Run: `npm run typecheck -w gateway`
Expected: 无输出。

- [x] **Step 10: 提交**

```bash
git add gateway/src/config-store/keys.ts gateway/src/config-store/materialize.ts gateway/src/session/configSnapshot.ts gateway/src/session/session.ts gateway/src/session/snapshotDeps.ts gateway/src/index.ts gateway/test/realtime-snapshot.test.ts gateway/test/config-snapshot.test.ts gateway/test/snapshot-deps.test.ts gateway/test/journey-runner.test.ts gateway/test/intent-copy.test.ts gateway/test/proactivity-config.test.ts gateway/test/support/configAdmin.ts
git commit -m "feat(gateway): resolve the active realtime model and per-model voices"
```
