# P4-T4：熟悉度语气进会话指令（开放项 2）

**Spec：** 开放项 2（已定：熟悉度同时影响被动回复；会话开始时按熟悉度档位取一句固定语气说明，随会话指令下发；会话中熟悉度不变，不需要额外推送）、「关系画像」三档熟悉度、Q9。

**位置（总览 P4 取舍第 7 条）：** 语气说明放在角色 `director.json` 的 `familiarityTones`（只写 zh）。会话在构造时把对应档位那一句接在人设后面（`personaFor`），所以它进入每一次会话指令，也自然计入「历史预算」计算；启动 / 发布时的预算检查按最长那句计。

熟悉度来自 `ProactiveRuntime.familiarityTier()`（P4-T2）：从这个角色已结束的会话推导，读库失败或没有记忆库时是 `new`。没有 `proactivity`（多数测试）或当前语言没有 `familiarityTones` 时不加。

**Files:**
- Modify: `gateway/src/roles/types.ts`、`gateway/src/config.ts`（`familiarityTones`）
- Modify: `gateway/roles/elder-companion/zh/director.json`
- Modify: `gateway/src/session/session.ts`（运行时提前构造；`personaFor` 接语气）
- Modify: `gateway/src/session/configSnapshot.ts`（预算检查计入最长语气句）
- Test: `gateway/test/proactive-session.test.ts`（加用例）、`gateway/test/intent-copy.test.ts`（加用例）

**Interfaces:**
- Consumes: P4-T2 `familiarityTier()`。
- Produces（冻结）：`DirectorConfig.familiarityTones?: { new: string; familiar: string; oldFriend: string }`。

- [x] **Step 1：写失败测试**

`gateway/test/proactive-session.test.ts` 末尾追加：

```ts
describe('familiarity tone (open item 2)', () => {
  const statsOf = (sessions: number, activeDays: number) => ({ firstMetAt: 1, sessions, totalMinutes: 0, activeDays, lastSessionAt: 1, hourHistogram: Array(24).fill(0) });

  it('adds the tone for this character’s familiarity to every instruction', async () => {
    const t = boot(fakeStore({ relationshipStats: vi.fn(() => statsOf(3, 2)) }));
    await t.open();
    expect(t.adapter.connects[0]!.instructions).toContain(director.familiarityTones!.familiar);
    expect(t.adapter.connects[0]!.instructions).not.toContain(director.familiarityTones!.new);
  });

  it('a new acquaintance gets the new tone', async () => {
    const t = boot();
    await t.open();
    expect(t.adapter.connects[0]!.instructions).toContain(director.familiarityTones!.new);
  });
});
```

`gateway/test/intent-copy.test.ts` 末尾追加：

```ts
describe('familiarity tones', () => {
  it('ships three zh tones and counts the longest in the startup budget', () => {
    const zh = loadDirectorConfig(zhPath);
    expect(Object.keys(zh.familiarityTones!).sort()).toEqual(['familiar', 'new', 'oldFriend']);
    expect(() => buildConfigSnapshot({
      gatewayRoot: root,
      overlay: { 'role:elder-companion/zh/director.familiarityTones.oldFriend': '很长的语气说明。'.repeat(250) },
      version: 9, ledger, sessionStartTimeoutMs: 10_000, models,
    })).toThrow(/提示词太长/);
  });
});
```

- [x] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/proactive-session.test.ts test/intent-copy.test.ts`
Expected: FAIL——`familiarityTones` 未定义，指令里没有语气句。

- [x] **Step 3：类型、schema、文案**

`gateway/src/roles/types.ts` 的 `DirectorConfig` 加：

```ts
  /** Open item 2: one fixed tone line per familiarity tier, appended to the persona for the whole session. */
  familiarityTones?: { new: string; familiar: string; oldFriend: string };
```

`gateway/src/config.ts` 的 `DirectorSchema` 加：

```ts
  familiarityTones: z.object({ new: z.string().min(1).max(2_000), familiar: z.string().min(1).max(2_000), oldFriend: z.string().min(1).max(2_000) }).strict().optional(),
```

（单句上限 2000 字只防误填；真正的上限是 Step 5 的预算检查——zh 指令总预算约 4700 字，人设已占约 1900 字，2000 字的语气句一定放不下。）

`gateway/roles/elder-companion/zh/director.json` 在 `intents` 之前加：

```json
  "familiarityTones": {
    "new": "你们刚认识不久：说话客气、亲切，多了解对方，不开玩笑。",
    "familiar": "你们已经聊过几次：说话亲切自然，可以轻松一点。",
    "oldFriend": "你们是老朋友了：说话随和，可以偶尔开个轻松的玩笑。"
  },
```

- [x] **Step 4：`Session`**

1. 把 P3-T6 加在构造函数里的 `this.proactive = deps.proactivity ? new ProactiveRuntime({ … }) : null;` 整段**移到** `this.gate = new PushGate({ … });` 之后、`this.language = this.resolveLanguage(…)` 之前，并把其中的 `ownerId`、`agentId` 改为 `ctx.ownerId`、`ctx.agentId`（那两个局部变量在更后面才定义）。原因：`personaFor` 在构造时就被调用（历史预算），它现在要读熟悉度。

2. `personaFor` 改为：

```ts
  private personaFor(language: Language): string {
    const cached = this.personas.get(language);
    if (cached !== undefined) return cached;
    const base = this.deps.roles.buildPersona(this.context.characterId, language);
    // Open item 2: familiarity is fixed for the session, so the tone rides on the cached persona.
    const tones = this.directorConfig(language).familiarityTones;
    const tone = tones && this.proactive ? tones[this.proactive.familiarityTier()] : '';
    const persona = tone ? `${base}\n\n${tone}` : base;
    this.personas.set(language, persona);
    return persona;
  }
```

- [x] **Step 5：预算检查**

`gateway/src/session/configSnapshot.ts` 里组装 `personas` 的循环改为：

```ts
    for (const pair of roles.characterLanguagePairs()) {
      const persona = roles.buildPersona(pair.characterId, pair.language);
      // The longest familiarity tone rides on the persona at run time; budget for it here.
      const tones = roles.director(pair.characterId, pair.language).familiarityTones;
      const tone = tones ? [tones.new, tones.familiar, tones.oldFriend].reduce((a, b) => (b.length > a.length ? b : a)) : '';
      (personas[pair.language] ??= []).push(tone ? `${persona}\n\n${tone}` : persona);
    }
```

- [x] **Step 6：测试与提交**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS。若某些会话测试逐字断言了连接时的指令全文，而它们注入了 `proactivity`，按「人设后多一句语气」更新期望，写进任务报告。

```bash
git add gateway/src/roles/types.ts gateway/src/config.ts gateway/roles/elder-companion/zh/director.json \
  gateway/src/session/session.ts gateway/src/session/configSnapshot.ts \
  gateway/test/proactive-session.test.ts gateway/test/intent-copy.test.ts
git commit -m "feat(proactive): familiarity tone in the session instructions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
