import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogLevelControl } from '../src/components/LogLevelControl.tsx';
import { ME, fakeFetch, renderWithProviders } from './helpers.tsx';

describe('LogLevelControl', () => {
  const idle = { 'GET /admin/api/log-level': { global: 'info', overrides: [] } };

  it('shows the current level and the overrides that are still active', async () => {
    const until = Date.now() + 12 * 60_000;
    const { fetch } = fakeFetch({ 'GET /admin/api/log-level': { global: 'info', overrides: [{ scope: 'owner', oid: '3f9a1c2b4d5e', level: 'debug', until }] } });
    renderWithProviders(<LogLevelControl />, fetch);
    expect(await screen.findByText('现在全部用户按「一般」记录。')).toBeTruthy();
    expect(screen.getByText(/^用户 3f9a1c2b4d5e 详细，到 \d{2}:\d{2} 恢复$/)).toBeTruthy();
  });

  it('needs a 12-character user id for a single user', async () => {
    const { fetch, calls } = fakeFetch(idle);
    renderWithProviders(<LogLevelControl />, fetch);
    await screen.findByText('现在全部用户按「一般」记录。');
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    expect((await screen.findByRole('alert')).textContent).toBe('请填写 12 位用户编号。');
    expect(calls.some((c) => c.method === 'POST' && c.url.pathname === '/admin/api/log-level')).toBe(false);
  });

  it('sends the override with the CSRF header and says when it ends', async () => {
    const until = Date.now() + 30 * 60_000;
    const { fetch, calls } = fakeFetch({
      ...idle,
      'POST /admin/api/log-level': () => ({ body: { global: 'info', overrides: [{ scope: 'owner', oid: '3f9a1c2b4d5e', level: 'debug', until }] } }),
    });
    renderWithProviders(<LogLevelControl />, fetch);
    await userEvent.type(screen.getByLabelText('用户编号'), '3F9A1C2B4D5E');
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    await waitFor(() => expect(document.querySelector('.ant-message')?.textContent).toContain('已应用，30 分钟后自动恢复'));
    const call = calls.find((c) => c.method === 'POST' && c.url.pathname === '/admin/api/log-level')!;
    expect(JSON.parse(String(call.init.body))).toEqual({ scope: 'owner', oid: '3f9a1c2b4d5e', level: 'debug' });
    expect(new Headers(call.init.headers).get('x-csrf-token')).toBe(ME.csrfToken);
    expect(screen.getByText(/^用户 3f9a1c2b4d5e 详细，到 \d{2}:\d{2} 恢复$/)).toBeTruthy();
  });

  it('can raise the level for everyone without a user id', async () => {
    const until = Date.now() + 30 * 60_000;
    const { fetch, calls } = fakeFetch({
      ...idle,
      'POST /admin/api/log-level': () => ({ body: { global: 'debug', overrides: [{ scope: 'global', oid: null, level: 'debug', until }] } }),
    });
    renderWithProviders(<LogLevelControl />, fetch);
    await userEvent.click(screen.getByText('全部用户'));
    expect(screen.queryByLabelText('用户编号')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    await screen.findByText(/^全部用户 详细，到 \d{2}:\d{2} 恢复$/);
    expect(screen.getByText('现在全部用户按「详细」记录。')).toBeTruthy();
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ scope: 'global', level: 'debug' });
  });
});
