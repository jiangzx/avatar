import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdminMe } from '@anyidea/protocol';
import { createApiClient } from '../api/client.ts';
import { adminApi, type AdminApi } from '../api/endpoints.ts';

export type AuthState = { status: 'loading' } | { status: 'anonymous' } | { status: 'signed-in'; me: AdminMe };

interface AuthValue {
  state: AuthState;
  api: AdminApi;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children, fetchImpl }: { children: ReactNode; fetchImpl?: typeof fetch }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  // The CSRF token lives only in memory; a reload asks /me again.
  const csrf = useRef<string | null>(null);

  const api = useMemo(
    () =>
      adminApi(
        createApiClient({
          ...(fetchImpl ? { fetchImpl } : {}),
          csrfToken: () => csrf.current,
          onUnauthorized: () => {
            csrf.current = null;
            setState({ status: 'anonymous' });
          },
        }),
      ),
    [fetchImpl],
  );

  useEffect(() => {
    let live = true;
    api
      .me()
      .then((me) => {
        if (!live) return;
        csrf.current = me.csrfToken;
        setState({ status: 'signed-in', me });
      })
      .catch(() => {
        if (live) setState({ status: 'anonymous' });
      });
    return () => {
      live = false;
    };
  }, [api]);

  const login = useCallback(
    async (password: string) => {
      const me = await api.login(password);
      csrf.current = me.csrfToken;
      setState({ status: 'signed-in', me });
    },
    [api],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      csrf.current = null;
      setState({ status: 'anonymous' });
    }
  }, [api]);

  const value = useMemo(() => ({ state, api, login, logout }), [state, api, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider missing');
  return value;
}

export function useApi(): AdminApi {
  return useAuth().api;
}
