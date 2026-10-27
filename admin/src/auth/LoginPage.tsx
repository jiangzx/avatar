import { useState, type FormEvent } from 'react';
import { Button, Input } from 'antd';
import { AdminApiError } from '../api/client.ts';
import { useAuth } from './AuthContext.tsx';

export function LoginPage() {
  const { login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password) {
      setError('请输入密码。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(password);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : '登录失败，请稍后再试。');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit} aria-labelledby="login-title" noValidate>
        <h1 id="login-title">陪伴值班台</h1>
        <p className="caption">输入管理员密码后进入。</p>
        <label htmlFor="admin-password">密码</label>
        <Input.Password
          id="admin-password"
          autoFocus
          autoComplete="current-password"
          value={password}
          status={error ? 'error' : ''}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p role="alert" className="login-error">
            {error}
          </p>
        )}
        <Button type="primary" htmlType="submit" loading={busy} block>
          登录
        </Button>
      </form>
    </main>
  );
}
