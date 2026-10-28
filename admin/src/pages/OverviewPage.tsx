import { useState } from 'react';
import { Segmented, Spin, Table, type TableColumnsType } from 'antd';
import type { AdminOverview, AdminRange } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { Brief } from '../components/Brief.tsx';
import { InlineBar } from '../components/InlineBar.tsx';
import { LoadError } from '../components/LoadError.tsx';
import { formatCount, formatDayLabel, formatPercent, formatSeconds, formatYuan, shanghaiDay } from '../format.ts';
import { kindLabel } from '../labels.ts';
import { useViewOptions } from '../layout/ViewOptions.tsx';
import { href } from '../router.ts';
import { palette } from '../theme.ts';
import { useLoad } from '../useLoad.ts';

const RANGE_OPTIONS: Array<{ label: string; value: AdminRange }> = [
  { label: '今天', value: 'today' },
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
];

export function OverviewPage({ now = Date.now }: { now?: () => number }) {
  const api = useApi();
  const { includeMock } = useViewOptions();
  const [range, setRange] = useState<AdminRange>('today');
  const { state, reload } = useLoad(() => api.overview(range, includeMock), [api, range, includeMock]);
  return (
    <div>
      <Segmented<AdminRange> options={RANGE_OPTIONS} value={range} onChange={setRange} aria-label="时间范围" />
      {state.status === 'loading' && <Spin style={{ display: 'block', margin: '48px 0' }} />}
      {state.status === 'error' && <LoadError message={state.message} onRetry={reload} />}
      {state.status === 'ready' && <OverviewBody data={state.data} today={shanghaiDay(now())} />}
    </div>
  );
}

function OverviewBody({ data, today }: { data: AdminOverview; today: string }) {
  return (
    <>
      <Brief range={data.range} brief={data.brief} />
      {data.alerts.length > 0 && <AlertList alerts={data.alerts} />}
      <LatencyLine latency={data.latency} />
      <DaysTable days={data.days} today={today} />
      <SpendList byKind={data.byKind} />
    </>
  );
}

type OverviewAlert = AdminOverview['alerts'][number];

function alertText(alert: OverviewAlert): string {
  if (alert.code === 'error_rate_1h') return `近 1 小时出错率 ${formatPercent(alert.value)}，超过 ${formatPercent(alert.threshold)} 的提醒线`;
  return `近 1 小时首音延迟 p95 ${formatSeconds(alert.value)}，超过 ${formatSeconds(alert.threshold)}的提醒线`;
}

function alertTarget(alert: OverviewAlert): string {
  return alert.code === 'error_rate_1h' ? href('/trace', { level: 'error' }) : href('/sessions');
}

function AlertList({ alerts }: { alerts: OverviewAlert[] }) {
  return (
    <section className="section" aria-labelledby="alerts-title">
      <h2 id="alerts-title">需要留意</h2>
      <ul className="alert-list">
        {alerts.map((alert) => (
          <li key={alert.code} data-tone="danger" style={{ color: palette.cinnabar }}>
            <span className="dot" aria-hidden="true" />
            <span>{alertText(alert)}</span>
            <a href={alertTarget(alert)}>查看</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LatencyLine({ latency }: { latency: AdminOverview['latency'] }) {
  const { firstAudioP50Ms: p50, firstAudioP95Ms: p95 } = latency;
  const text =
    p50 === null || p95 === null
      ? '首音延迟：还没有数据。'
      : `首音延迟：一半的回复在 ${formatSeconds(p50)}内开口，95% 在 ${formatSeconds(p95)}内。`;
  return <p className="prose">{text}</p>;
}

type DayRow = AdminOverview['days'][number];

function numberCell(text: string, value: number, max: number, tone: 'normal' | 'danger' = 'normal') {
  return (
    <span className="num-cell">
      {text}
      <InlineBar value={value} max={max} tone={tone} />
    </span>
  );
}

function DaysTable({ days, today }: { days: DayRow[]; today: string }) {
  const rows = [...days].sort((a, b) => b.day.localeCompare(a.day));
  const max = (pick: (d: DayRow) => number) => Math.max(0, ...rows.map(pick));
  const columns: TableColumnsType<DayRow> = [
    { title: '日期', dataIndex: 'day', render: (day: string) => formatDayLabel(day, today) },
    { title: '老人', dataIndex: 'owners', align: 'right', render: (v: number) => numberCell(formatCount(v), v, max((d) => d.owners)) },
    { title: '通话分钟', dataIndex: 'callMinutes', align: 'right', render: (v: number) => numberCell(formatCount(v), v, max((d) => d.callMinutes)) },
    { title: 'token', dataIndex: 'tokens', align: 'right', render: (v: number) => numberCell(formatCount(v), v, max((d) => d.tokens)) },
    { title: '费用', dataIndex: 'costMicroYuan', align: 'right', render: (v: number) => numberCell(formatYuan(v), v, max((d) => d.costMicroYuan)) },
    { title: '出错', dataIndex: 'errors', align: 'right', render: (v: number) => numberCell(String(v), v, max((d) => d.errors), v > 0 ? 'danger' : 'normal') },
  ];
  return (
    <section className="section" aria-labelledby="days-title">
      <h2 id="days-title">每天的情况</h2>
      {rows.length === 0 ? (
        <p className="caption">这段时间还没有通话。</p>
      ) : (
        <Table<DayRow> rowKey={(d) => d.day} size="middle" pagination={false} columns={columns} dataSource={rows} />
      )}
    </section>
  );
}

function SpendList({ byKind }: { byKind: AdminOverview['byKind'] }) {
  const rows = byKind.filter((r) => r.costMicroYuan > 0).sort((a, b) => b.share - a.share);
  return (
    <section id="spend" className="section" aria-labelledby="spend-title">
      <h2 id="spend-title">钱花在哪里</h2>
      {rows.length === 0 ? (
        <p className="caption">还没有产生费用。</p>
      ) : (
        <ul className="spend-list">
          {rows.map((row) => (
            <li key={row.kind}>
              <span>{kindLabel(row.kind)}</span>
              <span>{formatPercent(row.share)}</span>
              <InlineBar value={row.share} max={1} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
