# Task 8: 「初次见面」开场与 `greetingNoName` 兜底

**目标：** 开场按「这个角色和用户有没有已结束的会话 × 共享层有没有称呼」分四种情况，见下表。
- 初次见面且有称呼：用角色卡的 `greetingsFirstMeet` 安全模板。
- 初次见面且没有称呼：规划器只做自我介绍并问称呼，失败时念角色卡的 `greetingNoName`。
- 有已结束的会话：沿用现有逻辑。

「有称呼时开场不走规划器」这条契约（已踩过的坑第 5 条）继续成立。另外补一个会话层的回归测试：三个角色互不知情，实时模型收到的指令里不出现其他角色的名字。

**实现的 spec 章节：** 产品设计 → 开场（四种情形表和两条附注）；产品设计 → 记忆分层第 3 条（互不知情）；技术设计 §5「初次见面判断」；测试与验收 →「初次见面开场的四种组合」；决策 Q11、Q14。

**前置：** Task 7 已完成。
- C7：`SessionContext.firstMeet`、`SessionContext.characterId`、`SessionDeps.characters?`（Task 7 新增），`index.ts` 已把 `characters` 传给 Session。
- C5：`characters.greetingsFirstMeet(id, lang)`、`characters.greetingNoName(id, lang)`。
- C6：`roles.director(characterId, lang)`。
- `test/support/shipped.ts`（Task 6）。

**高风险区提醒：** 开场属于「打断与沉默」「记忆与回忆」两组坑位覆盖的区域。动手前先读 `docs/project/roadmap.md` 的这两节。本任务不改：
- 沉默四段式和规划器指令；
- `greetingNameTexts` / care 开场的现有逻辑；
- `requestResponse` 这个唯一出口；
- 告知流程。

改完必须跑 gateway 全量测试和 typecheck。真实三角色开场探针在 Task 17。

## 四种组合

| 情形 | 本任务之后的开场 | 规划器 |
|---|---|---|
| 初次见面（`firstMeet=true`），没有称呼 | 规划器自我介绍并问称呼。规划器拿到的 `memorySnapshot` 为空串，哪怕共享层有「基本情况」，也不会说「又见面了」。失败或拒绝时：`instruction = director.greetingInstruction`，`fallbackText = characters.greetingNoName(id, lang)` | 调用 1 次 |
| 初次见面，有称呼 | `characters.greetingsFirstMeet(id, lang)` 随机取一条，替换 `{name}`。同一会话、同一语言只选一次，开场被打断重播时仍是同一句 | **不调用** |
| 见过面，没有称呼 | 现有逻辑不变：规划器拿 `greetingMemorySnapshot`。失败时有记忆用 `greetingMemoryInstruction/Text`，否则用 `greetingInstruction/greetingText` | 调用 1 次 |
| 见过面，有称呼 | 现有逻辑不变：care 开场或 `greetingNameTexts` | **不调用** |

附加规则：
- 初次见面不做 care 开场（`startCareOpening` 直接返回 null）。新角色没有「上次没说完的事」，也省掉开场前等待模型的那段时间。
- 初次见面且没有称呼时，`Director.onSessionStart(hasMemory)` 传 `false`。这样之后的 `openingFollow` / `check` 走「问称呼」的文案，不走「刚才那件事」。初次见面但有称呼时，`hasMemory` 按快照是否为空来定，和现在一样。
- 记忆告知仍按整台手机只播一次。`noticePending` 由 `registry.resolve` 算出，本任务不碰。
- 没有注入 `characters`（只出现在测试里）时，`firstMeetGreeting` 返回 undefined，`greetingText` 也不替换，行为和 Task 7 结束时完全一样。

## Files

- Modify: `gateway/src/session/director.ts`
  - `DirectorDeps`（当前 :38–51）新增 `firstMeetGreeting?`
  - `requestGreeting`（当前 :549–556）先查它
- Modify: `gateway/src/session/session.ts`
  - 构造函数里 `new Director(...)` 的配置来源和 deps
  - `start()` 里 `onSessionStart` 的参数
  - `startCareOpening` 开头加初次见面判断
  - 新增 `firstMeetGreeting`、`directorConfig`、`openingHasMemory` 三个私有方法和两个字段
