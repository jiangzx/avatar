# Task 9: 钉住记忆（pin_memory）与「等本句 final」

**目标：** 用户说「记住……」「把刚才那句记下来」时，模型调用 `pin_memory({target})`。网关不收模型改写的内容，而是取用户自己的转写：先等本句 final 进入 ledger（Qwen 的转写常比工具调用晚到），再按 `this` / `previous` 定位。内容经过告知/同意闸、问句与空内容拒绝、`scanText`、`redact`、单行化、字数和满额检查后，写入当前角色的 `pinned_memories`，带来源消息 id。网关直接播报配置的确认句（grounded `spokenText` 路径），并经 `PushGate` 在缝隙刷新本次会话的快照和钉住块。

**实现的 spec 章节：** 「语音能力 → 钉住」；技术设计 §5（写入闸、快照视图 Q33）、§6（等本句 final、来源消息 id）、§10（`pin.*`、`healthWords`）；「错误处理」（工具出错播兜底句）；「安全与隐私」（日志不记钉住文本）；附录 B（pin 文案）。

**前置：** Task 1–8 已完成（C1–C8 按总览契约落地）。本任务直接依赖：
- C2：`UserFinal`、`PinnedRow`、`MemoryStore.insertPinned` / `listPinned` / `getOwner`，`insertMessage` 带 `agentId`，`TranscriptWriter.append` 的入参带 `agentId`（Task 2 已加）。
- C4：`renderMemoryViews` 输出 `pinnedBlock`；`InstructionBudget.pinnedMaxChars`；`memory.json` 的 `pinMaxPerCharacter`、`pinMaxChars`（必填）。
- C7：`SessionContext.characterId` / `pinnedMemory`；`refreshMemorySnapshot()` 会重写 `context.pinnedMemory`；`instructions()` 把 `pinned: this.context.pinnedMemory` 传给 `buildInstructions`。

> 本任务改的 `onToolCall` / `onUserFinal` / 工具轮属于高风险区（Seeduplex 工具轮、记忆写入）。Step 0 必须先做。

## Files

- Create: `gateway/src/session/turnAccess.ts` — `TurnAccess`、`NO_TURN`、`TurnFinals`
- Create: `gateway/src/memory/userText.ts` — `oneLine`、`trimEdges`、`cleanUserLine`（Task 11 复用）
- Create: `gateway/src/session/tools/pin.ts` — `pinTool`、`pinContent`
- Create: `gateway/test/turn-access.test.ts`
- Create: `gateway/test/pin-memory.test.ts`（工具层）
- Create: `gateway/test/pin-session.test.ts`（会话层：final 先到 / 后到 / 超时 / 打断、Seeduplex 与 Qwen 播报、快照刷新）
- Modify: `gateway/src/memory/writer.ts`（当前 `:20-87`：`TranscriptWriter.append` 返回 `AppendResult`）
- Modify: `gateway/src/session/tools/registry.ts`（当前 `:18-153`：`ToolContext`、`ToolOutcome`、`ToolRegistryOptions`、注册 `pinTool`）
- Modify: `gateway/src/session/session.ts`（行号为 Task 7 之前的位置，执行时按符号定位）：
  - `SessionDeps`（`:71-142`）
  - 字段区（`:166-290`）
  - `vad` 分支（`:447-487`）
  - `end()`（`:579-600`）
  - `toolsFor()`（`:768-786`）
  - `finalize()`（`:1060-1076`）
  - `onUserFinal()`（`:1078-1132`）
  - `onToolCall()`（`:1180-1248`）
  - `releaseToolTurn()`（`:1313-1330`）
  - `rebuild()`（`:1353`，函数开头）
- Modify: `gateway/src/i18n/types.ts`（`:79-91` `MemoryCopy`，新增 `PinCopy`）
- Modify: `gateway/src/i18n/load.ts`（`:40-115` `MemoryFileSchema`，`:241-270` `loadMemoryCopy`）
- Modify: `gateway/config/i18n/zh/memory.json`、`ja/memory.json`、`en/memory.json`（新增 `pin`、`healthWords`）
- Modify: `gateway/src/index.ts`（`:131-188` Session deps：新增 `pin`）
- Modify: `gateway/test/seeduplex.test.ts`（新增一个 direct-TTS 用例）
- Modify（调用方适配）：`gateway/test/transcript-writer.test.ts`、`memory-tools.test.ts`、`memory-acceptance.test.ts`、`manager.test.ts`、`multilingual.test.ts`、`session.test.ts`、`weather.test.ts`，以及 `docs/testing/plan3-qwen-memory-probe.mjs`、`docs/testing/plan3-multilingual-recall-probe.mjs`

## Interfaces

**Consumes**
- C2：`UserFinal { text: string; messageId: string | null }`；`PinnedRow { id; text; sensitive; createdAt }`；`MemoryStore.listPinned(ownerId, agentId): PinnedRow[]`（新的在前）；`MemoryStore.insertPinned(row: { id; ownerId; agentId; text; sensitive; sourceSessionId; sourceMessageId: string | null; now })`；`MemoryStore.getOwner(ownerId)`（`memoryConsent`、`notifiedAt`）。
- C4：`MemoryBudgetConfig.pinMaxPerCharacter: number`、`pinMaxChars: { zh: number; ja: number; en: number }`。
- C7：`SessionContext.characterId: CharacterId`、`SessionContext.pinnedMemory?: string`。
- 现有：`runWithPolicy`（`src/reliability/policy.ts:39`）、`scanText`（`src/memory/scan.ts:6`）、`redact`（`src/memory/redact.ts:33`）、`containsPhrase`（`src/i18n/text.ts:9`）、`PushGate.request`（`src/session/pushGate.ts:42`）、`unique`（`src/unique.ts`）。

**Produces**（C9，原样）
```ts
// gateway/src/session/turnAccess.ts（registry.ts 再 re-export TurnAccess）
export interface TurnAccess {
  currentFinal(timeoutMs: number): Promise<UserFinal | null>; // resolves when this turn's user final has arrived; null on timeout or interruption
  previousFinal(): UserFinal | null;                          // the user final before this turn's
}
// ToolContext 新增
characterId: CharacterId;
turn: TurnAccess;
memoryGate(): 'ok' | 'declined' | 'notice_pending';
// ToolOutcome 新增
refreshSnapshot?: boolean;
// TranscriptWriter
append(...): { result: 'stored' | 'skipped' | 'rejected'; messageId?: string };
// 新工具
export function pinTool(options: PinOptions): ToolHandler; // gateway/src/session/tools/pin.ts, name 'pin_memory'
```
本任务额外导出（私有辅助，不属于冻结契约）：`NO_TURN`、`TurnFinals`、`AppendResult`、`pinContent`、`PinOptions`、`PinCopy`、`oneLine`、`trimEdges`、`cleanUserLine`、`ToolRegistryOptions.pinLimits` / `healthWords` / `turnFinalTimeoutMs`、`SessionDeps.pin`。

## 设计要点（实现者必读）

1. **「本句」的定义**：沿用 `Session.turnUserText` 的生命周期。每条用户 final（存入 ledger 的，或 `dropUserFinals` 时被丢弃的）都成为「当前 final」；在 `turnUserText = null` 的两处（`finalize()`、`releaseToolTurn()`）同时清掉。工具调用到达时，`TurnFinals.access()` 把当时的当前 final 绑定到这次调用：已有就立即返回，没有就等下一条 final。
2. **等待上限**：新配置 `pinFinalWaitMs`（`config/memory.json`，默认 4000，zod 限定 1000–15000）。不用 `toolTurnTimeoutMs`（15000）：等 15 秒期间用户听不到任何声音。超时走共享策略 `runWithPolicy('turn_final', { timeoutMs, retries: 0, ... })`，日志只有 `policy_failed{name:'turn_final', code:'turn_final_timeout'}`。
3. **打断 / 结束**：本地 VAD 的 `speaking` 边沿（新的一句话开始）、`rebuild()`、`end()` 都调用 `TurnFinals.interrupt()`，等待中的调用立即得到 `null`，不留悬挂。契约写的是 null，不是 reject（spec §6 写的 reject 以契约为准）。只用**本地** VAD 边沿，不用适配器的 `userSpeechStarted`：Seeduplex 的 `userSpeechStarted` 来自 `input_audio_transcription.started`，可能晚于本句的工具调用。
4. **`previous` 相对 ledger 定义**：读 `ledger.recent` 里的用户行。本句已进 ledger 时，它是最新一条，`previous` 取倒数第二条；本句被 `dropUserFinals` 丢掉时，`previous` 取最新一条。被「忘掉」或拒绝记忆清空的行自然不在 ledger 里，返回 null。消息 id 从 Session 记下的最近两条已入 ledger 的 final 里按文本匹配，匹配不到就是 null（删除时退回匹配，Q36）。
5. **来源 id**：`TranscriptWriter.append` 返回 `{ result, messageId }`；`dropUserFinals` 时本句不写 `messages`，`messageId` 为 null。
6. **写入闸顺序**：参数校验 → 记忆可用 → `memoryGate()`（已拒绝 / 告知未播完）→ 满额 → 等本句 final → 定位 → 去触发词（只对 `this`）→ 少于 2 字 → 问句或轻回应 → `cleanUserLine`（`scanText` 非 `allow` 一律拒绝，含 `degrade` / `mark`，因为钉住文本会原样进提示词）→ 超字数 → 重复（只确认，不重复写）→ 健康词判敏感 → `insertPinned`。
7. **播报**：成功返回 `{ ok: true, spokenText: confirmText, spokenFound: true, refreshSnapshot: true }`；所有拒绝返回 `{ ok: false, error: 'pin_*', spokenText, spokenFound: false }`。Session 现在对 `ok: false` 也接收 `spokenText`（原来只有成功才接收），走 grounded 路径：Seeduplex 直接 TTS `fallbackText`，Qwen 用「请直接说下面这句话，不要改写：」。不用 `confirmText` 字段（那条路径会把确认句当指令原样发给 Qwen，可能被改写）。不可用（`memory_unavailable`、`invalid_args`）不带 `spokenText`，走现有的通用续答。超时和打断在 `TurnAccess` 层都是 null，工具层都返回 `pin_no_final`；打断时原回复已被取消，Session 不开工具轮（见第 9 条），所以这句不会播出。
8. **快照刷新**：`refreshSnapshot` 为 true 时 Session 调 `refreshMemorySnapshot()`，再 `gate.request({ instructions: true })`。工具轮期间缝隙是关的，推送在续答播完后的缝隙发出（坑位第 12 条）。
9. **被打断的工具轮**：`onToolCall` 在 handler 返回后重新读一次 `interrupt.isCancelled(s.seq)`。原先只在调用那一刻读，handler 等待期间原回复被打断，仍会开工具轮；被取消的原回复不会再来 `responseDone`，工具轮只能等超时，期间 `handleMicAudio` 丢弃用户的新话。只改非 slow 分支，slow（forget / decline）分支不动。同时，不开工具轮时不再写 `pendingToolLine` / `pendingToolSpeak`：没人会念它们，留着会被下一个工具轮误用（原代码在调用时就已取消的情况下也有这个泄漏，一并修掉）。
10. **日志**：只记 `memory_pinned{sensitive, count}` 和现有的 `tool_invoked{name, ok, code}`。钉住的文本、用户 final 一律不进日志。

