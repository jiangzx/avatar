import { Button, Table, type TableColumnsType, type TableProps } from 'antd';
import type { Paged } from '../usePaged.ts';
import { LoadError } from './LoadError.tsx';

export interface PagedTableProps<T extends object> {
  paged: Paged<T>;
  columns: TableColumnsType<T>;
  rowKey: (row: T) => string;
  empty: string;
  expandable?: TableProps<T>['expandable'];
}

export function PagedTable<T extends object>({ paged, columns, rowKey, empty, expandable }: PagedTableProps<T>) {
  if (paged.status === 'error' && paged.items.length === 0) return <LoadError message={paged.error ?? ''} onRetry={paged.reload} />;
  if (paged.status === 'ready' && paged.items.length === 0) return <p className="caption">{empty}</p>;
  return (
    <>
      <Table<T>
        rowKey={rowKey}
        columns={columns}
        dataSource={paged.items}
        loading={paged.status === 'loading'}
        pagination={false}
        size="middle"
        {...(expandable ? { expandable } : {})}
      />
      {paged.hasMore && (
        <Button style={{ marginTop: 16 }} onClick={() => void paged.more()}>
          加载更多
        </Button>
      )}
    </>
  );
}
