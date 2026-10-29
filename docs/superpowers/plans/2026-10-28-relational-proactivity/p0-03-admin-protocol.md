# P0-T3：后台与 protocol 去掉 Seeduplex 提示

**Spec：** 「现状事实 › Seeduplex 的分布」、「实施分期」P0（保留历史标签）。

网关不再可能以 Seeduplex 运行，后台概览页「当前使用 Seeduplex，通话用量不统计。」的提示不会再出现，删掉。`admin/src/labels.ts` 的 `seeduplex: 'Seeduplex'` **保留**：真实库 `sessions.adapter` 里的历史通话仍可能是这个值，通话列表要能显示它。`AdminOverview.adapter` 字段保留（`string`），只改注释。

**Files:**
- Modify: `admin/src/pages/OverviewPage.tsx:40`
- Modify: `admin/test/overview.test.tsx:80-83`
- Modify: `admin/src/labels.ts:30-34`（只加注释）
- Modify: `protocol/src/adminApi.ts:11`（只改注释）

**Interfaces:**
- Consumes: P0-T2（网关 `adapter` 只会是 `mock` / `qwen`）。
- Produces: 无新接口。`AdminOverview.adapter: string` 形状不变。

- [ ] **Step 1：先改测试**

把 `admin/test/overview.test.tsx` 第 80–83 行的用例替换为：

```tsx
  it('shows no adapter notice, whatever the adapter', async () => {
    setup({ ...overview, adapter: 'seeduplex' });
    await screen.findByText('比昨天多 18 分钟。');
    expect(screen.queryByText('当前使用 Seeduplex，通话用量不统计。')).toBeNull();
  });
```

（`比昨天多 18 分钟。` 是同文件其他用例已经在等的简报句，用来确认页面已渲染完。）

- [ ] **Step 2：运行，确认失败**

Run: `npm test -w admin -- test/overview.test.tsx`
Expected: FAIL——提示仍然渲染。

- [ ] **Step 3：删掉提示**

`admin/src/pages/OverviewPage.tsx` 删除这一行：

```tsx
      {data.adapter === 'seeduplex' && <Alert type="info" showIcon message="当前使用 Seeduplex，通话用量不统计。" style={{ marginBottom: 24 }} />}
```

如果删除后该文件不再使用 `Alert`，从 antd 的 import 里去掉 `Alert`（`npm run typecheck -w admin` 会报未使用）。

`admin/src/labels.ts` 在 `ADAPTER_LABELS` 上方加注释：

```ts
// Seeduplex was removed in 2026-10; old call rows can still carry it.
```

`protocol/src/adminApi.ts` 第 11 行注释改为：

```ts
  adapter: string; // current gateway adapter: 'qwen' | 'mock'
```

- [ ] **Step 4：运行 admin 与 protocol 的检查**

Run: `npm test -w admin && npm run typecheck -w admin && npm run build -w admin && npm test -w protocol && npm run typecheck -w protocol`
Expected: 全部通过。`admin/test/labels.test.ts` 中 `adapterLabel('seeduplex')` 的断言保持通过（标签保留）。

- [ ] **Step 5：提交**

```bash
git add admin/src/pages/OverviewPage.tsx admin/test/overview.test.tsx admin/src/labels.ts protocol/src/adminApi.ts
git commit -m "refactor(admin): drop the Seeduplex usage notice, keep the history label

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