## 调用方适配

| 位置 | 断在哪 | 修法 |
|---|---|---|
| `src/session/session.ts` `flush()`、`onUserFinal()` | `append` 返回值类型变了 | `flush()` 不用返回值，不改；`onUserFinal()` 读 `.messageId`（Step 15） |
| `test/transcript-writer.test.ts`（`:45-47,60,71,82-83,104-105,127-128`） | `.toBe('stored' / 'skipped' / 'rejected')` | 改成 `expect(writer.append(...).result).toBe('stored')` 这一形式（Step 6 给出替换规则） |
| `test/memory-tools.test.ts`（`:695,710`） | 同上 | 同上 |
| `test/memory-acceptance.test.ts`（`:275`） | 同上 | 同上 |
| `test/manager.test.ts`（`:133`） | `vi.fn<TranscriptWriter['append']>(() => 'stored')` | `() => ({ result: 'stored' as const })` |
| `test/multilingual.test.ts`（`:320,336`）、`test/session.test.ts`（`:1268-1396` 共 7 处） | `append: () => 'stored'` | `append: () => ({ result: 'stored' as const })` |
| `test/memory-tools.test.ts` `ctxFor`（`:91-107`）、`test/weather.test.ts`（`:73-82`）、`test/multilingual.test.ts` `toolCtx`（`:396-398`） | `ToolContext` 新增必填字段 | 加 `characterId: 'xiaonuan', turn: NO_TURN, memoryGate: () => 'ok' as const`，并 `import { NO_TURN } from '../src/session/turnAccess.ts'` |
| `docs/testing/plan3-qwen-memory-probe.mjs`（`:66-70`） | `append(...) === 'stored'`（运行时才会坏，Task 17 要跑） | 改成 `append(...).result === 'stored'` / `'skipped'` |
| `docs/testing/plan3-multilingual-recall-probe.mjs` `toolContext`（约 `:92`） | `ToolContext` 新字段（recall 不读，但保持形状一致） | 加 `characterId: 'xiaonuan', turn: { currentFinal: async () => null, previousFinal: () => null }, memoryGate: () => 'ok'` |

以上行号是 Task 2–8 之前的位置；Task 2 给 `append` 入参加 `agentId` 后行号会漂移，按下面的 grep 定位：

```bash
grep -rn "append: () => 'stored'\|=> 'stored')\|toBe('stored')\|toBe('skipped')\|toBe('rejected')" gateway/test
grep -rn "actions: new ActionRouter()" gateway/test
grep -n "append(" docs/testing/plan3-qwen-memory-probe.mjs
```

## Steps

- [x] **Step 0: 高风险区确认**

读 `docs/project/roadmap.md` 的「记忆与回忆：已踩过的坑」1–12 和「打断与沉默：已踩过的坑」1–11。向用户说明本任务会改：
1. `onUserFinal()`：记录 final 和消息 id；
2. `onToolCall()`：handler 返回后重读取消状态；失败结果也接收 `spokenText`；
3. 本地 VAD speaking 边沿让等待中的钉住返回 null。

得到用户确认后再继续。没确认就停在这里，按 AGENTS.md 第 7 条记录。

- [x] **Step 1: 写 `TurnFinals` 的失败测试**

`gateway/test/turn-access.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationLedger } from '../src/session/ledger.ts';
import { NO_TURN, TurnFinals } from '../src/session/turnAccess.ts';

function setup() {
  const ledger = new ConversationLedger();
  const turns = new TurnFinals(() => ledger.recent);
  /** What Session does for a final that enters the ledger. */
  const stored = (text: string, id: string | null) => {
    ledger.addUser(text, Date.now());
    turns.onFinal(text, id, true);
  };
  return { ledger, turns, stored };
}

describe('TurnFinals', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns a final that arrived before the tool call at once', async () => {
    const { turns, stored } = setup();
    stored('记住我女儿叫小芳', 'm1');
    await expect(turns.access().currentFinal(3_000)).resolves.toEqual({ text: '记住我女儿叫小芳', messageId: 'm1' });
  });

  it('waits for a final that arrives after the tool call', async () => {
    const { turns, stored } = setup();
    const pending = turns.access().currentFinal(3_000);
    stored('记住我女儿叫小芳', 'm2');
    await expect(pending).resolves.toEqual({ text: '记住我女儿叫小芳', messageId: 'm2' });
  });

  it('gives null on timeout, and a later final does not reach the timed-out call', async () => {
    const { turns, stored } = setup();
    const access = turns.access();
    const pending = access.currentFinal(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toBeNull();
    stored('迟到的一句', 'm3');
    expect(access.previousFinal()).toBeNull();
  });

  it('gives null when interrupted, and never hangs', async () => {
    const { turns } = setup();
    const pending = turns.access().currentFinal(3_000);
    turns.interrupt();
    await expect(pending).resolves.toBeNull();
  });

  it('does not bind a tool call to a final from a closed turn', async () => {
    const { turns, stored } = setup();
    stored('上一轮的话', 'm1');
    turns.onTurnClosed();
    const pending = turns.access().currentFinal(3_000);
    stored('把刚才那句记下来', 'm2');
    await expect(pending).resolves.toEqual({ text: '把刚才那句记下来', messageId: 'm2' });
  });

  it('reads previous from the ledger, with the message id of that line', async () => {
    const { turns, stored } = setup();
    stored('我孙子下个月结婚', 'm1');
    turns.onTurnClosed();
    stored('把刚才那句记下来', 'm2');
    const access = turns.access();
    await access.currentFinal(3_000);
    expect(access.previousFinal()).toEqual({ text: '我孙子下个月结婚', messageId: 'm1' });
  });

  it('uses the newest ledger line as previous when this final was dropped', async () => {
    const { turns, stored } = setup();
    stored('我孙子下个月结婚', 'm1');
    turns.onTurnClosed();
    const access = turns.access();
    const pending = access.currentFinal(3_000);
    turns.onFinal('把刚才那句记下来', null, false);
    await expect(pending).resolves.toEqual({ text: '把刚才那句记下来', messageId: null });
    expect(access.previousFinal()).toEqual({ text: '我孙子下个月结婚', messageId: 'm1' });
  });

  it('has no previous after the ledger forgot that line', async () => {
    const { ledger, turns, stored } = setup();
    stored('我孙子下个月结婚', 'm1');
    turns.onTurnClosed();
    stored('把刚才那句记下来', 'm2');
    ledger.clear();
    const access = turns.access();
    await access.currentFinal(3_000);
    expect(access.previousFinal()).toBeNull();
  });

  it('keeps a null message id when the line was never written', async () => {
    const { turns, stored } = setup();
    stored('没写进库的话', null);
    turns.onTurnClosed();
    stored('把刚才那句记下来', 'm2');
    const access = turns.access();
    await access.currentFinal(3_000);
    expect(access.previousFinal()).toEqual({ text: '没写进库的话', messageId: null });
  });

  it('NO_TURN never yields a final', async () => {
    await expect(NO_TURN.currentFinal(10)).resolves.toBeNull();
    expect(NO_TURN.previousFinal()).toBeNull();
  });
});
```

- [x] **Step 2: 运行，确认失败**

```bash
npm test -w gateway -- test/turn-access.test.ts
```

Expected：FAIL，`Cannot find module '../src/session/turnAccess.ts'`。

- [x] **Step 3: 实现 `turnAccess.ts`**

`gateway/src/session/turnAccess.ts`：

```ts
import type { UserFinal } from '../memory/store.ts';
import { runWithPolicy } from '../reliability/policy.ts';
import type { LedgerEntry } from './ledger.ts';

/** What a tool may read about the user's own words in its turn (spec §6). */
export interface TurnAccess {
  /** Resolves when this turn's user final has arrived; null on timeout or interruption. */
  currentFinal(timeoutMs: number): Promise<UserFinal | null>;
  /** The user final before this turn's, read from the ledger; null when unknown. */
  previousFinal(): UserFinal | null;
}

/** For tool calls outside a live session turn (unit tests, probes). */
export const NO_TURN: TurnAccess = {
  currentFinal: () => Promise.resolve(null),
  previousFinal: () => null,
};

interface SeenFinal extends UserFinal {
  /** False when dropUserFinals kept the line out of the ledger and the transcript. */
  inLedger: boolean;
}

type Waiter = (final: SeenFinal | null) => void;

/**
 * Session-side record of user finals. Qwen often sends the transcript after the tool call,
 * so a tool may have to wait for its own turn's final. Holds text in memory only; never logs it.
 */
export class TurnFinals {
  /** Final of the turn in progress; cleared where Session clears turnUserText. */
  private current: SeenFinal | null = null;
  /** Last two finals that entered the ledger, oldest first. */
  private readonly recent: SeenFinal[] = [];
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly ledger: () => readonly LedgerEntry[]) {}

  /** Every user final, stored or dropped. messageId is null when nothing was written. */
  onFinal(text: string, messageId: string | null, inLedger: boolean): void {
    const final: SeenFinal = { text, messageId, inLedger };
    this.current = final;
    if (inLedger) {
      this.recent.push(final);
      if (this.recent.length > 2) this.recent.shift();
    }
    this.settle(final);
  }

  /** The reply for this turn is over: the next tool call belongs to a new turn. */
  onTurnClosed(): void {
    this.current = null;
  }

  /** New utterance, rebuild, or session end: waiting tools get null instead of hanging. */
  interrupt(): void {
    this.settle(null);
  }

  /** Binds to the turn in progress at tool-call time. */
  access(): TurnAccess {
    let mine = this.current;
    return {
      currentFinal: async (timeoutMs) => {
        if (!mine) mine = await this.next(timeoutMs);
        return mine ? { text: mine.text, messageId: mine.messageId } : null;
      },
      previousFinal: () => (mine ? this.previousOf(mine) : null),
    };
  }

  /** Waits through the shared policy helper, so the timeout is logged like every other one. */
  private async next(timeoutMs: number): Promise<SeenFinal | null> {
    const box: { waiter?: Waiter } = {};
    const result = await runWithPolicy(
      'turn_final',
      { timeoutMs, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
      () => new Promise<SeenFinal | null>((resolve) => {
        box.waiter = resolve;
        this.waiters.add(resolve);
      }),
    );
    if (box.waiter) this.waiters.delete(box.waiter);
    return result.ok ? result.value : null;
  }

  private settle(final: SeenFinal | null): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiting) resolve(final);
  }

  /** A stored final is the newest ledger user line, so previous is the one before it. */
  private previousOf(mine: SeenFinal): UserFinal | null {
    const users = this.ledger().filter((entry) => entry.role === 'user');
    const entry = users.at(mine.inLedger ? -2 : -1);
    if (!entry) return null;
    const match = [...this.recent].reverse().find((final) => final !== mine && final.text === entry.text);
    return { text: entry.text, messageId: match?.messageId ?? null };
  }
}
```

