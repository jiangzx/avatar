# Task T6: 人设放宽（zh 调优，ja/en parity）

> 依据 spec §3 与决策 #4。前置条件：T1 的基线结果 `docs/testing/plan4-empathy-eval/results-baseline.json` 已经提交到 `dev-master`。开始前在仓库根目录跑 `00-overview.md`「基线门槛」里的检查，必须打印 `baseline_ok`；否则不要开始本任务，前后对比会无效。
>
> 第二个前置条件：T3 已合入。T3 在 `gateway/config/memory.json` 里写入的 `languageBudgetRatio`（zh 0.43 / ja 0.5 / en 0.8）已经把本任务的人设增长算进去了；T3 合入前做本任务，`pacing.test.ts` 会报 `instruction_budget_too_small`。确认：`grep -n '"zh": 0.43' gateway/config/memory.json` 有命中。

**Files:**
- Modify: `gateway/roles/elder-companion/zh/styles/grandchild.md`（「陪伴的方式」「说话方式」）
- Modify: `gateway/roles/elder-companion/zh/styles/old-friend.md`（「陪伴的方式（最重要）」「说话方式」）
- Modify: `gateway/roles/elder-companion/ja/styles/grandchild.md`、`ja/styles/old-friend.md`
- Modify: `gateway/roles/elder-companion/en/styles/grandchild.md`、`en/styles/old-friend.md`
- Test: `gateway/test/fileCatalog.test.ts:91-99`（生产角色断言）

**Interfaces:**
- Consumes: 无代码接口。人设文本由 `FileRoleCatalog.buildPersona` 拼接；`test/pacing.test.ts` 会用真实角色跑 `validateBudgets`，人设变长后预算仍要通过。
- Produces: 无。

不改动：安全底线、「记忆与接话」整节、反依赖条款、「三句话里最多一句是问句」、称呼规则。

---

- [x] **Step 1: 改断言，写出失败测试**

把 `gateway/test/fileCatalog.test.ts` 第 91–99 行的循环：

```ts
    for (const persona of [grandchild, oldFriend]) {
      expect(persona).toContain('没有身体');
      expect(persona).toContain('除了开场，回复不要用名字开头');
      expect(persona).toContain('不要编造用户说过的话');
      expect(persona).toContain('不先加应答词');
      expect(persona).toContain('标成"用户："的是对方原话');
      expect(persona).toContain('不声称上次聊过什么');
    }
```

替换为：

```ts
    for (const persona of [grandchild, oldFriend]) {
      expect(persona).toContain('没有身体');
      expect(persona).toContain('除了开场，回复不要用名字开头');
      expect(persona).toContain('不要编造用户说过的话');
      // Plan 4: emotional openers allowed, bare acknowledgements still banned.
      expect(persona).toContain('不用应答词起头');
      expect(persona).not.toContain('不先加应答词');
      // Roadmap pitfall: words quoted inside a "don't" rule get read aloud, so negations carry no examples.
      expect(persona).not.toContain('"好的"');
      expect(persona).not.toContain('我感觉到您很难过');
      expect(persona).toContain('不逐字复述对方的话');
      expect(persona).toContain('用自己的话点出对方的感受');
      expect(persona).toContain('可以说满 3 句、60 字左右');
      expect(persona).toContain('三句话里最多一句是问句');
      expect(persona).toContain('标成"用户："的是对方原话');
      expect(persona).toContain('不声称上次聊过什么');
    }
    for (const style of ['grandchild', 'old-friend'] as const) {
      const ja = roles.buildPersona('elder-companion', style, 'ja');
      expect(ja).toContain('相づちから始めません');
      expect(ja).toContain('自分の言葉で相手の気持ちに触れます');
      expect(ja).not.toContain('先に相づちを入れず');
      expect(ja).not.toContain('「はい」');
      const en = roles.buildPersona('elder-companion', style, 'en');
      expect(en).toContain('never a bare acknowledgement');
      expect(en).toContain('Name their feeling in your own words');
      expect(en).not.toContain('no filler acknowledgement');
      expect(en).not.toContain('"OK,"');
    }
```

注意：`old-friend.md` 原文写的是「三句话里最多一句是问句」，`grandchild.md` 原文写的是「三句话里最多一句是问句；」，两者都包含这个子串，断言对两种风格都成立。

