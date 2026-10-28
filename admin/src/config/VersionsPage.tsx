import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Input, Modal, Spin, Table } from 'antd';
import type { AdminConfigVersion, AdminConfigVersionDiff } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { formatDateTime } from '../format.ts';
import { PromptDiff } from './PromptDiff.tsx';
import './config.css';

const KIND_LABEL: Record<AdminConfigVersion['kind'], string> = { publish: '发布', rollback: '回滚', reset: '恢复默认' };
const RESET_WORDS = '恢复默认';

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '操作没有成功，请稍后再试。';
}

export function VersionsPage() {
  const api = useApi();
  const { message } = App.useApp();
  const [rows, setRows] = useState<AdminConfigVersion[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ row: AdminConfigVersion; data: AdminConfigVersionDiff | null } | null>(null);
  const [target, setTarget] = useState<AdminConfigVersion | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetWords, setResetWords] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const page = await api.configVersions(null);
      setRows(page.items);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (e: unknown) {
      setError(errorText(e));
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const loadMore = async (): Promise<void> => {
    if (!nextCursor) return;
    try {
      const page = await api.configVersions(Number(nextCursor));
      setRows((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (e: unknown) {
      setError(errorText(e));
    }
  };

  const activeId = rows?.find((r) => r.active)?.id ?? 0;

  const showDiff = async (row: AdminConfigVersion): Promise<void> => {
    setDiff({ row, data: null });
    try {
      setDiff({ row, data: await api.configVersionDiff(row.id) });
    } catch (e: unknown) {
      setDiff(null);
      setError(errorText(e));
    }
  };

  const rollback = async (): Promise<void> => {
    if (!target) return;
    try {
      await api.configRollback({ toVersion: target.id, baseVersion: activeId });
      setTarget(null);
      void message.success('已回滚');
      void load();
    } catch (e: unknown) {
      setTarget(null);
      setError(errorText(e));
    }
  };

  const reset = async (): Promise<void> => {
    try {
      await api.configReset({ keys: 'all', baseVersion: activeId });
      setResetting(false);
      setResetWords('');
      void message.success('已恢复默认');
      void load();
    } catch (e: unknown) {
      setResetting(false);
      setError(errorText(e));
    }
  };

  if (!rows && !error) return <Spin />;
  return (
    <div className="versions-page">
      <h1 className="config-title">配置版本</h1>
      <p className="config-summary">每次发布、回滚、恢复默认都会留下一个版本。回滚也是新建一个版本，下一通电话开始生效。</p>
      {error && <Alert type="error" showIcon message={error} />}
      <Button danger onClick={() => { setResetWords(''); setResetting(true); }}>全部恢复默认</Button>
      <Table<AdminConfigVersion>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={rows ?? []}
        rowClassName={(row) => (row.active ? 'version-active' : '')}
        columns={[
          { title: '时间', dataIndex: 'createdAt', key: 'createdAt', render: (v: number) => formatDateTime(v) },
          { title: '操作', dataIndex: 'kind', key: 'kind', render: (v: AdminConfigVersion['kind']) => KIND_LABEL[v] },
          { title: '改动项数', dataIndex: 'changedKeys', key: 'changedKeys', align: 'right', render: (v: string[]) => v.length },
          { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v ?? '' },
          {
            title: '', key: 'actions',
            render: (_: unknown, row: AdminConfigVersion) => (
              <span className="version-actions">
                {row.active && <span className="price-badge">正在使用</span>}
                <Button type="link" onClick={() => void showDiff(row)}>看改了什么</Button>
                {!row.active && <Button type="link" onClick={() => setTarget(row)}>回滚到这个版本</Button>}
              </span>
            ),
          },
        ]}
      />
      {nextCursor && <Button type="link" onClick={() => void loadMore()}>更早的版本</Button>}

      <Modal open={diff !== null} title="这个版本改了什么" onCancel={() => setDiff(null)} footer={null} width={720}>
        {diff && !diff.data && <Spin />}
        {diff?.data && diff.data.lines.length === 0 && <p>这个版本没有改动。</p>}
        {diff?.data?.lines.map((line) => (
          <div key={line.key} className={`publish-row risk-${line.risk}`}>
            <span className="publish-label">{line.scene}：{line.label}</span>
            {line.textDiff
              ? <PromptDiff before={line.textDiff.before} after={line.textDiff.after} />
              : <span className="publish-change">{line.before} → {line.after}</span>}
          </div>
        ))}
      </Modal>

      <Modal
        open={target !== null}
        title="回滚配置"
        onCancel={() => setTarget(null)}
        footer={[
          <Button key="cancel" onClick={() => setTarget(null)}>取消</Button>,
          <Button key="ok" type="primary" onClick={() => void rollback()}>回滚</Button>,
        ]}
      >
        {target && <p>{`回滚到 ${formatDateTime(target.createdAt)} 的版本？会新建一个版本，下一通电话开始生效。`}</p>}
      </Modal>

      <Modal
        open={resetting}
        title="全部恢复默认"
        onCancel={() => setResetting(false)}
        footer={[
          <Button key="cancel" onClick={() => setResetting(false)}>取消</Button>,
          <Button key="ok" type="primary" danger disabled={resetWords !== RESET_WORDS} onClick={() => void reset()}>恢复默认</Button>,
        ]}
      >
        <p>后台做过的所有配置改动都会撤掉，回到仓库里的默认值。会新建一个版本，下一通电话开始生效。</p>
        <label className="publish-confirm">
          请输入「{RESET_WORDS}」
          <Input aria-label="确认文字" value={resetWords} autoComplete="off" onChange={(e) => setResetWords(e.target.value)} />
        </label>
      </Modal>
    </div>
  );
}
