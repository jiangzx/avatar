# 多角色与分层记忆 — Implementation Plan Overview

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划定为 subagent-driven-development，全程只用这一种。

**Goal:** 把「小暖 / 小凯 / 小欣」做成三个不同的人：各自有名字、声音、性格和私有记忆。称呼和基本资料由所有角色共享。同时实现钉住记忆、语音查看记忆、设置页查看与删除记忆、AI 身份提示和每 60 分钟的休息提醒。

**Architecture:**
- 网关新增角色卡注册表（`gateway/characters/*.json`）。提示词里的名字改成 `{{char}}` 等占位符，加载时按「角色 × 语言」替换。
- 记忆库用新基线（`user_version` 6）：私有数据按 `agent_id`（owner × 角色）存放，共享资料放在 `profile_facts`。作用域键只来自服务端的 `SessionContext`。
- App 首次启动改为选择角色；`POST /session` 带上角色 id；设置页通过新的记忆 HTTP 接口查看和删除记忆。

**Tech Stack:** Node 24.21+（`node:sqlite`）、TypeScript、vitest、zod；Flutter 3.47.6 / Dart 3.13.5、flutter_test；npm workspaces（`protocol/`、`gateway/`、`avatar-core/`）。

**Spec（已批准，约束）：** `docs/superpowers/specs/2026-10-26-multi-character-design.md`。决策 Q1–Q36 见 spec 的「决策记录」。每个任务的实现者先读 spec 的对应章节，再读本总览，最后读自己的任务文件。

## Global Constraints

- 回复用简体中文；代码注释用英文，简短。界面文案用简体中文，不出现「Duix」。
- 日志永远不记对话内容：音频、ASR 文本、回复文本、钉住的文本、记忆列表、称呼。只记事件名、id、计数、耗时、错误码。
- 不提交密钥。Key 只放环境变量或 `--dart-define`。只用 `git add <明确路径>`，禁止 `git add -A`，不覆盖与任务无关的未提交改动。
- 可调数值和文案只放配置：
  - 网关：`gateway/config/*.json`、`gateway/config/i18n/<lang>/*.json`、`gateway/roles/**`、`gateway/characters/*.json`
  - App：`app/assets/config/*.json`
  - 网关配置在启动时用 zod 校验，有关联的值要交叉校验。
- 分层：server → (session, identity) → (adapter, memory, roles, characters)，不允许反向 import。没有模块级可变状态。只在边界（HTTP、WS、工具参数、配置、模型 JSON）用 zod 校验，校验失败就拒绝。
- **作用域键只来自服务端的 `SessionContext`**（`ownerId`、`agentId`、`characterId`），绝不取自工具参数、模型输出或 HTTP body 里的 owner。HTTP 的 `character` 只用来在 token 对应的 owner 下找到 agent。
- **高风险区**：记忆召回、开场 / 沉默四段式、Seeduplex 工具轮。改动前先读 `docs/project/roadmap.md` 的「记忆与回忆：已踩过的坑」（1–12）和「打断与沉默：已踩过的坑」（1–11）。只有第 4 条按 Q33 修订：用户钉住的敏感记忆可以进完整快照，不进开场快照和主动接话快照。其余条目一律保持。
- session 变更（指令、音色、快照刷新）只能经 `PushGate` 在缝隙推送（已踩过的坑第 12 条）。
- 工具轮的播报沿用 grounded `spokenText` 的路径：Seeduplex 直接 TTS `fallbackText`，Qwen 用「请直接说下面这句话，不要改写：」。不要退回通用的 `toolContinueText`。
- 不新增 npm 或 Dart 依赖。
- 不兼容旧数据：旧 id（`lily` / `kai` / `default`）、旧存储 key（`style_id` / `avatar_id`）、旧数据库（`user_version` 1–5）全部丢弃，不写迁移和兼容代码。
- TDD：每个任务先写失败测试、确认失败，再实现、确认通过，然后提交。提交信息结尾的 `Co-Authored-By` 行以执行时会话系统给出的署名为准，任务文件里写的只是示例。
- 没跑过的东西不能说完成。报告里写真实命令和结果；真机步骤由用户确认的，写明「用户确认」。
- 卡住超过 20 分钟（环境、模型 Key、设备）：做一次手动验证，记入 `docs/blockers.md`，按 AGENTS.md 第 7 条处理，并在进度报告里列出所有跳过的项。

