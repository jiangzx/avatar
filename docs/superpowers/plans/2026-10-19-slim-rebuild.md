# 定期静默重建 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 长会话按可配置间隔做静默重建，清掉上游实时上下文；用户看到思考态，只有重连偏慢时才用当前模型原音说一句短过渡。

**Architecture:** 判定放在纯函数 `slimDecision`。`Session` 在安全缝或顺延到期时走现有 `rebuild('slim')`，不发 `model_reconnecting`。连上后按耗时决定是否 `createResponse` 一句过渡。客户端只认新的 `presence` 消息进入/离开思考态，不打开垫话。摘要语言由配置决定，进程级一套。

**Tech Stack:** Node 24 + TypeScript、zod、vitest、现有 `RealtimeAdapter`、Flutter 原生会话、`avatar-core` 状态机。

**Spec:** 2026-10-19 grilling 共享理解（本计划即规格）。费用背景见 `docs/research/qwen38-japanese-probe-and-2h-cost.md`。

## Global Constraints

- 不把对话正文、过渡句正文、摘要正文写入日志。诊断只记 `model_rebuild` 的 `reason`、耗时毫秒、是否说了过渡（布尔）。
- 可调项只进 `gateway/config/pacing.json`，zod 校验。不散落魔法数，不靠 `.env` 开关这套策略。
- 总开关 `slim.enabled=false` 时：不跑时间盒、不顺延、不说过渡。按轮次/字数的原有 slim、断线/出错重建、ledger 摘要保持今天的行为。
- slim 重建不发 `error` / `model_reconnecting`。那句「网络有点慢」只留给非 slim 重建。
- 不播放、不新增 macOS `say` 垫话。`fillersEnabled` 保持 false。同音色离线缓存不在本计划。
- 过渡句由已连接的适配器用当前 voice 说出：`instruction` 与 `fallbackText` 都带同一句。Qwen 走现有 `proactiveEvents`；Seeduplex 走 `fallbackText`。
- 中文注释保持英文且短。不改无关未提交文件。提交只在执行阶段、且用户要求时做。

---

## 文件

| 文件 | 职责 |
|---|---|
| `gateway/config/pacing.json` | 默认：开、20 分钟、顺延 2 分钟、过渡阈值 400 ms、摘要语言 `zh`、中/日过渡句 |
| `gateway/src/session/pacing.ts` | zod 扩展 |
| `gateway/src/session/slim.ts` | 纯判定：是否到期、能否重建、是否该说过渡 |
| `gateway/src/session/session.ts` | 计时、安全缝、顺延、presence、过渡 |
| `gateway/src/adapters/types.ts` | `ProactiveCue` 增加 `contextBridge` |
| `gateway/src/adapters/mock.ts` | 该 cue 播 `fallbackText` |
| `gateway/src/session/qwenSummarizer.ts` | 按语言选摘要提示 |
| `protocol/src/index.ts` | `presence` 消息 |
| `app/lib/native_gateway/protocol.dart` | 同上 |
| `app/lib/native_session/thinking_controller.dart` | 进入思考态且不武装垫话 |
| `app/lib/native_session/session_controller.dart` | 分发 `presence` |
| `avatar-core/src/avatar/stateMachine.ts` | `refreshStart` / `refreshEnd` |
| `avatar-core/src/app.ts` | 处理 `presence` |

---

### Task 1: 配置

**Files:**
- Modify: `gateway/config/pacing.json`
- Modify: `gateway/src/session/pacing.ts`
- Test: `gateway/test/pacing.test.ts`

**Interfaces:**
- Produces: `PacingConfig['slim']` 字段如下。

```ts
slim: {
  enabled: boolean;
  intervalMs: number;      // 默认 1_200_000
  maxDeferMs: number;      // 默认 120_000
  bridgeAfterMs: number;   // 默认 400
  summaryLanguage: 'zh' | 'ja';
  bridge: { zh: string; ja: string };
}
```

- [x] **Step 1: 写失败测试**

在 pacing 测试里解析一份最小 JSON，断言缺 `slim` 时 zod 失败；合法 `slim` 能读出 `intervalMs === 1_200_000`。再断言 `summaryLanguage: 'en'` 失败。

