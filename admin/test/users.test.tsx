import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminOwnerRow } from '@anyidea/protocol';
import { UsersPage } from '../src/pages/UsersPage.tsx';
import { fakeFetch, renderWithProviders } from './helpers.tsx';

function owner(oid: string, overrides: Partial<AdminOwnerRow> = {}): AdminOwnerRow {
  return {
    oid,
    createdAt: Date.parse('2026-10-20T02:00:00Z'),
    lastSeenAt: Date.parse('2026-10-27T06:02:00Z'),
    banned: false,
    sessions: 9,
    memoryItems: 14,
    usage: { tokens: 120_000, costMicroYuan: 1_250_000, unpricedCalls: 0 },
    ...overrides,
  };
}

describe('UsersPage', () => {
  it('explains the re-register limitation above the table', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/owners': { items: [owner('3f9a1c2b4d5e')], nextCursor: null } });
    renderWithProviders(<UsersPage />, fetch);
    expect(await screen.findByText('同一台手机重新注册后会显示成新用户。')).toBeTruthy();
  });

  it('links each user to the detail page and shows status and money', async () => {
    const { fetch } = fakeFetch({
      'GET /admin/api/owners': {
        items: [owner('3f9a1c2b4d5e', { banned: true }), owner('aa11bb22cc33', { lastSeenAt: null, usage: { tokens: 10, costMicroYuan: 0, unpricedCalls: 2 } })],
        nextCursor: null,
      },
    });
    renderWithProviders(<UsersPage />, fetch);
    const link = await screen.findByRole('link', { name: '3f9a1c2b4d5e' });
    expect(link.getAttribute('href')).toBe('#/users/3f9a1c2b4d5e');
    expect(screen.getByText('已封禁')).toBeTruthy();
    expect(screen.getByText('1.25 元')).toBeTruthy();
    expect(screen.getByText('未定价')).toBeTruthy();
    expect(screen.getByText('还没用过')).toBeTruthy();
    expect(screen.getByText('10月27日 14:02')).toBeTruthy();
  });

  it('loads the next page with the cursor', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /admin/api/owners': (url: URL) =>
        url.searchParams.get('cursor') === 'c2'
          ? { body: { items: [owner('bbbbbbbbbbbb')], nextCursor: null } }
          : { body: { items: [owner('aaaaaaaaaaaa')], nextCursor: 'c2' } },
    });
    renderWithProviders(<UsersPage />, fetch);
    await userEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    expect(await screen.findByRole('link', { name: 'bbbbbbbbbbbb' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'aaaaaaaaaaaa' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
    expect(calls.filter((c) => c.url.pathname === '/admin/api/owners').map((c) => c.url.searchParams.get('cursor'))).toEqual([null, 'c2']);
  });

  it('has an empty state', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/owners': { items: [], nextCursor: null } });
    renderWithProviders(<UsersPage />, fetch);
    expect(await screen.findByText('还没有用户注册。')).toBeTruthy();
  });
});