## 环境前置（执行机器）

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node | ≥ 24.21（`node:sqlite` 不带实验警告） | `node -v` |
| 依赖 | 仓库根目录 `npm ci` | `npm ls --workspaces --depth=0` |
| Flutter | 3.47.6 stable | `flutter --version` |
| 模型 Key（只有 Task 17 需要） | `gateway/.env` 里的 `DASHSCOPE_API_KEY`（Qwen 实时和 qwen-plus 抽取），可选 Seeduplex Key；文件已被 gitignore | `test -f gateway/.env && echo ok` |
| 记忆库 | `MEMORY_DB_PATH` 是仓库外的绝对路径。**旧库必须先删除**：新基线拒绝 `user_version` 1–5 | `ls -l "$MEMORY_DB_PATH"` |
| 真机（只有 Task 17 需要） | 小米 arm64，USB 调试；debug APK 需要**卸载重装**，丢弃旧的本地 key | `adb devices -l` |

## 命令

```bash
# repo root
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
npm test -w gateway -- test/<file>.test.ts          # one gateway test file (cwd: repo root)
node scripts/generate-character-ids.mjs                 # regenerate TS + Dart id lists
node scripts/generate-character-ids.mjs --check         # fails when generated files are stale
# app/
flutter test
flutter test test/<file>_test.dart
flutter analyze
flutter build apk --debug --dart-define-from-file=dev.json
```

## 冻结的契约

下面的名字、签名、文件位置是任务之间的接口。实现者可以加私有辅助函数，但**不能改这里的公开名字和形状**。如果确实需要改，停下来报告（AGENTS.md 第 7 条），由协调者同步更新本总览和受影响的任务。

### C1 协议（Task 1）
- 唯一来源 `protocol/characters.json`：`{ "ids": ["xiaonuan","xiaokai","xiaoxin"], "defaultId": "xiaonuan" }`。列表顺序就是 App 的显示顺序。
- 生成文件：
  - `protocol/src/characters.generated.ts`：导出 `CHARACTER_IDS`（`as const`）和 `DEFAULT_CHARACTER_ID`。
  - `app/lib/identity/character_ids.generated.dart`：导出 `const characterIds = <String>[...]` 和 `const defaultCharacterId = '...'`。
  - 生成器 `scripts/generate-character-ids.mjs`，支持 `--check`。
- `protocol/src/characters.ts`：`export type CharacterId = (typeof CHARACTER_IDS)[number]`；`export function isCharacterId(v: unknown): v is CharacterId`；re-export 生成的常量。`protocol/src/index.ts` 再 re-export。
- `ResponseKind = 'reply' | 'greeting' | 'followup' | 'reminder'`。
- `session.start.clientInfo` 删除 `voiceProfile`。
- `export interface SessionCreateRequest { character?: CharacterId }`，即 `POST /session` 的 body，缺省时用默认角色。
- `protocol/src/memoryApi.ts`（re-export）：
  ```ts
  export interface MemoryItem { id: string; text: string }
  export interface MemoryFactItem extends MemoryItem { category: 'preference' | 'person' | 'health' | 'other' | 'safety'; sensitive: boolean }
  export interface MemoryPinnedItem extends MemoryItem { sensitive: boolean }
  export interface MemoryOverview {
    profile: { addressing: MemoryItem | null; items: MemoryItem[] };
    characters: Array<{ character: CharacterId; pinned: MemoryPinnedItem[]; facts: MemoryFactItem[] }>;
  }
  export type MemoryClearScope = 'profile' | 'character' | 'all';
  ```

