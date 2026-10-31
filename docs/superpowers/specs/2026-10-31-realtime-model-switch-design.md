# 实时模型切换与每模型音色设计

日期：2026-10-31
状态：已与用户确认设计方向；实现计划见 `docs/superpowers/plans/2026-10-31-realtime-model-switch/00-overview.md`。
关联：路线 A（真人形象无表情的语音/文案补偿）；`docs/project/roadmap.md`。

## 1. 背景

真人形象（Duix）的画面是固定源视频帧，只有嘴部由音频驱动，无法根据用户情绪改变表情（`docs/superpowers/specs/2026-10-25-duix-avatar-engine-design.md` D6）。路线 A 接受这个限制，用声音和文案补偿。

当前实时模型 `qwen3.8-omni-flash-realtime` 上，`instructions` 不能可靠控制语音语气：

| 探针 | 结果 |
|---|---|
| session 级 instructions（“轻柔、放慢、音量低一点”） | 3.8：A/B 完全相同（3887 ms / RMS 2500）；3.1：A/B 完全相同（3520 ms / RMS 2678） |
| per-response instructions | 3.8：B 短 3.1%、响 5.1%；3.1：B 短 1.5%、响 1.9%；两者都没有变慢/变轻 |
| `speech_rate` | 3.8：1.0 与 0.8 都是 3860 ms，被忽略；3.1：1.0 → 3520 ms，0.8 → 4250 ms（+20.7%），0.6 → 5734 ms（+62.9%），RMS/峰值基本不变 |
| 中途 `session.update{speech_rate:0.8}` | 3.1：下一轮 4400 ms；对照 3440/3520 ms，比值 1.20–1.25，生效 |
| 3.1 接入 | `semantic_vad` 被拒（`invalid_value`）；`server_vad`、`smart_turn`、`smart_turn_v2` 可用；工具可注册 |
| 3.1 文档 | `speech_rate` 0.5–2.0，默认 1.0；`enable_speech_emotion` 默认 true；voice 只能在第一次 `session.update` 设置，后续忽略 |

结论：路线 A 的语音补偿只剩 `speech_rate` 一个可靠抓手，而它只在 `qwen-audio-3.1-realtime-flash` 等 3.x audio 模型上生效。因此需要：

1. 后台可在 `qwen3.8-omni-flash-realtime` 与 `qwen-audio-3.1-realtime-flash` 之间切换；
2. 每个模型有一套角色音色；
3. 低情绪时使用 `speech_rate` 放慢语速（仅支持的模型）。

## 2. 目标与非目标

**目标**

- 管理员在后台切换实时模型，下一通会话生效；正在进行的通话不受影响。
- 每个模型独立配置每个角色、每种语言的音色；切模型自动使用该模型的音色。
- 支持 `speech_rate` 的模型在低情绪时把语速降到配置值（初值 0.8），其余时候回到 1.0；在安全缝隙推送，不打断当前播放。
- `qwen-audio-3.1-realtime-flash` 已是默认模型（2026-10-31 用户确认）；`qwen3.8-omni-flash-realtime` 保留为可切回的回退。
- 不改变会话协议和 App 正常会话行为；管理端配置协议只增加一个可选字段。

**非目标**

- 不做 LivePortrait / EchoMimic / Sonic 等端侧表情模型（路线 A 完成后的独立调研）。
- 不做语音音高/音色情绪控制；`speech_rate` 只改语速。
- 不做运行时新增模型（新增模型仍需改配置并重启）；后台只做已有模型之间的切换。
- 不做声音复刻、灰度、A/B、自动降级到另一个模型。
- 默认模型已由用户决定切到 3.1；仍不做自动降级、灰度或 A/B。

## 3. 已确认决策