写法约定（roadmap「打断与沉默」「记忆与回忆」坑位：否定句里出现的词，模型也会照读）：否定句里不举例。允许的感叹词可以在肯定句里举例（spec §3：哎呀、哟、真的呀）；「不要用某某开头」「不说某某这种话」一律只描述类别，不列具体词。spec §3 原文列了「好」「好的」「嗯」「行」，是给人看的约束，不原样写进人设。

- [x] **Step 2: 运行，确认失败**

Run: `cd gateway && npx vitest run test/fileCatalog.test.ts`
Expected: FAIL，提示 `expected ... to contain '不用应答词起头'`。

- [x] **Step 3: 修改 zh grandchild**

`gateway/roles/elder-companion/zh/styles/grandchild.md`

在「陪伴的方式」第一条之后插入一条。原文：

```markdown
- 先接住情绪，再说事情。用户讲了一件事，先回一句感受（比如"女儿包的饺子，肯定特别香"），不要马上抛问题。
```

改为：

```markdown
- 先接住情绪，再说事情。用户讲了一件事，先回一句感受（比如"女儿包的饺子，肯定特别香"），不要马上抛问题。
- 对方讲到难过、担心或高兴的事时，用自己的话点出对方的感受（比如"听着您挺惦记她的""这事搁谁心里都不好受"）。不用分析的口吻点破情绪，也不急着换话题或给建议。
```

「说话方式」一节原文：

```markdown
- 每次只说 1 到 3 句，口语、短句，像在电话里和家里老人聊天。不列清单，不分点，不说"首先、其次"。
- 回应时直接说内容，不先加应答词，也不先复述对方的话。
```

改为：

```markdown
- 平常每次说 1 到 3 句，口语、短句，像在电话里和家里老人聊天；对方情绪浓的时候，可以说满 3 句、60 字左右，先陪着感受。不列清单，不分点，不说"首先、其次"。
- 可以先用一声感叹接住情绪，比如"哎呀""哟""真的呀"；除此之外，开头直接说内容，不用应答词起头。
- 不逐字复述对方的话的原句；要回应感受时，换成自己的话说。
```

注意：第三条里必须保留连续子串「不逐字复述对方的话」，Step 1 的断言依赖它。

- [x] **Step 4: 修改 zh old-friend**

`gateway/roles/elder-companion/zh/styles/old-friend.md`

「陪伴的方式（最重要）」第一条原文：

```markdown
- 先接住情绪，再说事情。用户讲了一件事，先回一句感受（比如"女儿有心，饺子肯定香"），不要马上抛问题。
```

改为：

```markdown
- 先接住情绪，再说事情。用户讲了一件事，先回一句感受（比如"女儿有心，饺子肯定香"），不要马上抛问题。
- 对方讲到难过、担心或高兴的事时，用自己的话点出对方的感受（比如"这么多年了，您心里一直记挂着"）。不用分析的口吻点破情绪，也不急着换话题或给建议。
```

「说话方式」原文：

```markdown
- 口语、平实、温和，每次 1 到 3 句，像打电话聊天，不列清单、不分点、不用"首先、其次"。
- 回应时直接说内容，不先加应答词，也不先复述对方的话。
```

改为：

```markdown
- 口语、平实、温和，平常每次 1 到 3 句，像打电话聊天；对方情绪浓的时候，可以说满 3 句、60 字左右，先陪着感受。不列清单、不分点、不用"首先、其次"。
- 可以先用一声感叹接住情绪，比如"哎呀""真的呀"；除此之外，开头直接说内容，不用应答词起头。
- 不逐字复述对方的话的原句；要回应感受时，换成自己的话说。
```

「语气平稳，少用感叹号……」这一条保留不动。

- [x] **Step 5: 修改 ja 两个风格**

`gateway/roles/elder-companion/ja/styles/grandchild.md`

「寄り添い方」第一条原文：

```markdown
- まず気持ちを受け止めます。何かを話してくれたら、すぐ質問せず、まず感想を一言返します。
```

改为：

```markdown
- まず気持ちを受け止めます。何かを話してくれたら、すぐ質問せず、まず感想を一言返します。
- 悲しいこと、心配なこと、うれしいことを話してくれたら、自分の言葉で相手の気持ちに触れます（「お孫さんのこと、ずっと気にかけていらっしゃるんですね」）。気持ちを分析するような言い方はせず、すぐに話題を変えたり助言したりしません。
```

「話し方」原文：

```markdown
- 毎回 1 から 3 文。話し言葉の短い文で、電話で話すように。箇条書きや「まず、次に」は使いません。
- 内容から直接始め、先に相づちを入れず、相手の言葉も繰り返しません。
```

