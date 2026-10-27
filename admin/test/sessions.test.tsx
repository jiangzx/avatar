import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type { AdminSessionRow } from '@anyidea/protocol';
import { SessionsPage } from '../src/pages/SessionsPage.tsx';
import { fakeFetch, renderWithProviders } from './helpers.tsx';

const SID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const NOW = Date.parse('2026-10-27T06:30:00Z');

function row(overrides: Partial<AdminSessionRow> = {}): AdminSessionRow {
  return {
    sid: SID,
    oid: '3f9a1c2b4d5e',
    character: 'xiaonuan',
    adapter: 'qwen',
    startedAt: Date.parse('2026-10-27T06:02:00Z'),
    endedAt: Date.parse('2026-10-27T06:14:40Z'),
    endReason: 'client_end',
    replies: 21,
    errors: 1,
    firstAudioP50Ms: 1100,
    usage: { tokens: 41_000, costMicroYuan: 430_000, unpricedCalls: 0 },
    ...overrides,
  };
}

describe('SessionsPage', () => {
  it('lists calls with plain duration, end reason and a link to the trace', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/sessions': { items: [row(), row({ sid: 'open-1', endedAt: null, endReason: null })], nextCursor: null } });
    renderWithProviders(<SessionsPage oid={undefined} now={() => NOW} />, fetch);
    expect(await screen.findByText('12 分 40 秒')).toBeTruthy();
    expect(screen.getByText('用户挂断')).toBeTruthy();
    expect(screen.getAllByText('进行中').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('link', { name: '查看经过' })[0]!.getAttribute('href')).toBe(`#/trace/${SID}`);
    expect(screen.getAllByText('小暖').length).toBe(2);
  });

  it('shows how each call was connected', async () => {
    const { fetch } = fakeFetch({
      'GET /admin/api/sessions': { items: [row(), row({ sid: 'mock-1', adapter: 'mock' }), row({ sid: 'old-1', adapter: null })], nextCursor: null },
    });
    renderWithProviders(<SessionsPage oid={undefined} now={() => NOW} />, fetch);
    expect(await screen.findByRole('columnheader', { name: '接入方式' })).toBeTruthy();
    expect(screen.getByText('通义千问')).toBeTruthy();
    expect(screen.getByText('Mock（测试）')).toBeTruthy();
    expect(screen.getByText('未记录')).toBeTruthy();
  });

  it('filters by the user from the address and by today in Shanghai', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /admin/api/sessions': { items: [], nextCursor: null } });
    renderWithProviders(<SessionsPage oid="3f9a1c2b4d5e" now={() => NOW} />, fetch);
    expect(await screen.findByText('这段时间没有通话。')).toBeTruthy();
    const call = calls.find((c) => c.url.pathname === '/admin/api/sessions')!;
    expect(call.url.searchParams.get('oid')).toBe('3f9a1c2b4d5e');
    expect(call.url.searchParams.get('from')).toBe(String(Date.parse('2026-10-26T16:00:00Z')));
  });
});