- Create: `gateway/test/first-meet.test.ts`
- Modify: `gateway/test/director.test.ts`（在「uses the deterministic name-only greeting instead of planning an invented topic」之后追加 2 个用例）

## Interfaces

- **Consumes：** C5 `CharacterRegistry.greetingsFirstMeet` / `greetingNoName`；C7 `SessionContext.firstMeet` / `characterId`；Task 7 的 `SessionDeps.characters?`；C6 `RoleCatalog.director`。
- **Produces**（C8）：
  ```ts
  // DirectorDeps (gateway/src/session/director.ts)
  /** First meeting with a known name: a card template with {name} filled in; undefined otherwise. Checked before safeGreeting. */
  firstMeetGreeting?(): string | undefined;
  ```
  - 「没有称呼且是初次见面时，规划器失败的兜底用 `characters.greetingNoName`」：Session 交给 Director 的配置里，`greetingText` 换成 `greetingNoName`，只在 `firstMeet && characters` 时替换。
  - C8 原文是「`safeGreeting` 先查它」。实现上由 Director 在 `requestGreeting` 里先调 `firstMeetGreeting()`，取不到再调 `safeGreeting()`，效果相同。这样 `firstMeetGreeting` 在没有规划器（没有 textClient）时也生效，而 `safeGreeting` 现在只在有规划器时才接线。

## 调用方适配

- `DirectorDeps` 新增的是可选成员。现有 `new Director(...)` 调用（`director.test.ts`、`director-silence.test.ts`、Session）都不用改。
- Session 的改动只在 `firstMeet === true` 且注入了 `characters` 时才生效。Task 7 已经把现有测试里的 ctx 统一成 `firstMeet: false`。默认的 `devContext` 是 `firstMeet: true`，但这类测试都没有注入 `characters`，也没有记忆快照，所以开场行为不变。
- `test/memory-acceptance.test.ts` 的第一次会话是初次见面，但它构造 Session 时没有传 `characters`，开场仍是 `director.greetingText`，原断言成立。
- 不改任何公开签名，typecheck 不会出现新的调用方错误。

## Steps

- [x] **Step 1: 写失败的 Director 单元测试**

在 `gateway/test/director.test.ts` 的「uses the deterministic name-only greeting instead of planning an invented topic」用例之后追加：

```ts
  it('prefers the first-meet template over the name greeting and never plans', () => {
    const reqs: ProactiveRequest[] = [];
    let planned = 0;
    const d = new Director(cfg, {
      requestResponse: (_k, r) => reqs.push(r),
      planProactiveLine: () => { planned += 1; return { text: '又见面啦' }; },
      getMemorySnapshot: () => '称呼：王叔',
      firstMeetGreeting: () => '王叔您好，我是小凯，头一回来陪您。',
      safeGreeting: () => '王叔，又见面啦。',
    });
    d.onSessionStart(true);
    expect(planned).toBe(0);
    expect(reqs).toEqual([{
      cue: 'greeting',
      instruction: '王叔您好，我是小凯，头一回来陪您。',
      fallbackText: '王叔您好，我是小凯，头一回来陪您。',
    }]);
  });

  it('falls through to the name greeting when there is no first-meet template', () => {
    const reqs: ProactiveRequest[] = [];
    let planned = 0;
    const d = new Director(cfg, {
      requestResponse: (_k, r) => reqs.push(r),
      planProactiveLine: () => { planned += 1; return { text: '又见面啦' }; },
      firstMeetGreeting: () => undefined,
      safeGreeting: () => '王叔，又见面啦。',
    });
    d.onSessionStart(true);
    expect(planned).toBe(0);
    expect(reqs).toEqual([{ cue: 'greeting', instruction: '王叔，又见面啦。', fallbackText: '王叔，又见面啦。' }]);
  });
```

- [x] **Step 2: 写失败的会话层测试**