| # | 决策 |
|---|---|
| D1 | 两个实时模型都可在后台切换；复用现有 `model:qwen.realtimeModel` 覆盖层，下一通会话生效。 |
| D2 | 每个模型一套音色；新增 `voice:<model>/<character>.<lang>` 覆盖层，每个模型、每个角色、每种语言独立配置。 |
| D3 | 低情绪（`isLow(card, affect.lowIntensity)`）时 `speech_rate = low`（初值 0.8），否则 `default`（1.0）；仅支持该参数的模型发送。 |
| D4 | 3.1 初始使用 `server_vad`，保留 `smart_turn_v2` 作为对比项；由模型配置决定，不在代码里写死。 |
| D5 | 3.1 的 voice 只能连接时设置，因此换语且目标音色不同时重连适配器；音色相同则不重连。 |
| D6 | 每模型音色是主数据源；角色卡 `voices.qwen` 仅作兼容兜底。env 默认实时模型上旧的角色音色覆盖继续生效，新的 `voice:` 覆盖优先。 |
| D7 | `speech_rate` 的推送沿用 `PushGate` 的安全缝隙语义；当前正在播放的回复不变，从下一次可推送的回复开始生效。 |
| D8 | 3.1 与 3.8 同价（北京：文本输入 1.5 / 音频输入 6 / 文本输出 4.5 / 音频输出 12 元每百万 token），价格基线加一行。 |
| D9 | 2026-10-31 用户确认 3.1 设为默认；3.8 保留可切回。真机/音色试听已由用户确认基本可用（blockers #72/#73）；`max_response_output_tokens` 仍不被 3.1 执行（#74），当前 `pacing.output.maxTokens` 为 null，所以默认配置没有发送该上限。 |

## 4. 配置设计

### 4.1 实时模型注册表

新增 `gateway/config/realtime.json`，作为实时模型能力、音色目录和基线角色音色的唯一真源。

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

说明：

- 3.1 的音色目录和 `byCharacter` 是**候选**，必须试听确认；若男声/多语种音色不满足，按 T7 的试听结果替换，不沿用未验证的 `Tina`/`Evan`。
- `catalog` 是该模型允许选择的音色；`byCharacter` 是基线。管理端覆盖后，以覆盖值为准。
- `voiceUpdate`：`live` = 可在会话中切换音色（3.8）；`connect_only` = 只能连接时设置（3.1）。
- `turnDetection`：3.8 `semantic_vad`；3.1 默认 `server_vad`，可配置为 `smart_turn_v2` 做对比。
- `speechRate`：`null` = 不支持；对象为支持时的边界和默认值。
- 模型 id 允许字母、数字、点和连字符；`voice:` 覆盖层的模型段按注册表校验。

### 4.2 管理端选项

`gateway/config/admin/qwen-options.json` 只保留文本模型：

```json
{
  "textModels": [
    { "value": "qwen-plus", "label": "通义千问 Plus" },
    { "value": "qwen-flash", "label": "通义千问 Flash" }
  ]
}
```

管理端的实时模型下拉和音色下拉从 `realtime.json` 生成，避免两处维护。`QwenOptions` 变为：

```ts
interface QwenOptions {
  realtimeModels: QwenOption[];
  textModels: QwenOption[];
  voices: Record<string, Record<Language, QwenOption[]>>; // model id -> language -> options
}
```

`optionsFor(options, ref, language, model)` 对 `voices.{lang}` 使用传入的模型；其他 ref 忽略模型。

### 4.3 覆盖层

| 覆盖键 | 目标 | 说明 |
|---|---|---|
| `model:qwen.realtimeModel` | 现有虚拟设置 | 选择实时模型，下一通会话生效。 |
| `voice:<model>/<character>.<lang>` | `realtime.json` 的 `models[<model>].voices.byCharacter[<character>][<lang>]` | 每模型、每角色、每语言的音色。 |

`voice:` 是新的特殊目标，不按点分 JSON 路径解析（模型 id 含点）。`parseOverlayKey` 只做语法解析，模型是否存在由配置加载和发布校验判断。`readTargetValue`、`materializeConfigTree`、`setJsonPath` 需要为这个目标增加专门的读写分支。

### 4.4 兼容旧音色覆盖

旧键 `character:<character>.voices.qwen.<lang>` 仍然可解析和写入角色卡。运行时优先级：

1. 当前模型存在对应的 `voice:<model>/<character>.<lang>` 覆盖 → 用覆盖值；
2. 当前模型等于 env 默认实时模型（`config.qwenModel`）且存在旧 `character:...voices.qwen...` 覆盖 → 用旧覆盖值；
3. 当前模型的 `byCharacter` 基线；
4. 角色卡 `voices.qwen`；
5. env 默认音色。

这样旧配置在 3.8 上继续生效，新的每模型配置优先。管理端不再展示旧音色项；旧覆盖在后台重新发布前保持有效。

### 4.5 价格基线

`gateway/config/pricing.json` 增加：

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

`effectiveFrom` 与现有条目一致（北京时间 2026-01-01），保证当前会话可计价；价格单位为微元/百万 token。