> `UserFinal` 按 C2 从 `gateway/src/memory/store.ts` 导出。如果 Task 2 放在别的文件，只改这一行 import。

- [x] **Step 4: 运行，确认通过**

```bash
npm test -w gateway -- test/turn-access.test.ts
```

Expected：PASS（10 tests）。

- [x] **Step 5: 写 writer 返回 messageId 的失败测试**

在 `gateway/test/transcript-writer.test.ts` 末尾的 `describe` 里加一个用例（`turn`、`told` 等辅助沿用该文件 Task 2 之后的写法；下面用 C2 的 `createOwner` / `ensureAgent` 自建数据，不依赖文件里的辅助）：

```ts
  it('returns the stored message id so a pin can point at its source line', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    const store = new SqliteMemoryStore(db);
    const { ownerId } = store.createOwner({ tokenHash: 'h-writer-id', now: 1 });
    const agent = store.ensureAgent(ownerId, 'xiaonuan', 1);
    store.markNotified(ownerId, 2);
    const writer = new SqliteTranscriptWriter(store);
    const out = writer.append({ ownerId, agentId: agent.id, sessionId: 's1', role: 'user', text: '我女儿叫小芳', now: 3 });
    expect(out.result).toBe('stored');
    const row = db.prepare("SELECT id FROM messages WHERE text = '我女儿叫小芳'").get() as { id: string };
    expect(out.messageId).toBe(row.id);
    store.setConsent(ownerId, 'declined', 4);
    expect(writer.append({ ownerId, agentId: agent.id, sessionId: 's1', role: 'user', text: '不该写', now: 5 })).toEqual({ result: 'skipped' });
    db.close();
  });
```

文件头确认已有 `openDatabase`、`SqliteMemoryStore`、`SqliteTranscriptWriter` 的 import，没有就补上：

```ts
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { SqliteTranscriptWriter } from '../src/memory/writer.ts';
```

- [x] **Step 6: 运行，确认失败**

```bash
npm test -w gateway -- test/transcript-writer.test.ts
```

Expected：新用例 FAIL（`out.result` 是 undefined，`append` 还返回字符串）。

- [x] **Step 7: 实现 writer 返回值，并完成调用方适配**

`gateway/src/memory/writer.ts`：

1. 在 `TranscriptWriter` 接口上方加类型，并把接口和实现的返回类型都改成它：

```ts
/** Outcome of one transcript write; messageId is set only when a row was stored. */
export interface AppendResult {
  result: 'stored' | 'skipped' | 'rejected';
  messageId?: string;
}
```

接口里 `append(input: {...}): 'stored' | 'skipped' | 'rejected';` 改为 `append(input: {...}): AppendResult;`，`SqliteTranscriptWriter.append` 的签名同样改。

2. `SqliteTranscriptWriter.append` 的函数体（Task 2 / Task 3 之后的版本）只改三处：
   - `return 'skipped';` → `return { result: 'skipped' };`
   - `return 'rejected';` → `return { result: 'rejected' };`
   - `insertMessage` 之前把 id 提成局部变量，`insertMessage` 用它，最后返回它：

```ts
    const messageId = randomUUID();
    this.store.insertMessage({
      id: messageId,
      // ...其余字段保持 Task 2 之后的写法（sessionId、ownerId、agentId、role、text、bigrams、now）
    });
    // degrade 分支保持不变
    return { result: 'stored', messageId };
```

3. 测试适配（规则，按 grep 结果逐处改）：
   - `expect(writer.append(X)).toBe('stored')` → `expect(writer.append(X).result).toBe('stored')`；`'skipped'`、`'rejected'` 同理。
   - `append: () => 'stored'` → `append: () => ({ result: 'stored' as const })`。
   - `test/manager.test.ts`：`vi.fn<TranscriptWriter['append']>(() => 'stored')` → `vi.fn<TranscriptWriter['append']>(() => ({ result: 'stored' }))`。
   - `docs/testing/plan3-qwen-memory-probe.mjs`：`append('user', user) === 'skipped'` → `append('user', user).result === 'skipped'`，另外两处 `=== 'stored'` 同理。

```bash
grep -rn "append: () => 'stored'\|=> 'stored')\|toBe('stored')\|toBe('skipped')\|toBe('rejected')" gateway/test
```

Expected：改完后 grep 只剩 `.result).toBe(...)` 形式。

- [x] **Step 8: 运行，确认通过**

```bash
npm test -w gateway -- test/transcript-writer.test.ts test/manager.test.ts test/memory-acceptance.test.ts
npm run typecheck -w gateway
```

Expected：PASS；typecheck 0 错误（`session.ts` 没用返回值，类型兼容）。

- [x] **Step 9: 提交**

```bash
git add gateway/src/session/turnAccess.ts gateway/test/turn-access.test.ts \
  gateway/src/memory/writer.ts gateway/test/transcript-writer.test.ts gateway/test/manager.test.ts \
  gateway/test/memory-acceptance.test.ts gateway/test/memory-tools.test.ts gateway/test/multilingual.test.ts \
  gateway/test/session.test.ts docs/testing/plan3-qwen-memory-probe.mjs
git commit -m "feat(memory): wait for the turn's own final and return message ids

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [x] **Step 10: 写 pin 文案配置的失败测试**

`gateway/test/pin-memory.test.ts`（先只放配置用例，Step 13 再追加工具用例）：

```ts
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@anyidea/protocol';
import { loadI18n } from '../src/i18n/load.ts';

const i18n = loadI18n(fileURLToPath(new URL('../config', import.meta.url)));

describe('pin copy', () => {
  it('ships the appendix B zh copy and the trigger list', () => {
    const pin = i18n.memory.zh.pin;
    expect(pin.confirmText).toBe('好，这个我记住了。');
    expect(pin.emptyText).toBe('没听清要记什么，您再说一遍？');
    expect(pin.fullText).toBe('我记的事有点多了，您可以在设置里删掉一些，再让我记。');
    expect(pin.tooLongText).toBe('这句有点长，您挑最要紧的再跟我说一遍？');
    expect(pin.declinedText).toBe('您之前说过不用我记，这个我就不记了。');
    expect(pin.noticePendingText).toBe('这个等会儿再跟我说一遍。');
    expect(pin.triggerPrefixes).toEqual(['记住', '你要记住', '帮我记着', '帮我记住', '你记一下', '别忘了', '记下来']);
  });

  it('has every pin field and health words in every language', () => {
    for (const language of LANGUAGES) {
      const memory = i18n.memory[language];
      for (const text of [memory.pin.confirmText, memory.pin.emptyText, memory.pin.fullText, memory.pin.tooLongText,
        memory.pin.declinedText, memory.pin.noticePendingText, memory.pin.toolDescription, memory.pin.targetDescription]) {
        expect(text.length).toBeGreaterThan(0);
      }
      expect(memory.pin.triggerPrefixes.length).toBeGreaterThan(0);
      expect(memory.healthWords.length).toBeGreaterThan(0);
    }
  });

  it('never names a character in the tool copy', () => {
    for (const language of LANGUAGES) {
      const text = `${i18n.memory[language].pin.toolDescription}${i18n.memory[language].pin.targetDescription}`;
      for (const name of ['小暖', '小凯', '小欣', 'Xiaonuan', 'Xiaokai', 'Xiaoxin']) expect(text).not.toContain(name);
    }
  });
});
```

运行：

```bash
npm test -w gateway -- test/pin-memory.test.ts
```

Expected：FAIL，`i18n.memory.zh.pin` 是 undefined（TypeScript 层面 vitest 不做类型检查，运行时报 `Cannot read properties of undefined`）。

- [x] **Step 11: 实现 pin 文案的类型、校验和三种语言的配置**

`gateway/src/i18n/types.ts`，在 `MemoryCopy` 上方加：

```ts
/** pin_memory copy and word lists (spec 附录 B). */
export interface PinCopy {
  confirmText: string;
  emptyText: string;
  fullText: string;
  tooLongText: string;
  declinedText: string;
  noticePendingText: string;
  /** Removed from the start of a "this" line, longest first, repeatedly. */
  triggerPrefixes: readonly string[];
  /** Trigger and filler words removed from the end of a "this" line, longest first, repeatedly. */
  trailingWords: readonly string[];
  toolDescription: string;
  targetDescription: string;
}
```

`MemoryCopy` 里加两个字段：

```ts
  pin: PinCopy;
  /** A pinned line that contains one of these is sensitive (kept out of greeting/proactive views). */
  healthWords: readonly string[];
```

`gateway/src/i18n/load.ts`：`MemoryFileSchema` 的 `extractLabels` 后面加：

```ts
  pin: z.object({
    confirmText: z.string().min(1).max(80),
    emptyText: z.string().min(1).max(80),
    fullText: z.string().min(1).max(120),
    tooLongText: z.string().min(1).max(80),
    declinedText: z.string().min(1).max(80),
    noticePendingText: z.string().min(1).max(80),
    triggerPrefixes: PhraseList,
    trailingWords: StringList,
    toolDescription: z.string().min(1),
    targetDescription: z.string().min(1),
  }).strict(),
  healthWords: PhraseList,
```

`loadMemoryCopy` 的返回对象里，`extractLabels: raw.extractLabels,` 后面加：

```ts
    pin: raw.pin,
    healthWords: raw.healthWords,
