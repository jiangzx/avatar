import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App.tsx';
import { useApi } from '../src/auth/AuthContext.tsx';
import { ME, fakeFetch, renderWithProviders } from './helpers.tsx';

const anonymous = { 'GET /admin/api/me': () => ({ status: 401, body: { error: 'unauthorized', message: '登录已过期，请重新登录。' } }) };

describe('login', () => {
  it('shows the login form when there is no session', async () => {
    const { fetch } = fakeFetch(anonymous);
    renderWithProviders(<App />, fetch);
    expect(await screen.findByLabelText('密码')).toBeTruthy();
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
  });

  it('shows the server message when the password is wrong and clears the field', async () => {
    const { fetch } = fakeFetch({
      ...anonymous,
      'POST /admin/api/login': () => ({ status: 401, body: { error: 'login_failed', message: '密码不对，请重新输入。' } }),
    });
    renderWithProviders(<App />, fetch);
    const input = (await screen.findByLabelText('密码')) as HTMLInputElement;
    await userEvent.type(input, 'wrong{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('密码不对，请重新输入。');
    expect(input.value).toBe('');
  });

  it('asks for a password before calling the server', async () => {
    const { fetch, calls } = fakeFetch(anonymous);
    renderWithProviders(<App />, fetch);
    await userEvent.click(await screen.findByRole('button', { name: '登录' }));
    expect((await screen.findByRole('alert')).textContent).toBe('请输入密码。');
    expect(calls.some((c) => c.url.pathname === '/admin/api/login')).toBe(false);
  });

  it('enters the console after a correct password, by keyboard only', async () => {
    let signedIn = false;
    const { fetch } = fakeFetch({
      'GET /admin/api/me': () => (signedIn ? { body: ME } : { status: 401, body: {} }),
      'POST /admin/api/login': () => {
        signedIn = true;
        return { body: ME };
      },
    });
    renderWithProviders(<App />, fetch);
    await screen.findByLabelText('密码');
    await userEvent.keyboard('right-password{Enter}');
    expect(await screen.findByText('看情况')).toBeTruthy();
    expect(screen.getByText('查问题')).toBeTruthy();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy();
  });

  it('returns to the login form when any call answers 401', async () => {
    function Probe() {
      const api = useApi();
      return <button onClick={() => void api.owners(null, false).catch(() => {})}>probe</button>;
    }
    const { fetch } = fakeFetch({ 'GET /admin/api/owners': () => ({ status: 401, body: {} }) });
    renderWithProviders(
      <>
        <App />
        <Probe />
      </>,
      fetch,
    );
    expect(await screen.findByText('看情况')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'probe' }));
    await waitFor(() => expect(screen.getByLabelText('密码')).toBeTruthy());
  });
});