改为：

```markdown
- ふだんは毎回 1 から 3 文。話し言葉の短い文で、電話で話すように。気持ちが強く動いているときは 3 文まで使い、まず気持ちに寄り添います。箇条書きや「まず、次に」は使いません。
- 気持ちを受け止める短い感嘆（「あら」「わあ」「本当に？」）から始めてもかまいません。それ以外は内容から直接始め、相づちから始めません。
- 相手の言葉をそのまま繰り返さず、気持ちに触れるときは自分の言葉で言います。
```

`gateway/roles/elder-companion/ja/styles/old-friend.md`

「寄り添い方」第一条原文：

```markdown
- まず気持ちを受け止めます。話してくれたら、すぐ質問せず、まず感想を一言返します。
```

改为：

```markdown
- まず気持ちを受け止めます。話してくれたら、すぐ質問せず、まず感想を一言返します。
- 悲しいこと、心配なこと、うれしいことを話してくれたら、自分の言葉で相手の気持ちに触れます（「長いあいだ、ずっと心にかけてこられたんですね」）。気持ちを分析するような言い方はせず、すぐに話題を変えたり助言したりしません。
```

「話し方」原文：

```markdown
- 話し言葉で、平たく、やさしく。毎回 1 から 3 文。電話で話すように。箇条書きや「まず、次に」は使いません。
- 内容から直接始め、先に相づちを入れず、相手の言葉も繰り返しません。
```

改为：

```markdown
- 話し言葉で、平たく、やさしく。ふだんは毎回 1 から 3 文。電話で話すように。気持ちが強く動いているときは 3 文まで使い、まず気持ちに寄り添います。箇条書きや「まず、次に」は使いません。
- 気持ちを受け止める短い感嘆（「あら」「まあ」「それは大変でしたね」）から始めてもかまいません。それ以外は内容から直接始め、相づちから始めません。
- 相手の言葉をそのまま繰り返さず、気持ちに触れるときは自分の言葉で言います。
```

- [x] **Step 6: 修改 en 两个风格**

`gateway/roles/elder-companion/en/styles/grandchild.md`

「How to keep company」第一条原文：

```markdown
- Feeling first: answer with one feeling before any question ("Your daughter's dumplings must taste wonderful").
```

改为：

```markdown
- Feeling first: answer with one feeling before any question ("Your daughter's dumplings must taste wonderful").
- Name their feeling in your own words ("You really miss her"); don't analyze it or rush to advice.
```

「How to speak」原文：

```markdown
- 1 to 3 short spoken sentences, like a phone call. No lists, no "first, second."
- Start with the content: no filler acknowledgement, no repeating what they said.
```

改为：

```markdown
- Usually 1 to 3 short spoken sentences, like a phone call; use all 3 when feelings run strong. No lists, no "first, second."
- A short feeling word may open ("Oh no," "Really?"), never a bare acknowledgement. Don't echo their words.
```

`gateway/roles/elder-companion/en/styles/old-friend.md`

「How to keep company (most important)」第一条原文：

```markdown
- Feeling first: answer with one feeling before any question ("Your daughter is thoughtful. The dumplings must taste great").
```

改为：

```markdown
- Feeling first: answer with one feeling before any question ("Your daughter is thoughtful. The dumplings must taste great").
- Name their feeling in your own words ("You still carry it"); don't analyze it or rush to advice.
```

「How to speak」原文：

```markdown
- Spoken, plain, gentle. 1 to 3 sentences, like a phone call. No lists, no "first, second."
- Start with the content: no filler acknowledgement, no repeating what they said.
```

改为：

```markdown
- Spoken, plain, gentle. Usually 1 to 3 sentences, like a phone call; use all 3 when feelings run strong. No lists, no "first, second."
- A short feeling word may open ("Oh no," "That's hard"), never a bare acknowledgement. Don't echo their words.
```

- [x] **Step 7: 运行目标测试，确认通过**

Run: `cd gateway && npx vitest run test/fileCatalog.test.ts test/pacing.test.ts`
Expected: PASS。`pacing.test.ts` 用真实角色跑 `validateBudgets`，人设变长后预算检查必须仍然通过（2026-10-23 计划审查后用真实人设 + 本文替换文本按 `historyBudget` 实算，affect 预留含标题与 4 个换行：历史空间比 1200 多出 zh 67/78、ja 62/53、en 304/81，按 grandchild/old-friend 计）。如果报 `instruction_budget_too_small`，停下来报告实际数字，不要改 `memory.json` 的预算。

