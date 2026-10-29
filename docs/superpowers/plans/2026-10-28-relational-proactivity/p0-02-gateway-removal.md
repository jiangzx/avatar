# P0-T2：删除网关里的 Seeduplex

**Spec：** 「现状事实 › Seeduplex 的分布」、Q8、「实施分期」P0。

删除 Seeduplex 的实现、配置、角色卡音色和专属测试。**保留**：`RealtimeAdapter` 接口与三个能力标记（`supportsPlaybackTruncate`、`verbatimFallback`、`supportsUserText`）、`session.ts` 中按标记分支的两处（`!supportsUserText` 拒绝调试文本、`verbatimFallback` 记住告知句照读方式）、`ProactiveRequest.fallbackText`。这些留给以后的 `CascadeAdapter`，由 `pin-session.test.ts` 里 `boot({ verbatim: true })` 的假适配器继续覆盖。

**Files:**
- Delete: `gateway/src/adapters/seeduplex.ts`
- Delete: `gateway/test/seeduplex.test.ts`、`gateway/test/seeduplex.integration.test.ts`
- Delete: `gateway/scripts/probe-seeduplex-languages.ts`、`gateway/scripts/probe-seeduplex-timing.ts`、`gateway/scripts/probe-seeduplex-wave.ts`、`gateway/scripts/probe-emotion-p3-seeduplex-style.ts`、`gateway/scripts/probe-emotion-p4-session-update.ts`
- Modify: `gateway/src/config.ts`、`gateway/src/index.ts`、`gateway/src/characters/card.ts`、`gateway/src/characters/registry.ts`
- Modify: `gateway/characters/xiaokai.json`、`xiaonuan.json`、`xiaoxin.json`；`gateway/test/fixtures/characters/xiaokai.json`、`xiaonuan.json`、`xiaoxin.json`
- Modify（注释）：`gateway/src/adapters/types.ts`、`gateway/src/session/pushGate.ts`、`gateway/src/session/tools/recall.ts`、`gateway/src/session/session.ts:101`
- Modify（测试）：`gateway/test/config.test.ts`、`gateway/test/characters.test.ts`、`gateway/test/snapshot-deps.test.ts`、`gateway/test/secrets.test.ts`、`gateway/test/director-silence.test.ts`、`gateway/test/pin-session.test.ts`
- Modify：`gateway/.env.example`；`docs/testing/plan3-mock-smoke.mjs`、`docs/testing/2026-10-27-observability-smoke.mjs`、`docs/testing/2026-10-27-config-isolation-smoke.mjs`（删掉置空的 `SEEDUPLEX_API_KEY`）

**Interfaces:**
- Consumes: P0-T1（`push-seam.test.ts` 已不 import Seeduplex）。
- Produces:
  - `GatewayConfig.adapter: 'mock' | 'qwen'`；`GatewayConfig` 不再有任何 `seeduplex*` 字段。
  - `CharacterCard.voices: { qwen: { zh, ja, en } }`（strict，只有 `qwen`）。
  - `type VoiceAdapter = 'qwen'`；`CharacterRegistry.voiceFor(id, adapter, language)` 签名不变。

- [ ] **Step 1：先改测试，表达新行为**

`gateway/test/config.test.ts`：
- 第 22–24 行的用例改名并保持断言（`seeduplex` 现在是未知适配器）：

```ts
  it('rejects the removed Seeduplex adapter', () => {
    expect(() => loadConfig({ APP_SECRET: 'x'.repeat(16), ADAPTER: 'seeduplex' })).toThrow('Unsupported ADAPTER "seeduplex"');
  });
```

- 第 28 行 `toEqual` 的期望对象删掉 `seeduplexEndpoint`、`seeduplexModel`、`seeduplexVoice`、`seeduplexVoices` 四个键，其余不变。
- 第 40–53 行的音色用例删掉 `SEEDUPLEX_VOICE`、`SEEDUPLEX_VOICE_EN` 两个输入和 `seeduplexVoices`、`seeduplexVoice` 两条断言。
- 删除第 55–61 行整个 `requires a key only when Seeduplex is explicitly selected` 用例。
- 删除第 95 行 `SEEDUPLEX_ENDPOINT` 那条断言。

`gateway/test/characters.test.ts`：把第 65–70 行六条 `seeduplex` 断言替换为：

```ts
    // The card keeps one voice table per adapter; only Qwen is left.
    expect(r.voiceFor('xiaokai', 'qwen', 'zh')).toBe('Evan');
  });

  it('rejects a card that still carries a Seeduplex voice table', () => {
    const dir = copyCards();
    patchCard(dir, 'xiaokai', (card) => { card.voices.seeduplex = { zh: null, en: null }; });
    expect(() => loadCharacterRegistry(dir, LANGUAGES)).toThrow('character_card_invalid:xiaokai.json:voices');
```

