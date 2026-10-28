# P3-T9: 模型与 Key 页、价格表页、版本历史页

**目标：**
- **模型与 Key**：在场景配置页（`model` 场景：地址、模型名下拉）下方加 Key 面板：默认只显示末 4 位，点「显示」看明文（灰字「查看会被记录」），可以更换；服务器没配加密主密钥时只读并说明原因。
- **价格表**：按模型分组列出历次价格和生效日期，当前生效的那条加青瓷左色条；列出还没有价格、但已经有调用的模型（费用显示「未定价」）；可以新增一条价格。
- **版本历史**：列出每次发布、回滚、恢复默认；查看某个版本改了什么；回滚到任意旧版本（确认后新建一个版本）；全部恢复默认（输入确认）。

**实现的 spec 章节：** 「界面设计 → 其他页面」（模型与 Key、价格表）；「配置覆盖层 → 回滚与恢复默认」；「密钥」；「价格」；决策 Q11、Q12/Q16、Q21、Q34。

**前置：** P3-T5（API 与类型）、P3-T7（`ConfigScenePage`、`PromptDiff`、接口表里的 `secrets`/`putSecret`/`revealSecret`/`pricing`/`addPrice`/`configVersions`/`configVersionDiff`/`configRollback`/`configReset`、测试夹具）、P3-T8（`routes.tsx` 的 `settings` 分支）完成。

**Files:**
- Create: `admin/src/config/priceFormat.ts`（单价换算）
- Create: `admin/src/config/SecretsPanel.tsx`
- Create: `admin/src/config/ModelKeyPage.tsx`
- Create: `admin/src/config/PricingPage.tsx`
- Create: `admin/src/config/VersionsPage.tsx`
- Modify: `admin/src/config/config.css`（追加三页样式）
- Modify: `admin/src/layout/AppLayout.tsx`（「调设置」分组加「价格表」「配置版本」）
- Modify: `admin/src/routes.tsx`（`/settings/model`、`/settings/versions`、`/pricing`）
- Test: `admin/test/model-pricing-versions.test.tsx`（新建）

**Interfaces:**
- Consumes：
  - P3-T5 类型（`@anyidea/protocol`）：`AdminSecretRow { name; label; source: 'admin' | 'env' | 'missing'; last4; updatedAt; writable }`、`AdminSecretReveal`、`AdminPriceRow { …; origin: 'baseline' | 'admin'; active }`、`AdminPricing { prices; unpricedModels: Array<{ model; calls }> }`、`AdminPriceCreate`、`AdminConfigVersion { id; createdAt; kind; actor; note; changedKeys: string[]; active }`、`AdminConfigVersionDiff { id; lines: AdminConfigImpactLine[] }`、`AdminPage<T>`。单价单位：微元/百万 token。
  - P3-T7：`useApi()` 上的 `secrets()`、`putSecret(name, value)`、`revealSecret(name)`、`pricing()`、`addPrice(body)`、`configVersions(before)`（每页 20 条，新的在前）、`configVersionDiff(id)`、`configRollback({ toVersion, baseVersion })`、`configReset({ keys: 'all', baseVersion })`；`ConfigScenePage`（`below` 插槽）、`PromptDiff`；`admin/test/fixtures/config.ts` 的 `version()`、`bodyOf()`。
  - P2-T7：`formatDateTime(ts)`（`admin/src/format.ts`，Asia/Shanghai，`'10月27日 14:02'`）。
  - P2-T6：`fakeFetch`、`renderWithProviders`（`admin/test/helpers.tsx`）；`NAV_GROUPS`（`admin/src/layout/AppLayout.tsx`）。
- Produces：
  ```ts
  // admin/src/config/priceFormat.ts
  export function formatPerMillion(micro: number | null): string; // 1_500_000 -> '1.5', null -> '—'
  export function yuanToMicro(yuan: number): number;            // per-million price in yuan -> micro-yuan
  export function shanghaiDayStart(day: string): number;        // 'YYYY-MM-DD' -> ms at 00:00 +08:00
  ```

## 设计与安全要点

- Key 明文只存在组件状态里：点「隐藏」或离开页面就丢弃；不写 `localStorage`，不 `console` 输出。输入框用 `Input.Password`、`autoComplete="off"`。
- 显示明文按钮旁边常驻灰字「查看会被记录」（网关对每次 reveal 记审计 `secret_revealed`）。
- 单价界面单位是「元/百万 token」，存储是微元/百万 token；新增价格时换算。没有价格的模型不显示 0 元，显示「未定价」。
- 回滚、恢复默认都是「新建一个版本」，文案写清楚「下一通电话开始生效」。恢复默认会清掉所有后台改动，需要输入「恢复默认」。
- 文案：「显示」/「隐藏」、「更换」→ 成功提示「已保存，下一通电话开始使用」；「新增价格」→「已添加价格」；「回滚到这个版本」→「已回滚」；「全部恢复默认」→「已恢复默认」。错误显示服务器给的中文说明。