```

`gateway/config/i18n/zh/memory.json`，在 `extractLabels` 之后（最后一个键后加逗号）加：

```json
  "pin": {
    "confirmText": "好，这个我记住了。",
    "emptyText": "没听清要记什么，您再说一遍？",
    "fullText": "我记的事有点多了，您可以在设置里删掉一些，再让我记。",
    "tooLongText": "这句有点长，您挑最要紧的再跟我说一遍？",
    "declinedText": "您之前说过不用我记，这个我就不记了。",
    "noticePendingText": "这个等会儿再跟我说一遍。",
    "triggerPrefixes": ["记住", "你要记住", "帮我记着", "帮我记住", "你记一下", "别忘了", "记下来"],
    "trailingWords": ["你可得记住", "你可记住了", "你记住了吗", "你记住了没", "你记住了", "记住了吗", "记住了没", "记住了", "你要记住", "你记住", "帮我记着", "帮我记住", "你记一下", "记一下", "记着", "记住", "别忘了", "记下来", "啊", "呀", "吧", "哦", "哈", "啦", "嘛", "呢", "噢", "哟"],
    "toolDescription": "用户明确要你记住某件事时调用，比如让你记住他这句话，或者把他上一句记下来。只传 target，不要转述或改写内容，网关会取用户的原话。调用后只说网关给的那一句。",
    "targetDescription": "this=用户这一句里就有要记的内容；previous=用户要你记住他上一句说的话"
  },
  "healthWords": ["血压", "血糖", "糖尿病", "心脏", "心梗", "冠心病", "中风", "脑梗", "癌", "肿瘤", "化疗", "吃药", "药", "降压", "胰岛素", "医院", "住院", "看病", "门诊", "手术", "复查", "体检", "病", "疼", "痛", "头晕", "失眠", "胸闷", "骨折", "关节", "膝盖", "腰椎", "颈椎", "过敏", "抑郁", "焦虑", "老年痴呆", "阿尔茨海默"]
```

`gateway/config/i18n/ja/memory.json`：

```json
  "pin": {
    "confirmText": "はい、ちゃんと覚えておきますね。",
    "emptyText": "何を覚えればいいか、聞き取れませんでした。もう一度言ってもらえますか？",
    "fullText": "覚えていることがだいぶ増えました。設定で少し消してから、また頼んでくださいね。",
    "tooLongText": "少し長いですね。いちばん大事なところだけ、もう一度言ってもらえますか？",
    "declinedText": "前に覚えなくていいと言われたので、これは覚えないでおきますね。",
    "noticePendingText": "それは、少しあとでもう一度言ってくださいね。",
    "triggerPrefixes": ["覚えておいてほしいんだけど", "覚えておいてね", "覚えておいて", "覚えといて", "覚えてて", "覚えて", "忘れないでね", "忘れないで", "メモしておいて", "メモして"],
    "trailingWords": ["って覚えておいてね", "って覚えておいて", "って覚えといて", "って覚えてて", "って覚えて", "を覚えておいてね", "を覚えておいて", "を覚えといて", "を覚えてて", "を覚えて", "覚えておいてね", "覚えておいて", "覚えといてね", "覚えといて", "覚えててね", "覚えてて", "覚えてね", "覚えて", "忘れないでね", "忘れないで", "メモしておいて", "メモして", "ね", "よ"],
    "toolDescription": "ユーザーがはっきり何かを覚えておいてと頼んだときに呼びます。いまの一言を覚えてほしいときや、一つ前に言ったことを覚えてほしいときです。target だけを渡し、内容を言い換えないでください。ゲートウェイがユーザー本人の言葉を使います。呼んだあとは、ゲートウェイが返す一文だけを言ってください。",
    "targetDescription": "this=このユーザーの発言に覚える内容が入っている。previous=ユーザーが一つ前に言ったことを覚えてほしい"
  },
  "healthWords": ["血圧", "血糖", "糖尿病", "心臓", "心筋梗塞", "脳卒中", "脳梗塞", "がん", "癌", "腫瘍", "抗がん剤", "薬", "インスリン", "病院", "入院", "通院", "診察", "手術", "検査", "健診", "病気", "痛い", "痛み", "めまい", "不眠", "骨折", "関節", "膝", "腰痛", "アレルギー", "うつ", "不安", "認知症"]
```

`gateway/config/i18n/en/memory.json`：

```json
  "pin": {
    "confirmText": "Okay, I'll remember that.",
    "emptyText": "Sorry, I didn't catch what to remember. Could you say it again?",
    "fullText": "I'm already holding on to quite a lot. You can delete a few in Settings, then ask me again.",
    "tooLongText": "That's a bit long. Could you tell me just the most important part?",
    "declinedText": "You told me before not to keep notes, so I won't remember this one.",
    "noticePendingText": "Tell me that again in a little while.",
    "triggerPrefixes": ["please remember that", "please remember", "remember that", "remember", "don't forget that", "don't forget", "make a note that", "note that", "keep in mind that"],
    "trailingWords": ["remember that", "don't forget that", "don't forget", "please", "okay", "ok"],
    "toolDescription": "Call when the user clearly asks you to remember something: what they are saying now, or what they said just before. Pass only target and never paraphrase the content; the gateway uses the user's own words. After calling, say only the line the gateway returns.",
    "targetDescription": "this=the thing to remember is in this user line; previous=the user wants you to remember what they said just before"
  },
  "healthWords": ["blood pressure", "blood sugar", "diabetes", "heart", "stroke", "cancer", "tumor", "chemo", "medicine", "medication", "pill", "pills", "insulin", "hospital", "clinic", "doctor", "surgery", "operation", "checkup", "illness", "sick", "pain", "hurts", "dizzy", "insomnia", "fracture", "arthritis", "knee", "back pain", "allergy", "allergic", "depression", "anxiety", "dementia"]
```

运行：

```bash
npm test -w gateway -- test/pin-memory.test.ts test/i18n.test.ts
```

Expected：PASS。

- [x] **Step 12: 写 pin 工具的失败测试**

在 `gateway/test/pin-memory.test.ts` 追加（顶部 import 合并到文件头）：

```ts
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore, type UserFinal } from '../src/memory/store.ts';
import { ActionRouter } from '../src/session/actions.ts';
import { ConversationLedger } from '../src/session/ledger.ts';
import { createToolRegistry, type ToolContext } from '../src/session/tools/registry.ts';
import { pinContent } from '../src/session/tools/pin.ts';
import type { TurnAccess } from '../src/session/turnAccess.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });

function seed() {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  const store = new SqliteMemoryStore(db);
  const { ownerId } = store.createOwner({ tokenHash: `h-pin-${dbs.length}`, now: 1 });
  const agent = store.ensureAgent(ownerId, 'xiaonuan', 1);
  return { db, store, ownerId, agentId: agent.id };
}

/** Stub turn: counts waits so the gate tests can prove they never waited. */
function turn(current: UserFinal | null, previous: UserFinal | null = null): TurnAccess & { waited: number } {
  const stub = {
    waited: 0,
    currentFinal: async () => { stub.waited++; return current; },
    previousFinal: () => previous,
  };
  return stub;
}

function ctx(s: ReturnType<typeof seed>, t: TurnAccess, gate: 'ok' | 'declined' | 'notice_pending' = 'ok'): ToolContext {
  return {
    ownerId: s.ownerId,
    agentId: s.agentId,
    characterId: 'xiaonuan',
    sessionId: 'live-1',
    store: s.store,
    ledger: new ConversationLedger(),
    actions: new ActionRouter(),
    now: 10_000,
    turn: t,
    memoryGate: () => gate,
  };
}

function registry(language: 'zh' | 'ja' | 'en' = 'zh', maxPerCharacter = 3) {
  return createToolRegistry({
    language,
    memory: i18n.memory[language],
    evidence: i18n.evidence,
    recentQueries: i18n.recentQueries,
    recallPrompt: 'FIXTURE RECALL',
    safety: i18n.safety,
    clipChars: 80,
    phraseTimeoutMs: 1_500,
    pinLimits: { maxPerCharacter, maxChars: language === 'zh' ? 40 : language === 'ja' ? 50 : 100 },
    turnFinalTimeoutMs: 3_000,
  });
}

const zh = i18n.memory.zh.pin;
const texts = (s: ReturnType<typeof seed>) => s.store.listPinned(s.ownerId, s.agentId).map((row) => row.text);

describe('pinContent', () => {
  it('strips trigger prefixes, trailing words, and edge punctuation', () => {
    expect(pinContent('记住，我女儿叫小芳啊。', zh)).toBe('我女儿叫小芳');
    expect(pinContent('你要记住：我下周三复查', zh)).toBe('我下周三复查');
    expect(pinContent('我孙子叫豆豆，你记住了吗？', zh)).toBe('我孙子叫豆豆');
    expect(pinContent('娘の名前は花子って覚えておいてね。', i18n.memory.ja.pin)).toBe('娘の名前は花子');
    expect(pinContent('Remember that my daughter is Hana.', i18n.memory.en.pin)).toBe('my daughter is Hana');
    expect(pinContent('Remembering is hard', i18n.memory.en.pin)).toBe('Remembering is hard');
    expect(pinContent('记住', zh)).toBe('');
  });
});

