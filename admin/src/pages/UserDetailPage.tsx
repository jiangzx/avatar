import { useState } from 'react';
import { App, Button, Input, Modal, Spin, Table, Tag, type TableColumnsType } from 'antd';
import type { AdminOwnerDetail } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { InlineBar } from '../components/InlineBar.tsx';
import { LoadError } from '../components/LoadError.tsx';
import { formatCount, formatDateTime, formatDayLabel, formatMoney, formatYuan, shanghaiDay } from '../format.ts';
import { characterName } from '../labels.ts';
import { useViewOptions } from '../layout/ViewOptions.tsx';
import { href, navigate } from '../router.ts';
import { CHARACTER_COLORS } from '../theme.ts';
import { useEscapeClose } from '../useEscapeClose.ts';
import { errorMessage, useLoad } from '../useLoad.ts';

type CharacterRow = AdminOwnerDetail['characters'][number];
type DailyRow = AdminOwnerDetail['daily'][number];

export function UserDetailPage({ oid }: { oid: string }) {
  const api = useApi();
  const { includeMock } = useViewOptions();
  const [deleting, setDeleting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'ban' | 'unban' | null>(null);
  const { state, reload } = useLoad(() => api.owner(oid, includeMock), [api, oid, includeMock]);

  if (state.status === 'loading') return <Spin style={{ display: 'block', margin: '48px 0' }} />;
  if (state.status === 'error') return <LoadError message={state.message} onRetry={reload} />;
  const owner = state.data;

  function confirmBan() {
    setConfirmAction('ban');
  }

  function confirmUnban() {
    setConfirmAction('unban');
  }

  return (
    <div>
      <h1 className="page-title">
        用户 {oid} {owner.banned && <Tag color="error">已封禁</Tag>}
      </h1>
      <p className="caption">
        注册于 {formatDateTime(owner.createdAt)}，{owner.lastSeenAt === null ? '还没用过' : `最后活跃 ${formatDateTime(owner.lastSeenAt)}`}。
      </p>
      <div className="page-actions">
        {owner.banned ? <Button onClick={confirmUnban}>解封这位用户</Button> : <Button onClick={confirmBan}>封禁这位用户</Button>}
        <Button danger onClick={() => setDeleting(true)}>
          删除全部数据
        </Button>
        <a href={href('/sessions', { oid })}>查看这位用户的通话</a>
      </div>
      <p className="prose">
        累计 {formatCount(owner.usage.tokens)} token，费用 {formatMoney(owner.usage)}，通话 {owner.sessions} 次，记忆 {owner.memoryItems} 条。
      </p>
      <CharacterTable rows={owner.characters} />
      <ProactiveDailyTable rows={owner.proactiveDaily} onReset={() => setResetting(true)} />
      <DailyTable rows={owner.daily} />
      <ResetProactiveDailyModal
        oid={oid}
        open={resetting}
        onClose={() => setResetting(false)}
        onDone={() => { setResetting(false); reload(); }}
      />
      <DeleteOwnerModal oid={oid} open={deleting} onClose={() => setDeleting(false)} />
      <ConfirmOwnerModal
        action={confirmAction}
        oid={oid}
        onClose={() => setConfirmAction(null)}
        onDone={() => { setConfirmAction(null); reload(); }}
      />
    </div>
  );
}

function ConfirmOwnerModal({ action, oid, onClose, onDone }: {
  action: 'ban' | 'unban' | null;
  oid: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useApi();
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  useEscapeClose(action !== null, onClose);
  const isBan = action === 'ban';

  async function ok(): Promise<void> {
    if (!action) return;
    setBusy(true);
    try {
      if (isBan) await api.banOwner(oid);
      else await api.unbanOwner(oid);
      message.success(isBan ? '已封禁' : '已解封');
      onDone();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={action !== null}
      title={isBan ? '封禁这位用户？' : '解封这位用户？'}
      okText={isBan ? '封禁' : '解封'}
      cancelText="取消"
      okButtonProps={{ danger: isBan, loading: busy }}
      onOk={() => void ok()}
      onCancel={onClose}
      keyboard
    >
      <p>{isBan
        ? '封禁后，这位用户正在进行的通话会立即结束，之后不能开始新通话。数据不会删除，解封后一切恢复。'
        : '解封后，这位用户可以重新开始通话。'}</p>
    </Modal>
  );
}

function CharacterTable({ rows }: { rows: CharacterRow[] }) {
  const maxCost = Math.max(0, ...rows.map((r) => r.usage.costMicroYuan));
  const columns: TableColumnsType<CharacterRow> = [
    {
      title: '角色',
      dataIndex: 'character',
      render: (id: string) => (
        <span>
          <span className="swatch" style={{ background: CHARACTER_COLORS[id] ?? '#4D5D63' }} aria-hidden="true" />
          {characterName(id)}
        </span>
      ),
    },
    { title: '通话次数', dataIndex: 'sessions', align: 'right' },
    { title: '记忆条数', dataIndex: 'memoryItems', align: 'right' },
    { title: 'token', key: 'tokens', align: 'right', render: (_: unknown, r: CharacterRow) => formatCount(r.usage.tokens) },
    {
      title: '费用',
      key: 'cost',
      align: 'right',
      render: (_: unknown, r: CharacterRow) => (
        <span className="num-cell">
          {formatMoney(r.usage)}
          <InlineBar value={r.usage.costMicroYuan} max={maxCost} {...(CHARACTER_COLORS[r.character] ? { color: CHARACTER_COLORS[r.character] } : {})} />
        </span>
      ),
    },
  ];
  return (
    <section className="section" aria-labelledby="characters-title">
      <h2 id="characters-title">各角色</h2>
      {rows.length === 0 ? (
        <p className="caption">这位用户还没和任何角色通过话。</p>
      ) : (
        <Table<CharacterRow> rowKey={(r) => r.character} size="middle" pagination={false} columns={columns} dataSource={rows} />
      )}
    </section>
  );
}

function ProactiveDailyTable({ rows, onReset }: { rows: AdminOwnerDetail['proactiveDaily']; onReset: () => void }) {
  const columns: TableColumnsType<AdminOwnerDetail['proactiveDaily'][number]> = [
    {
      title: '角色',
      dataIndex: 'character',
      render: (id: string) => (
        <span>
          <span className="swatch" style={{ background: CHARACTER_COLORS[id] ?? '#4D5D63' }} aria-hidden="true" />
          {characterName(id)}
        </span>
      ),
    },
    { title: '今日主动次数', dataIndex: 'count', align: 'right' },
  ];
  return (
    <section className="section" aria-labelledby="proactive-daily-title">
      <h2 id="proactive-daily-title">今日主动次数</h2>
      {rows.length === 0 ? (
        <p className="caption">这位用户还没和任何角色通过话。</p>
      ) : (
        <Table rowKey={(r) => r.character} size="middle" pagination={false} columns={columns} dataSource={rows} />
      )}
      <div className="page-actions">
        <Button onClick={onReset}>清零今日主动次数</Button>
      </div>
    </section>
  );
}

function ResetProactiveDailyModal({ oid, open, onClose, onDone }: {
  oid: string; open: boolean; onClose: () => void; onDone: () => void;
}) {
  const api = useApi();
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);

  useEscapeClose(open, onClose);

  async function reset() {
    setBusy(true);
    try {
      await api.resetProactiveDaily(oid);
      message.success('已清零');
      onDone();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="清零今天的主动次数？"
      okText="清零"
      cancelText="取消"
      okButtonProps={{ loading: busy }}
      onOk={() => void reset()}
      onCancel={onClose}
    >
      <p>会把这位用户今天所有角色的主动开口计数清零；记忆、通话和接受率统计都不受影响。对之后开始的新会话生效，正在进行的会话仍按旧计数。</p>
    </Modal>
  );
}

function DailyTable({ rows }: { rows: DailyRow[] }) {
  const sorted = [...rows].sort((a, b) => b.day.localeCompare(a.day));
  const today = shanghaiDay(Date.now());
  const maxCost = Math.max(0, ...sorted.map((r) => r.costMicroYuan));
  const columns: TableColumnsType<DailyRow> = [
    { title: '日期', dataIndex: 'day', render: (day: string) => formatDayLabel(day, today) },
    { title: 'token', dataIndex: 'tokens', align: 'right', render: (v: number) => formatCount(v) },
    {
      title: '费用',
      dataIndex: 'costMicroYuan',
      align: 'right',
      render: (v: number) => (
        <span className="num-cell">
          {formatYuan(v)}
          <InlineBar value={v} max={maxCost} />
        </span>
      ),
    },
  ];
  return (
    <section className="section" aria-labelledby="daily-title">
      <h2 id="daily-title">每天的用量</h2>
      {sorted.length === 0 ? (
        <p className="caption">这段时间还没有用量。</p>
      ) : (
        <Table<DailyRow> rowKey={(r) => r.day} size="middle" pagination={false} columns={columns} dataSource={sorted} />
      )}
    </section>
  );
}

function DeleteOwnerModal({ oid, open, onClose }: { oid: string; open: boolean; onClose: () => void }) {
  const api = useApi();
  const { message } = App.useApp();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  function close() {
    setTyped('');
    onClose();
  }

  useEscapeClose(open, close);

  async function remove() {
    setBusy(true);
    try {
      await api.deleteOwner(oid);
      message.success('已删除');
      close();
      navigate('/users');
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="删除这位用户的全部数据？"
      okText="删除"
      cancelText="取消"
      okButtonProps={{ danger: true, disabled: typed !== oid, loading: busy }}
      onOk={() => void remove()}
      onCancel={close}
    >
      <p>会删除这位用户的记忆、通话记录、用量和日志，不能恢复。后台操作记录会保留。</p>
      <label htmlFor="confirm-oid">请输入用户编号 {oid} 确认</label>
      <Input id="confirm-oid" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
    </Modal>
  );
}