## Steps

- [x] **Step 1: 写失败测试**

新建 `admin/test/model-pricing-versions.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminConfigVersion, AdminPricing, AdminSecretRow } from '@anyidea/protocol';
import { formatPerMillion, shanghaiDayStart, yuanToMicro } from '../src/config/priceFormat.ts';
import { PricingPage } from '../src/config/PricingPage.tsx';
import { SecretsPanel } from '../src/config/SecretsPanel.tsx';
import { VersionsPage } from '../src/config/VersionsPage.tsx';
import { fakeFetch, renderWithProviders } from './helpers.tsx';
import { bodyOf, version } from './fixtures/config.ts';

const AT_1402 = Date.parse('2026-10-27T14:02:00+08:00');
const KEY_PATH = '/admin/api/secrets/DASHSCOPE_API_KEY';

describe('priceFormat', () => {
  it('formats per-million prices and converts yuan to micro-yuan', () => {
    expect(formatPerMillion(1_500_000)).toBe('1.5');
    expect(formatPerMillion(12_000_000)).toBe('12');
    expect(formatPerMillion(null)).toBe('—');
    expect(yuanToMicro(1.5)).toBe(1_500_000);
    expect(yuanToMicro(0.15)).toBe(150_000);
    expect(shanghaiDayStart('2026-10-27')).toBe(Date.parse('2026-10-27T00:00:00+08:00'));
  });
});

const secret: AdminSecretRow = { name: 'DASHSCOPE_API_KEY', label: '通义千问（阿里云百炼）API Key', source: 'admin', last4: 'a1b2', updatedAt: AT_1402, writable: true };

describe('SecretsPanel', () => {
  it('masks the key, reveals it on demand and says that viewing is recorded', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /admin/api/secrets': [secret],
      [`POST ${KEY_PATH}/reveal`]: { name: secret.name, value: 'sk-test-0000a1b2' },
    });
    renderWithProviders(<SecretsPanel />, fetch);
    const row = await screen.findByRole('region', { name: secret.label });
    expect(within(row).getByText('••••a1b2')).toBeTruthy();
    expect(within(row).getByText('查看会被记录')).toBeTruthy();
    expect(within(row).getByText('在后台设置，10月27日 14:02 更新')).toBeTruthy();

    await userEvent.click(within(row).getByRole('button', { name: '显示' }));
    expect(await within(row).findByText('sk-test-0000a1b2')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url.pathname === `${KEY_PATH}/reveal`)).toBe(true);

    await userEvent.click(within(row).getByRole('button', { name: '隐藏' }));
    expect(within(row).queryByText('sk-test-0000a1b2')).toBeNull();
    expect(within(row).getByText('••••a1b2')).toBeTruthy();
  });

  it('replaces a key and tells when it takes effect', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /admin/api/secrets': [secret],
      [`PUT ${KEY_PATH}`]: { ...secret, last4: 'c3d4' },
    });
    renderWithProviders(<SecretsPanel />, fetch);
    const row = await screen.findByRole('region', { name: secret.label });
    await userEvent.click(within(row).getByRole('button', { name: '更换' }));
    await userEvent.type(await screen.findByLabelText('新的 Key'), 'sk-new-0000c3d4');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(bodyOf(calls, 'PUT', KEY_PATH)).toEqual({ value: 'sk-new-0000c3d4' }));
    expect(await screen.findByText('已保存，下一通电话开始使用')).toBeTruthy();
  });

  it('is read-only without the master key', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/secrets': [{ ...secret, source: 'env', updatedAt: null, writable: false }] });
    renderWithProviders(<SecretsPanel />, fetch);
    const row = await screen.findByRole('region', { name: secret.label });
    expect(within(row).getByText('来自服务器环境变量')).toBeTruthy();
    expect(within(row).getByText('服务器没有配置加密主密钥，这个 Key 只能在服务器环境变量里更换。')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: '更换' })).toBeNull();
  });
});

const pricing: AdminPricing = {
  prices: [
    { id: 'p1', model: 'qwen3.8-omni-flash-realtime', effectiveFrom: Date.parse('2026-01-01T00:00:00+08:00'), inputText: 1_500_000, inputAudio: 6_000_000, outputText: 4_500_000, outputAudio: 12_000_000, cached: null, source: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-10-27', origin: 'baseline', active: true },
    { id: 'p2', model: 'qwen-plus', effectiveFrom: Date.parse('2026-01-01T00:00:00+08:00'), inputText: 800_000, inputAudio: null, outputText: 2_000_000, outputAudio: null, cached: null, source: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-10-27', origin: 'baseline', active: true },
  ],
  unpricedModels: [{ model: 'qwen3-asr-flash-realtime', calls: 12 }],
};

describe('PricingPage', () => {
  it('groups prices by model, marks the active one and lists unpriced models', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/pricing': pricing });
    renderWithProviders(<PricingPage />, fetch);
    const group = await screen.findByRole('region', { name: 'qwen3.8-omni-flash-realtime' });
    const active = within(group).getByText('正在使用').closest('tr')!;
    expect(active.className).toContain('price-active');
    expect(within(active).getByText('12')).toBeTruthy();
    expect(within(active).getAllByText('—').length).toBe(1);
    expect(screen.getByText('qwen3-asr-flash-realtime')).toBeTruthy();
    expect(screen.getByText('未定价，12 次调用')).toBeTruthy();
  });

  it('adds a price in yuan and sends micro-yuan', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /admin/api/pricing': pricing,
      'POST /admin/api/pricing': { ...pricing.prices[1]!, id: 'p3', model: 'qwen3-asr-flash-realtime', origin: 'admin' },
    });
    renderWithProviders(<PricingPage />, fetch);
    await userEvent.click(await screen.findByRole('button', { name: '给它定价' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('模型') as HTMLInputElement).value).toBe('qwen3-asr-flash-realtime');
    await userEvent.type(within(dialog).getByLabelText('生效日期'), '2026-10-27');
    await userEvent.type(within(dialog).getByLabelText('输入文本'), '1');
    await userEvent.type(within(dialog).getByLabelText('输入音频'), '3.5');
    await userEvent.type(within(dialog).getByLabelText('输出文本'), '2');
    await userEvent.type(within(dialog).getByLabelText('来源网址'), 'https://help.aliyun.com/zh/model-studio/model-pricing');
    await userEvent.type(within(dialog).getByLabelText('查询日期'), '2026-10-27');
    await userEvent.click(within(dialog).getByRole('button', { name: '添加' }));
    await waitFor(() => expect(bodyOf(calls, 'POST', '/admin/api/pricing')).toEqual({
      model: 'qwen3-asr-flash-realtime',
      effectiveFrom: Date.parse('2026-10-27T00:00:00+08:00'),
      inputText: 1_000_000,
      inputAudio: 3_500_000,
      outputText: 2_000_000,
      outputAudio: null,
      cached: null,
      source: 'https://help.aliyun.com/zh/model-studio/model-pricing',
      checkedAt: '2026-10-27',
    }));
    expect(await screen.findByText('已添加价格')).toBeTruthy();
  });

  it('refuses a price without an https source', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /admin/api/pricing': pricing });
    renderWithProviders(<PricingPage />, fetch);
    await userEvent.click(await screen.findByRole('button', { name: '新增价格' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('模型'), 'qwen-flash');
    await userEvent.type(within(dialog).getByLabelText('生效日期'), '2026-10-27');
    await userEvent.type(within(dialog).getByLabelText('输入文本'), '0.15');
    await userEvent.type(within(dialog).getByLabelText('输出文本'), '1.5');
    await userEvent.type(within(dialog).getByLabelText('来源网址'), 'http://example.com');
    await userEvent.type(within(dialog).getByLabelText('查询日期'), '2026-10-27');
    await userEvent.click(within(dialog).getByRole('button', { name: '添加' }));
    expect(within(dialog).getByText('来源网址必须以 https:// 开头')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

const versions: AdminConfigVersion[] = [
  version(7, { createdAt: AT_1402 + 3_600_000, changedKeys: ['pacing:restReminder.firstAfterMs', 'memory:listMaxItems'], active: true }),
  version(5, { createdAt: AT_1402, active: false }),
];
const page = { items: versions, nextCursor: null };

describe('VersionsPage', () => {
  it('shows what a version changed', async () => {
    const { fetch } = fakeFetch({
      'GET /admin/api/config/versions': page,
      'GET /admin/api/config/versions/5/diff': {
        id: 5,
        lines: [{ key: 'pacing:restReminder.firstAfterMs', label: '连续聊多久提醒休息', scene: '对话节奏', before: '60 分钟', after: '90 分钟', characters: '所有角色', risk: 'low', textDiff: null }],
      },
    });
    renderWithProviders(<VersionsPage />, fetch);
    const row = (await screen.findByText('10月27日 14:02')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: '看改了什么' }));
    expect(await screen.findByText('60 分钟 → 90 分钟')).toBeTruthy();
    expect(screen.getByText('对话节奏：连续聊多久提醒休息')).toBeTruthy();
  });

  it('rolls back after confirmation, based on the active version', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /admin/api/config/versions': page, 'POST /admin/api/config/rollback': version(8, { kind: 'rollback' }) });
    renderWithProviders(<VersionsPage />, fetch);
    const row = (await screen.findByText('10月27日 14:02')).closest('tr')!;
    const activeRow = screen.getByText('10月27日 15:02').closest('tr')!;
    expect(within(activeRow).getByText('正在使用')).toBeTruthy();
    expect(within(activeRow).getByText('2')).toBeTruthy();
    expect(within(activeRow).queryByRole('button', { name: '回滚到这个版本' })).toBeNull();

    await userEvent.click(within(row).getByRole('button', { name: '回滚到这个版本' }));
    expect(await screen.findByText('回滚到 10月27日 14:02 的版本？会新建一个版本，下一通电话开始生效。')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '回滚' }));
    await waitFor(() => expect(bodyOf(calls, 'POST', '/admin/api/config/rollback')).toEqual({ toVersion: 5, baseVersion: 7 }));
    expect(await screen.findByText('已回滚')).toBeTruthy();
  });

  it('needs the typed words before restoring every default', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /admin/api/config/versions': page, 'POST /admin/api/config/reset': version(8, { kind: 'reset', changedKeys: [] }) });
    renderWithProviders(<VersionsPage />, fetch);
    await userEvent.click(await screen.findByRole('button', { name: '全部恢复默认' }));
    const confirm = await screen.findByRole('button', { name: '恢复默认' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('确认文字'), '恢复默认');
    expect(confirm.disabled).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() => expect(bodyOf(calls, 'POST', '/admin/api/config/reset')).toEqual({ keys: 'all', baseVersion: 7 }));
    expect(await screen.findByText('已恢复默认')).toBeTruthy();
  });
});
```

