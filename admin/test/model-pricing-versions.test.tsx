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