- [x] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/pacing.test.ts`
Expected: FAIL（schema 尚不认识 `slim`，或测试文件/断言对不上）

- [x] **Step 3: 实现**

`PacingSchema` 增加：

```ts
slim: z.object({
  enabled: z.boolean(),
  intervalMs: z.number().int().min(60_000).max(3_600_000),
  maxDeferMs: z.number().int().min(0).max(600_000),
  bridgeAfterMs: z.number().int().min(0).max(10_000),
  summaryLanguage: z.enum(['zh', 'ja']),
  bridge: z.object({
    zh: z.string().min(1).max(80),
    ja: z.string().min(1).max(80),
  }).strict(),
}).strict(),
```

`gateway/config/pacing.json` 的 `rebuild` 旁加入：

```json
"slim": {
  "enabled": true,
  "intervalMs": 1200000,
  "maxDeferMs": 120000,
  "bridgeAfterMs": 400,
  "summaryLanguage": "zh",
  "bridge": {
    "zh": "我想想刚才聊到哪。",
    "ja": "さっきの続きを思い出すね。"
  }
}
```

`gateway/src/index.ts` 把 `pacing.slim` 放进 `SessionDeps`。`gateway/test/pacing.test.ts` 第 34 行的 `PacingConfig` 对象字面量补上同一 `slim` 字段，否则类型检查失败。

- [x] **Step 4: 测试通过**

Run: `npm test -w gateway -- test/pacing.test.ts`
Expected: PASS

---

### Task 2: 纯判定

**Files:**
- Create: `gateway/src/session/slim.ts`
- Test: `gateway/test/slim.test.ts`

**Interfaces:**
- Consumes: Task 1 的数字，但不 import zod。
- Produces:

```ts
export interface SlimClockInput {
  enabled: boolean;
  now: number;
  dueAt: number;
  deferredSince: number | null;
  maxDeferMs: number;
  seamOpen: boolean;
}

export type SlimClockAction = 'idle' | 'defer' | 'rebuild';

export function slimClockAction(input: SlimClockInput): SlimClockAction