- [x] **Step 2: 运行，确认失败**

Run: `npm test -w admin -- test/model-pricing-versions.test.tsx`
Expected: FAIL，报 `Failed to resolve import "../src/config/priceFormat.ts"`。

- [x] **Step 3: 实现 priceFormat**

新建 `admin/src/config/priceFormat.ts`：

```ts
/** Prices are stored as micro-yuan per million tokens; the page shows yuan per million tokens. */
export function formatPerMillion(micro: number | null): string {
  if (micro === null) return '—';
  return String(Number((micro / 1_000_000).toFixed(4)));
}

export function yuanToMicro(yuan: number): number {
  return Math.round(yuan * 1_000_000);
}

export function shanghaiDayStart(day: string): number {
  return Date.parse(`${day}T00:00:00+08:00`);
}
```

- [x] **Step 4: 实现 SecretsPanel 和 ModelKeyPage**

新建 `admin/src/config/SecretsPanel.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Input, Modal, Spin } from 'antd';
import type { AdminSecretRow } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { formatDateTime } from '../format.ts';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sourceText(row: AdminSecretRow): string {
  if (row.source === 'admin') return row.updatedAt !== null ? `在后台设置，${formatDateTime(row.updatedAt)} 更新` : '在后台设置';
  if (row.source === 'env') return '来自服务器环境变量';
  return '还没有设置';
}

function SecretRow({ row, onSaved }: { row: AdminSecretRow; onSaved: () => void }) {
  const api = useApi();
  const { message } = App.useApp();
  const [plain, setPlain] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Drop the plaintext when the row goes away.
  useEffect(() => () => setPlain(null), []);

  const reveal = async (): Promise<void> => {
    try {
      setPlain((await api.revealSecret(row.name)).value);
      setError(null);
    } catch (e: unknown) {
      setError(errorText(e, '没能读取这个 Key，请稍后再试。'));
    }
  };

  const close = () => { setEditing(false); setDraft(''); };

  const save = async (): Promise<void> => {
    const value = draft.trim();
    if (!value) { setError('Key 不能为空。'); return; }
    try {
      await api.putSecret(row.name, value);
      close();
      setPlain(null);
      setError(null);
      void message.success('已保存，下一通电话开始使用');
      onSaved();
    } catch (e: unknown) {
      setError(errorText(e, '保存没有成功，请稍后再试。'));
    }
  };

  const masked = row.last4 ? `••••${row.last4}` : '没有设置';
  return (
    <section aria-label={row.label} className="secret-row">
      <div className="secret-head">
        <h3 className="setting-label">{row.label}</h3>
        <span className="secret-value">{plain ?? masked}</span>
        {row.source !== 'missing' && (
          plain === null
            ? <Button onClick={() => void reveal()}>显示</Button>
            : <Button onClick={() => setPlain(null)}>隐藏</Button>
        )}
        {row.writable && <Button onClick={() => { setEditing(true); setError(null); }}>更换</Button>}
      </div>
      <p className="setting-impact">{sourceText(row)}</p>
      {row.source !== 'missing' && <p className="setting-impact">查看会被记录</p>}
      {!row.writable && <p className="setting-compliance">服务器没有配置加密主密钥，这个 Key 只能在服务器环境变量里更换。</p>}
      {error && <Alert type="error" showIcon message={error} />}
      <Modal
        open={editing}
        title={`更换${row.label}`}
        onCancel={close}
        footer={[
          <Button key="cancel" onClick={close}>取消</Button>,
          <Button key="save" type="primary" onClick={() => void save()}>保存</Button>,
        ]}
      >
        <label className="secret-input">
          新的 Key
          <Input.Password aria-label="新的 Key" value={draft} autoComplete="off" onChange={(e) => setDraft(e.target.value)} />
        </label>
        <p className="setting-impact">保存后从下一通电话开始使用，正在进行的通话不受影响。</p>
      </Modal>
    </section>
  );
}

export function SecretsPanel() {
  const api = useApi();
  const [rows, setRows] = useState<AdminSecretRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (): Promise<void> => {
    try {
      setRows(await api.secrets());
      setError(null);
    } catch (e: unknown) {
      setError(errorText(e, '读取 Key 没有成功，请刷新页面。'));
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  if (error && !rows) return <Alert type="error" showIcon message={error} />;
  if (!rows) return <Spin />;
  return (
    <div className="secrets-panel">
      <h2 className="config-subtitle">Key</h2>
      {rows.map((row) => <SecretRow key={row.name} row={row} onSaved={() => void load()} />)}
    </div>
  );
}
```