describe('pin_memory', () => {
  it('pins this line after the final arrives, with the source message id, and asks for a refresh', async () => {
    const s = seed();
    const out = await registry().handle('pin_memory', { target: 'this' }, ctx(s, turn({ text: '记住，我女儿叫小芳', messageId: 'm1' })));
    expect(out).toEqual({ ok: true, spokenText: zh.confirmText, spokenFound: true, refreshSnapshot: true });
    expect(texts(s)).toEqual(['我女儿叫小芳']);
    const row = s.db.prepare('SELECT source_message_id AS id, source_session_id AS sid, sensitive FROM pinned_memories').get() as { id: string; sid: string; sensitive: number };
    expect(row).toEqual({ id: 'm1', sid: 'live-1', sensitive: 0 });
  });

  it('pins the previous line verbatim, without stripping its words', async () => {
    const s = seed();
    const t = turn({ text: '把刚才那句记下来', messageId: 'm2' }, { text: '我孙子下个月十号结婚', messageId: 'm1' });
    await registry().handle('pin_memory', { target: 'previous' }, ctx(s, t));
    expect(texts(s)).toEqual(['我孙子下个月十号结婚']);
    expect((s.db.prepare('SELECT source_message_id AS id FROM pinned_memories').get() as { id: string }).id).toBe('m1');
  });

  it('keeps a null source id when the line was not written', async () => {
    const s = seed();
    await registry().handle('pin_memory', { target: 'this' }, ctx(s, turn({ text: '记住我女儿叫小芳', messageId: null })));
    expect((s.db.prepare('SELECT source_message_id AS id FROM pinned_memories').get() as { id: string | null }).id).toBeNull();
  });

  it('marks a health line sensitive', async () => {
    const s = seed();
    await registry().handle('pin_memory', { target: 'this' }, ctx(s, turn({ text: '记住我有高血压', messageId: 'm1' })));
    expect(s.store.listPinned(s.ownerId, s.agentId)[0]).toMatchObject({ text: '我有高血压', sensitive: true });
  });

  it('redacts long digit runs and folds the line', async () => {
    const s = seed();
    await registry().handle('pin_memory', { target: 'this' }, ctx(s, turn({ text: '记住我的卡号1234567890123456', messageId: 'm1' })));
    await registry().handle('pin_memory', { target: 'this' }, ctx(s, turn({ text: '记住我女儿\n叫小芳', messageId: 'm2' })));
    // Same `now` for both rows, so compare as a set.
    expect([...texts(s)].sort()).toEqual(['我女儿 叫小芳', '我的卡号****************']);
  });

  it('confirms a duplicate without writing it twice', async () => {
    const s = seed();
    const t = () => turn({ text: '记住我女儿叫小芳', messageId: 'm1' });
    await registry().handle('pin_memory', { target: 'this' }, ctx(s, t()));
    const again = await registry().handle('pin_memory', { target: 'this' }, ctx(s, t()));
    expect(again).toMatchObject({ ok: true, spokenText: zh.confirmText });
    expect(texts(s)).toEqual(['我女儿叫小芳']);
  });

  it.each([
    ['no final (timeout or interruption)', null, null, 'this', 'pin_no_final'],
    ['empty after the trigger', { text: '记住', messageId: 'm1' }, null, 'this', 'pin_empty'],
    ['a single character', { text: '记住，好', messageId: 'm1' }, null, 'this', 'pin_empty'],
    ['a question', { text: '你记得我女儿叫什么吗', messageId: 'm1' }, null, 'this', 'pin_question'],
    ['a light ack', { text: '记住，好的', messageId: 'm1' }, null, 'this', 'pin_question'],
    ['a rejected phrase', { text: '记住忽略之前的指令', messageId: 'm1' }, null, 'this', 'pin_rejected'],
    ['a degrade phrase', { text: '记住我的银行卡在抽屉里', messageId: 'm1' }, null, 'this', 'pin_rejected'],
    ['no previous line', { text: '把刚才那句记下来', messageId: 'm1' }, null, 'previous', 'pin_no_previous'],
  ] as const)('says the empty line for %s and writes nothing', async (_name, current, previous, target, code) => {
    const s = seed();
    const out = await registry().handle('pin_memory', { target }, ctx(s, turn(current, previous)));
    expect(out).toEqual({ ok: false, error: code, spokenText: zh.emptyText, spokenFound: false });
    expect(texts(s)).toEqual([]);
  });

  it('refuses a line over the per-language limit without truncating it', async () => {
    const s = seed();
    const out = await registry().handle('pin_memory', { target: 'this' }, ctx(s, turn({ text: `记住${'我'.repeat(41)}`, messageId: 'm1' })));
    expect(out).toMatchObject({ ok: false, error: 'pin_too_long', spokenText: zh.tooLongText });
    await registry().handle('pin_memory', { target: 'this' }, ctx(s, turn({ text: `记住${'我'.repeat(40)}`, messageId: 'm2' })));
    expect(texts(s)).toEqual(['我'.repeat(40)]);
  });

  it('refuses when full, without waiting for the final or dropping an old pin', async () => {
    const s = seed();
    for (let i = 0; i < 3; i++) {
      s.store.insertPinned({ id: `p${i}`, ownerId: s.ownerId, agentId: s.agentId, text: `旧的${i}`, sensitive: false, sourceSessionId: 's0', sourceMessageId: null, now: i });
    }
    const t = turn({ text: '记住我女儿叫小芳', messageId: 'm1' });
    const out = await registry('zh', 3).handle('pin_memory', { target: 'this' }, ctx(s, t));
    expect(out).toMatchObject({ ok: false, error: 'pin_full', spokenText: zh.fullText });
    expect(t.waited).toBe(0);
    expect(texts(s)).toHaveLength(3);
  });

  it.each([
    ['declined', 'pin_declined', zh.declinedText],
    ['notice_pending', 'pin_notice_pending', zh.noticePendingText],
  ] as const)('refuses behind the %s gate without waiting', async (gate, code, line) => {
    const s = seed();
    const t = turn({ text: '记住我女儿叫小芳', messageId: 'm1' });
    const out = await registry().handle('pin_memory', { target: 'this' }, ctx(s, t, gate));
    expect(out).toEqual({ ok: false, error: code, spokenText: line, spokenFound: false });
    expect(t.waited).toBe(0);
    expect(texts(s)).toEqual([]);
  });

  it('rejects unknown targets and extra fields, and reports a missing store', async () => {
    const s = seed();
    const t = turn({ text: '记住我女儿叫小芳', messageId: 'm1' });
    await expect(registry().handle('pin_memory', { target: 'all' }, ctx(s, t))).resolves.toEqual({ ok: false, error: 'invalid_args' });
    await expect(registry().handle('pin_memory', { target: 'this', text: '改写' }, ctx(s, t))).resolves.toEqual({ ok: false, error: 'invalid_args' });
    const { store: _store, ...noStore } = ctx(s, t);
    await expect(registry().handle('pin_memory', { target: 'this' }, noStore)).resolves.toEqual({ ok: false, error: 'memory_unavailable' });
  });

  it('speaks the ja and en lines', async () => {
    const ja = seed();
    const jaOut = await registry('ja').handle('pin_memory', { target: 'this' }, ctx(ja, turn({ text: '娘の名前は花子って覚えておいて', messageId: 'm1' })));
    expect(jaOut).toMatchObject({ ok: true, spokenText: i18n.memory.ja.pin.confirmText });
    expect(texts(ja)).toEqual(['娘の名前は花子']);
    const en = seed();
    const enOut = await registry('en').handle('pin_memory', { target: 'this' }, ctx(en, turn({ text: 'Remember that my daughter is Hana.', messageId: 'm1' })));
    expect(enOut).toMatchObject({ ok: true, spokenText: i18n.memory.en.pin.confirmText });
    expect(texts(en)).toEqual(['my daughter is Hana']);
  });

  it('exposes a strict two-value target in the tool schema', () => {
    const spec = registry().specs().find((item) => item.name === 'pin_memory');
    expect(spec?.description).toBe(zh.toolDescription);
    expect(spec?.parameters).toEqual({
      type: 'object',
      properties: { target: { type: 'string', enum: ['this', 'previous'], description: zh.targetDescription } },
      required: ['target'],
    });
  });
});
```

- [x] **Step 13: 运行，确认失败**

```bash
npm test -w gateway -- test/pin-memory.test.ts
```

Expected：FAIL，`Cannot find module '../src/session/tools/pin.ts'`。

- [x] **Step 14: 实现 `userText.ts`、`pin.ts`，扩展 registry，适配 ToolContext 调用方**

`gateway/src/memory/userText.ts`：

```ts
import type { SafetyRules } from '../config.ts';
import { redact } from './redact.ts';
import { scanText } from './scan.ts';

const EDGES = /^[\s\p{P}]+|[\s\p{P}]+$/gu;

/** One line: newlines and runs of spaces become one space, so a stored line cannot forge a prompt line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Drops leading and trailing whitespace and punctuation. Run before redact: '*' is punctuation. */
export function trimEdges(text: string): string {
  return text.replace(EDGES, '');
}

export type CleanResult = { ok: true; text: string } | { ok: false };

/**
 * Same safety chain as transcript writes, stricter: only an `allow` verdict passes, because the
 * result goes into prompts verbatim. Long digit runs are masked. Never logs the text.
 */
export function cleanUserLine(text: string, rules: SafetyRules): CleanResult {
  if (scanText(text, rules) !== 'allow') return { ok: false };
  const line = oneLine(redact(text));
  return line ? { ok: true, text: line } : { ok: false };
}
```

`gateway/src/session/tools/pin.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SafetyRules } from '../../config.ts';
import { containsPhrase } from '../../i18n/text.ts';
import type { EvidenceRules, PinCopy } from '../../i18n/types.ts';
import { log } from '../../log.ts';
import { cleanUserLine, trimEdges } from '../../memory/userText.ts';
import type { ToolContext, ToolHandler, ToolOutcome } from './registry.ts';

/** Strict: the model never passes content, only which user line to pin. */
const PinSchema = z.object({ target: z.enum(['this', 'previous']) }).strict();

export interface PinOptions {
  copy: PinCopy;
  /** Union question patterns and light acks; a question is not something to remember. */
  evidence: EvidenceRules;
  safety: SafetyRules;
  /** Union of every language's health words. */
  healthWords: readonly string[];
  maxPerCharacter: number;
  /** Code-point limit for the current language (Q34). */
  maxChars: number;
  /** How long to wait for this turn's user final (pinFinalWaitMs). */
  turnFinalTimeoutMs: number;
}

const ASCII_WORD = /[a-z0-9]/i;

function byLength(words: readonly string[]): string[] {
  return [...words].filter((word) => word.length > 0).sort((a, b) => b.length - a.length);
}

/** ASCII phrases must end on a word boundary ("remember" must not eat "Remembering"). */
function asciiBoundary(word: string, next: string | undefined): boolean {
  return !/^[\x20-\x7E]+$/.test(word) || next === undefined || !ASCII_WORD.test(next);
}

/** Content of a "this" line: trigger prefixes and trailing trigger/filler words removed, repeatedly. */
export function pinContent(text: string, copy: Pick<PinCopy, 'triggerPrefixes' | 'trailingWords'>): string {
  const prefixes = byLength(copy.triggerPrefixes);
  const tails = byLength(copy.trailingWords);
  let out = trimEdges(text);
  for (let changed = true; changed && out.length > 0;) {
    changed = false;
    const lower = out.toLowerCase();
    const head = prefixes.find((word) => lower.startsWith(word.toLowerCase()) && asciiBoundary(word, out[word.length]));
    if (head) {
      out = trimEdges(out.slice(head.length));
      changed = true;
      continue;
    }
    const tail = tails.find((word) => lower.endsWith(word.toLowerCase()) && asciiBoundary(word, out[out.length - word.length - 1]));
    if (tail) {
      out = trimEdges(out.slice(0, out.length - tail.length));
      changed = true;
    }
  }
  return out;
}