### C2 记忆库（Task 2）
- `gateway/src/memory/migrations.ts` 的基线是第 6 版，`BASELINE_VERSION = 6`。读到 1–5 时抛出 `memory db predates multi-character schema; delete it`；读到比代码新的版本时沿用现有报错。表结构见 spec 技术设计第 4 节，包含 `source_message_ids`（JSON 文本，默认 `'[]'`）和 `pinned_memories.source_message_id`（可空）。
- 记录类型：
  ```ts
  export interface AgentRecord { id: string; ownerId: string; characterId: CharacterId; memoryEpoch: number }
  export interface UserFinal { text: string; messageId: string | null }
  export type ProfileCategory = 'addressing' | 'profile';
  export type AgentFactCategory = 'preference' | 'person' | 'health' | 'other' | 'safety';
  export interface ProfileFactRow { id: string; category: ProfileCategory; text: string }
  export interface AgentFactRow { id: string; category: AgentFactCategory; text: string; sensitive: boolean }
  export interface PinnedRow { id: string; text: string; sensitive: boolean; createdAt: number }
  export interface DeletedItem { kind: 'profile' | 'agent_fact' | 'pinned'; agentId: string | null; text: string; sourceMessageIds: string[] }
  ```
- `MemoryStore` 中**新增或签名改变**的方法（其余现有方法保留，并按 spec 第 5 节改作用域）：
  ```ts
  createOwner(input: { tokenHash: string; now: number }): { ownerId: string; deviceId: string };
  ensureAgent(ownerId: string, characterId: CharacterId, now: number): AgentRecord;
  hasEndedSession(agentId: string): boolean;
  continuousSince(ownerId: string, now: number, gapMs: number): number;
  insertMessage(row: { id: string; sessionId: string; ownerId: string; agentId: string; role: 'user' | 'assistant'; text: string; bigrams: string; now: number }): void;
  listProfileFacts(ownerId: string): ProfileFactRow[];
  listAgentFacts(ownerId: string, agentId: string): AgentFactRow[];           // includes sensitive; callers filter
  listPinned(ownerId: string, agentId: string): PinnedRow[];                 // newest first
  insertPinned(row: { id: string; ownerId: string; agentId: string; text: string; sensitive: boolean; sourceSessionId: string; sourceMessageId: string | null; now: number }): void;
  recentUserMessages(ownerId: string, agentId: string, limit: number): { text: string }[];
  searchMessages(ownerId: string, agentId: string, match: string, limit: number): { text: string }[];
  searchMessagesLike(ownerId: string, agentId: string, needle: string, limit: number): { text: string }[];
  careFollowup(ownerId: string, agentId: string, currentSessionId: string, now: number, maxAgeMs: number): { id: string; quote: string; createdAt: number } | undefined;
  listPendingMessages(ownerId: string, agentId: string): PendingMessage[];
  agentsPendingExtraction(): Array<{ ownerId: string; agentId: string }>;
  memoryForExtract(ownerId: string, agentId: string): ExtractMemory;
  writeExtraction(ownerId: string, agentId: string, change: ExtractionChange): void;
  memoryEpochs(ownerId: string, agentId: string): { owner: number; agent: number } | undefined;
  bumpOwnerEpoch(ownerId: string): number;
  bumpAgentEpoch(ownerId: string, agentId: string): number;
  forgetMatches(ownerId: string, agentId: string, query: string, match: string | null, sessionId: string, triggerText?: string | null): ForgetResult;
  setAddressing(ownerId: string, name: string, now: number): void;           // plain name, single row
  deleteMemoryItem(ownerId: string, itemId: string): DeletedItem | undefined;
  deleteMessagesByIds(ownerId: string, agentId: string | null, ids: readonly string[]): number; // null = any agent of owner
  clearAgentMemory(ownerId: string, agentId: string): void;                  // keeps the agent row
  clearProfile(ownerId: string): void;
  clearAllMemory(ownerId: string): void;                                     // keeps owners/devices/agents/consent
  wipeOwnerMemory(ownerId: string): void;                                    // decline path: all memory + consent=declined
  ```
  删除的旧方法：`setAgentStyle`、`listFacts`、`listProactiveFacts`、`listNotes`、`snapshotRows`、`ownersPendingExtraction`、`bumpEpoch`、`memoryEpoch`、`latestEpisode`。
- 孤儿清理改为「创建早于截止时间，且没有任何 agent 行」。