注意：`getByLabelText('新的 Key')` 可能同时命中 `<label>` 文字和 `aria-label`；两者指向同一个 input，返回单个元素。若 Ant Design 的 `Input.Password` 把 `aria-label` 放在外层 span 导致命中两个元素，改用 `id` + `<label htmlFor>`，保持标签文字不变。

新建 `admin/src/config/ModelKeyPage.tsx`：

```tsx
import { ConfigScenePage } from './ConfigScenePage.tsx';
import { SecretsPanel } from './SecretsPanel.tsx';

export function ModelKeyPage() {
  return <ConfigScenePage scene="model" below={<SecretsPanel />} />;
}
```

- [x] **Step 5: 实现 PricingPage**

新建 `admin/src/config/PricingPage.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Input, InputNumber, Modal, Spin, Table } from 'antd';
import type { AdminPriceCreate, AdminPriceRow, AdminPricing } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { formatDateTime } from '../format.ts';
import { formatPerMillion, shanghaiDayStart, yuanToMicro } from './priceFormat.ts';
import './config.css';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
type PriceKey = 'inputText' | 'inputAudio' | 'outputText' | 'outputAudio' | 'cached';

interface FormState { model: string; effectiveDay: string; checkedAt: string; source: string; prices: Record<PriceKey, number | null> }

const EMPTY_PRICES: Record<PriceKey, number | null> = { inputText: null, inputAudio: null, outputText: null, outputAudio: null, cached: null };
const PRICE_FIELDS: Array<[PriceKey, string]> = [
  ['inputText', '输入文本'], ['inputAudio', '输入音频'], ['outputText', '输出文本'], ['outputAudio', '输出音频'], ['cached', '缓存'],
];

function formErrors(form: FormState): string[] {
  const errors: string[] = [];
  if (!form.model.trim()) errors.push('请填写模型名');
  if (!DAY.test(form.effectiveDay)) errors.push('生效日期请按 2026-10-27 这样填写');
  if (form.prices.inputText === null || form.prices.outputText === null) errors.push('输入文本和输出文本的单价必须填写');
  if (Object.values(form.prices).some((v) => v !== null && v < 0)) errors.push('单价不能是负数');
  if (!form.source.startsWith('https://')) errors.push('来源网址必须以 https:// 开头');
  if (!DAY.test(form.checkedAt)) errors.push('查询日期请按 2026-10-27 这样填写');
  return errors;
}

function toCreate(form: FormState): AdminPriceCreate {
  const micro = (v: number | null) => (v === null ? null : yuanToMicro(v));
  return {
    model: form.model.trim(),
    effectiveFrom: shanghaiDayStart(form.effectiveDay),
    inputText: yuanToMicro(form.prices.inputText ?? 0),
    inputAudio: micro(form.prices.inputAudio),
    outputText: yuanToMicro(form.prices.outputText ?? 0),
    outputAudio: micro(form.prices.outputAudio),
    cached: micro(form.prices.cached),
    source: form.source.trim(),
    checkedAt: form.checkedAt,
  };
}

function columns() {
  const price = (key: PriceKey, title: string) => ({
    title, dataIndex: key, key, align: 'right' as const,
    render: (v: number | null) => formatPerMillion(v),
  });
  return [
    {
      title: '生效时间', dataIndex: 'effectiveFrom', key: 'effectiveFrom',
      render: (v: number, row: AdminPriceRow) => (
        <span>{formatDateTime(v)}{row.active && <span className="price-badge">正在使用</span>}</span>
      ),
    },
    ...PRICE_FIELDS.map(([key, title]) => price(key, title)),
    {
      title: '来源', dataIndex: 'source', key: 'source',
      render: (v: string, row: AdminPriceRow) => (
        <span>
          <a href={v} target="_blank" rel="noreferrer noopener">官方价格页</a>
          <span className="price-checked">{row.checkedAt} 查询{row.origin === 'admin' ? '，后台添加' : ''}</span>
        </span>
      ),
    },
  ];
}

export function PricingPage() {
  const api = useApi();
  const { message } = App.useApp();
  const [data, setData] = useState<AdminPricing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await api.pricing());
      setLoadError(null);
    } catch (e: unknown) {
      setLoadError(e instanceof Error && e.message ? e.message : '读取价格表没有成功，请刷新页面。');
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const submit = async (): Promise<void> => {
    if (!form) return;
    const problems = formErrors(form);
    setErrors(problems);
    if (problems.length > 0) return;
    try {
      await api.addPrice(toCreate(form));
      setForm(null);
      void message.success('已添加价格');
      void load();
    } catch (e: unknown) {
      setErrors([e instanceof Error && e.message ? e.message : '添加没有成功，请稍后再试。']);
    }
  };

  const open = (model = '') => { setErrors([]); setForm({ model, effectiveDay: '', checkedAt: '', source: '', prices: { ...EMPTY_PRICES } }); };

  if (loadError) return <Alert type="error" showIcon message={loadError} />;
  if (!data) return <Spin />;

  const models = [...new Set(data.prices.map((p) => p.model))];
  return (
    <div className="pricing-page">
      <h1 className="config-title">价格表</h1>
      <p className="config-summary">单价单位是「元/百万 token」，按官方标价算，不扣免费额度。改价只影响之后的通话，以前的费用不重算。</p>
      <Button type="primary" onClick={() => open()}>新增价格</Button>

      {data.unpricedModels.length > 0 && (
        <section className="unpriced" aria-label="还没有价格的模型">
          <h2 className="config-subtitle">还没有价格的模型</h2>
          <p className="setting-impact">这些模型的费用在总览和用户页里显示为「未定价」。</p>
          {data.unpricedModels.map((m) => (
            <div key={m.model} className="unpriced-row">
              <span className="unpriced-model">{m.model}</span>
              <span className="unpriced-note">未定价，{m.calls} 次调用</span>
              <Button type="link" onClick={() => open(m.model)}>给它定价</Button>
            </div>
          ))}
        </section>
      )}

      {models.map((model) => (
        <section key={model} aria-label={model} className="price-group">
          <h2 className="config-subtitle">{model}</h2>
          <Table<AdminPriceRow>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={data.prices.filter((p) => p.model === model).sort((a, b) => b.effectiveFrom - a.effectiveFrom)}
            columns={columns()}
            rowClassName={(row) => (row.active ? 'price-active' : '')}
          />
        </section>
      ))}

      <Modal
        open={form !== null}
        title="新增价格"
        onCancel={() => setForm(null)}
        footer={[
          <Button key="cancel" onClick={() => setForm(null)}>取消</Button>,
          <Button key="add" type="primary" onClick={() => void submit()}>添加</Button>,
        ]}
      >
        {form && (
          <div className="price-form">
            <label>模型<Input aria-label="模型" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></label>
            <label>生效日期<Input aria-label="生效日期" placeholder="2026-10-27" value={form.effectiveDay} onChange={(e) => setForm({ ...form, effectiveDay: e.target.value.trim() })} /></label>
            {PRICE_FIELDS.map(([key, label]) => (
              <label key={key}>
                {label}
                <InputNumber<number>
                  aria-label={label}
                  min={0}
                  step={0.01}
                  addonAfter="元/百万 token"
                  value={form.prices[key]}
                  onChange={(v) => setForm({ ...form, prices: { ...form.prices, [key]: typeof v === 'number' ? v : null } })}
                />
              </label>
            ))}
            <label>来源网址<Input aria-label="来源网址" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} /></label>
            <label>查询日期<Input aria-label="查询日期" placeholder="2026-10-27" value={form.checkedAt} onChange={(e) => setForm({ ...form, checkedAt: e.target.value.trim() })} /></label>
            {errors.map((error) => <p key={error} role="alert" className="setting-error">{error}</p>)}
          </div>
        )}
      </Modal>
    </div>
  );
}
```

