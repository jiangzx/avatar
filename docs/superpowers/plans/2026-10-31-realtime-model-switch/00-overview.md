# 实时模型切换与每模型音色 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员在后台在 `qwen3.8-omni-flash-realtime` 和 `qwen-audio-3.1-realtime-flash` 之间切换，两个模型各自拥有一套角色音色，并在低情绪时用 `speech_rate` 放慢语速。

**Architecture:** 新增 `gateway/config/realtime.json` 作为实时模型能力、音色目录和基线音色的唯一真源；`ConfigSnapshot` 解析当前生效模型和音色；`QwenAdapter` 按模型发送 `turn_detection` / `speech_rate`；会话通过现有 `PushGate` 在安全缝隙推送语速；管理端用新的 `voice:<model>/<character>.<lang>` 覆盖层和 `{model}` 描述符展开维护每模型音色。

**Tech Stack:** TypeScript 7、Node 24、zod、vitest、React/antd（admin）、npm workspaces。

**Spec:** `docs/superpowers/specs/2026-10-31-realtime-model-switch-design.md`

## Global Constraints

- 回复用简体中文；代码注释用英文，短。
- 默认模型仍是 `qwen3.8-omni-flash-realtime`；3.1 只作为后台可选项，验证通过前不设为默认。
- 不改变会话协议和 App 正常会话行为；管理端配置协议只增加一个可选字段 `model`。
- 不新增依赖；不提交密钥、模型、音频或对话内容。
- 日志只记事件名、id、计数、耗时、错误码和布尔/配置值；不记对话正文。
- 所有配置值进配置文件，不硬编码；启动时用 zod 校验并做交叉校验。
- 每个任务 TDD：先写失败测试，确认失败，再实现，确认通过，然后提交。
- 提交信息按执行时会话的系统要求署名；不要 `git add -A`，只加显式路径。
- 3.1 的音色映射是待试听候选；试听不通过就记 blocker，不把未验证音色当默认。

## 已确认决策

| # | 决策 |
|---|---|
| D1 | 两个实时模型都可在后台切换；复用 `model:qwen.realtimeModel`，下一通会话生效。 |
| D2 | 每模型一套音色；新增 `voice:<model>/<character>.<lang>` 覆盖层。 |
| D3 | 低情绪 → `speech_rate=0.8`，否则 `1.0`；仅 3.1 发送；在安全缝隙推送。 |
| D4 | 3.1 初始 `server_vad`；`smart_turn_v2` 作为对比项。 |
| D5 | 3.1 的 voice 只能连接时设置；换语且音色不同时重连。 |
| D6 | 每模型音色为主数据源；角色卡音色只作兼容兜底；旧覆盖在 env 默认模型上继续生效。 |
| D7 | 当前播放的回复不变，下一条回复使用新语速。 |
| D8 | 3.1 与 3.8 同价，价格基线加一行。 |

## 任务与依赖

| 文件 | Task | 内容 | 依赖 |
|---|---|---|---|
| `01-t1-realtime-registry.md` | T1 | `realtime.json`、注册表加载/校验、价格条目、测试 | — |
| `02-t2-snapshot-voice.md` | T2 | `ConfigSnapshot.realtime`、音色优先级、`index.ts` 接线 | T1 |
| `03-t3-adapter-capabilities.md` | T3 | `QwenAdapter` turn detection / speech_rate / voiceUpdate、Mock | T1, T2 |
| `04-t4-affect-speech-rate.md` | T4 | AffectCard → `speech_rate` → `PushGate` | T3 |
| `05-t5-language-rebuild.md` | T5 | 换语音色不同 → `rebuild('language')` | T3 |
| `06-t6-admin-backend.md` | T6 | `{model}` 描述符、选项合并、发布校验、协议字段 | T1, T2 |
| `07-t7-admin-ui.md` | T7 | 管理端测试夹具、两行声音、typecheck/build | T6 |
| `08-t8-smoke-closeout.md` | T8 | 真实 Qwen 冒烟、音色试听、全量回归、文档/路线图 | T2–T7 |

