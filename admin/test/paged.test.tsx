import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AdminPage } from '@anyidea/protocol';
import { usePaged } from '../src/usePaged.ts';

interface Row { id: number }

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('usePaged', () => {
  it('drops a 加载更多 response that started before the filters changed', async () => {
    const stale = deferred<AdminPage<Row>>();
    let firstPageCalls = 0;
    const fetchPage = (cursor: string | null): Promise<AdminPage<Row>> => {
      if (cursor === 'old-cursor') return stale.promise;
      firstPageCalls += 1;
      return Promise.resolve(firstPageCalls === 1 ? { items: [{ id: 1 }], nextCursor: 'old-cursor' } : { items: [{ id: 2 }], nextCursor: null });
    };
    const { result, rerender } = renderHook(({ filter }: { filter: string }) => usePaged(fetchPage, [filter]), {
      initialProps: { filter: 'a' },
    });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.more();
    });
    rerender({ filter: 'b' });
    await waitFor(() => expect(result.current.items).toEqual([{ id: 2 }]));

    stale.resolve({ items: [{ id: 99 }], nextCursor: null });
    await act(async () => {
      await pending;
    });
    expect(result.current.items).toEqual([{ id: 2 }]);
    expect(result.current.hasMore).toBe(false);
  });
});