export function shouldSpeakBridge(elapsedMs: number, bridgeAfterMs: number, enabled: boolean): boolean
```

规则：

- `enabled === false` → 永远 `idle`。`shouldSpeakBridge` 永远 false。
- `now < dueAt` 且没有在顺延 → `idle`。
- 到期且 `seamOpen` → `rebuild`。
- 到期且缝关上、`deferredSince === null` → `defer`。
- 顺延中且缝开了 → `rebuild`。
- 顺延中、缝仍关、`now - deferredSince >= maxDeferMs` → `rebuild`。
- `shouldSpeakBridge`: `enabled && elapsedMs >= bridgeAfterMs`。

- [x] **Step 1: 写失败测试** 覆盖上面每一条。
- [x] **Step 2: 跑测试确认失败**（模块不存在）。
- [x] **Step 3: 实现 `slim.ts`。**
- [x] **Step 4: 测试通过。**

Run: `npm test -w gateway -- test/slim.test.ts`

---

### Task 3: 摘要语言

**Files:**
- Modify: `gateway/src/session/qwenSummarizer.ts`
- Test: `gateway/test/summarizer.test.ts`

**Interfaces:**
- Consumes: `summaryLanguage: 'zh' | 'ja'`
- Produces: `QwenSummarizer` 构造参数增加 `language: 'zh' | 'ja'`

提示词（整段替换系统提示，不要在日志里打印）：

- `zh`：保持现有「压缩成简洁的中文摘要……」
- `ja`：`会話を簡潔な日本語の要約にしてください。呼び名、自己紹介、人や出来事、気持ち、未完の話題を残してください。要約本文だけを出力してください。`

- [x] **Step 1: 失败测试** 用假 `fetch`，断言 `language: 'ja'` 时请求体 system 含「日本語」，`zh` 时含「中文摘要」。不断言完整用户转写被日志打印（测试只看请求体）。
- [x] **Step 2: 确认失败。**
- [x] **Step 3: 实现。** `gateway/src/index.ts` 把 `pacing.slim.summaryLanguage` 传给 `QwenSummarizer`。`MockSummarizer` 不改行为。
- [x] **Step 4: 测试通过。**

Run: `npm test -w gateway -- test/summarizer.test.ts`

---

### Task 4: 会话接线

**Files:**
- Modify: `gateway/src/session/session.ts`（`maybeSlimContext`、`rebuild`、`start`、`handleClientMessage` 的 vad / playback.stopped）
- Modify: `gateway/src/adapters/types.ts`
- Modify: `gateway/src/adapters/mock.ts`
- Modify: `gateway/src/index.ts`
- Test: `gateway/test/session.test.ts`

**Interfaces:**
- Consumes: `slimClockAction`、`shouldSpeakBridge`、`pacing.slim`、`ProactiveCue`
- Produces: slim 重建时发送 `{ type: 'presence', phase: 'refreshing' | 'ready' }`（协议类型在 Task 5 落地；本任务可先在 gateway 侧把消息写进 `ServerMessage`，Task 5 再让客户端解析。若协议必须先编译，把 Task 5 的 protocol 类型改动提前到本任务第一步。）

**行为：**

1. `SessionDeps` 增加 `slim`（Task 1 的对象）和 `now?: () => number`（测试注入，默认 `Date.now`）。
2. `start` 成功后若 `slim.enabled`：`dueAt = now() + intervalMs`，`setTimeout` 到点调用 `tickSlim()`。
3. `userSpeaking` 来自 `vad` 的 speaking/silent。安全缝 = 非工具轮、非 `userSpeaking`、非 `responseLive`、`interrupt.active === null`。
4. `playback.stopped` reason=ended 且现有 `maybeSlimContext()` 之后，再 `tickSlim()`。`vad` silent 时也 `tickSlim()`。
5. `tickSlim`：调用 `slimClockAction`。`defer` 时记下 `deferredSince` 并把计时器设到顺延截止。`rebuild` 时 `void this.rebuild('slim')`，成功后 `dueAt = now() + intervalMs`，清顺延。
6. `rebuild('slim')` 开头发送 `presence refreshing`，记下 `slimStartedAt`。不要发 `model_reconnecting`。
7. slim 连上之后：`elapsed = now() - slimStartedAt`。若 `shouldSpeakBridge`：`createResponse({ cue: 'contextBridge', instruction: line, fallbackText: line })`，不发 `presence ready`（下一句音频会把思考态带走）。否则发 `presence ready`。`line = slim.bridge[slim.summaryLanguage]`。
8. `enabled === false` 时不注册时间盒计时器。`maybeSlimContext` 的轮次/字数路径保持，仍走 `rebuild('slim')`，因此仍有思考态；但不说过渡（`shouldSpeakBridge` 在 disabled 时为 false）。断线重建仍发 `model_reconnecting`。
9. `ProactiveCue` 加 `'contextBridge'`。`MockAdapter.createResponse` 在该 cue 使用 `request.fallbackText`。其它 cue 仍走脚本表。
10. 日志：`log('model_rebuild', { reason, elapsedMs, bridge: boolean })`。不要把 `line` 放进去。

- [x] **Step 1: 失败测试**（加在 `session.test.ts`，复用 `setup` / `greetAndFinish`）

1. `slim.enabled true`、`intervalMs: 1000`、`now` 可控或 `vi.useFakeTimers`：开场播放结束后推进到到期且缝开着 → `mocks.length === 2`，消息里有 `presence refreshing`，没有 `model_reconnecting`。
2. 到期时先发 `vad speaking`：不重建；再 `vad silent`：重建。
3. 缝一直关着，推进 `maxDeferMs`：仍然重建。
4. `enabled: false` 且只推进时间、轮次不够：不重建。`rebuildAfterTurns: 1` 的现有测试仍重建且无 `model_reconnecting`。
5. 适配器 `connect` 人为拖过 `bridgeAfterMs`：重建后 mock 说出 `fallbackText`（中文默认句）。快连接：不出现这句。
6. `simulateDrop` 的现有测试仍包含 `model_reconnecting`。

- [x] **Step 2: 确认新测试失败。**
- [x] **Step 3: 实现。** 注意 `rebuild` 开头对 slim 发 presence；`finally` 里仅在 `connected && reason==='slim'` 时做过渡判定。
- [x] **Step 4: 测试通过。**

Run: `npm test -w gateway -- test/session.test.ts test/slim.test.ts`
Expected: PASS。再跑 `npm test -w gateway` 与 `npm run typecheck -w gateway`。

---

### Task 5: 客户端感知

**Files:**
- Modify: `protocol/src/index.ts`
- Modify: `app/lib/native_gateway/protocol.dart`
- Modify: `app/lib/native_session/thinking_controller.dart`
- Modify: `app/lib/native_session/session_controller.dart`
- Modify: `avatar-core/src/avatar/stateMachine.ts`
- Modify: `avatar-core/src/app.ts`
- Test: `avatar-core/test` 里状态机测试、`app/test/native_session_controller_test.dart`、`gateway` 若协议有往返测试则补一条

**Interfaces:**
- Consumes: `{ type: 'presence', phase: 'refreshing' | 'ready' }`
- Produces: 思考态，且 `_reconnecting` 保持 false（不触发 long-wait 垫话）

协议：

```ts
| { type: 'presence'; phase: 'refreshing' | 'ready' }
```

Dart：`Presence` 密封类，`parseServerMessage` 识别它。未知 phase 返回 null（丢掉，不当错误）。

`ThinkingController`：

```dart
List<ThinkCommand> onContextRefresh() {
  _phase = _Phase.thinking;
  return const [SetAvatarState('thinking')];
}