创建 `gateway/test/first-meet.test.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHARACTER_IDS } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import type { SessionConfig } from '../src/adapters/types.ts';
import type { CharacterRegistry } from '../src/characters/registry.ts';
import type { MemoryStore } from '../src/memory/store.ts';
import type { TextModelClient } from '../src/memory/textClient.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import { loadAffectConfig } from '../src/session/affect.ts';
import type { SessionContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session, type SessionDeps, type Transport } from '../src/session/session.ts';
import { shippedCharacters, shippedRoles } from './support/shipped.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const affect = loadAffectConfig(`${root}config/affect.json`);
const script: MockScript = { greeting: '你好呀', followup: '还在吗', fallbackReply: '我在听', turns: [] };

const director: DirectorConfig = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup',
  idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume',
  toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
  greetingMemoryInstruction: 'GM', greetingMemoryText: '又见到您了。',
  greetingNameTexts: ['{name}，又见面了。'],
  silenceDecision: {
    instruction: 'D', speakInstruction: 'SAY {continuation}',
    maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
    policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
  },
};

/** Card stub: the no-name line names the character and language so the fallback is unambiguous. */
const characters: CharacterRegistry = {
  ids: () => CHARACTER_IDS,
  roleOf: () => 'elder-companion',
  gender: () => 'male',
  name: () => '小凯',
  spokenName: () => '小凯',
  identity: () => 'IDENTITY',
  greetingNoName: (id, language) => `NO-NAME ${id} ${language}`,
  greetingsFirstMeet: () => ['{name}您好，我是小凯，头一回来陪您。', '您好{name}，我叫小凯，以后常来陪您。'],
  voiceFor: () => undefined,
};

const PROFILE = '基本情况：老家在山东';
const NAMED = `称呼：王叔\n${PROFILE}`;
const owned = { ownerId: 'owner-1', agentId: 'agent-1', characterId: 'xiaokai', language: 'zh' } as const;
const FIRST_MEET_LINES = ['王叔您好，我是小凯，头一回来陪您。', '您好王叔，我叫小凯，以后常来陪您。'];

function planner(reply = '{"speak":false}') {
  const inputs: Array<{ stage: string; memorySnapshot: string }> = [];
  const client: TextModelClient = {
    complete: async (input) => {
      inputs.push(JSON.parse(input.user) as { stage: string; memorySnapshot: string });
      return reply;
    },
  };
  return { inputs, client };
}

function open(ctx: SessionContext, client: TextModelClient, overrides: Partial<SessionDeps> = {}) {
  const mock = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
  const session = new Session({
    adapterFactory: () => mock,
    summarizer: new MockSummarizer(),
    roles: fixedRoleCatalog('P', director),
    characters,
    textClient: client,
    ...overrides,
  }, ctx, 'first-meet');
  const creates = vi.spyOn(mock, 'createResponse');
  const transport: Transport = { send: () => {}, sendAudio: () => {} };
  return { session, creates, transport };
}

const greetingCalls = (creates: ReturnType<typeof open>['creates']) =>
  creates.mock.calls.map(([request]) => request).filter((request) => request?.cue === 'greeting');

describe('opening by first meeting and addressing', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('first meeting, no name: the planner sees no memory and the card line is the fallback', async () => {
    const { inputs, client } = planner();
    const s = open({ ...owned, firstMeet: true, memorySnapshot: PROFILE, greetingMemorySnapshot: PROFILE, proactiveMemorySnapshot: PROFILE }, client);
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(100);
    expect(inputs).toEqual([expect.objectContaining({ stage: 'greeting', memorySnapshot: '' })]);
    expect(greetingCalls(s.creates)).toEqual([{ cue: 'greeting', instruction: 'G', fallbackText: 'NO-NAME xiaokai zh' }]);
    s.session.end();
  });

  it('first meeting with a name: a first-meet template, never the planner, never "again"', async () => {
    const { inputs, client } = planner('{"speak":true,"text":"王叔，又见面啦，上次聊到京剧"}');
    const s = open({ ...owned, firstMeet: true, memorySnapshot: NAMED, greetingMemorySnapshot: NAMED, proactiveMemorySnapshot: PROFILE }, client);
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(100);
    expect(inputs).toEqual([]);
    const [opening] = greetingCalls(s.creates);
    expect(FIRST_MEET_LINES).toContain(opening?.fallbackText);
    expect(opening?.instruction).toBe(opening?.fallbackText);
    expect(greetingCalls(s.creates).some((request) => request?.fallbackText.includes('又见'))).toBe(false);
    s.session.end();
  });

  it('met before, no name: the planner keeps the greeting view and the memory copy is the fallback', async () => {
    const { inputs, client } = planner();
    const s = open({ ...owned, firstMeet: false, memorySnapshot: PROFILE, greetingMemorySnapshot: PROFILE, proactiveMemorySnapshot: PROFILE }, client);
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(100);
    expect(inputs).toEqual([expect.objectContaining({ stage: 'greeting', memorySnapshot: PROFILE })]);
    expect(greetingCalls(s.creates)).toEqual([{ cue: 'greeting', instruction: 'GM', fallbackText: '又见到您了。' }]);
    s.session.end();
  });

  it('met before with a name: the safe name template, never the planner (pitfall 5)', async () => {
    const { inputs, client } = planner('{"speak":true,"text":"上次聊到您喜欢听京剧"}');
    const s = open({ ...owned, firstMeet: false, memorySnapshot: NAMED, greetingMemorySnapshot: NAMED, proactiveMemorySnapshot: PROFILE }, client);
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(100);
    expect(inputs).toEqual([]);
    expect(greetingCalls(s.creates)).toEqual([{ cue: 'greeting', instruction: '王叔，又见面了。', fallbackText: '王叔，又见面了。' }]);
    s.session.end();
  });

  it('keeps the first-meet line stable so a retried opening repeats the same sentence', () => {
    const s = open({ ...owned, firstMeet: true, greetingMemorySnapshot: NAMED }, planner().client);
    const pick = () => (s.session as unknown as { firstMeetGreeting(): string | undefined }).firstMeetGreeting();
    // Mock after construction so nothing else consumes the stubbed values.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(pick()).toBe(FIRST_MEET_LINES[0]);
    random.mockReturnValue(0.99);
    expect(pick()).toBe(FIRST_MEET_LINES[0]);
    random.mockRestore();
    s.session.end();
  });

  it('keeps Task 7 behavior without a character registry', async () => {
    const { inputs, client } = planner();
    const s = open({ ...owned, firstMeet: true, memorySnapshot: NAMED, greetingMemorySnapshot: NAMED }, client, { characters: undefined });
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(100);
    expect(inputs).toEqual([]);
    expect(greetingCalls(s.creates)).toEqual([{ cue: 'greeting', instruction: '王叔，又见面了。', fallbackText: '王叔，又见面了。' }]);
    s.session.end();
  });

  it('skips the care opening at a first meeting only', async () => {
    const roles = fixedRoleCatalog('P', { ...director, greetingCareTexts: ['{name}，又见面啦。'] });
    for (const firstMeet of [true, false]) {
      const careFollowup = vi.fn(() => undefined);
      const store = { careFollowup } as unknown as MemoryStore;
      const s = open({ ...owned, firstMeet, memorySnapshot: NAMED, greetingMemorySnapshot: NAMED }, planner().client, { roles, store, affect });
      await s.session.start(s.transport);
      expect(careFollowup).toHaveBeenCalledTimes(firstMeet ? 0 : 1);
      s.session.end();
    }
  });
});

describe('characters do not know each other (Q14)', () => {
  it('sends each character only its own name and the unknown-name rule', async () => {
    const shipped = shippedCharacters();
    for (const characterId of CHARACTER_IDS) {
      const configs: SessionConfig[] = [];
      const mock = new MockAdapter({ script });
      const connect = mock.connect.bind(mock);
      vi.spyOn(mock, 'connect').mockImplementation((config) => { configs.push(config); return connect(config); });
      const session = new Session({
        adapterFactory: () => mock,
        summarizer: new MockSummarizer(),
        roles: shippedRoles(),
        characters: shipped,
      }, { characterId, firstMeet: true, language: 'zh' }, `isolation-${characterId}`);
      await session.start({ send: () => {}, sendAudio: () => {} });
      const instructions = configs[0]!.instructions;
      expect(instructions).toContain(shipped.name(characterId, 'zh'));
      expect(instructions).toContain('用户提到你不认识的名字时，当作用户认识的人来接话');
      for (const other of CHARACTER_IDS.filter((id) => id !== characterId)) {
        expect(instructions).not.toContain(shipped.name(other, 'zh'));
      }
      session.end();
    }
  });
});
```

