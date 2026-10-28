import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { AdminOverview } from '@anyidea/protocol';
import { OverviewPage } from '../src/pages/OverviewPage.tsx';
import { palette } from '../src/theme.ts';
import { fakeFetch, renderWithProviders } from './helpers.tsx';

const NOW = Date.parse('2026-10-27T06:00:00Z'); // 14:00 in Shanghai

const overview: AdminOverview = {
  range: 'today',
  brief: { owners: 12, callMinutes: 86, costMicroYuan: 4_300_000, errors: 2, deltaMinutesVsPrev: 18 },
  days: [
    { day: '2026-10-26', owners: 10, callMinutes: 68, tokens: 330_000, costMicroYuan: 3_410_000, errors: 0 },
    { day: '2026-10-27', owners: 12, callMinutes: 86, tokens: 412_000, costMicroYuan: 4_300_000, errors: 2 },
  ],
  byKind: [
    { kind: 'memory_extract', costMicroYuan: 258_000, share: 0.06 },
    { kind: 'realtime_reply', costMicroYuan: 3_956_000, share: 0.92 },
    { kind: 'summarize', costMicroYuan: 86_000, share: 0.02 },
  ],
  latency: { firstAudioP50Ms: 1100, firstAudioP95Ms: 2800 },
  alerts: [{ code: 'first_audio_p95', value: 2800, threshold: 2000 }],
  adapter: 'qwen',
};

function setup(data: AdminOverview = overview) {
  const fake = fakeFetch({ 'GET /admin/api/overview': () => ({ body: data }) });
  renderWithProviders(<OverviewPage now={() => NOW} />, fake.fetch);
  return fake;
}

describe('OverviewPage', () => {
  it('opens with the brief sentence', async () => {
    setup();
    expect(await screen.findByText('比昨天多 18 分钟。')).toBeTruthy();
  });

  it('marks alerts in cinnabar with a plain explanation', async () => {
    setup();
    const item = await screen.findByText('近 1 小时首音延迟 p95 2.8 秒，超过 2 秒的提醒线');
    const row = item.closest('li')!;
    expect(row.getAttribute('data-tone')).toBe('danger');
    expect(row.style.color).toBe('rgb(180, 35, 24)'); // palette.cinnabar
    expect(palette.cinnabar).toBe('#B42318');
    expect(within(row).getByRole('link', { name: '查看' }).getAttribute('href')).toBe('#/sessions');
  });

  it('formats the error-rate alert as a percentage', async () => {
    setup({ ...overview, alerts: [{ code: 'error_rate_1h', value: 0.12, threshold: 0.05 }] });
    expect(await screen.findByText('近 1 小时出错率 12%，超过 5% 的提醒线')).toBeTruthy();
  });

  it('hides 需要留意 when nothing is wrong', async () => {
    setup({ ...overview, alerts: [] });
    await screen.findByText('比昨天多 18 分钟。');
    expect(screen.queryByText('需要留意')).toBeNull();
  });

  it('explains first-audio latency in words', async () => {
    setup();
    expect(await screen.findByText('首音延迟：一半的回复在 1.1 秒内开口，95% 在 2.8 秒内。')).toBeTruthy();
  });

  it('lists days newest first and labels today', async () => {
    setup();
    const today = await screen.findByText('10月27日（今天）');
    const rows = screen.getAllByRole('row');
    expect(rows.findIndex((r) => r.contains(today))).toBeLessThan(rows.findIndex((r) => r.textContent?.includes('10月26日')));
    expect(screen.getByText('41.2 万')).toBeTruthy();
  });

  it('shows where the money goes, largest share first', async () => {
    setup();
    const section = (await screen.findByText('钱花在哪里')).closest('section')!;
    const items = within(section).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['实时通话92%', '记忆整理6%', '对话摘要2%']);
  });

  it('shows no adapter notice, whatever the adapter', async () => {
    setup({ ...overview, adapter: 'seeduplex' });
    await screen.findByText('比昨天多 18 分钟。');
    expect(screen.queryByText('当前使用 Seeduplex，通话用量不统计。')).toBeNull();
  });

  it('asks for mock data only when the switch is on', async () => {
    window.localStorage.setItem('admin.includeMock', '1');
    const { calls } = setup();
    await screen.findByText('比昨天多 18 分钟。');
    const call = calls.find((c) => c.url.pathname === '/admin/api/overview')!;
    expect(call.url.searchParams.get('mock')).toBe('1');
    expect(call.url.searchParams.get('range')).toBe('today');
  });

  it('shows the server message and a retry button on failure', async () => {
    const { fetch } = fakeFetch({
      'GET /admin/api/overview': () => ({ status: 500, body: { error: 'internal', message: '统计数据暂时读不出来，请稍后再试。' } }),
    });
    renderWithProviders(<OverviewPage now={() => NOW} />, fetch);
    expect(await screen.findByText('统计数据暂时读不出来，请稍后再试。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