### 4.6 启动校验

- `models` 非空；模型 id 合法；至少包含默认模型。
- 每个模型有三种语言的 `catalog`，每个 `catalog` 非空，`value` 唯一。
- 每个角色的三种语言都有 `byCharacter`，且值在该模型该语言的 `catalog` 中。
- `turnDetection.type` ∈ `semantic_vad | server_vad | smart_turn | smart_turn_v2`；`silenceDurationMs` 为正整数（可选）。
- `speechRate` 为 `null` 或 `{min,max,default,low}`，满足 `0.5 ≤ min ≤ low ≤ max ≤ 2.0`、`default` 在区间内。
- `voiceUpdate` ∈ `live | connect_only`。
- 每个实时模型在价格基线中有音频输入和音频输出价格；否则启动失败并给出中文说明。
- 发布覆盖层时：`voice:` 的模型/角色/语言必须存在，音色必须在该模型该语言的 `catalog` 中；`model:qwen.realtimeModel` 必须是注册表中的模型。

## 5. 运行时设计

### 5.1 快照

`ConfigSnapshot` 新增：

```ts
interface RealtimeConfig {
  model: string;                 // 当前生效模型
  turnDetection: { type: string; silenceDurationMs?: number };
  speechRate: { min: number; max: number; default: number; low: number } | null;
  voiceUpdate: 'live' | 'connect_only';
  voices: Record<CharacterId, Record<Language, string>>; // 当前模型的有效音色
}
```

`buildConfigSnapshot` 在物化后的配置树上加载 `realtime.json`，用 `virtual.models.realtimeModel` 选模型，解析有效音色并做上述校验。快照不可变；发布新版本后新会话使用新快照，现有会话不变。

### 5.2 音色解析

`index.ts` 的 `voiceFor` 改为：

```ts
voiceFor: (snapshot, characterId, language) =>
  config.adapter === 'qwen' ? snapshot.realtime.voices[characterId]?.[language] : undefined
```

兜底顺序在快照构建时完成（见 4.4），运行时只读结果。`config.qwenVoices` 仍作为快照构建的最后兜底，不直接参与每次调用。

### 5.3 适配器

`QwenOptions` 增加：

```ts
interface QwenOptions {
  apiKey: string;
  endpoint: string;
  model: string;
  voice: string;
  turnDetection: { type: string; silenceDurationMs?: number };
  speechRate: number | null;   // null = 不发送
  supportsVoiceUpdate: boolean;
}
```

`connect` 的 `session.update`：

```ts
turn_detection: {
  type: opts.turnDetection.type,
  // Only semantic_vad and server_vad take silence_duration_ms; smart_turn modes omit it.
  ...(opts.turnDetection.type !== 'smart_turn' && opts.turnDetection.type !== 'smart_turn_v2'
      && opts.turnDetection.silenceDurationMs !== undefined
    ? { silence_duration_ms: opts.turnDetection.silenceDurationMs }
    : {}),
},
...(opts.speechRate !== null ? { speech_rate: opts.speechRate } : {}),
```

`updateSession` 扩展：

```ts
updateSession?(update: {
  instructions?: string;
  voice?: { value: string | undefined };
  speechRate?: number;
}): void;
```

Qwen 只在 `speechRate !== undefined` 且模型支持时把 `speech_rate` 放进同一次部分 `session.update`。`MockAdapter` 记录 `speechRate` 供测试断言。

Tool schemas are normalized at the adapter boundary: every function's `parameters` gets a `required` array (empty when absent). `qwen-audio-3.1-realtime-flash` returns `InternalError` during `response.create` when any tool schema omits `required`; 3.8 tolerated it. The adapter preserves an existing `required` list and adds `[]` only when missing.

新增只读能力：

```ts
readonly supportsVoiceUpdate: boolean; // 3.8 true；3.1 false
```

`updateVoice` 在 `connect_only` 模型上不发送部分 `session.update`（避免误导），由会话层决定重连。

### 5.4 情绪 → 语速

`SessionDeps` 增加 `realtime`（来自快照的 `RealtimeConfig`）。`Session` 保存 `private speechRate: number`（连接时取 `realtime.speechRate.default`，无支持时为 1.0）。`onAffectCard` 在现有 `this.emotion?.onAffect(...)` 之后：

