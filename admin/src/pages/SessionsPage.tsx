import { useState } from 'react';
import { Segmented, Select, type TableColumnsType } from 'antd';
import type { AdminRange, AdminSessionRow } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { PagedTable } from '../components/PagedTable.tsx';
import { formatDateTime, formatDuration, formatMoney, formatSeconds, rangeStart } from '../format.ts';
import { characterName, endReasonLabel } from '../labels.ts';
import { useViewOptions } from '../layout/ViewOptions.tsx';
import { href } from '../router.ts';
import { palette } from '../theme.ts';
import { usePaged } from '../usePaged.ts';

const RANGE_OPTIONS: Array<{ label: string; value: AdminRange }> = [
  { label: '今天', value: 'today' },
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
];

const CHARACTER_OPTIONS = [
  { label: '全部角色', value: '' },
  { label: '小暖', value: 'xiaonuan' },
  { label: '小凯', value: 'xiaokai' },
  { label: '小欣', value: 'xiaoxin' },
];

const columns: TableColumnsType<AdminSessionRow> = [
  { title: '开始时间', dataIndex: 'startedAt', render: (ts: number) => formatDateTime(ts) },
  { title: '角色', dataIndex: 'character', render: (id: string) => characterName(id) },
  { title: '用户', dataIndex: 'oid', render: (oid: string) => <a href={href(`/users/${oid}`)}>{oid}</a> },
  { title: '时长', key: 'duration', render: (_: unknown, r: AdminSessionRow) => (r.endedAt === null ? '进行中' : formatDuration(r.endedAt - r.startedAt)) },
  { title: '回复', dataIndex: 'replies', align: 'right' },
  {
    title: '出错',
    dataIndex: 'errors',
    align: 'right',
    render: (v: number) => <span style={v > 0 ? { color: palette.cinnabar } : undefined}>{v}</span>,
  },
  { title: '首音（中位数）', dataIndex: 'firstAudioP50Ms', align: 'right', render: (v: number | null) => formatSeconds(v) },
  { title: '费用', key: 'usage', align: 'right', render: (_: unknown, r: AdminSessionRow) => formatMoney(r.usage) },
  { title: '结束方式', key: 'end', render: (_: unknown, r: AdminSessionRow) => endReasonLabel(r) },
  { title: '', key: 'trace', render: (_: unknown, r: AdminSessionRow) => <a href={href(`/trace/${r.sid}`)}>查看经过</a> },
];

export function SessionsPage({ oid, now = Date.now }: { oid: string | undefined; now?: () => number }) {
  const api = useApi();
  const { includeMock } = useViewOptions();
  const [range, setRange] = useState<AdminRange>('today');
  const [character, setCharacter] = useState('');
  const from = rangeStart(range, now());
  const paged = usePaged(
    (cursor) => api.sessions({ ...(oid ? { oid } : {}), ...(character ? { character } : {}), from, cursor, includeMock }),
    [api, oid, character, from, includeMock],
  );
  return (
    <div>
      <h1 className="page-title">通话</h1>
      <div className="toolbar">
        <Segmented<AdminRange> options={RANGE_OPTIONS} value={range} onChange={setRange} aria-label="时间范围" />
        <Select value={character} options={CHARACTER_OPTIONS} onChange={setCharacter} style={{ width: 140 }} aria-label="角色" />
        {oid && (
          <span className="caption">
            只看用户 {oid}，<a href={href('/sessions')}>看全部</a>
          </span>
        )}
      </div>
      <PagedTable paged={paged} columns={columns} rowKey={(r) => r.sid} empty="这段时间没有通话。" />
    </div>
  );
}
