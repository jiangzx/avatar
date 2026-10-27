import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface ViewOptions { includeMock: boolean; setIncludeMock(value: boolean): void }

const STORAGE_KEY = 'admin.includeMock';
const ViewOptionsContext = createContext<ViewOptions | null>(null);

/** Mock usage is hidden by default (spec Q36); the choice survives a reload. */
export function ViewOptionsProvider({ children }: { children: ReactNode }) {
  const [includeMock, setState] = useState(() => window.localStorage.getItem(STORAGE_KEY) === '1');
  const setIncludeMock = useCallback((value: boolean) => {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    setState(value);
  }, []);
  const value = useMemo(() => ({ includeMock, setIncludeMock }), [includeMock, setIncludeMock]);
  return <ViewOptionsContext.Provider value={value}>{children}</ViewOptionsContext.Provider>;
}

export function useViewOptions(): ViewOptions {
  const value = useContext(ViewOptionsContext);
  if (!value) throw new Error('ViewOptionsProvider missing');
  return value;
}