日期用文本框而不是 Ant Design 的 DatePicker：测试和小白都更直观（占位文字给出格式），也不需要额外的 dayjs 配置。

- [x] **Step 6: 实现 VersionsPage**

新建 `admin/src/config/VersionsPage.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Input, Modal, Spin, Table } from 'antd';
import type { AdminConfigVersion, AdminConfigVersionDiff } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { formatDateTime } from '../format.ts';
import { PromptDiff } from './PromptDiff.tsx';
import './config.css';

const KIND_LABEL: Record<AdminConfigVersion['kind'], string> = { publish: '发布', rollback: '回滚', reset: '恢复默认' };
const RESET_WORDS = '恢复默认';

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '操作没有成功，请稍后再试。';
}

export function VersionsPage() {
  const api = useApi();
  const { message } = App.useApp();
  const [rows, setRows] = useState<AdminConfigVersion[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ row: AdminConfigVersion; data: AdminConfigVersionDiff | null } | null>(null);
  const [target, setTarget] = useState<AdminConfigVersion | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetWords, setResetWords] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const page = await api.configVersions(null);
      setRows(page.items);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (e: unknown) {
      setError(errorText(e));
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const loadMore = async (): Promise<void> => {
    if (!nextCursor) return;
    try {
      const page = await api.configVersions(Number(nextCursor));
      setRows((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (e: unknown) {
      setError(errorText(e));
    }
  };

  const activeId = rows?.find((r) => r.active)?.id ?? 0;

  const showDiff = async (row: AdminConfigVersion): Promise<void> => {
    setDiff({ row, data: null });
    try {
      setDiff({ row, data: await api.configVersionDiff(row.id) });
    } catch (e: unknown) {
      setDiff(null);
      setError(errorText(e));
    }
  };

  const rollback = async (): Promise<void> => {
    if (!target) return;
    try {
      await api.configRollback({ toVersion: target.id, baseVersion: activeId });
      setTarget(null);
      void message.success('已回滚');
      void load();
    } catch (e: unknown) {
      setTarget(null);
      setError(errorText(e));
    }
  };

  const reset = async (): Promise<void> => {
    try {
      await api.configReset({ keys: 'all', baseVersion: activeId });
      setResetting(false);
      setResetWords('');
      void message.success('已恢复默认');
      void load();
    } catch (e: unknown) {
      setResetting(false);
      setError(errorText(e));
    }
  };

  if (!rows && !error) return <Spin />;
  return (
    <div className="versions-page">
      <h1 className="config-title">配置版本</h1>
      <p className="config-summary">每次发布、回滚、恢复默认都会留下一个版本。回滚也是新建一个版本，下一通电话开始生效。</p>
      {error && <Alert type="error" showIcon message={error} />}
      <Button danger onClick={() => { setResetWords(''); setResetting(true); }}>全部恢复默认</Button>
      <Table<AdminConfigVersion>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={rows ?? []}
        rowClassName={(row) => (row.active ? 'version-active' : '')}
        columns={[
          { title: '时间', dataIndex: 'createdAt', key: 'createdAt', render: (v: number) => formatDateTime(v) },
          { title: '操作', dataIndex: 'kind', key: 'kind', render: (v: AdminConfigVersion['kind']) => KIND_LABEL[v] },
          { title: '改动项数', dataIndex: 'changedKeys', key: 'changedKeys', align: 'right', render: (v: string[]) => v.length },
          { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v ?? '' },
          {
            title: '', key: 'actions',
            render: (_: unknown, row: AdminConfigVersion) => (
              <span className="version-actions">
                {row.active && <span className="price-badge">正在使用</span>}
                <Button type="link" onClick={() => void showDiff(row)}>看改了什么</Button>
                {!row.active && <Button type="link" onClick={() => setTarget(row)}>回滚到这个版本</Button>}
              </span>
            ),
          },
        ]}
      />
      {nextCursor && <Button type="link" onClick={() => void loadMore()}>更早的版本</Button>}

      <Modal open={diff !== null} title="这个版本改了什么" onCancel={() => setDiff(null)} footer={null} width={720}>
        {diff && !diff.data && <Spin />}
        {diff?.data && diff.data.lines.length === 0 && <p>这个版本没有改动。</p>}
        {diff?.data?.lines.map((line) => (
          <div key={line.key} className={`publish-row risk-${line.risk}`}>
            <span className="publish-label">{line.scene}：{line.label}</span>
            {line.textDiff
              ? <PromptDiff before={line.textDiff.before} after={line.textDiff.after} />
              : <span className="publish-change">{line.before} → {line.after}</span>}
          </div>
        ))}
      </Modal>

      <Modal
        open={target !== null}
        title="回滚配置"
        onCancel={() => setTarget(null)}
        footer={[
          <Button key="cancel" onClick={() => setTarget(null)}>取消</Button>,
          <Button key="ok" type="primary" onClick={() => void rollback()}>回滚</Button>,
        ]}
      >
        {target && <p>{`回滚到 ${formatDateTime(target.createdAt)} 的版本？会新建一个版本，下一通电话开始生效。`}</p>}
      </Modal>

      <Modal
        open={resetting}
        title="全部恢复默认"
        onCancel={() => setResetting(false)}
        footer={[
          <Button key="cancel" onClick={() => setResetting(false)}>取消</Button>,
          <Button key="ok" type="primary" danger disabled={resetWords !== RESET_WORDS} onClick={() => void reset()}>恢复默认</Button>,
        ]}
      >
        <p>后台做过的所有配置改动都会撤掉，回到仓库里的默认值。会新建一个版本，下一通电话开始生效。</p>
        <label className="publish-confirm">
          请输入「{RESET_WORDS}」
          <Input aria-label="确认文字" value={resetWords} autoComplete="off" onChange={(e) => setResetWords(e.target.value)} />
        </label>
      </Modal>
    </div>
  );
}
```

