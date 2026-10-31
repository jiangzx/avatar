# Task 7: 管理端测试夹具与两行声音

**Files:**
- Modify: `admin/test/fixtures/config.ts`
- Modify: `admin/test/config-scene.test.tsx`

**Interfaces:**
- Consumes: T6 的 `AdminConfigItem.model` 和服务端带模型 label 的 item。
- Produces: admin 工作区 typecheck/test/build 通过；页面能显示两行模型声音。

背景：管理端页面本身不需要新逻辑；服务端已经把模型 label 放进 item label，页面按现有 `SettingRow` 渲染。这个任务只补协议字段的测试夹具和一条回归测试。

- [x] **Step 1: 写失败测试**

`admin/test/fixtures/config.ts` 的 `item()` 默认对象加：

```ts
model: null,
```

`admin/test/config-scene.test.tsx` 的 fixtures 导入里补 `item`（当前只导入了 `scene` 等），然后追加（使用已有的 `scene`/`fakeFetch`/`renderWithProviders`）：

```ts
it('renders one voice row per model with that model options', async () => {
  const voice38 = item({
    key: 'voice:qwen3.8-omni-flash-realtime/xiaonuan.zh',
    label: '声音（Qwen3.8 Omni Flash 实时版）',
    control: 'select',
    language: 'zh',
    character: 'xiaonuan',
    model: 'qwen3.8-omni-flash-realtime',
    impact: { characters: '小暖', stage: '声音', effective: 'next_session' },
    options: [{ value: 'longanlingxin', label: '龙安灵心（温柔女声）', priceNote: null }],
    baseline: 'longanlingxin',
    current: 'longanlingxin',
  });
  const voice31 = item({
    key: 'voice:qwen-audio-3.1-realtime-flash/xiaonuan.zh',
    label: '声音（Qwen-Audio 3.1 Flash 实时版）',
    control: 'select',
    language: 'zh',
    character: 'xiaonuan',
    model: 'qwen-audio-3.1-realtime-flash',
    impact: { characters: '小暖', stage: '声音', effective: 'next_session' },
    options: [{ value: 'longanlingxin_v3.1', label: '龙安灵心 v3.1（温柔女声，多语种）', priceNote: null }],
    baseline: 'longanlingxin_v3.1',
    current: 'longanlingxin_v3.1',
  });
  const { fetch } = fakeFetch({
    'GET /admin/api/config/scenes/characters': scene([voice38, voice31], { id: 'characters', title: '角色' }),
  });
  renderWithProviders(<ConfigScenePage scene="characters" />, fetch);
  const row38 = await screen.findByRole('region', { name: '声音（Qwen3.8 Omni Flash 实时版）（小暖）' });
  const row31 = await screen.findByRole('region', { name: '声音（Qwen-Audio 3.1 Flash 实时版）（小暖）' });
  expect(within(row38).getByText('龙安灵心（温柔女声）')).toBeTruthy();
  expect(within(row31).getByText('龙安灵心 v3.1（温柔女声，多语种）')).toBeTruthy();
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm test -w admin -- test/config-scene.test.tsx`
Expected: FAIL，`AdminConfigItem` 缺 `model` 或新增用例失败。

- [x] **Step 3: 跑 admin 检查**

Run: `npm test -w admin`
Expected: PASS。

Run: `npm run typecheck -w admin`
Expected: 无输出。

Run: `npm run build -w admin`
Expected: 构建成功。

- [x] **Step 4: 提交**

```bash
git add admin/test/fixtures/config.ts admin/test/config-scene.test.tsx
git commit -m "test(admin): cover per-model voice rows"
```