List<ThinkCommand> onContextRefreshDone() {
  if (_phase != _Phase.thinking) return const [];
  _phase = _Phase.idle;
  return const [SetAvatarState('idle')];
}
```

不要调用 `onModelReconnecting`。`session_controller` 在 `Presence` 上调用上述方法并 `emit` 状态，不 `emit(UiStatus('model_reconnecting'))`。

`stateMachine.ts`：

```ts
export type AvatarInput = ... | 'refreshStart' | 'refreshEnd';
// refreshStart: listening/idle/thinking → thinking；speaking 保持 speaking
// refreshEnd: thinking → idle；其它保持
```

`app.ts` 的 `onServerMessage` 处理 `presence`：`refreshing` → `transition` 用新输入；`ready` 同理。思考超时在 `phase===refreshing` 期间不把状态打回 idle（用一个 `refreshing` 标志挡住 `thinkingTimeout`）。

- [x] **Step 1: 失败测试**
  - 状态机：`idle + refreshStart → thinking`，`thinking + refreshEnd → idle`，`speaking + refreshStart → speaking`。
  - Flutter：收到 `presence refreshing` 后头像状态是 `thinking`，状态文案不是「网络有点慢」；`fillersEnabled` 仍为 false 时不出现 `PlayFiller`。
- [x] **Step 2: 确认失败。**
- [x] **Step 3: 实现。**
- [x] **Step 4: 通过。**

Run: `npm test -w avatar-core`；`cd app && flutter test test/native_session_controller_test.dart`
Expected: PASS

---

### Task 6: 路线图一行

**Files:**
- Modify: `docs/project/roadmap.md` 文首状态段

写明：定期静默重建计划已落地或未落地（以实际执行结果为准）、默认 20 分钟、开关在 `pacing.json` 的 `slim.enabled`、垫话仍然关闭。不要把过渡句正文写进路线图以外的日志说明里重复贴大段。本任务无新测试。执行本计划时，做完 Task 4–5 再改这一行。

---

## 明确不做

- 不录、不播本地垫话，不把 `fillersEnabled` 打开。
- 不做「同音色 PCM 缓存」。
- 不按角色分别配置语言。日语部署把 `summaryLanguage` 设为 `ja`。同一进程同时中日不在本计划。
- 不改 Seeduplex / Qwen 的音频协议。
- 不用 2 小时真会话验证费用。费用仍以研究笔记的公式为准。

## 自检

| 共享理解 | 任务 |
|---|---|
| 折中成本，20 分钟重建 | Task 1 默认 `intervalMs` |
| 安全缝，最多顺延 2 分钟 | Task 2–4 |
| 轮次/字数保险仍在 | Task 4 不改 `maybeSlimContext` 条件 |
| 总开关关掉时间盒 | Task 2 `enabled`，Task 4 测试 |
| 思考态；慢于 400 ms 才原音过渡 | Task 4–5 |
| 不发「网络有点慢」 | Task 4 测试 |
| 摘要随配置语言 | Task 3 |
| 不播 say 垫话 | 明确不做 + Task 5 不断言 PlayFiller |