### C3 抽取（Task 3）
- `MemoryWorker` 的任务键是 `(ownerId, agentId)`，队列仍按 owner 串行。入口 `enqueue(ownerId: string, agentId: string, reason: ExtractReason)`。
- 抽取输入：用户行编号为 `u1..uN`（每次运行内有效），网关映射回 `PendingMessage.id`。
- `user_facts` op 的 category 用 `z.enum(['addressing','profile','preference','person','health','other'])` 校验；`sources: z.array(z.string().max(8)).max(20).optional()`，缺省为 `[]`。不在白名单里的 op 丢弃并计数，不让整批失败。
- `addressing` / `profile` 写入 `profile_facts`，addressing 去掉「称呼：」标签只存纯名字；其余写入本 agent 的 `agent_facts`；`safety` 只能由 writer 写入。
- epoch：开始时读 `memoryEpochs`，写入前在同一事务里复核 owner 和 agent 两个 epoch。

### C4 快照与预算（Task 4）
- `renderMemoryViews(input)` 输出 `{ full, greeting, proactive, hasTopic, pinnedBlock }`：
  - `full`：称呼 + 基本情况 + 本角色非敏感事实 + 本角色最近已结束会话里的用户陈述（不含钉住）
  - `greeting`：称呼 + 基本情况 + 钉住的非敏感项 + 本角色非敏感事实
  - `proactive`：基本情况 + 钉住的非敏感项 + 本角色非敏感事实
  - `pinnedBlock`：本角色**全部**钉住项，包括敏感项，带 `PROMPT_LABELS[lang].pinned` 标签。
- `PROMPT_LABELS` 新增 `profile`、`pinned` 两个标签，文案见 spec 附录 B。
- `buildInstructions(parts, budget, labels)` 的 `parts` 新增 `pinned?: string`，渲染在快照之前，不截断。`InstructionBudget` 新增 `pinnedMaxChars: number`；`historyBudget` 按满额预留这一段。
- `gateway/config/memory.json` 新增：`pinMaxPerCharacter: 10`、`pinMaxChars: { zh: 40, ja: 50, en: 50 }`、`listMaxItems: 5`。`pinnedMaxChars = pinMaxPerCharacter × (pinMaxChars[lang] + 标签和换行开销)`，由代码计算，不单独配置。`languageBudgetRatio` 定为 `{ zh: 0.49, ja: 0.58, en: 0.9 }`（算式见 Task 4）；zod 上限从 0.8 放宽到 0.9；不改 `rebuild.contextChars`。en 在 Task 6 之后如果仍放不下，按 Task 6 第 13 步的规则调小 `pinMaxChars.en`，下限 35。