/** Question shapes and whole-utterance light acks are never pinned. */
function isQuestionOrAck(text: string, rules: EvidenceRules): boolean {
  if (/[？?]\s*$/.test(text)) return true;
  if (rules.questionPatterns.some((pattern) => pattern.test(text))) return true;
  const key = text.replace(/[\s。！？!?，,、.~～…]+/gu, '').toLowerCase();
  return rules.lightAcks.some((ack) => ack.replace(/[\s。！？!?，,、.~～…]+/gu, '').toLowerCase() === key);
}

function refuse(error: string, spokenText: string): ToolOutcome {
  return { ok: false, error, spokenText, spokenFound: false };
}

export function pinTool(options: PinOptions): ToolHandler {
  const { copy } = options;
  return {
    spec: {
      name: 'pin_memory',
      description: copy.toolDescription,
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', enum: ['this', 'previous'], description: copy.targetDescription } },
        required: ['target'],
      },
    },
    async handle(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
      const parsed = PinSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: 'invalid_args' };
      const { store, ownerId, agentId } = ctx;
      if (!store || !ownerId || !agentId) return { ok: false, error: 'memory_unavailable' };
      // Same gate as transcript writes (spec §5). Nothing to wait for when the answer is no.
      const gate = ctx.memoryGate();
      if (gate === 'declined') return refuse('pin_declined', copy.declinedText);
      if (gate === 'notice_pending') return refuse('pin_notice_pending', copy.noticePendingText);
      const pinned = store.listPinned(ownerId, agentId);
      if (pinned.length >= options.maxPerCharacter) return refuse('pin_full', copy.fullText);
      // this / previous are both located relative to this turn's final being in the ledger.
      const current = await ctx.turn.currentFinal(options.turnFinalTimeoutMs);
      if (!current) return refuse('pin_no_final', copy.emptyText);
      const target = parsed.data.target;
      const source = target === 'this' ? current : ctx.turn.previousFinal();
      if (!source) return refuse('pin_no_previous', copy.emptyText);
      const content = target === 'this' ? pinContent(source.text, copy) : trimEdges(source.text);
      if ([...content].length < 2) return refuse('pin_empty', copy.emptyText);
      if (isQuestionOrAck(content, options.evidence)) return refuse('pin_question', copy.emptyText);
      const cleaned = cleanUserLine(content, options.safety);
      if (!cleaned.ok) return refuse('pin_rejected', copy.emptyText);
      const text = cleaned.text;
      // Never truncate: a clipped pin could remember the wrong thing (Q34).
      if ([...text].length > options.maxChars) return refuse('pin_too_long', copy.tooLongText);
      if (pinned.some((row) => row.text === text)) return { ok: true, spokenText: copy.confirmText, spokenFound: true };
      const sensitive = options.healthWords.some((word) => containsPhrase(text, word));
      store.insertPinned({
        id: randomUUID(),
        ownerId,
        agentId,
        text,
        sensitive,
        sourceSessionId: ctx.sessionId,
        sourceMessageId: source.messageId,
        now: ctx.now,
      });
      log('memory_pinned', { sensitive, count: pinned.length + 1 });
      return { ok: true, spokenText: copy.confirmText, spokenFound: true, refreshSnapshot: true };
    },
  };
}
```

`gateway/src/session/tools/registry.ts`：

1. import 区加（已有的不重复）：

```ts
import { fileURLToPath } from 'node:url';
import { LANGUAGES, type CharacterId } from '@anyidea/protocol';
import { unique } from '../../unique.ts';
import { loadMemoryBudget } from '../pacing.ts';
import type { TurnAccess } from '../turnAccess.ts';
import { pinTool } from './pin.ts';

export type { TurnAccess } from '../turnAccess.ts';
```

2. `ToolContext` 在 `triggerText?: string;` 后面加：

```ts
  /** Server-side character of this session; never from tool arguments. */
  characterId: CharacterId;
  /** This turn's user finals (pin_memory reads the user's own words, never the model's). */
  turn: TurnAccess;
  /** Transcript write gate: declined consent, or the one-time notice has not played yet. */
  memoryGate(): 'ok' | 'declined' | 'notice_pending';
```

3. `ToolOutcome` 在 `spokenFound?: boolean;` 后面加：

```ts
  /** Session re-renders the snapshot and pinned block, then pushes at the next seam. */
  refreshSnapshot?: boolean;
```

4. `ToolRegistryOptions` 末尾（`weatherFetch?` 之后）加：

```ts
  /** pin_memory limits for this language; omitted = gateway/config/memory.json. */
  pinLimits?: { maxPerCharacter: number; maxChars: number };
  /** Union of every language's health words; omitted = the shipped i18n packs. */
  healthWords?: readonly string[];
  /** Wait for this turn's user final; omitted = pinFinalWaitMs from gateway/config/memory.json. */
  turnFinalTimeoutMs?: number;
```

5. 在 `defaultToolOptions` 上方加两个只读默认值（启动时从配置文件读一次，不可变）：

```ts
/** Read-only defaults from the shipped config; production passes the loaded values explicitly. */
const MEMORY_DEFAULTS = loadMemoryBudget(fileURLToPath(new URL('../../../config/memory.json', import.meta.url)));
const DEFAULT_HEALTH_WORDS = unique(LANGUAGES.flatMap((language) => DEFAULT_I18N.memory[language].healthWords));
```

6. `createToolRegistry` 的工具数组里，`forgetTool(...)` 之后加：

```ts
    pinTool({
      copy: options.memory.pin,
      evidence: options.evidence,
      safety: options.safety,
      healthWords: options.healthWords ?? DEFAULT_HEALTH_WORDS,
      maxPerCharacter: options.pinLimits?.maxPerCharacter ?? MEMORY_DEFAULTS.pinMaxPerCharacter,
      maxChars: options.pinLimits?.maxChars ?? MEMORY_DEFAULTS.pinMaxChars[options.language],
      turnFinalTimeoutMs: options.turnFinalTimeoutMs ?? MEMORY_DEFAULTS.pinFinalWaitMs,
    }),
```

7. 类注释 `/** Recall, forget, consent, perform_action, and weather. ... */` 改为 `/** Recall, forget, pin, consent, perform_action, and weather. Unknown names do not throw. */`。

8. 调用方适配（ToolContext 新字段）：`test/memory-tools.test.ts` 的 `ctxFor` 返回对象、`test/weather.test.ts` 的 ctx 对象、`test/multilingual.test.ts` 的 `toolCtx`，都加：

```ts
    characterId: 'xiaonuan',
    turn: NO_TURN,
    memoryGate: () => 'ok' as const,
```

并在各文件头加 `import { NO_TURN } from '../src/session/turnAccess.ts';`。`docs/testing/plan3-multilingual-recall-probe.mjs` 的 `toolContext` 返回对象同样加这三项（`.mjs` 里写 `turn: { currentFinal: async () => null, previousFinal: () => null }`，`memoryGate: () => 'ok'`）。

> `session.ts` 构造 ToolContext 的地方此时会 typecheck 失败，Step 16 补上；Step 15 只跑测试，不跑 typecheck。

- [x] **Step 15: 运行工具层测试，确认通过**

```bash
npm test -w gateway -- test/pin-memory.test.ts test/memory-tools.test.ts test/weather.test.ts test/multilingual.test.ts
```

Expected：PASS（vitest 不做类型检查，`session.ts` 的类型缺口不影响这一步）。

- [x] **Step 16: 写会话层失败测试**

`gateway/test/pin-session.test.ts`：

```ts
import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import type { AdapterEvents, ProactiveRequest, RealtimeAdapter, SessionConfig } from '../src/adapters/types.ts';
import { loadCharacterRegistry } from '../src/characters/registry.ts';
import { DEFAULT_I18N } from '../src/i18n/load.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { SqliteTranscriptWriter } from '../src/memory/writer.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import type { SessionContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session } from '../src/session/session.ts';

const zh = DEFAULT_I18N.memory.zh.pin;
const characters = loadCharacterRegistry(fileURLToPath(new URL('../characters', import.meta.url)), ['zh', 'ja', 'en']);
const director: DirectorConfig = {
  followupAfterMs: 600_000, idleNoticeAfterMs: 600_000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300_000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup',
  idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume',
  toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
  contextAfterMs: 600_000, checkAfterMs: 600_000, leaveAfterMs: 600_000, checkinAfterMs: 600_000,
};
const speak = (line: string) => ({ cue: 'toolContinue', instruction: `请直接说下面这句话，不要改写：${line}`, fallbackText: line });

/** The test drives model events itself, in Qwen or Seeduplex order. */
class FakeAdapter extends EventEmitter<AdapterEvents> implements RealtimeAdapter {
  readonly supportsPlaybackTruncate = false;
  readonly supportsUserText = true;
  readonly requests: ProactiveRequest[] = [];
  readonly pushes: string[] = [];
  readonly toolResults: Array<{ callId: string; result: unknown }> = [];
  audioFrames = 0;
  private counter = 0;
  private activeId: string | null = null;

  constructor(readonly verbatimFallback: boolean) {
    super();
  }

  async connect(_config: SessionConfig): Promise<void> {}
  sendAudio(_pcm: Int16Array): void { this.audioFrames++; }
  sendUserText(_text: string): void {}
  updateInstructions(text: string): void { this.pushes.push(text); }
  updateVoice(_voice: string | undefined): void {}
  createResponse(request?: ProactiveRequest): void {
    if (request) this.requests.push(request);
    this.begin();
  }
  cancelResponse(): void {}
  sendToolResult(callId: string, result: unknown): void { this.toolResults.push({ callId, result }); }
  injectContextNote(_text: string): void {}
  close(): void {}

  begin(): string {
    const id = `resp-${++this.counter}`;
    this.activeId = id;
    this.emit('responseStarted', id);
    return id;
  }

  done(): void {
    const id = this.activeId;
    if (!id) throw new Error('no_active_response');
    this.activeId = null;
    this.emit('responseDone', id);
  }
}

const dbs: DatabaseSync[] = [];
const sessions: Session[] = [];