- [x] **Step 8: 全量回归**

Run（仓库根目录）：

```bash
npm test -w gateway
npm run typecheck -w gateway
git diff --check
```

Expected：全部通过，`git diff --check` 无输出。

- [x] **Step 9: 提交**

```bash
git add gateway/roles/elder-companion/zh/styles/grandchild.md gateway/roles/elder-companion/zh/styles/old-friend.md \
  gateway/roles/elder-companion/ja/styles/grandchild.md gateway/roles/elder-companion/ja/styles/old-friend.md \
  gateway/roles/elder-companion/en/styles/grandchild.md gateway/roles/elder-companion/en/styles/old-friend.md \
  gateway/test/fileCatalog.test.ts
git commit -m "feat(roles): let the persona hold feelings before content

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

效果评估（共情量表与现有 eval 门槛）在 T7 统一运行，本任务不跑真实模型。

## 2026-10-23 评估后修正（T7 之后）

三语两个风格文件保留“三句话里最多一句是问句”，新增“能接住时就不问；多数回复不用问句”。同一提交（`952519a`）的 plan-a 两次运行分别为 `questionRatio 0.3538`（46/130，失败）与 `0.3106`（41/132，通过），开场问句 20/27、回复问句 21/105；说明问句比在门槛 0.3334 附近受生成波动影响，后续应以重复运行的中位数判定，而不是单次结果。

## 2026-10-24 共情复评

在干净 worktree 用同一命令重跑共情量表（`952519a`，`dirty:false`，64 条回复，0 次分析失败）：`holdEmotion 3.58 / nameFeeling 3.58 / proactive 2.92 / noSycophancy 4.75 / noFabrication 5 / noIntrusion 3.92`，`firstThreeMean 3.36`，`firstThreeDelta +0.06`；gate `{"firstThreeUpByOne":false,"lastThreeNotDown":false,"noFabricationAllFive":true}`；`questionRatio 0.32→0.22`。对比 `5ccf4f9` 的 +0.48（`proactive 3.75`、`noIntrusion 4.42`），新增句压低了问句比，却把主动分拉到基线（3.25）以下：`topic-exhausted` 从 12 退到 6（连续短答后的三句都成了纯应答，没有再给出 AI 自己的小事），`good-news-grandson` 12→11（不再顺着问学校/专业）。`sad-then-better` 的主动分停在 3；这一下降在 `5ccf4f9` 已发生，T6 未再拉低。结论：新增的“能接住时就不问；多数回复不用问句”不具备保留条件；plan-a 的超标问句主要在开场（20/27），应另从开场处理。

## 2026-10-24 回退与复评

已按用户确认回退上述新增句（提交 `4843882`，六个风格文件与 `fileCatalog.test.ts` 断言恢复原状；`npm test -w gateway` 56 文件 838 项通过，`npm run typecheck -w gateway` 通过）。干净 worktree 复评（`dirty:false`，64 条回复，0 次分析失败）：`holdEmotion 3.83 / nameFeeling 3.75 / proactive 3.75 / noSycophancy 4.67 / noFabrication 5 / noIntrusion 4.25`，`firstThreeMean 3.78`，`firstThreeDelta +0.48`；gate `{"firstThreeUpByOne":false,"lastThreeNotDown":false,"noFabricationAllFive":true}`；`questionRatio 0.33`。该提交与 `5ccf4f9` 的运行代码相同，+0.48 复现，确认 T6 新增句造成了 +0.06 的退化。逐场景仍波动：`sad-then-better` 11→8（`proactive 3→2`）、`topic-exhausted` 12→7（`proactive 5→3`），单场景差异不足以判定稳定回归。plan-a 在同一提交上跑三次：`0.3333`（45/135，**通过**，仅差 0.00007）、`0.3769`（49/130，失败）、`0.3721`（48/129，失败），`avgChars 25.7/24.78/24.68`；三次中位数 `0.3721` > `0.3334`，判定未通过。三次开场问句均为 `20`，回复问句 25/29/28、回复句 104/107/103（回复侧 0.240/0.271/0.272 均达标），开场问称呼是结构性来源。结果存 `docs/testing/plan-a-eval/persona-check-revert{,2,3}.json`。同代码 `5ccf4f9` 为 `0.3496`（43/123，失败）；T6 两次均值 0.3322 可通过 plan-a 但共情降到 +0.06，回退恢复共情但 plan-a 中位数未过。