说明：
- 快照字符串是手写的，不经过 store（Session 没有 store 时 `refreshMemorySnapshot` 直接返回）。称呼行用 `PROMPT_LABELS.zh.addressing + separator`，也就是「称呼：」，这正是 `greetingName()` 识别的前缀。「基本情况：」这一行只是一个非称呼的记忆行，用来模拟共享层资料。测试不依赖 Task 4 的标签常量。
- care 用例只验证有没有去查 `careFollowup`。stub 返回 undefined，care 开场随即放弃，开场回到 `greetingNameTexts`。

- [x] **Step 3: 运行，确认失败**

```bash
npm test -w gateway -- test/director.test.ts test/first-meet.test.ts
```

预期 FAIL：
- Director 的两个新用例：TypeScript 报 `firstMeetGreeting` 不是 `DirectorDeps` 的已知成员；即便忽略类型，`prefers the first-meet template` 断言也会失败（拿到的是 `safeGreeting` 的句子）。
- `first meeting, no name`：规划器拿到的 `memorySnapshot` 是 `PROFILE`，兜底是 `GM` / `又见到您了。`。
- `first meeting with a name`：开场是「王叔，又见面了。」。
- `keeps the first-meet line stable`：`firstMeetGreeting` 不存在。
- `skips the care opening`：firstMeet=true 时 `careFollowup` 也被调用了一次。