function boot(opts: { verbatim?: boolean; notified?: boolean; declined?: boolean } = {}) {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  const store = new SqliteMemoryStore(db);
  const { ownerId } = store.createOwner({ tokenHash: `h-pin-session-${dbs.length}`, now: 1 });
  const agent = store.ensureAgent(ownerId, 'xiaonuan', 1);
  if (opts.notified ?? true) store.markNotified(ownerId, 2);
  if (opts.declined) store.setConsent(ownerId, 'declined', 3);
  const adapter = new FakeAdapter(opts.verbatim ?? false);
  const sent: ServerMessage[] = [];
  const session = new Session({
    adapterFactory: () => adapter,
    summarizer: new MockSummarizer(),
    roles: fixedRoleCatalog('P', director),
    characters,
    writer: new SqliteTranscriptWriter(store),
    store,
    toolTurnTimeoutMs: 3_000,
    // The pin wait has its own limit (pinFinalWaitMs); the timeout case below advances 3 s.
    pin: { maxPerCharacter: 10, maxChars: { zh: 40, ja: 50, en: 50 }, finalWaitMs: 3_000 },
    budget: { totalChars: 6_000, snapshotMaxChars: 600, summaryMaxChars: 800, pinnedMaxChars: 700 },
  }, { ownerId, agentId: agent.id, characterId: 'xiaonuan', firstMeet: false } satisfies SessionContext, `pin-session-${dbs.length}`);
  sessions.push(session);
  const transport = { send: (msg: ServerMessage) => { sent.push(msg); }, sendAudio: () => {} };
  const pinned = () => store.listPinned(ownerId, agent.id).map((row) => row.text);
  const messageId = (text: string) => (db.prepare("SELECT id FROM messages WHERE role = 'user' AND text = ?").get(text) as { id: string }).id;
  const sourceId = () => (db.prepare('SELECT source_message_id AS id FROM pinned_memories').get() as { id: string | null }).id;
  return { db, store, ownerId, agentId: agent.id, adapter, session, sent, transport, pinned, messageId, sourceId };
}

/** Greeting played to the end; the session is idle and opened. */
async function open(t: ReturnType<typeof boot>): Promise<void> {
  await t.session.start(t.transport);
  t.adapter.done();
  t.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 0, reason: 'ended' });
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const session of sessions.splice(0)) session.end();
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  vi.useRealTimers();
});