### C5 角色卡（Task 5）
- `gateway/src/characters/card.ts`：zod `CharacterCardSchema`，字段见 spec 技术设计第 2 节；`voices: { qwen: Record<Language, string|null>; seeduplex: { zh: string|null; en: string|null } }`。
- `gateway/src/characters/registry.ts`：
  ```ts
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
  启动时校验：卡片 id 集合等于 `CHARACTER_IDS`；每张卡覆盖所有语言；`greetingsFirstMeet` 每条都含 `{name}`，长度上限按语言分别是 zh 40 / ja 50 / en 100 字符；`identity` 不出现其他角色的名字；`extensions` 的键带命名空间。
- 角色卡文件：`gateway/characters/{xiaonuan,xiaokai,xiaoxin}.json`。中文文案取自 spec 附录 A；ja/en 由 Task 5 按附录 A 的含义翻译。

### C6 角色包与提示词（Task 6）
- `RoleCatalog`（替换现有接口）：
  ```ts
  export interface RoleCatalog {
    defaultRole(): string;
    defaultLanguage(roleId: string): Language;
    supportedLanguages(roleId: string): readonly Language[];
    buildPersona(characterId: CharacterId, language?: Language): string;
    activityText(roleId: string, activityId: string, language?: Language): string | undefined;
    director(characterId: CharacterId, language?: Language): DirectorConfig;   // placeholders resolved
    extractPrompt(language?: Language): string;
    recallPrompt(characterId: CharacterId, language?: Language): string;
    carePrompt(characterId: CharacterId, language?: Language): string;
    affectPrompt(characterId: CharacterId, language?: Language): string;
  }
  ```
  删除 `defaultStyle`、`hasStyle`、`voiceFor`、`pairs`。`FileRoleCatalog.load(rootDir, characters: CharacterRegistry)`；`fixedRoleCatalog` 测试桩跟着改。
- 占位符：`{{char}}`、`{{charSpoken}}`、`{{charIdentity}}`。替换后残留 `{{` 就启动失败。
- 文件：删除 `roles/elder-companion/*/styles/`，新增 `roles/elder-companion/<lang>/persona.md`；`role.json` 删除 `styles`、`defaultStyle`、`voices`。
- 测试：`gateway/roles/**` 和 `gateway/mock/script.json` 里不能出现任何角色名的字面量。

### C7 身份与会话上下文（Task 7）
- `SessionContext`（替换）：
  ```ts
  export interface SessionContext {
    ownerId?: string;
    agentId?: string;
    characterId: CharacterId;
    language?: Language;
    firstMeet: boolean;
    continuousSince?: number;
    memorySnapshot?: string;
    greetingMemorySnapshot?: string;
    greetingHasTopic?: boolean;
    proactiveMemorySnapshot?: string;
    pinnedMemory?: string;
  }
  ```
  roleId 由 `characters.roleOf(characterId)` 得出；音色由 `characters.voiceFor(characterId, adapter, language)` 得出，为 undefined 时用现有环境变量的默认值。
- `ContextResolver.resolve(bearer: string | undefined, characterId: CharacterId): ResolveResult`；`devContext(roles, characters, characterId)`。
- `IdentityService.register()` 无参数；删除 `setStyle`。
- HTTP：`POST /session` 的 body 用 zod `SessionCreateSchema = z.object({ character: z.enum(CHARACTER_IDS).optional() }).strict()` 校验，失败返回 400 `unknown_character`；`POST /device/register` 的 body 删除 `style`；删除 `PATCH /agent/style`。
- 删除 `Session.useYoungMaleVoice`、`youngMale*` 配置、`QWEN_VOICE_YOUNG_MALE*` 环境变量、`voiceProfile` 的全部分支。
- eval 和 `make-filler-clips.ts`：`--style` 改为 `--character`。

### C8 开场（Task 8）
- Director 的依赖新增 `firstMeetGreeting(): string | undefined`：当 `ctx.firstMeet && 有称呼` 时，返回随机一条替换好 `{name}` 的 `greetingsFirstMeet`，否则返回 undefined。Director 的 `requestGreeting` 最先查它，在 `safeGreeting` 和规划器之前，这样没有接规划器时也生效。
- 没有称呼且是初次见面时，规划器失败的兜底用 `characters.greetingNoName`。

### C9 工具（Task 9、Task 10）
- `ToolContext` 新增：
  ```ts
  characterId: CharacterId;
  turn: TurnAccess;
  memoryGate(): 'ok' | 'declined' | 'notice_pending';
  ```
  ```ts
  export interface TurnAccess {
    currentFinal(timeoutMs: number): Promise<UserFinal | null>; // resolves when this turn's user final has arrived; null on timeout, interruption or session end (never rejects)
    previousFinal(): UserFinal | null;                          // the user final before this turn's
  }
  ```
- `ToolOutcome` 新增 `refreshSnapshot?: boolean`。为 true 时，Session 重新渲染快照和 `pinnedMemory`，经 `PushGate` 推送。
- `TranscriptWriter.append(...)` 返回 `{ result: 'stored' | 'skipped' | 'rejected'; messageId?: string }`。
- 新工具：`gateway/src/session/tools/pin.ts`（`pinTool`）、`gateway/src/session/tools/list.ts`（`listTool`），在 `tools/registry.ts` 注册。
- i18n `config/i18n/<lang>/memory.json` 新增 `pin` 和 `list` 两块，以及 `healthWords`，键名见 spec 第 10 节和附录 B。

### C10 记忆 HTTP 接口（Task 11）
- `gateway/src/identity/memoryService.ts`：
  ```ts
  export interface MemoryService {
    ownerOf(bearer: string): string | undefined;
    overview(ownerId: string): MemoryOverview;
    setAddressing(ownerId: string, text: string): 'ok' | 'declined' | 'rejected';
    deleteItem(ownerId: string, itemId: string): boolean;          // Q35/Q36 source deletion inside
    clear(ownerId: string, scope: MemoryClearScope, characterId?: CharacterId): void;
  }
  ```
  server 处理顺序：`ownerOf` → `manager.endOwner(ownerId, 'memory_changed')` → 调用 service。所有写操作在一个 immediate 事务里先 bump epoch 再删除。
- 路由：`GET /memory`、`PUT /memory/addressing`、`DELETE /memory/items/:id`、`DELETE /memory?scope=...&character=...`。新增限流桶 `memory`，`MEMORY_RATE_LIMIT` 默认 60/60s。响应头带 `Cache-Control: no-store`。

### C11 休息提醒（Task 12）
- `gateway/config/pacing.json` 新增 `restReminder: { firstAfterMs: 3600000, everyMs: 3600000, continuityGapMs: 600000 }`。
- `gateway/src/session/restReminder.ts`：`export function nextReminderAt(continuousSince: number, now: number, cfg: RestReminderConfig): number`，以及 `RestReminderClock`（注入 `now`、`setTimer`、`clearTimer`、`onDue`）。
- `ProactiveRequest.cue` 新增 `'restReminder'`；`requestResponse('reminder', ...)`；i18n 新增 `restReminderText`。

### C12 App（Task 13–16）
- `app/assets/config/characters.json`：`{ "characters": [ { "id", "title", "subtitle", "engine": "duix" | "webview", "duixModel"?: string, "webviewAvatar"?: string } ] }`。
- `app/assets/config/companion.json`：`{ "aiCaption": "我是 AI 陪伴，不是真人", "restToastMs": 6000 }`。
- `app/lib/identity/characters.dart`：
  ```dart
  class CharacterOption implements PickerOption { id, title, subtitle, engine, duixModel, webviewAvatar }
  class CharacterCatalog { List<CharacterOption> options; CharacterOption? byId(String id); String get defaultId; }
  Future<CharacterCatalog> loadCharacterCatalog(AssetBundle bundle);
  ```
- `DeviceIdentity`：key 为 `device_token`、`character_id`；方法 `savedCharacter()`、`chooseFirstCharacter(String id)`（注册 + 保存）、`changeCharacter(String id)`。删除全部 style 相关代码。
- `IdentityBackend.register()` 无参数；删除 `patchStyle`。
- `GatewayTransport` 新增 `get`、`put`、`delete`；`CredentialStore` 新增 `delete(String key)`。
- `app/lib/memory/memory_api.dart`：`MemoryApi.overview()`、`setAddressing(String)`、`deleteItem(String id)`、`clear(MemoryClearScope scope, {String? character})`，返回 `MemoryResult<T>`（sealed：`MemoryOk<T>` / `MemoryFailed(reason)`）；401 时 renew 后重试一次。
- `EngineSwitchController.availabilityFor(CharacterOption) → CharacterAvailability`（sealed：`Available` / `Preparing(double? fraction)` / `Unavailable(String reason)` / `PrepareFailed(String reason)` / `Hidden` / `Checking`）。
- `NativeGatewayClient` 的构造参数新增 `characterId`，`POST /session` 的 body 为 `{"character": id}`；`SessionStart` 删除 `voiceProfile`。
- 垫话音频：`assets/filler/<characterId>/`；`thinking.json` 的 `styles` 改为 `characters`。

### 契约修订（写任务文件时由协调者确认，优先于上面的条目）

- **C1**：网关 zod 里的 `voiceProfile` 保留到 Task 7 再删，过渡期小凯的男声照常工作。生成器的 `--check` 测试放在 gateway 包里。
- **C2**：
  - `ForgetResult` 增加 `pinned`、`profile` 两个计数。
  - `FactChange` 的 add/update 增加可选的 `sourceMessageIds`。
  - `immediate()` 可重入：store 的写方法在外层事务里直接加入。`clear*` 和 `deleteMemoryItem` 不 bump epoch，由调用方在同一个 `immediate()` 里 bump。
  - 清除某个角色时连同 sessions 一起删。
  - Task 11 追加 `listAgents`、`matchMessageIds`、`recordMemoryChange`、`scrubChangeDiffs`。
  - 两层 epoch 的复核在 Task 2 的 `applyExtractOps` 里实现。
- **C3**：入口是 `enqueue(ownerId, agentId, reason, language?)`；原来的通用 `enqueue(ownerId, job)` 改名为 `schedule`。
- **C4**：
  - `InstructionBudget.pinnedMaxChars` 是可选字段，缺省为 0，生产路径总会填。
  - `SessionContext.pinnedMemory` 由 Task 4 先加。
  - Task 9 新增 `memory.json` 的 `pinFinalWaitMs: 4000`（zod 1000–15000），作为钉住等待本句转写的上限，不用 `toolTurnTimeoutMs`。
- **C7**：`devContext` 的 `characters` 参数和 `SessionDeps.characters` 是可选的，生产代码一定传。`continuousSince` 由 Task 12 赋值。`POST /session` 的 schema 是 strict，带多余字段返回 400。Mock 台词经 `withCharacterName` 填入角色名。
- **C9**：
  - i18n 增加 `pin.trailingWords`、`list.itemEnd`。
  - 钉住时 `scanText` 结果只要不是 `allow` 就拒绝。
  - Task 9 第 0 步修正现有工具轮的取消与遗留问题（高风险，见下方「执行前已确认的高风险改动」）。
- **C10**：
  - `ftsMatch` 移到 `memory/fts.ts`，`recall.ts` 保留同名导出。
  - 逐条删除时，epoch 在删除之后、同一个事务里 bump。
  - 限流配置为 `MEMORY_RATE_LIMIT_MAX` 和 `MEMORY_RATE_LIMIT_WINDOW_MS`。
  - `Cache-Control: no-store` 已经对所有响应统一设置（`server.ts:131`）。
- **C11**：`restReminderText` 放在 `config/i18n/<lang>/memory.json`。
- **C12**：
  - `CharacterAvailability` 由 Task 13 在 `app/lib/identity/character_availability.dart` 定义。
  - `EngineSwitchController` 增加 `prepare`、`acknowledgeCrash`、`crashDisabled`。
  - App 的界面文案沿用 `engine_copy.dart` 的做法，放在 Dart 文案文件里（`memory/memory_copy.dart` 等）。
  - 每次记忆写请求返回后，无论成功失败都调用 `onMemoryChanged`。
  - `UiSubtitle` 增加可选的 `responseSeq`。
- **命令**：单文件测试用 `npm test -w gateway -- test/<file>.test.ts`（vitest 的 `-w` 是 watch）。

### 执行前已确认的高风险改动

（由用户在交付 plan 时确认，确认结果见下方；没有确认的项，执行到对应步骤时停下来询问。）
- Task 6：沉默规划器规则 8 末尾加「基本情况只当背景」；persona 里说明 `基本情况：` / `用户让你记住：` 两个标签。
- Task 9 第 0 步：工具轮在 handler 返回后重新读取原回复是否已被取消；失败结果也播 `spokenText`；不开工具轮时清掉 `pendingToolLine` / `pendingToolSpeak`。
- 确认结果：Task 6 已确认（2026-10-27）。Task 9 第 0 步仍待用户确认。

## 任务与依赖

| 文件 | Task | 内容 | 依赖 |
|---|---|---|---|
| `01-t1-protocol-contracts.md` | 1 | C1：角色 id 来源与生成器、`ResponseKind`、`SessionCreateRequest`、`memoryApi` 类型、删除 `voiceProfile` | — |
| `02-t2-memory-schema-store.md` | 2 | C2：新基线、store 作用域改造、新方法、孤儿规则、writer 带 agentId、隔离测试 | 1 |
| `03-t3-extraction-scoping.md` | 3 | C3：worker 按 agent、category 白名单、共享和私有分流、称呼纯名字、来源编号（Q36）、`extract.md` | 2 |
| `04-t4-snapshot-budget.md` | 4 | C4：三种视图加 pinnedBlock、新标签、指令预算的 pinned 段、预算比例 | 2 |
| `05-t5-character-registry.md` | 5 | C5：角色卡 schema、注册表、三张卡（zh/ja/en） | 1 |
| `06-t6-prompt-templating.md` | 6 | C6：`persona.md`、占位符替换、去风格、`RoleCatalog` 新接口、名字字面量测试 | 5 |
| `07-t7-identity-session-wiring.md` | 7 | C7：`SessionContext`、`resolve(bearer, character)`、`POST /session` body、register、删除 style 接口、音色、eval | 2, 4, 6 |
| `08-t8-first-meet-greeting.md` | 8 | C8：初次见面开场、互不知情的安全规则回归 | 7 |
| `09-t9-pin-memory.md` | 9 | C9：`TurnAccess`（等本句 final）、writer 返回 messageId、`memoryGate`、`pin_memory`、快照刷新 | 3, 4, 7 |
| `10-t10-list-forget.md` | 10 | C9：`list_memory`、`forget_memory` 改作用域、`recall_memory` 改作用域 | 9 |
| `11-t11-memory-http.md` | 11 | C10：MemoryService、四个路由、Q35/Q36 来源删除、清除范围 | 3, 7 |
| `12-t12-rest-reminder.md` | 12 | C11：连续计时、`RestReminderClock`、Director 集成、`reminder` kind | 7 |
| `13-t13-app-characters-identity.md` | 13 | C12：角色配置、生成的 id、`CharacterPickerPage`、首次注册、去风格、`POST /session` body、垫话目录 | 1, 7 |
| `14-t14-app-duix-availability.md` | 14 | C12：按角色输出可用性、置灰、准备进度、不悄悄换人、`SelectionCard` 置灰样式 | 13 |
| `15-t15-app-memory-settings.md` | 15 | C12：transport 和 store 扩展、`MemoryApi`、设置页四块、二次确认、epoch bump | 11, 13 |
| `16-t16-app-caption-reminder.md` | 16 | C12：AI 常驻提示、reminder toast | 12, 13 |
| `17-t17-probes-acceptance-docs.md` | 17 | 真实探针（A1、A2、A3、A6，三角色开场，召回回归）、手机验收、roadmap / AGENTS.md / blockers 收尾 | 1–16 |

执行顺序：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17。一个执行者按顺序做，不并行。

**中间状态说明**：Task 2–6 期间，网关的其他调用方会暂时编译不过（签名已变，调用方还没跟上）。规则如下：
- 每个任务必须让 `npm run typecheck -w gateway` 和 `npm test -w gateway` 回到全绿。
- 调用方的最小适配写在引入签名变更的那个任务里，例如 Task 2 改了 `recentUserMessages` 的签名，就由 Task 2 把 `recall.ts` 的调用补上 `agentId`。
- 适配只做到「能编译、行为等价」，完整改造留给后续任务。
- 每个任务文件的「调用方适配」一节会列出这些点。

## 共享文件（多个任务都会改，按顺序改，不要回退别人的改动）

- `gateway/src/memory/store.ts`：Task 2 主改，Task 3、9、11 追加。
- `gateway/src/session/session.ts`：Task 7 主改，Task 8、9、12 追加。
- `gateway/src/session/director.ts`：Task 8、12。
- `gateway/src/session/tools/registry.ts`：Task 9、10。
- `gateway/src/server/server.ts`、`schemas.ts`：Task 7、11。
- `gateway/src/index.ts`：Task 2、5、6、7、9、10、11、12。
- `gateway/config/memory.json`、`gateway/config/i18n/*/memory.json`：Task 4、6、9、10、12。
- `gateway/src/session/context.ts`：Task 4（加 `pinnedMemory`）、Task 7（其余字段）。
- `protocol/src/index.ts`：只有 Task 1 改。
- `app/lib/identity/app_shell.dart`：Task 13、14、15。
- `app/lib/avatar_page.dart`：Task 13、16。

## 完成定义（整个计划）

1. Task 1–16 的测试全部通过：`npm test -w protocol`、`npm test -w gateway`、`npm run typecheck -w gateway`、`cd app && flutter test`、`flutter analyze`，以及 `node scripts/generate-character-ids.mjs --check`。
2. 隔离测试全部存在并且通过（清单见 spec「测试与验收」）。
3. Task 17：
   - 真实探针的结果记入 `docs/testing/2026-10-26-multi-character-probes.md`。
   - 召回回归：「上次聊到哪儿了 / 上次聊过电影吗 / 我说过喜欢喝茶吗」，每个角色都只命中自己的数据。
   - 手机验收由用户确认。
4. `docs/project/roadmap.md` 更新状态和实际跑过的测试；`docs/blockers.md` 记录：
   - 小欣音色
   - Seeduplex 女声
   - 紧急联系人、老年人指导、数据导出等合规项
   - 探针没达标的项
5. 每个任务单独提交；推送到远程前先征得用户同意。