顺序执行。T4 和 T5 都依赖 T3，但都会改 `session.ts`，不要并行；T6/T7 依赖 T1，可以和 T2–T5 并行，但本计划按一个执行者串行，避免 `config-store`/`protocol` 冲突。

## 共享接口（冻结）

```ts
// gateway/src/realtime/models.ts
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
export function loadRealtimeRegistry(path: string, opts?: { defaultModel?: string }): RealtimeRegistry;
export function voiceFor(model: RealtimeModel, characterId: CharacterId, language: Language): string;
export function missingRealtimePrices(registry: RealtimeRegistry, pricedModels: ReadonlySet<string>): string[];

export interface RealtimeConfig {
  model: string;
  turnDetection: TurnDetection;
  speechRate: SpeechRateConfig | null;
  voiceUpdate: 'live' | 'connect_only';
  voices: Record<CharacterId, Record<Language, string>>;
}

// gateway/src/adapters/types.ts
export interface RealtimeAdapter {
  readonly supportsVoiceUpdate?: boolean; // omitted = true (legacy)
  updateSession?(update: {
    instructions?: string;
    voice?: { value: string | undefined };
    speechRate?: number;
  }): void;
}

// gateway/src/session/pushGate.ts
export interface PushRequest {
  instructions?: boolean;
  voice?: { value: string | undefined };
  speechRate?: number;
}

// protocol/src/adminApi.ts
export interface AdminConfigItem {
  // ...existing fields
  model: string | null;
}
```

## 命令

```bash
# 单个测试
npm test -w gateway -- test/realtime-models.test.ts
npm test -w gateway -- test/config-snapshot.test.ts
npm test -w gateway -- test/qwen.test.ts
npm test -w gateway -- test/push-gate.test.ts
npm test -w gateway -- test/session.test.ts
npm test -w gateway -- test/config-descriptors.test.ts
npm test -w admin -- test/config-scene.test.tsx

# 全量
npm test -w protocol
npm run typecheck -w protocol
npm test -w gateway
npm run typecheck -w gateway
npm test -w admin
npm run typecheck -w admin
npm run build -w admin
git diff --check
```

## 验收

- 后台模型下拉出现两个模型；切换后下一通会话使用新模型，进行中的会话不变。
- 3.8 行为与改动前一致；3.1 能连接、出声、工具可用、zh/ja/en 可用。
- 每种语言下每个角色有两行声音（3.8 / 3.1），选项来自对应模型 catalog；无效音色发布被拒。
- 3.1 上低情绪后的下一条回复 `speech_rate=0.8`，非低情绪 `1.0`；3.8 不发送。
- 换语且音色不同时 3.1 重连并使用新音色；不出现 `model_reconnecting` 故障提示。
- 全量测试、typecheck、admin build、`git diff --check` 通过。

## 风险与停点

- 3.1 音色/多语种质量未验证：T8 试听；不通过记 `docs/blockers.md`，保留 3.8 默认，不静默换音色。
- `server_vad` 打断体感未知：T8 真机对比；不通过保留 `server_vad` 并记录，不改成未验证的 `smart_turn_v2`。
- `max_response_output_tokens` 在 3.1 上未回显：T8 检查；无效则记 blocker，不假设它生效。
- 真实 Key 不可用：T8 标 blocker，跳过真实冒烟，不声称通过；其余测试必须跑。

## 执行后变更（2026-10-31）

- 真机切换 3.1 后所有回复 `InternalError`；根因是 3.1 要求每个 tool 的 `parameters` 带 `required`，适配器 `toQwenTool` 已归一化并有回归测试。见冒烟记录 §4.1。
- 用户确认 3.1 会话可用后，`qwen-audio-3.1-realtime-flash` 设为默认：`config.ts` 的 env fallback、`QwenAdapter` 构造默认和本地 `.env` 都改为 3.1；3.8 保留可切回。
- `qwen-plus` affect 超时排查：同 prompt 复测约 1s；线上 2.5s 超时是预算处中止，建议 4000ms 或一次重试，尚未改配置。见 blockers #75。
