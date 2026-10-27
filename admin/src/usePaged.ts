import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminPage } from '@anyidea/protocol';
import { errorMessage } from './useLoad.ts';

export interface Paged<T> {
  items: T[];
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  hasMore: boolean;
  more(): Promise<void>;
  reload(): void;
}

/** Cursor pagination for AdminPage<T> lists; deps change restarts from the first page. */
export function usePaged<T>(fetchPage: (cursor: string | null) => Promise<AdminPage<T>>, deps: readonly unknown[]): Paged<T> {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Paged<T>['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  useEffect(() => {
    let live = true;
    setStatus('loading');
    setItems([]);
    setError(null);
    fetchRef.current(null).then(
      (page) => {
        if (!live) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setStatus('ready');
      },
      (err: unknown) => {
        if (!live) return;
        setError(errorMessage(err));
        setStatus('error');
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);

  const more = useCallback(async () => {
    if (!cursor) return;
    try {
      const page = await fetchRef.current(cursor);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
      setStatus('error');
    }
  }, [cursor]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { items, status, error, hasMore: cursor !== null, more, reload };
}
