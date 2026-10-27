import { useState, type FormEvent } from 'react';
import { Button, Input, Segmented, Select, Spin, type TableColumnsType } from 'antd';
import type { AdminLogRow } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import type { LogLevelName } from '../api/endpoints.ts';
import { LoadError } from '../components/LoadError.tsx';
import { LogLevelControl } from '../components/LogLevelControl.tsx';
import { PagedTable } from '../components/PagedTable.tsx';
import { Timeline, timelineLabel, type TimelineData } from '../components/Timeline.tsx';
import { parseDiagInput } from '../diag.ts';
import { formatDateTime, formatTimeOfDay, rangeStart } from '../format.ts';
import { levelLabel } from '../labels.ts';
import { href, navigate } from '../router.ts';
import { palette } from '../theme.ts';
import { useLoad } from '../useLoad.ts';
import { usePaged } from '../usePaged.ts';

const NOT_RECOGNISED = '没认出这个编号。请粘贴手机设置页「复制诊断编号」得到的内容，或者一段通话编号。';
const LEVELS: LogLevelName[] = ['error', 'warn', 'info', 'debug'];

type LogRange = 'today' | '7d';

const LOG_RANGE_OPTIONS: Array<{ label: string; value: LogRange }> = [
  { label: '今天', value: 'today' },
  { label: '近 7 天', value: '7d' },
];

function parseRange(query: URLSearchParams): LogRange {
  return query.get('range') === '7d' ? '7d' : 'today';
}

function levelColor(level: string): string | undefined {
  if (level === 'error') return palette.cinnabar;
  if (level === 'warn') return palette.amberText;
  return undefined;
}

const columns: TableColumnsType<AdminLogRow> = [
  { title: '时间', dataIndex: 'ts', render: (ts: number) => `${formatDateTime(ts).split(' ')[0]} ${formatTimeOfDay(ts, true)}` },
  { title: '级别', dataIndex: 'level', render: (level: string) => <span style={{ color: levelColor(level) }}>{levelLabel(level)}</span> },
  { title: '事件', key: 'event', render: (_: unknown, row: AdminLogRow) => timelineLabel(row) },
  { title: '用户', dataIndex: 'oid', render: (oid: string | null) => (oid ? <a href={href(`/users/${oid}`)}>{oid}</a> : '—') },
  { title: '通话', dataIndex: 'sid', render: (sid: string | null) => (sid ? <a href={href(`/trace/${sid}`)}>查看经过</a> : '—') },
];

function DiagSearch() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    const target = parseDiagInput(value);
    if (target.kind === 'invalid') {
      setError(NOT_RECOGNISED);
      return;
    }
    setError(null);
    if (target.kind === 'session') navigate(`/trace/${target.sid}`);
    else navigate('/trace', { oid: target.oid });
  }
  return (
    <form onSubmit={submit} noValidate style={{ marginBottom: 24 }}>
      <div className="toolbar">
        <label htmlFor="diag-input">诊断编号或通话编号</label>
        <Input id="diag-input" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 420 }} autoComplete="off" />
        <Button type="primary" htmlType="submit">
          查找
        </Button>
      </div>
      {error && (
        <p role="alert" className="login-error">
          {error}
        </p>
      )}
    </form>
  );
}

function LogFilters({ query }: { query: URLSearchParams }) {
  const [oid, setOid] = useState(query.get('oid') ?? '');
  const [event, setEvent] = useState(query.get('event') ?? '');
  const [level, setLevel] = useState(query.get('level') ?? '');
  const [range, setRange] = useState<LogRange>(() => parseRange(query));
  function submit(e: FormEvent) {
    e.preventDefault();
    navigate('/trace', {
      oid: oid.trim().toLowerCase() || undefined,
      event: event.trim() || undefined,
      level: level || undefined,
      range: range === '7d' ? '7d' : undefined,
    });
  }
  return (
    <form className="toolbar" onSubmit={submit} noValidate>
      <Segmented<LogRange> options={LOG_RANGE_OPTIONS} value={range} onChange={setRange} aria-label="日志时间范围" />
      <label htmlFor="filter-oid">用户编号</label>
      <Input id="filter-oid" value={oid} onChange={(e) => setOid(e.target.value)} style={{ width: 160 }} autoComplete="off" />
      <label htmlFor="filter-event">事件</label>
      <Input id="filter-event" value={event} onChange={(e) => setEvent(e.target.value)} style={{ width: 180 }} autoComplete="off" />
      <Select
        value={level}
        onChange={setLevel}
        style={{ width: 140 }}
        aria-label="级别"
        // The trigger is self-describing next to the plain level text in the table.
        labelRender={({ label, value }) => (value ? `级别：${String(label)}` : label)}
        options={[{ label: '全部级别', value: '' }, ...LEVELS.map((l) => ({ label: levelLabel(l), value: l }))]}
      />
      <Button htmlType="submit">筛选</Button>
    </form>
  );
}

function LogList({ query, now }: { query: URLSearchParams; now: () => number }) {
  const api = useApi();
  const oid = query.get('oid') ?? undefined;
  const event = query.get('event') ?? undefined;
  const levelParam = query.get('level');
  const level = LEVELS.find((l) => l === levelParam);
  const from = rangeStart(parseRange(query), now());
  const paged = usePaged(
    (cursor) => api.logs({ ...(oid ? { oid } : {}), ...(event ? { event } : {}), ...(level ? { level } : {}), from, cursor }),
    [api, oid, event, level, from],
  );
  return (
    <>
      <LogFilters key={query.toString()} query={query} />
      <PagedTable
        paged={paged}
        columns={columns}
        rowKey={(row) => String(row.id)}
        empty="这个时间段没有日志，试试放宽时间范围。"
        expandable={{
          expandedRowRender: (row) => (
            <ul className="prose" style={{ margin: 0 }}>
              {Object.entries(row.fields).map(([key, value]) => (
                <li key={key}>
                  {key}：{String(value)}
                </li>
              ))}
            </ul>
          ),
        }}
      />
    </>
  );
}

function SessionTimeline({ sid }: { sid: string }) {
  const api = useApi();
  const { state, reload } = useLoad(() => api.timeline(sid), [api, sid]);
  return (
    <>
      <p>
        <a href={href('/trace')}>看全部日志</a>
      </p>
      {state.status === 'loading' && <Spin style={{ display: 'block', margin: '48px 0' }} />}
      {state.status === 'error' && <LoadError message={state.message} onRetry={reload} />}
      {state.status === 'ready' && <Timeline timeline={state.data as TimelineData} />}
    </>
  );
}

export function TracePage({ sid, query, now = Date.now }: { sid: string | undefined; query: URLSearchParams; now?: () => number }) {
  return (
    <div>
      <h1 className="page-title">排查</h1>
      <DiagSearch />
      {sid ? <SessionTimeline sid={sid} /> : <LogList query={query} now={now} />}
      <LogLevelControl />
    </div>
  );
}