`met before …`、`keeps Task 7 behavior …` 和互不知情用例此时就应该通过：前两者保护现有行为，后者是 Task 6 的回归。

- [x] **Step 4: 改 `director.ts`**

在 `DirectorDeps` 里、`safeGreeting?(): string | null;` 那一行之前加：

```ts
  /** First meeting with a known name: a card template with {name} filled in; undefined otherwise. Checked before safeGreeting. */
  firstMeetGreeting?(): string | undefined;
```

`requestGreeting` 开头的这两行：

```ts
    // With a stored name, never let the planner invent a past topic.
    const safe = this.deps.safeGreeting?.();
```

替换为：

```ts
    // A known name never goes to the planner: first-meet template first, then the met-before name greeting.
    const safe = this.deps.firstMeetGreeting?.() ?? this.deps.safeGreeting?.();
```

方法其余部分不动。

- [x] **Step 5: 改 `session.ts`**

1. 第 30 行的 director import 改为 `import { Director, type DirectorConfig, type SilenceContext, type SilencePlan } from './director.ts';`（`director.ts` 已经 re-export `DirectorConfig`，见 `director.ts:8`）。
2. 在字段区（`private openLoop: string | undefined;` 附近）加：
   ```ts
   /** First-meet opening, picked once per language so a cut-off opening repeats the same sentence. */
   private firstMeetLine: { language: Language; text: string } | null = null;
   /** First meetings only: director configs whose greetingText is the card's no-name line. */
   private readonly firstMeetDirectors = new Map<Language, DirectorConfig>();
   ```
3. 构造函数里的 `new Director(...)`：
   - 第一个参数 `(language) => deps.roles.director(ctx.characterId, language),` 改为 `(language) => this.directorConfig(language),`
   - deps 对象里，`requestResponse: …` 那一行之后加（放在 `...(deps.textClient && hasSilencePlanner ? {` 之外，**始终接线**）：
     ```ts
     firstMeetGreeting: () => this.firstMeetGreeting(),
     ```
   - `getMemorySnapshot` 改为：
     ```ts
     getMemorySnapshot: (stage) => stage === 'greeting'
       // A first meeting must not sound like a reunion: the greeting planner sees no memory.
       ? (this.context.firstMeet ? '' : this.context.greetingMemorySnapshot ?? '')
       : this.context.proactiveMemorySnapshot ?? '',
     ```
