import { useState } from 'react';
import { Segmented, Select, type TableColumnsType } from 'antd';
import type { AdminAuditRow, AdminRange } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { PagedTable } from '../components/PagedTable.tsx';
import { formatDateTime, rangeStart } from '../format.ts';
import { AUDIT_ACTION_LABELS, actionLabel } from '../labels.ts';
import { usePaged } from '../usePaged.ts';

const RANGE_OPTIONS: Array<{ label: string; value: AdminRange }> = [
  { label: '今天', value: 'today' },
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
];

function display(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'from' in value && 'to' in value) {
    const change = value as { from: unknown; to: unknown };
    return `${String(change.from)} → ${String(change.to)}`;
  }
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

/** Audit detail holds keys and numeric/switch changes only; prompts appear as 已修改 (spec). */
export function formatAuditDetail(detail: Record<string, unknown>): string {
  const entries = Object.entries(detail);
  if (entries.length === 0) return '—';
  return entries.map(([key, value]) => `${key}：${display(value)}`).join('；');
}

const columns: TableColumnsType<AdminAuditRow> = [
  { title: '时间', dataIndex: 'ts', width: 170, ellipsis: true, render: (ts: number) => formatDateTime(ts) },
  { title: '操作', dataIndex: 'action', width: 110, ellipsis: true, render: (action: string) => actionLabel(action) },
  { title: '对象', dataIndex: 'target', width: 140, ellipsis: true, render: (target: string | null) => target ?? '—' },
  { title: '详情', dataIndex: 'detail', render: (detail: Record<string, unknown>) => formatAuditDetail(detail) },
];

export function AuditPage({ now = Date.now }: { now?: () => number }) {
  const api = useApi();
  const [range, setRange] = useState<AdminRange>('7d');
  const [action, setAction] = useState('');
  const from = rangeStart(range, now());
  const paged = usePaged((cursor) => api.audit({ ...(action ? { action } : {}), from, cursor }), [api, action, from]);
  return (
    <div>
      <h1 className="page-title">审计</h1>
      <div className="toolbar">
        <Segmented<AdminRange> options={RANGE_OPTIONS} value={range} onChange={setRange} aria-label="时间范围" />
        <Select
          value={action}
          onChange={setAction}
          style={{ width: 180 }}
          aria-label="操作"
          options={[{ label: '全部操作', value: '' }, ...Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label }))]}
        />
      </div>
      <PagedTable paged={paged} columns={columns} rowKey={(row) => String(row.id)} empty="这个时间段没有后台操作。" />
    </div>
  );
}