```ts
const rateCfg = this.deps.realtime?.speechRate ?? null;
const lowThreshold = this.deps.affect?.lowIntensity ?? Number.POSITIVE_INFINITY;
const nextRate = rateCfg
  ? (isLow(card, lowThreshold) ? rateCfg.low : rateCfg.default)
  : undefined;
const rateChanged = nextRate !== undefined && nextRate !== this.speechRate;
if (rateChanged) this.speechRate = nextRate;
this.syncAffectRender(rateChanged ? nextRate : undefined);
```

`syncAffectRender(rate?: number)` 把 affect 文案变化和语速变化合并到**同一次** `gate.request`：`{ instructions?: true, speechRate?: rate }`。这样一次情绪变化最多排一次 `session.update`，不会因为先发 instructions 再发语速而把语速推迟一整轮。

`isLow` 的阈值沿用现有 `affect.lowIntensity`（2）；语速配置只提供 `low` 和 `default`，不重复阈值。

`PushRequest` 增加 `speechRate?: number`；`PushGate.request` 接受并合并最新值；`sendSessionUpdate` 把它传给 `adapter.updateSession`，日志只记 `speechRate: update.speechRate !== undefined`（布尔，不含内容）。推送异常只记 `session_push_failed`，不向用户报错、不影响会话。

时序：AffectCard 通常在用户 final 后异步到达；若回复已开始，`PushGate` 会等到当前回复结束后的安全缝隙，因此**当前回复不受影响，下一条回复使用新语速**。这是可接受的语义，必须在验收里写明。

重连（`rebuild('error'|'slim'|'language')`）后，新适配器以模型默认语速连接；若当前 `speechRate` 不是默认值，重连成功后要把它重新推一次，否则会话状态和模型实际语速会不一致。`forget`/`decline` 重连会清空卡片，应同时把 `speechRate` 复位到默认，不要重推低语速。

### 5.5 换语与音色

`applyLanguage(language)` 在更新 `this.language` 前记录 `previousVoice`；更新后计算 `nextVoice`：

- `nextVoice === previousVoice`：只推送 instructions，不重连。
- 不同且 `adapter.supportsVoiceUpdate`：推送 `{ instructions, voice }`，行为不变。
- 不同且不支持：调用 `rebuild('language')`。重连时 `sessionConfig()` 会带上新语言的 instructions、tools 和音色；`rebuild` 保留麦克风缓冲，继续现有会话。

`RebuildReason` 增加 `'language'`。`rebuild` 对 `'language'` 不发送 `model_reconnecting` 错误（避免用户看到故障提示），只记 `model_rebuild { reason: 'language' }`；若重连失败，仍走既有 `model_unavailable` 重试路径。

## 6. 后台设计

### 6.1 选项与描述符

- `loadQwenOptions` 改造为从 `realtime.json` 生成 `realtimeModels` 和 `voices`，从 `qwen-options.json` 读取 `textModels`。函数名可保留，调用方改为传入两个路径或一个 gateway root。
- `DescriptorItem` 支持 `{model}` 展开；`loadDescriptorCatalog` 的 opts 增加 `models`（来自 `realtime.json` 的模型 id 列表）。
- `ConcreteItem` 增加 `model: string | null`；`AdminConfigItem`（`protocol/src/adminApi.ts`）增加 `model: string | null`。
- `characters.json` 的旧声音项替换为：

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

- `configApi` 构建 `AdminConfigItem` 时用 `item.model` 解析音色选项，并把模型 label 追加到展示 label（例如「声音（Qwen-Audio 3.1 Flash 实时版）」）。`model` 字段供测试和后续分组使用。
- `validateDisplayValue` 用 `item.model` 校验音色是否在该模型的 catalog 中。
- 发布预览的 diff 使用带模型 label 的 label，便于区分两套音色。

### 6.2 管理端 UI

- 模型页：实时模型下拉自动出现 3.1；价格说明来自价格表；切换后提示「下一通电话生效」。
- 角色页：每种语言下，每个角色显示两行声音（3.8 一行、3.1 一行），行标题带模型 label；选项来自对应模型的 catalog。不需要模型选择器或跨场景联动。
- 旧的角色卡声音项不再展示；已存在的旧覆盖仍生效（见 4.4）。
- 管理端测试覆盖：两行声音、按模型过滤选项、无效音色发布被拒、模型下拉包含 3.1、价格说明。

## 7. 测试与验收

### 7.1 单元与集成

