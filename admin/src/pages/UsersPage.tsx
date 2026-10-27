import { Tag, type TableColumnsType } from 'antd';
import type { AdminOwnerRow } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { PagedTable } from '../components/PagedTable.tsx';
import { formatDateTime, formatMoney } from '../format.ts';
import { useViewOptions } from '../layout/ViewOptions.tsx';
import { href } from '../router.ts';
import { usePaged } from '../usePaged.ts';

const columns: TableColumnsType<AdminOwnerRow> = [
  { title: '用户编号', dataIndex: 'oid', render: (oid: string) => <a href={href(`/users/${oid}`)}>{oid}</a> },
  { title: '注册时间', dataIndex: 'createdAt', render: (ts: number) => formatDateTime(ts) },
  { title: '最后活跃', dataIndex: 'lastSeenAt', render: (ts: number | null) => (ts === null ? '还没用过' : formatDateTime(ts)) },
  { title: '通话次数', dataIndex: 'sessions', align: 'right' },
  { title: '记忆条数', dataIndex: 'memoryItems', align: 'right' },
  { title: '累计费用', key: 'usage', align: 'right', render: (_: unknown, row: AdminOwnerRow) => formatMoney(row.usage) },
  { title: '状态', dataIndex: 'banned', render: (banned: boolean) => (banned ? <Tag color="error">已封禁</Tag> : null) },
];

export function UsersPage() {
  const api = useApi();
  const { includeMock } = useViewOptions();
  const paged = usePaged((cursor) => api.owners(cursor, includeMock), [api, includeMock]);
  return (
    <div>
      <h1 className="page-title">用户</h1>
      <p className="caption">同一台手机重新注册后会显示成新用户。</p>
      <PagedTable paged={paged} columns={columns} rowKey={(row) => row.oid} empty="还没有用户注册。" />
    </div>
  );
}
