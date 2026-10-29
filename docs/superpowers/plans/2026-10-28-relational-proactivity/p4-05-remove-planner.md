# P4-T5：删除文本模型沉默规划器

**Spec：** Q7（关键路径上不调文本模型规划）、Q16（删逐句词表硬校验）、Q17（开场不再等文本模型）、「意图渲染」（现有 `planProactiveLine` 移除）、总览 P3 取舍第 1 条（规划器暂留到 P4）、总览 P4 取舍第 1、2 条。

**改后谁来说：**

| 场合 | P3 之后 | P4-T5 之后 |
|---|---|---|
| 已知称呼开场 | 引擎（P4-T3） | 不变 |
| 不知道称呼的开场 | 文本规划器写句子，Qwen 照读 | Qwen 按 `greetingInstruction` 说（自我介绍、问称呼） |
| zh 已聊起来或已知称呼的四段沉默 | 引擎 | 不变 |
| zh 不知道称呼、还没开口的前几段 | 文本规划器 | 配置指令（`openingFollowInstruction`、`checkInstruction`…，Qwen 按指令说） |
| ja/en 四段沉默 | 文本规划器 | 配置指令 |

`Director` 的「问规划器」口子（`planProactiveLine` 依赖与 `SilencePlan`）保留：`Session` 只在有运行时的时候接上它，而它现在只问运行时。`Director` 内部按文字规划套 `speakInstruction` 的分支保留为通用能力（现有 Director 测试仍覆盖它），不再从 `silenceDecision` 读模板。

**删除范围：** `gateway/src/session/silence.ts`、`gateway/test/silence.test.ts`、`SilenceDecisionConfig` 与 `DirectorConfig.silenceDecision`（`roles/types.ts`）、`DirectorSchema.silenceDecision`（`config.ts`）、三种语言 `director.json` 的 `silenceDecision` 块、`Session` 的 `silencePlanners`、`textPlan`、`hasSilencePlanner`/`textPlanner`、只服务规划器的 `getMemorySnapshot` / `getPlanExtras` 接线与 `planExtras()` 方法、`Director.planSpeakInstruction` 里读 `silenceDecision` 的那一行、`gateway/scripts/probe-proactive-lines.ts`（import 了规划器，会挡住 typecheck）、`docs/testing/plan3-silence-flow-probe.mjs`（同理；`plan3-silence-flow-*.json` 结果保留作历史）。

**保留：** 用量类型 `'silence_plan'` 与后台标签（历史用量行）；i18n `silence.json` 的 `greeting`/`listening`/`anytime`/`maxCheckinChars`（`listening`/`anytime` 仍被事后核对与后台 `checkinText` 校验使用；`greeting` 变成无人使用，留着不影响，避免改动逐字锁定的 zh 文件）。

**Files:**
- Delete: 见上
- Modify: `gateway/src/roles/types.ts`、`gateway/src/config.ts`、`gateway/roles/elder-companion/{zh,ja,en}/director.json`、`gateway/src/session/director.ts`、`gateway/src/session/session.ts`
- Test: `gateway/test/proactive-session.test.ts`（加用例）；引用规划器或 `silenceDecision` 的现有测试按下文规则修改

**Interfaces:**
- Consumes: P4-T3 之后的会话。
- Produces（冻结）：`DirectorConfig` 去掉 `silenceDecision`。

- [x] **Step 1：写失败测试**

`gateway/test/proactive-session.test.ts` 末尾追加：

```ts
describe('no text planner anywhere (P4-T5)', () => {
  it('a first meeting without a name opens with the configured instruction, and no text model is called', async () => {
    const complete = vi.fn(async () => '{"speak":true,"text":"不应出现"}');
    const adapter = new FakeAdapter();
    const session = new Session({
      adapterFactory: () => adapter,
      summarizer: new MockSummarizer(),
      roles: fixedRoleCatalog('P', director),
      textClient: { complete },
      i18n,
      proactivity,
    }, { characterId: 'xiaonuan', firstMeet: true, language: 'zh' }, 'no-planner');
    sessions.push(session);
    await session.start({ send: () => {}, sendAudio: () => {} });
    expect(adapter.requests[0]).toEqual({ cue: 'greeting', instruction: director.greetingInstruction, fallbackText: director.greetingText });
    adapter.done();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 0, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(director.contextAfterMs! + director.checkAfterMs!);
    expect(adapter.requests.length).toBeGreaterThanOrEqual(2);
    expect(complete).not.toHaveBeenCalled();
  });
});
```

这条用例在删除前也可能已经通过（本文件的 `director` 从 P3-T6 起就没有 `silenceDecision`），它是行为回归保护；本任务真正的失败信号是 Step 2 删除类型后，其余 fixture 里残留的 `silenceDecision` 让 typecheck 报错——按 Step 4 的规则逐个处理。

