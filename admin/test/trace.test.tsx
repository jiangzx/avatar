import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminLogRow } from '@anyidea/protocol';
import { rangeStart } from '../src/format.ts';
import { TracePage } from '../src/pages/TracePage.tsx';
import { fakeFetch, renderWithProviders } from './helpers.tsx';

const SID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

function log(id: number, overrides: Partial<AdminLogRow> = {}): AdminLogRow {
  return {
    id,
    ts: Date.parse('2026-10-27T06:02:31Z') + id * 1000,
    level: 'error',
    event: 'adapter_error',
    seq: null,
    fields: { code: 'qwen_socket_error' },
    sid: SID,
    oid: '3f9a1c2b4d5e',
    char: 'xiaonuan',
    job: null,
    ...overrides,
  };
}

describe('TracePage search', () => {
  it('opens the timeline for a pasted diagnostic code', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/logs': { items: [], nextCursor: null } });
    renderWithProviders(<TracePage sid={undefined} query={new URLSearchParams()} />, fetch);
    await userEvent.type(screen.getByLabelText('诊断编号或通话编号'), `${SID}-3f9a1c2b4d5e{Enter}`);
    await waitFor(() => expect(window.location.hash).toBe(`#/trace/${SID}`));
  });

  it('filters logs by owner when only an owner id is pasted', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/logs': { items: [], nextCursor: null } });
    renderWithProviders(<TracePage sid={undefined} query={new URLSearchParams()} />, fetch);
    await userEvent.type(screen.getByLabelText('诊断编号或通话编号'), '3f9a1c2b4d5e');
    await userEvent.click(screen.getByRole('button', { name: '查找' }));
    await waitFor(() => expect(window.location.hash).toBe('#/trace?oid=3f9a1c2b4d5e'));
  });

  it('explains what to paste when the code is not recognised', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/logs': { items: [], nextCursor: null } });
    renderWithProviders(<TracePage sid={undefined} query={new URLSearchParams()} />, fetch);
    await userEvent.type(screen.getByLabelText('诊断编号或通话编号'), 'hello{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('没认出这个编号。请粘贴手机设置页「复制诊断编号」得到的内容，或者一段通话编号。');
  });
});

describe('TracePage logs', () => {
  it('passes the address filters to the API and shows plain level names', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /admin/api/logs': { items: [log(1)], nextCursor: null } });
    renderWithProviders(<TracePage sid={undefined} query={new URLSearchParams('level=error&oid=3f9a1c2b4d5e')} />, fetch);
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('错误')).toBeTruthy();
    const filterSelect = screen.getByLabelText('级别').closest('.ant-select') as HTMLElement;
    expect(within(filterSelect).getByText('错误')).toBeTruthy();
    const call = calls.find((c) => c.url.pathname === '/admin/api/logs')!;
    expect(call.url.searchParams.get('level')).toBe('error');
    expect(call.url.searchParams.get('oid')).toBe('3f9a1c2b4d5e');
    expect(screen.getByRole('link', { name: '查看经过' }).getAttribute('href')).toBe(`#/trace/${SID}`);
    expect(screen.getByText('10月27日 14:02:32')).toBeTruthy();
  });

  it('asks for every level when 全部级别 is the active filter', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /admin/api/logs': { items: [], nextCursor: null } });
    renderWithProviders(<TracePage sid={undefined} query={new URLSearchParams()} />, fetch);
    await screen.findByText('这个时间段没有日志，试试放宽时间范围。');
    const call = calls.find((c) => c.url.pathname === '/admin/api/logs')!;
    expect(call.url.searchParams.get('level')).toBe('debug');
  });

  it('widens the log window when the address asks for the past 7 days', async () => {
    const now = Date.parse('2026-10-27T06:30:00Z');
    const { fetch, calls } = fakeFetch({ 'GET /admin/api/logs': { items: [], nextCursor: null } });
    renderWithProviders(<TracePage sid={undefined} query={new URLSearchParams('range=7d')} now={() => now} />, fetch);
    await screen.findByText('这个时间段没有日志，试试放宽时间范围。');
    const call = calls.find((c) => c.url.pathname === '/admin/api/logs')!;
    expect(call.url.searchParams.get('from')).toBe(String(rangeStart('7d', now)));
  });

  it('loads more with the cursor and has an empty state', async () => {
    const first = fakeFetch({
      'GET /admin/api/logs': (url: URL) =>
        url.searchParams.get('cursor') === 'n2' ? { body: { items: [log(2, { event: 'model_rebuild', level: 'info' })], nextCursor: null } } : { body: { items: [log(1)], nextCursor: 'n2' } },
    });
    renderWithProviders(<TracePage sid={undefined} query={new URLSearchParams()} />, first.fetch);
    await userEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('一般')).toBeTruthy();
  });

  it('shows the empty state', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/logs': { items: [], nextCursor: null } });
    renderWithProviders(<TracePage sid={undefined} query={new URLSearchParams()} />, fetch);
    expect(await screen.findByText('这个时间段没有日志，试试放宽时间范围。')).toBeTruthy();
  });
});

describe('TracePage timeline', () => {
  it('loads the session timeline and links back to all logs', async () => {
    const { fetch } = fakeFetch({
      [`GET /admin/api/sessions/${SID}/timeline`]: {
        session: {
          sid: SID, oid: '3f9a1c2b4d5e', character: 'xiaokai', adapter: 'qwen',
          startedAt: Date.parse('2026-10-27T06:02:00Z'), endedAt: null, endReason: null,
          replies: 0, errors: 0, firstAudioP50Ms: null, usage: { tokens: 0, costMicroYuan: 0, unpricedCalls: 0 },
        },
        items: [],
      },
    });
    renderWithProviders(<TracePage sid={SID} query={new URLSearchParams()} />, fetch);
    expect(await screen.findByRole('heading', { name: '小凯和用户 3f9a1c2b4d5e 的通话' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '看全部日志' }).getAttribute('href')).toBe('#/trace');
  });
});