（第 71 行原有的 `});` 现在收尾新用例。`copyCards` / `patchCard` 是该文件已有的 helper，`patchCard` 的回调参数类型是 `Record<string, any>`，可以直接写 `card.voices.seeduplex`。）

`gateway/test/snapshot-deps.test.ts` 第 147–155 行改为：

```ts
  it('keeps the mock model and leaves usageSource unset when none is passed', () => {
    const s = snap();
    const mock = sessionDepsFromSnapshot(s, ctx, 'sid-test', factories(), {
      usageSource: { adapter: 'mock', model: 'mock' },
    });
    expect(mock.usageSource).toEqual({ adapter: 'mock', model: 'mock' });
    const unbilled = sessionDepsFromSnapshot(s, ctx, 'sid-test', factories(), {});
    expect(unbilled.usageSource).toBeUndefined();
  });
```

`gateway/test/secrets.test.ts` 第 113 行改为：

```ts
    expect(isSecretName('OTHER_API_KEY')).toBe(false);
```

`gateway/test/director-silence.test.ts` 第 180 行注释改为：

```ts
    // Qwen renders `instruction`; a verbatim (direct-TTS) adapter would speak `fallbackText`. Both get the planned check-in.
```

`gateway/test/pin-session.test.ts`：第 29 行注释改为 `/** The test drives model events itself, in Qwen or direct-TTS order. */`；第 220 行用例名改为 `'sends the same grounded request to a direct-TTS adapter'`；第 229 行注释改为 `// A verbatim adapter speaks fallbackText; Qwen follows the verbatim instruction. Never toolContinueText.`。

- [ ] **Step 2：运行改过的测试，确认按预期失败**

Run: `npm test -w gateway -- test/config.test.ts test/characters.test.ts`
Expected: FAIL——`rejects the removed Seeduplex adapter`（当前仍接受 `seeduplex`）、`parses defaults` 的 `toEqual`（多出 seeduplex 键）、`rejects a card that still carries a Seeduplex voice table`（当前 schema 允许）。

- [ ] **Step 3：删除实现与专属文件**

```bash
git rm gateway/src/adapters/seeduplex.ts gateway/test/seeduplex.test.ts gateway/test/seeduplex.integration.test.ts \
  gateway/scripts/probe-seeduplex-languages.ts gateway/scripts/probe-seeduplex-timing.ts gateway/scripts/probe-seeduplex-wave.ts \
  gateway/scripts/probe-emotion-p3-seeduplex-style.ts gateway/scripts/probe-emotion-p4-session-update.ts
```

- [ ] **Step 4：改 `gateway/src/config.ts`**

接口里删掉 `seeduplexApiKey?`、`seeduplexEndpoint`、`seeduplexModel`、`seeduplexVoice`、`seeduplexVoices` 五个字段，`adapter` 改为：

```ts
  adapter: 'mock' | 'qwen';
```

`loadConfig` 中：

```ts
  const adapter = env.ADAPTER ?? 'mock';
  if (adapter !== 'mock' && adapter !== 'qwen') throw new Error(`Unsupported ADAPTER \"${adapter}\"`);
```

并删除这些行：`const seeduplexApiKey = ...`、`if (adapter === 'seeduplex' && !seeduplexApiKey) ...`、`const seeduplexEndpoint = ...`、`if (adapter === 'seeduplex') requireProtocol('SEEDUPLEX_ENDPOINT', ...)`、`const seeduplexVoice = ...` 与 `const seeduplexVoices = {...}` 两段，以及返回对象中的 `...(seeduplexApiKey ? { seeduplexApiKey } : {})`、`seeduplexEndpoint`、`seeduplexModel: ...`、`seeduplexVoice: ...`、`seeduplexVoices` 五行。

- [ ] **Step 5：改 `gateway/src/index.ts`**

删除 `import { SeeduplexAdapter } from './adapters/seeduplex.ts';`。

`usageSource` 一段改为（Mock 与 Qwen 都计）：

```ts
const usageSource = config.adapter === 'qwen'
  ? { adapter: 'qwen' as const, model: config.qwenModel }
  : { adapter: 'mock' as const, model: 'mock' };
```

并删掉其上方 `// Seeduplex is not counted (spec Q9/Q14).` 注释。原来 `...(usage && usageSource ? { usage, usageSource } : {})` 保持不变（`usageSource` 现在恒非空，表达式仍然成立）。

`makeSessionFactory` 的 `adapter` 工厂改为：

```ts
    adapter: ({ snapshot, characterId, apiKey }) => config.adapter === 'qwen'
      ? new QwenAdapter({ apiKey: apiKey!, endpoint: snapshot.model.realtimeEndpoint, model: snapshot.model.realtimeModel, voice: config.qwenVoice })
      : new MockAdapter({ script: withCharacterName(script, snapshot.characters.name(characterId, 'zh')), speech, speechThreshold: config.mockSpeechThreshold, paceFactor: config.mockPaceFactor, emitUsage: usage !== null }),
```

