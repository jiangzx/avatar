import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminOwnerDetail } from '@anyidea/protocol';
import { UserDetailPage } from '../src/pages/UserDetailPage.tsx';
import { ME, fakeFetch, renderWithProviders } from './helpers.tsx';

const OID = '3f9a1c2b4d5e';

function detail(banned = false): AdminOwnerDetail {
  return {
    oid: OID,
    createdAt: Date.parse('2026-10-20T02:00:00Z'),
    lastSeenAt: Date.parse('2026-10-27T06:02:00Z'),
    banned,
    sessions: 9,
    memoryItems: 14,
    usage: { tokens: 120_000, costMicroYuan: 1_250_000, unpricedCalls: 0 },
    characters: [
      { character: 'xiaonuan', sessions: 6, memoryItems: 10, usage: { tokens: 90_000, costMicroYuan: 1_000_000, unpricedCalls: 0 } },
      { character: 'xiaokai', sessions: 3, memoryItems: 4, usage: { tokens: 30_000, costMicroYuan: 250_000, unpricedCalls: 0 } },
    ],
    daily: [{ day: '2026-10-27', tokens: 40_000, costMicroYuan: 420_000 }],
    proactiveDaily: [
      { character: 'xiaonuan', count: 20 },
      { character: 'xiaokai', count: 2 },
    ],
  };
}

describe('UserDetailPage', () => {
  it('summarises usage per character without any conversation content', async () => {
    const { fetch } = fakeFetch({ [`GET /admin/api/owners/${OID}`]: detail() });
    renderWithProviders(<UserDetailPage oid={OID} />, fetch);
    expect(await screen.findByText('累计 12.0 万 token，费用 1.25 元，通话 9 次，记忆 14 条。')).toBeTruthy();
    expect(screen.getAllByText('小暖').length).toBeGreaterThan(0);
    expect(screen.getAllByText('小凯').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: '查看这位用户的通话' }).getAttribute('href')).toBe(`#/sessions?oid=${OID}`);
  });

  it('bans after confirmation, with the CSRF header, then says 已封禁', async () => {
    let banned = false;
    const { fetch, calls } = fakeFetch({
      [`GET /admin/api/owners/${OID}`]: () => ({ body: detail(banned) }),
      [`POST /admin/api/owners/${OID}/ban`]: () => {
        banned = true;
        return { status: 204 };
      },
    });
    renderWithProviders(<UserDetailPage oid={OID} />, fetch);
    await userEvent.click(await screen.findByRole('button', { name: '封禁这位用户' }));
    expect(await screen.findByText('封禁后，这位用户正在进行的通话会立即结束，之后不能开始新通话。数据不会删除，解封后一切恢复。')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '封禁' }));
    // The page title also gets an 已封禁 tag after reload, so check the toast itself.
    await waitFor(() => expect(document.querySelector('.ant-message')?.textContent).toContain('已封禁'));
    const ban = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/ban'))!;
    expect(new Headers(ban.init.headers).get('x-csrf-token')).toBe(ME.csrfToken);
    expect(await screen.findByRole('button', { name: '解封这位用户' })).toBeTruthy();
  });

  it('resets today\'s proactive count after confirmation', async () => {
    const { fetch, calls } = fakeFetch({
      [`GET /admin/api/owners/${OID}`]: detail(),
      [`POST /admin/api/owners/${OID}/proactive-daily/reset`]: () => ({ status: 204 }),
    });
    renderWithProviders(<UserDetailPage oid={OID} />, fetch);
    await userEvent.click(await screen.findByRole('button', { name: '清零今日主动次数' }));
    expect(await screen.findByText('会把这位用户今天所有角色的主动开口计数清零；记忆、通话和接受率统计都不受影响。')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '清零' }));
    await waitFor(() => expect(document.querySelector('.ant-message')?.textContent).toContain('已清零'));
    const reset = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/proactive-daily/reset'))!;
    expect(new Headers(reset.init.headers).get('x-csrf-token')).toBe(ME.csrfToken);
  });

  it('deletes only after the exact user id is typed, then returns to the list', async () => {
    const { fetch, calls } = fakeFetch({
      [`GET /admin/api/owners/${OID}`]: detail(),
      [`DELETE /admin/api/owners/${OID}`]: () => ({ status: 204 }),
    });
    renderWithProviders(<UserDetailPage oid={OID} />, fetch);
    await userEvent.click(await screen.findByRole('button', { name: '删除全部数据' }));
    const confirm = await screen.findByRole('button', { name: '删除' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(`请输入用户编号 ${OID} 确认`), '3f9a1c');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(`请输入用户编号 ${OID} 确认`), '2b4d5e');
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() => expect(window.location.hash).toBe('#/users'));
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(JSON.parse(String(del.init.body))).toEqual({ confirm: OID });
    expect(new Headers(del.init.headers).get('x-csrf-token')).toBe(ME.csrfToken);
    expect(await screen.findByText('已删除')).toBeTruthy();
  });
});