注意：「全部恢复默认」按钮和确认弹窗里的「恢复默认」按钮名字不同，测试用 `getByRole('button', { name: '恢复默认' })` 只命中弹窗里的那个；这一页没有其他名为「恢复默认」的按钮（说明行的「恢复默认」不在这一页）。

- [x] **Step 7: 追加样式**

在 `admin/src/config/config.css` 末尾追加：

```css
.config-subtitle { font-size: 17px; font-weight: 600; color: #24343b; margin: 32px 0 8px; }

.secret-row { padding: 16px 16px 16px 19px; margin-bottom: 12px; border-radius: 6px; border-left: 3px solid #b42318; background: #fff; }
.secret-head { display: flex; align-items: center; gap: 12px; }
.secret-head .setting-label { margin-right: auto; }
.secret-value { font-variant-numeric: tabular-nums; word-break: break-all; }
.secret-input { display: flex; flex-direction: column; gap: 8px; }

.unpriced { margin-top: 24px; }
.unpriced-row { display: flex; align-items: center; gap: 16px; padding: 6px 0; border-top: 1px solid #dce3e1; }
.unpriced-note { color: #8a5a12; }

.price-group .ant-table { font-variant-numeric: tabular-nums; }
tr.price-active > td:first-child { box-shadow: inset 3px 0 0 #2f6f68; }
.price-badge { margin-left: 8px; font-size: 12px; color: #2f6f68; font-weight: 600; }
.price-checked { margin-left: 8px; font-size: 12px; color: #4d5d63; }
.price-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
.price-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.price-form .setting-error { grid-column: 1 / -1; }

tr.version-active > td:first-child { box-shadow: inset 3px 0 0 #2f6f68; }
.version-actions { display: inline-flex; align-items: center; gap: 4px; }
```

