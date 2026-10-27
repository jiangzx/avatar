import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminPage } from '@anyidea/protocol';
import { errorMessage } from './useLoad.ts';

export interface Paged<T> {
  items: T[];
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  hasMore: boolean;
  moreLoading: boolean;
  more(): Promise<void>;
  reload(): void;
}

/** Cursor pagination for AdminPage<T> lists; deps change restarts from the first page. */
export function usePaged<T>(fetchPage: (cursor: string | null) => Promise<AdminPage<T>>, deps: readonly unknown[]): Paged<T> {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Paged<T>['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  // Bumped on every restart so a 加载更多 request from an older filter cannot land in the new list.
  const generationRef = useRef(0);

  useEffect(() => {
    let live = true;
    generationRef.current += 1;
    const generation = generationRef.current;
    setStatus('loading');
    setItems([]);
    setError(null);
    setMoreLoading(false);
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
      generationRef.current += 1;
    };
  }, [...deps, tick]);

  const more = useCallback(async () => {
    if (!cursor || moreLoading) return;
    const generation = generationRef.current;
    setMoreLoading(true);
    setError(null);
    setStatus('ready');
    try {
      const page = await fetchRef.current(cursor);
      if (generation !== generationRef.current) return;
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(errorMessage(err));
      setStatus('error');
    } finally {
      if (generation === generationRef.current) setMoreLoading(false);
    }
  }, [cursor, moreLoading]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { items, status, error, hasMore: cursor !== null, moreLoading, more, reload };
}