`firstMeet: true` 且没有称呼时，`directorConfig` 只有在注入 `characters` 时才把 `greetingText` 换成角色卡的无称呼开场；这里没注入，所以期望是 `director.greetingText`。

- [x] **Step 2：运行用例，然后删除类型与配置**

Run: `npm test -w gateway -- test/proactive-session.test.ts`，记录结果（通过或失败都写进报告）。

`gateway/src/roles/types.ts`：删除 `SilenceDecisionConfig` 接口与 `DirectorConfig.silenceDecision`；`contextInstruction` 的注释改为 `/** Step 1 instruction for the configured path (ja/en, no name yet). */`。

`gateway/src/config.ts`：删除 `DirectorSchema` 的 `silenceDecision` 字段及其两个 refine 文案。

三个 `director.json` 删除整个 `"silenceDecision": { … }` 块（注意前一行的逗号）。

- [x] **Step 3：`Director` 与 `Session`**

`gateway/src/session/director.ts` 的 `planSpeakInstruction`：

```ts
  private planSpeakInstruction(stage: ProactivePlanStage): string {
    const c = this.cfg;
    return stage === 'greeting'
      ? (c.greetingInstruction ?? this.silence().contextInstruction)
      : this.silence().contextInstruction;
  }
```

`gateway/src/session/session.ts`：
1. 删除 `import { createSilencePlanner } from './silence.ts';`、字段 `silencePlanners`、`hasSilencePlanner` 与 `textPlanner` 两个局部变量、方法 `textPlan`、方法 `planExtras`（以及因此不再使用的 import，例如 `timeContext`；以 typecheck 报出的未使用项为准，只删确实无人使用的）。
2. `Director` 依赖改为：

```ts
        ...(this.proactive ? { planProactiveLine: (context, signal) => this.planProactiveLine(context, signal) } : {}),
```

删除 `getMemorySnapshot`、`getPlanExtras` 两项。

3. `planProactiveLine`：

```ts
  /** Silence steps ask the decision engine; null = the configured stage copy. The opening never comes here with a known name. */
  private planProactiveLine(context: SilenceContext, _signal: AbortSignal): SilencePlan | null {
    if (context.stage === 'greeting' || !this.proactive) return null;
    const line = this.proactive.silenceLine({ …与 P3-T6 相同… });
    if (line && 'request' in line) return { text: line.request.fallbackText, request: line.request };
    if (line && 'quiet' in line) return { text: null, quiet: true };
    if (line && 'close' in line) return { text: null, close: true };
    return null;
  }
```

（`silenceLine` 的参数对象原样保留 P3-T6 的写法。）

- [x] **Step 4：删除文件**

```bash
git rm gateway/src/session/silence.ts gateway/test/silence.test.ts gateway/scripts/probe-proactive-lines.ts docs/testing/plan3-silence-flow-probe.mjs
grep -rn "createSilencePlanner\|silenceDecision\|SilenceDecisionConfig\|probe-proactive-lines\|plan3-silence-flow-probe" gateway/src gateway/test gateway/scripts docs/testing docs/project/roadmap.md
```

Expected：`grep` 只剩 roadmap 里的历史记录（不改历史记录）；代码与测试里没有输出。

引用规划器的现有测试按这条规则处理：
- **断言「文本规划器说了什么 / 被调用了几次」的会话级用例**（`multilingual.test.ts` 的 checkin 规划用例、`session.test.ts` 里注入 `silenceDecision` 与规划回复的用例）：删除，或改为断言新表格里的说话方（配置指令或引擎）。
- **只是 fixture 里带了 `silenceDecision`** 的用例：删掉该字段，断言不变。
- **`Director` 级用例**（`director*.test.ts` 直接注入 `planProactiveLine`）：不受影响，保留；从 `loadDirectorConfig` 解构 `silenceDecision` 的写法改为直接使用配置。
逐条写进任务报告。

- [x] **Step 5：测试与提交**

Run: `npm test -w gateway && npm run typecheck -w gateway && npm test -w admin && npm run typecheck -w admin`
Expected: PASS。

```bash
git add gateway/src/roles/types.ts gateway/src/config.ts gateway/roles/elder-companion/zh/director.json gateway/roles/elder-companion/ja/director.json gateway/roles/elder-companion/en/director.json \
  gateway/src/session/director.ts gateway/src/session/session.ts gateway/test/proactive-session.test.ts
git commit -m "refactor(session): remove the text-model silence planner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（Step 4 改过的测试文件按明确路径一并加入；`git rm` 的删除已暂存。）