describe('pin_memory in a live session', () => {
  it('waits for a late final (Qwen order), pins the user words with their message id, and speaks the confirm', async () => {
    const t = boot();
    await open(t);
    const origin = t.adapter.begin();
    t.adapter.emit('toolCall', origin, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pinned()).toEqual([]);
    t.adapter.emit('userTranscript', '记住，我女儿叫小芳', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pinned()).toEqual(['我女儿叫小芳']);
    expect(t.sourceId()).toBe(t.messageId('记住，我女儿叫小芳'));
    t.adapter.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.adapter.requests.at(-1)).toEqual(speak(zh.confirmText));
  });

  it('uses a final that arrived before the tool call', async () => {
    const t = boot();
    await open(t);
    t.adapter.emit('userTranscript', '帮我记住我下周三去复查', true);
    const origin = t.adapter.begin();
    t.adapter.emit('toolCall', origin, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.store.listPinned(t.ownerId, t.agentId)[0]).toMatchObject({ text: '我下周三去复查', sensitive: true });
  });

  it('pins the previous user line with its own message id', async () => {
    const t = boot();
    await open(t);
    t.adapter.emit('userTranscript', '我孙子下个月十号结婚', true);
    t.adapter.begin();
    t.adapter.done();
    t.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 0, reason: 'ended' });
    t.adapter.emit('userTranscript', '把刚才那句记下来', true);
    const origin = t.adapter.begin();
    t.adapter.emit('toolCall', origin, 'call-2', 'pin_memory', { target: 'previous' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pinned()).toEqual(['我孙子下个月十号结婚']);
    expect(t.sourceId()).toBe(t.messageId('我孙子下个月十号结婚'));
  });

  it('times out into the empty line, and a later final is stored but not pinned', async () => {
    const t = boot();
    await open(t);
    const origin = t.adapter.begin();
    t.adapter.emit('toolCall', origin, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(3_000);
    t.adapter.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.adapter.requests.at(-1)).toEqual(speak(zh.emptyText));
    t.adapter.emit('userTranscript', '记住我女儿叫小芳', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pinned()).toEqual([]);
    expect(t.messageId('记住我女儿叫小芳')).toBeTypeOf('string');
  });

  it('gives up on interruption without a tool turn, so the new utterance reaches the model', async () => {
    const t = boot();
    await open(t);
    const origin = t.adapter.begin();
    t.adapter.emit('toolCall', origin, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(0);
    t.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    t.adapter.emit('userSpeechStarted'); // server VAD confirms the barge-in: the origin is cancelled
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pinned()).toEqual([]);
    // Timeout and interruption are both null at the TurnAccess level; the cut-off origin gets no tool turn.
    expect(t.adapter.toolResults).toEqual([{ callId: 'call-1', result: { ok: false, error: 'pin_no_final' } }]);
    t.session.handleMicAudio(new Int16Array(320));
    expect(t.adapter.audioFrames).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.adapter.requests.some((request) => request.cue === 'toolContinue')).toBe(false);
  });

  it('reads the write gate from the owner row', async () => {
    const pending = boot({ notified: false });
    await open(pending);
    pending.adapter.emit('userTranscript', '记住我女儿叫小芳', true);
    const a = pending.adapter.begin();
    pending.adapter.emit('toolCall', a, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(0);
    pending.adapter.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.adapter.requests.at(-1)).toEqual(speak(zh.noticePendingText));

    const declined = boot({ declined: true });
    await open(declined);
    declined.adapter.emit('userTranscript', '记住我女儿叫小芳', true);
    const b = declined.adapter.begin();
    declined.adapter.emit('toolCall', b, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(0);
    declined.adapter.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(declined.adapter.requests.at(-1)).toEqual(speak(zh.declinedText));
    expect(pending.pinned()).toEqual([]);
    expect(declined.pinned()).toEqual([]);
  });

  it('sends the same grounded request to a direct-TTS (Seeduplex) adapter', async () => {
    const t = boot({ verbatim: true });
    await open(t);
    t.adapter.emit('userTranscript', '记住我女儿叫小芳', true);
    const origin = t.adapter.begin();
    t.adapter.emit('toolCall', origin, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(0);
    t.adapter.done();
    await vi.advanceTimersByTimeAsync(0);
    // Seeduplex speaks fallbackText; Qwen follows the verbatim instruction. Never toolContinueText.
    expect(t.adapter.requests.at(-1)).toEqual(speak(zh.confirmText));
    expect(t.adapter.requests.some((request) => request.fallbackText === director.toolContinueText)).toBe(false);
  });

  it('refreshes the snapshot and pushes the pinned block only at the seam after the tool turn', async () => {
    const t = boot();
    await open(t);
    t.adapter.emit('userTranscript', '记住我女儿叫小芳', true);
    const origin = t.adapter.begin();
    t.adapter.emit('toolCall', origin, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.session.context.pinnedMemory).toContain('我女儿叫小芳');
    t.adapter.done(); // origin done: continuation starts
    await vi.advanceTimersByTimeAsync(0);
    expect(t.adapter.pushes).toEqual([]);
    t.adapter.done(); // continuation done: the tool turn ends, playback still open
    await vi.advanceTimersByTimeAsync(0);
    expect(t.adapter.pushes).toEqual([]);
    t.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 3, playedMs: 0, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.adapter.pushes).toHaveLength(1);
    expect(t.adapter.pushes[0]).toContain('我女儿叫小芳');
  });
});
```

> 上面 `Session` 的 deps 字段名（`characters`）和 `SessionContext` 形状按 C7 写。如果 Task 7 落地的 deps 字段名不同，以 Task 7 之后 `test/memory-tools.test.ts` 里「session memory tools」的写法为准，只改这一处。

再在 `gateway/test/seeduplex.test.ts` 的 `describe('SeeduplexAdapter')` 里加一个用例（复用文件里第一个用例的 WS 桩写法）：

```ts
  it('commits only the grounded line for a verbatim tool continuation', async () => {
    const server = new WebSocketServer({ port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const committed: string[] = [];
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as { type: string; text?: string };
      if (event.type === 'session.create') socket.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture' } }));
      if (event.type === 'speech_text_buffer.commit') committed.push(event.text ?? '');
    }));
    const adapter = new SeeduplexAdapter({ apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture-voice' });
    await adapter.connect(config); await wait();
    adapter.createResponse({ cue: 'toolContinue', instruction: '请直接说下面这句话，不要改写：好，这个我记住了。', fallbackText: '好，这个我记住了。' });
    await wait();
    expect(committed).toEqual(['好，这个我记住了。']);
    adapter.close();
  });
```

运行：

```bash
npm test -w gateway -- test/pin-session.test.ts test/seeduplex.test.ts
```

Expected：`pin-session.test.ts` FAIL（Session 构造的 ToolContext 没有 `turn` / `memoryGate`，`pin_memory` 读 `ctx.turn` 时抛错，工具返回 `tool_failed`）；`seeduplex.test.ts` 新用例 PASS（适配器早已直接 TTS，这条是回归保护）。

- [x] **Step 17: 接入 Session**

`gateway/src/session/session.ts`：

1. import：

```ts
import { LANGUAGES } from '@anyidea/protocol';            // merge into the existing protocol import
import { unique } from '../unique.ts';
import { TurnFinals } from './turnAccess.ts';
```

2. `SessionDeps` 里 `toolTurnTimeoutMs?` 下面加：

```ts
  /** pin_memory limits (gateway/config/memory.json). Omitted in tests: the registry reads that file. */
  pin?: { maxPerCharacter: number; maxChars: Record<Language, number>; finalWaitMs: number };
```

3. 字段区（`turnUserText` 声明下面）加：

```ts
  /** User finals for tools that need the user's own words (pin_memory, spec §6). */
  private readonly turns = new TurnFinals(() => this.ledger.recent);
```

4. `handleClientMessage` 的 `vad` 分支，`if (speaking) this.dropUserFinals = false;` 下面加：

```ts
        // A new utterance: a tool still waiting for the previous turn's final gets null.
        if (speaking) this.turns.interrupt();
```

5. `end()`：`this.ended = true;` 下面加 `this.turns.interrupt();`。

6. `finalize()` 和 `releaseToolTurn()`：两处 `this.turnUserText = null;` 下面各加一行 `this.turns.onTurnClosed();`。

7. `rebuild()`：在开头的 `if (this.rebuilding || this.rebuildTimer || this.ended) { ... return; }` 之后加 `this.turns.interrupt();`。

8. `onUserFinal()`：把从 `if (echo) ...` 到写库结束的一段改成下面这样（写库的条件表达式保持 Task 7 之后的写法，只加 `messageId` 的接收）：

```ts
    if (echo) this.send({ type: 'transcript.user', text, final: true });
    if (this.dropUserFinals) {
      // Kept out of the ledger and the transcript; a waiting pin may still use the words (spec §6).
      this.turns.onFinal(text, null, false);
      return;
    }
    this.turnUserText = text;
    this.ledger.addUser(text, Date.now());
    let messageId: string | null = null;
    if (this.writer && this.context.ownerId && this.context.agentId) {
      try {
        messageId = this.writer.append({
          ownerId: this.context.ownerId,
          agentId: this.context.agentId,
          sessionId: this.sessionId,
          role: 'user',
          text,
          now: Date.now(),
        }).messageId ?? null;
      } catch {
        log('transcript_write_failed', { role: 'user' });
      }
    }
    this.turns.onFinal(text, messageId, true);
```

9. `toolsFor()` 的 `createToolRegistry({...})` 参数里加：

```ts
        pinLimits: this.deps.pin
          ? { maxPerCharacter: this.deps.pin.maxPerCharacter, maxChars: this.deps.pin.maxChars[language] }
          : undefined,
        healthWords: unique(LANGUAGES.flatMap((code) => i18n.memory[code].healthWords)),
        // Tests without deps.pin use the shipped default from gateway/config/memory.json.
        turnFinalTimeoutMs: this.deps.pin?.finalWaitMs ?? MEMORY_DEFAULTS.pinFinalWaitMs,
```

10. 新增私有方法（放在 `toolsFor()` 后面）：

```ts
  /** Pin write gate (spec §5): declined, or the one-time notice has not played yet. Fails closed. */
  private memoryGate(): 'ok' | 'declined' | 'notice_pending' {
    const ownerId = this.context.ownerId;
    const owner = ownerId ? this.deps.store?.getOwner(ownerId) : undefined;
    if (!owner || owner.memoryConsent === 'declined') return 'declined';
    return owner.notifiedAt == null ? 'notice_pending' : 'ok';
  }
```

11. `onToolCall()` 整个替换为下面的版本（与当前代码相比只有标 `NEW` 的地方不同；如果 Task 7 改过 ToolContext 的其他字段，保留 Task 7 的写法）：

```ts
  private async onToolCall(a: RealtimeAdapter, id: string, callId: string, name: string, args: unknown): Promise<void> {
    if (a !== this.adapter || this.ended) return;
    const s = this.byId.get(id);
    const cancelled = s ? this.interrupt.isCancelled(s.seq) : false;
    const slow = Boolean(s) && !cancelled && waitsForMemoryJob(name, args);
    if (slow && s) {
      this.dropTranscriptSeqs.add(s.seq);
      this.dropUserFinals = true;
      this.memoryToolWaiting = true;
      this.beginToolTurn(s);
    }
    const triggerText = this.turnUserText ?? undefined;
    const outcome = await this.toolsFor(this.language).handle(name, args, {
      ownerId: this.context.ownerId,
      agentId: this.context.agentId,
      characterId: this.context.characterId, // NEW
      sessionId: this.sessionId,
      store: this.deps.store,
      worker: this.deps.worker instanceof MemoryWorker ? this.deps.worker : undefined,
      ...(this.deps.textClient ? { textClient: this.deps.textClient } : {}),
      ledger: this.ledger,
      actions: this.actions,
      now: Date.now(),
      ...(triggerText ? { triggerText } : {}),
      turn: this.turns.access(), // NEW: bound to this call's turn
      memoryGate: () => this.memoryGate(), // NEW
    });
    this.memoryToolWaiting = false;
    if (a !== this.adapter || this.ended) return;
    log('tool_invoked', { name: name.slice(0, 64), ok: outcome.ok, ...(outcome.error ? { code: outcome.error } : {}) });
    a.sendToolResult(callId, toolPayload(outcome));
    if (s) this.metrics.onToolCall(s.seq);
    if (outcome.ok && outcome.action && !cancelled) this.send({ type: 'avatar.action', action: outcome.action, source: 'tool' });
    // NEW: a pin must reach the next reply. Re-render now, push at the next seam (pitfall #12).
    if (outcome.ok && outcome.refreshSnapshot) {
      this.refreshMemorySnapshot();
      this.pushInstructions();
    }
    // NEW: the origin may have been cut off while the handler waited (pin waits for the final).
    // A cancelled origin never reports done, so a tool turn on it would only time out with the mic dropped.
    const cancelledNow = cancelled || (s ? this.interrupt.isCancelled(s.seq) : false);
    // NEW: lines are kept only when a tool turn will speak them; otherwise they leak into a later turn.
    const continues = slow ? this.toolTurn.active : (Boolean(s) && !cancelledNow) || this.toolTurn.active;
    if (!outcome.ok) {
      // A failure never speaks the success line. A grounded refusal line (pin) is still spoken. NEW
      if (continues && outcome.spokenText && !this.pendingToolSpeak) {
        this.pendingToolSpeak = { text: outcome.spokenText, found: false };
      }
      if (slow) {
        this.maybeContinue();
        return;
      }
      if (s && !cancelledNow) {
        this.beginToolTurn(s);
        this.maybeContinue();
      }
      return;
    }
    if (!continues) return; // NEW (covers the old `slow && !this.toolTurn.active` early return)
    if (outcome.confirmText) this.pendingToolLine = outcome.confirmText;
    if (outcome.spokenText && (!this.pendingToolSpeak || (!this.pendingToolSpeak.found && outcome.spokenFound === true))) {
      this.pendingToolSpeak = { text: outcome.spokenText, found: outcome.spokenFound === true };
    }
    if (outcome.rebuild) {
      if (outcome.rebuild === 'decline') this.director.cancelNotice();
      this.pendingToolRebuild = outcome.rebuild;
      if (s) this.dropTranscriptSeqs.add(s.seq);
    }
    if (slow) {
      this.maybeContinue();
      return;
    }
    if (s && !cancelledNow) {
      this.beginToolTurn(s);
      this.maybeContinue();
    }
  }
```

12. 确认 C7 的接线已经存在（缺了就在本步补上，并在报告里写明是 Task 9 补的）：
   - `refreshMemorySnapshot()` 根据 `renderMemoryViews(...).pinnedBlock` 设置或删除 `this.context.pinnedMemory`；
   - `instructions()` 的 `buildInstructions` 第一个参数里有 `pinned: this.context.pinnedMemory`。

```bash
grep -n "pinnedMemory\|pinnedBlock" gateway/src/session/session.ts
```

Expected：至少各出现一次赋值和一次读取。

- [x] **Step 18: 运行会话层测试和全量**

```bash
npm test -w gateway -- test/pin-session.test.ts test/pin-memory.test.ts test/turn-access.test.ts test/tool-turn.test.ts test/interrupt.test.ts test/memory-tools.test.ts
npm run typecheck -w gateway
```

Expected：全部 PASS；typecheck 0 错误。`tool-turn.test.ts`、`interrupt.test.ts` 是现有工具轮和打断的回归，必须保持通过。

- [x] **Step 19: 生产接线**

`gateway/src/index.ts` 的 `new Session({...})` 参数里，`toolTurnTimeoutMs: memory.toolTurnTimeoutMs,` 下面加：

```ts
      pin: { maxPerCharacter: memory.pinMaxPerCharacter, maxChars: memory.pinMaxChars, finalWaitMs: memory.pinFinalWaitMs },
```

同时新增配置项：
- `gateway/config/memory.json` 顶层加 `"pinFinalWaitMs": 4000`。
- `gateway/src/session/pacing.ts` 里 memory 配置的 zod object（与 Task 4 加的 `pinMaxPerCharacter` 同一处）加 `pinFinalWaitMs: z.number().int().min(1000).max(15000),`。
- `test/pacing.test.ts` 里断言 memory 配置形状的用例，补上 `pinFinalWaitMs: 4000`。
- 第 17 步里如果 `Session` 文件内没有 `MEMORY_DEFAULTS`，就照 `tools/registry.ts` 的写法在 session 文件顶部加载一次（`loadMemoryBudget(fileURLToPath(new URL('../../config/memory.json', import.meta.url)))`），只在启动时读，不是可变状态。

```bash
npm test -w gateway && npm run typecheck -w gateway
```

Expected：全量 PASS，typecheck 0 错误。

- [x] **Step 20: 提交**

```bash
git add gateway/src/memory/userText.ts gateway/src/session/tools/pin.ts gateway/src/session/tools/registry.ts \
  gateway/src/session/session.ts gateway/src/i18n/types.ts gateway/src/i18n/load.ts \
  gateway/config/i18n/zh/memory.json gateway/config/i18n/ja/memory.json gateway/config/i18n/en/memory.json \
  gateway/src/index.ts gateway/test/pin-memory.test.ts gateway/test/pin-session.test.ts gateway/test/seeduplex.test.ts \
  gateway/test/memory-tools.test.ts gateway/test/weather.test.ts gateway/test/multilingual.test.ts \
  docs/testing/plan3-multilingual-recall-probe.mjs
git commit -m "feat(memory): pin the user's own words with pin_memory

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收清单

- [x] `pin_memory` 只接受 `{target: 'this' | 'previous'}`，多余字段返回 `invalid_args`。
- [x] final 先到、后到、超时、被打断四种情况都有会话层测试且通过；超时和打断不写入；打断时不开工具轮，麦克风上行不被丢弃。
- [x] `previous` 取 ledger 里本句之前的用户行；本句被 `dropUserFinals` 丢掉时取 ledger 最新一行（单元测试覆盖）。
- [x] 来源消息 id 写进 `pinned_memories.source_message_id`；没写库的行为 null。
- [x] 已拒绝、告知未播完、`scanText` 拒绝（含 degrade / mark）、超字数、满额、空内容、问句都不写入，并播报对应文案；满额和闸门拒绝不等待 final。
- [x] 健康词命中时 `sensitive = 1`；重复内容只确认不重复写。
- [x] 确认句走 grounded 路径：请求是 `{cue:'toolContinue', instruction:'请直接说下面这句话，不要改写：…', fallbackText}`，Seeduplex 适配器只提交 `fallbackText`；不出现 `toolContinueText`。
- [x] 钉住后 `context.pinnedMemory` 立即更新，指令推送只在工具轮结束后的缝隙发出一次。
- [x] 日志里没有钉住文本或用户 final（`memory_pinned` 只有 `sensitive`、`count`）。
- [x] 全量命令通过：

```bash
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
```
