import { useCallback, useEffect, useState } from 'react';
import { AdminApiError } from './api/client.ts';

export type Load<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

export function errorMessage(error: unknown): string {
  return error instanceof AdminApiError ? error.message : '后台出错了，请稍后再试。';
}

/** Loads once per deps change; stale responses are dropped. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): { state: Load<T>; reload: () => void } {
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    load().then(
      (data) => {
        if (live) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (live) setState({ status: 'error', message: errorMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { state, reload };
}