`voiceFor` 改为：

```ts
    // Character card voice for the active adapter, then the env default.
    voiceFor: (snapshot, characterId, language) => config.adapter === 'qwen'
      ? snapshot.characters.voiceFor(characterId, 'qwen', language) ?? config.qwenVoices[language]
      : undefined,
```

- [ ] **Step 6：改角色卡 schema 与注册表**

`gateway/src/characters/card.ts` 的 `voices` 改为：

```ts
  voices: z.object({
    qwen: z.object({ zh: Voice, ja: Voice, en: Voice }).strict(),
  }).strict(),
```

`gateway/src/characters/registry.ts`：

```ts
export type VoiceAdapter = 'qwen';
```

`CardRegistry.voiceFor` 改为：

```ts
  voiceFor(id: CharacterId, _adapter: VoiceAdapter, language: Language): string | undefined {
    return this.card(id).voices.qwen[language] ?? undefined;
  }
```

六个 JSON（`gateway/characters/*.json` 三个、`gateway/test/fixtures/characters/*.json` 三个）删掉 `"seeduplex": {...}` 这一项，并去掉 `qwen` 那一项末尾随之多余的逗号。例如 `gateway/characters/xiaokai.json`：

```json
  "voices": {
    "qwen": { "zh": "Evan", "ja": "Evan", "en": "Evan" }
  },
```

fixture 里是单行：`"voices": { "qwen": { "zh": null, "ja": null, "en": null } },`。

- [ ] **Step 7：改注释与示例环境文件**

- `gateway/src/adapters/types.ts`：`updateSession?` 上方注释改为 `/** One combined session change. Qwen sends a single partial session.update. */`。
- `gateway/src/session/pushGate.ts` 第 17–19 行注释改为：

```ts
/**
 * Holds session changes until a safe seam (blockers #48: a session.update during a reply can
 * silence the next turn). Merges requests, sends at most one per user turn and per interval.
 */
```

- `gateway/src/session/tools/recall.ts` 第 184 行改为 `/** Speak the grounded line, never a canned continuation (pitfall #6). */`。
- `gateway/src/session/session.ts` 第 101 行改为 `/** Adapter and model billed for realtime replies. Unset in eval and most tests. */`。
- `gateway/.env.example`：删除第 5–11 行（`# Set ADAPTER=seeduplex ...` 与六行 `# SEEDUPLEX_*`）。
- 三个 `docs/testing/*.mjs` 冒烟脚本：删掉各自的 `SEEDUPLEX_API_KEY: '',`（`2026-10-27-observability-smoke.mjs` 第 39 行是行内对象，只删这一个键）。

- [ ] **Step 8：运行改过的测试**

Run: `npm test -w gateway -- test/config.test.ts test/characters.test.ts test/snapshot-deps.test.ts test/secrets.test.ts test/director-silence.test.ts test/pin-session.test.ts test/push-seam.test.ts`
Expected: PASS。

- [ ] **Step 9：全量测试、typecheck 与残留检查**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部通过；测试文件数比改前少 2（两个 seeduplex 测试文件）。

Run: `grep -rni seeduplex gateway --exclude-dir=node_modules`
Expected: 只剩两处负向断言——`gateway/test/config.test.ts`（`rejects the removed Seeduplex adapter`）与 `gateway/test/characters.test.ts`（`rejects a card that still carries a Seeduplex voice table`），以及 `gateway/test/config-descriptors.test.ts` 中非法覆盖键 `'model:seeduplex.realtimeModel'`（仍然非法，保留）。有其他输出就继续清理。

- [ ] **Step 10：提交**

```bash
git add gateway/src/config.ts gateway/src/index.ts gateway/src/characters/card.ts gateway/src/characters/registry.ts \
  gateway/src/adapters/types.ts gateway/src/session/pushGate.ts gateway/src/session/tools/recall.ts gateway/src/session/session.ts \
  gateway/characters/xiaokai.json gateway/characters/xiaonuan.json gateway/characters/xiaoxin.json \
  gateway/test/fixtures/characters/xiaokai.json gateway/test/fixtures/characters/xiaonuan.json gateway/test/fixtures/characters/xiaoxin.json \
  gateway/test/config.test.ts gateway/test/characters.test.ts gateway/test/snapshot-deps.test.ts gateway/test/secrets.test.ts \
  gateway/test/director-silence.test.ts gateway/test/pin-session.test.ts gateway/.env.example \
  docs/testing/plan3-mock-smoke.mjs docs/testing/2026-10-27-observability-smoke.mjs docs/testing/2026-10-27-config-isolation-smoke.mjs
git commit -m "refactor(gateway): remove the Seeduplex adapter, keep the capability flags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（Step 3 的 `git rm` 已经暂存了删除。）
