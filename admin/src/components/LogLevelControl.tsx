import { useEffect, useState, type FormEvent } from 'react';
import { App, Button, Input, Segmented, Select } from 'antd';
import type { AdminLogLevelState } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import type { LogLevelName } from '../api/endpoints.ts';
import { formatTimeOfDay } from '../format.ts';
import { levelLabel } from '../labels.ts';
import { errorMessage } from '../useLoad.ts';

type Scope = 'owner' | 'global';

const SCOPE_OPTIONS: Array<{ label: string; value: Scope }> = [
  { label: '某位用户', value: 'owner' },
  { label: '全部用户', value: 'global' },
];

const LEVEL_OPTIONS: Array<{ label: string; value: LogLevelName }> = [
  { label: '详细', value: 'debug' },
  { label: '一般', value: 'info' },
  { label: '只看警告', value: 'warn' },
  { label: '只看错误', value: 'error' },
];

const OWNER_ID = /^[0-9a-f]{12}$/;

export function LogLevelControl() {
  const api = useApi();
  const { message } = App.useApp();
  const [scope, setScope] = useState<Scope>('owner');
  const [oid, setOid] = useState('');
  const [level, setLevel] = useState<LogLevelName>('debug');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<AdminLogLevelState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.logLevel().then(
      (current) => live && setState(current),
      (err: unknown) => live && setLoadError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [api]);

  async function apply(event: FormEvent) {
    event.preventDefault();
    const owner = oid.trim().toLowerCase();
    if (scope === 'owner' && !OWNER_ID.test(owner)) {
      setError('请填写 12 位用户编号。');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await api.setLogLevel(scope === 'owner' ? { scope, oid: owner, level } : { scope, level });
      setState(result);
      setLoadError(null);
      const mine = result.overrides.find((o) => o.scope === scope && (scope === 'global' || o.oid === owner));
      const minutes = mine ? Math.max(1, Math.round((mine.until - Date.now()) / 60_000)) : null;
      message.success(minutes === null ? '已应用' : `已应用，${minutes} 分钟后自动恢复`);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section" aria-labelledby="log-level-title">
      <h2 id="log-level-title">临时调高日志详细程度</h2>
      <p className="caption prose">排查某位用户的问题时，可以临时记录更多细节（仍然不含对话内容），到时间会自动恢复。</p>
      {state && <p className="prose">现在全部用户按「{levelLabel(state.global)}」记录。</p>}
      {loadError && <p className="caption prose">读不到当前设置：{loadError}</p>}
      <form className="toolbar" onSubmit={apply} noValidate>
        <Segmented<Scope> options={SCOPE_OPTIONS} value={scope} onChange={setScope} aria-label="范围" />
        {scope === 'owner' && (
          <>
            <label htmlFor="log-level-oid">用户编号</label>
            <Input id="log-level-oid" value={oid} onChange={(e) => setOid(e.target.value)} style={{ width: 180 }} autoComplete="off" />
          </>
        )}
        <Select value={level} options={LEVEL_OPTIONS} onChange={setLevel} style={{ width: 120 }} aria-label="详细程度" />
        <Button type="primary" htmlType="submit" loading={busy}>
          应用
        </Button>
      </form>
      {error && (
        <p role="alert" className="login-error">
          {error}
        </p>
      )}
      {state && state.overrides.length > 0 && (
        <ul className="prose">
          {state.overrides.map((o) => (
            <li key={`${o.scope}-${o.oid ?? 'all'}`}>
              {o.scope === 'global' ? '全部用户' : `用户 ${o.oid}`} {levelLabel(o.level)}，到 {formatTimeOfDay(o.until)} 恢复
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