- [x] **Step 8: 运行，确认通过**

Run: `npm test -w admin -- test/model-pricing-versions.test.tsx`
Expected: PASS（priceFormat 1、SecretsPanel 3、PricingPage 3、VersionsPage 3，共 10 个用例）。

- [x] **Step 9: 侧栏与路由**

修改 `admin/src/layout/AppLayout.tsx`：在 T7 加的「调设置」分组 `items` 末尾追加：

```tsx
      { path: '/pricing', label: '价格表' },
      { path: '/settings/versions', label: '配置版本' },
```

修改 `admin/src/routes.tsx`：import `ModelKeyPage`、`PricingPage`、`VersionsPage`（`./config/*.tsx`）。把 T8 的 `case 'settings':` 分支改为下面的样子，并在它后面加 `pricing` 分支：

```tsx
    case 'settings': {
      const scene = id ?? 'pacing';
      // key resets the draft when switching scenes.
      if (scene === 'pacing') return <ConfigScenePage key="pacing" scene="pacing" aside={(view) => <PacingRuler view={view} />} />;
      if (scene === 'model') return <ModelKeyPage key="model" />;
      if (scene === 'versions') return <VersionsPage />;
      return <ConfigScenePage key={scene} scene={scene} />;
    }
    case 'pricing':
      return <PricingPage />;
```

- [x] **Step 10: 全量验证**

Run: `npm test -w admin && npm run typecheck -w admin && npm run build -w admin`
Expected: 全部通过。

- [x] **Step 11: 提交**

```bash
git add admin/src/config/priceFormat.ts admin/src/config/SecretsPanel.tsx admin/src/config/ModelKeyPage.tsx \
  admin/src/config/PricingPage.tsx admin/src/config/VersionsPage.tsx admin/src/config/config.css \
  admin/src/layout/AppLayout.tsx admin/src/routes.tsx admin/test/model-pricing-versions.test.tsx
git commit -m "feat(admin): model and key page, price table and config versions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收

- Key 默认显示 `••••末4位`；「显示」后出现明文并可「隐藏」；常驻「查看会被记录」；没有主密钥时只读并说明原因。
- 价格表按模型分组，当前生效行有青瓷左色条和「正在使用」；未定价模型显示「未定价，N 次调用」并可一键定价；新增价格以元输入、以微元提交。
- 版本历史可看 diff；回滚有确认句并以当前版本为 `baseVersion`；全部恢复默认必须输入「恢复默认」。