4. `start()` 里的 `this.director.onSessionStart(Boolean(this.context.memorySnapshot?.trim()));` 改为 `this.director.onSessionStart(this.openingHasMemory());`。
5. `startCareOpening()` 的第一行之前加：
   ```ts
   // A new character has nothing left over to ask about.
   if (this.context.firstMeet) return null;
   ```
6. 在 `safeGreeting()` 方法之前加三个私有方法：
   ```ts
   /** First meeting with a known name (spec 开场 table): a card template with {name}. Never the planner. */
   private firstMeetGreeting(): string | undefined {
     const characters = this.deps.characters;
     if (!this.context.firstMeet || !characters) return undefined;
     const name = this.greetingName();
     if (!name) return undefined;
     const picked = this.firstMeetLine;
     if (picked && picked.language === this.language) return picked.text;
     const templates = characters.greetingsFirstMeet(this.context.characterId, this.language);
     const text = templates[Math.floor(Math.random() * templates.length)]!.replaceAll('{name}', name);
     this.firstMeetLine = { language: this.language, text };
     return text;
   }

   /** First meeting: the card's no-name line replaces greetingText as the planner-failure fallback. */
   private directorConfig(language: Language): DirectorConfig {
     const base = this.deps.roles.director(this.context.characterId, language);
     const characters = this.deps.characters;
     if (!this.context.firstMeet || !characters) return base;
     let config = this.firstMeetDirectors.get(language);
     if (!config) {
       config = { ...base, greetingText: characters.greetingNoName(this.context.characterId, language) };
       this.firstMeetDirectors.set(language, config);
     }
     return config;
   }

   /** A first meeting without a name opens like a session with no memory: introduce yourself, ask the name. */
   private openingHasMemory(): boolean {
     if (!this.context.memorySnapshot?.trim()) return false;
     return !(this.context.firstMeet && !this.greetingName());
   }
   ```

`firstMeetDirectors` 和 `firstMeetLine` 是带初始值的类字段，会在构造函数体执行前完成初始化，所以构造函数里创建 Director 时调用 `directorConfig` 是安全的。

- [x] **Step 6: 运行，确认通过**

```bash
npm test -w gateway -- test/director.test.ts test/first-meet.test.ts test/session.test.ts test/care-opening.test.ts test/memory-acceptance.test.ts
```

预期：PASS。后三个文件用来确认现有开场、care 开场和端到端记忆路径没有受影响。

- [x] **Step 7: 全量回归**

```bash
npm run typecheck -w gateway
npm test -w gateway
```

预期：typecheck 无错误，全部测试通过。

- [x] **Step 8: 提交**

```bash
git add gateway/src/session/director.ts gateway/src/session/session.ts gateway/test/first-meet.test.ts gateway/test/director.test.ts
git commit -m "feat(gateway): greet a first meeting per character

A character meeting a named user for the first time opens with a card
template, never the planner; without a name the planner introduces the
character with no memory and falls back to the card's no-name line.
First meetings skip the care opening.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收清单

- [x] 四种组合的测试全部存在并通过：初次见面 × 有无称呼、见过面 × 有无称呼。
- [x] 有称呼时开场不调用规划器：初次见面用 `greetingsFirstMeet`，见过面用 `greetingNameTexts` / care，两种都有测试断言 `inputs` 为空。
- [x] 初次见面没有称呼时，规划器的 greeting 输入里 `memorySnapshot` 为空串；兜底句是角色卡的 `greetingNoName`。
- [x] 初次见面的模板在同一会话、同一语言里只选一次。
- [x] 初次见面不查 `careFollowup`；见过面照常查。
- [x] 三个角色的会话指令里只有自己的名字，并且都带着「不认识的名字」那条规则。
- [x] 沉默四段式、规划器指令、告知流程、`requestResponse` 出口都没有改动（`git diff` 里 `director.ts` 只有 `DirectorDeps` 和 `requestGreeting` 两处变化）。
- [x] `npm run typecheck -w gateway` 和 `npm test -w gateway` 全绿。