- 注册表：合法配置通过；缺模型/缺语言/缺角色/非 catalog 音色/非法 `speechRate`/非法 `turnDetection`/缺价格均失败。
- 覆盖层：`voice:` 解析、物化、读取、回滚；非法模型/角色/语言/音色被拒；旧 `character:...voices...` 仍可解析。
- 快照：模型覆盖生效；音色优先级（新覆盖 → 旧覆盖仅默认模型 → byCharacter → 角色卡 → env）；缺模型报中文错误。
- 适配器：3.8 payload 用 `semantic_vad`、无 `speech_rate`；3.1 用 `server_vad`、带 `speech_rate`；`updateSession` 带 `speech_rate`；`supportsVoiceUpdate` 正确；Mock 记录。
- 会话：低情绪卡 → 推送 0.8；非低 → 1.0；无支持模型不推送；重复值不重复推送；推送失败不影响通话。
- 换语：音色相同不重连；音色不同 + `connect_only` 触发 `rebuild('language')`；`live` 仍走 `updateSession`；重连不发送 `model_reconnecting`。
- 管理端：描述符 `{model}` 展开、选项、协议字段、页面两行声音、发布校验、价格说明。

### 7.2 真实 Qwen 冒烟（需要 Key）

- 3.8：短会话、工具轮、zh/ja/en；确认行为与现状一致。
- 3.1：`server_vad` 连接、工具轮、zh/ja/en、首音延迟、打断；`speech_rate` 1.0/0.8 的时长差；换语重连；音色试听。
- `smart_turn_v2` 作为对比项，记录首音和打断体感；不通过则保留 `server_vad`。
- 探针只使用合成文本/音频；音频试听后删除；日志/报告不含正文。

### 7.3 验收标准

- 后台可切换两个模型；下一通会话使用新模型，进行中的会话不受影响。
- 3.8 行为与改动前一致（音色、打断、工具、首音）。
- 3.1 能连接、能出声、工具可用、三种语言可用；使用的音色属于该模型 catalog。
- 低情绪后的**下一条**回复语速为 0.8（3.1）；非低情绪为 1.0；3.8 不发送。
- 换语时声音不出现旧语言音色；必要时短暂重连，不出现故障提示。
- gateway/protocol/admin 测试、typecheck、admin build 全通过；无 `git diff --check` 问题。

## 8. 风险与待验证

| 风险 | 处理 |
|---|---|
| 3.1 音色名单与 3.8 不同，`Tina`/`Evan` 很可能不可用 | T1 用候选值，T7 试听确认；不沿用未验证音色。 |
| 3.1 多语种音质/发音未验证 | T7 逐语言试听；不通过记 blocker，保留 3.8 默认。 |
| `server_vad` 与本机 VAD/打断语义不同 | T7 真机对比 `server_vad` 与 `smart_turn_v2`；必要时调 `silenceDurationMs`。 |
| 3.1 voice 只能连接时设置，换语重连有短暂停顿 | T5 实现重连；T7 真机确认体感；若不可接受，选多语种同一音色避免重连。 |
| `speech_rate` 只改语速，不改音高/音色 | 明确为路线 A 的边界；不承诺“悲伤语气”。 |
| `max_response_output_tokens` 在 3.1 上未回显 | T7 验证输出上限；若无效，改用模型侧/应用侧限长或记 blocker。 |
| 3.1 用量字段与 3.8 不同 | 现有 recorder 兼容 totals/明细；T7 检查 `usage_events` 计价。 |
| 管理端 `{model}` 展开和协议字段是接口变更 | T6 同步 admin 测试、typecheck、build。 |
| 旧角色音色覆盖迁移 | 4.4 优先级保证 3.8 旧覆盖继续生效；管理端不再展示旧项，T6 加测试。 |

## 9. 兼容性与回滚

- 默认模型已是 3.1；管理端可切回 3.8。切换仍是下一通会话生效。
- 管理端切换是覆盖层发布，可回滚到上一版本；切回 3.8 即恢复旧模型。
- 旧 `character:...voices.qwen...` 覆盖在 3.8 上继续生效；新的 `voice:` 覆盖优先。
- `realtime.json` 是基线；新增模型仍需改配置并重启，不在后台热加模型。
- 价格基线新增条目不影响现有模型计价；未定价调用仍按现有逻辑记 NULL。

## 10. 后续

路线 A 完成并验证后，再评估 LivePortrait / EchoMimic / Sonic 等端侧表情驱动方案的可行性、性能和授权；不在本设计范围内。
