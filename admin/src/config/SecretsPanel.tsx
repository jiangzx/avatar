import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Input, Modal, Spin } from 'antd';
import type { AdminSecretRow } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { formatDateTime } from '../format.ts';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sourceText(row: AdminSecretRow): string {
  if (row.source === 'admin') return row.updatedAt !== null ? `在后台设置，${formatDateTime(row.updatedAt)} 更新` : '在后台设置';
  if (row.source === 'env') return '来自服务器环境变量';
  return '还没有设置';
}

function SecretRow({ row, onSaved }: { row: AdminSecretRow; onSaved: () => void }) {
  const api = useApi();
  const { message } = App.useApp();
  const [plain, setPlain] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Drop the plaintext when the row goes away.
  useEffect(() => () => setPlain(null), []);

  const reveal = async (): Promise<void> => {
    try {
      setPlain((await api.revealSecret(row.name)).value);
      setError(null);
    } catch (e: unknown) {
      setError(errorText(e, '没能读取这个 Key，请稍后再试。'));
    }
  };

  const close = () => { setEditing(false); setDraft(''); };

  const save = async (): Promise<void> => {
    const value = draft.trim();
    if (!value) { setError('Key 不能为空。'); return; }
    try {
      await api.putSecret(row.name, value);
      close();
      setPlain(null);
      setError(null);
      void message.success('已保存，下一通电话开始使用');
      onSaved();
    } catch (e: unknown) {
      setError(errorText(e, '保存没有成功，请稍后再试。'));
    }
  };

  const masked = row.last4 ? `••••${row.last4}` : '没有设置';
  return (
    <section aria-label={row.label} className="secret-row">
      <div className="secret-head">
        <h3 className="setting-label">{row.label}</h3>
        <span className="secret-value">{plain ?? masked}</span>
        {row.source !== 'missing' && (
          plain === null
            ? <Button onClick={() => void reveal()}>显示</Button>
            : <Button onClick={() => setPlain(null)}>隐藏</Button>
        )}
        {row.writable && <Button onClick={() => { setEditing(true); setError(null); }}>更换</Button>}
      </div>
      <p className="setting-impact">{sourceText(row)}</p>
      {row.source !== 'missing' && <p className="setting-impact">查看会被记录</p>}
      {!row.writable && <p className="setting-compliance">服务器没有配置加密主密钥，这个 Key 只能在服务器环境变量里更换。</p>}
      {error && <Alert type="error" showIcon message={error} />}
      <Modal
        open={editing}
        title={`更换${row.label}`}
        onCancel={close}
        footer={[
          <Button key="cancel" onClick={close}>取消</Button>,
          <Button key="save" type="primary" onClick={() => void save()}>保存</Button>,
        ]}
      >
        <label className="secret-input">
          新的 Key
          <Input.Password aria-label="新的 Key" value={draft} autoComplete="off" onChange={(e) => setDraft(e.target.value)} />
        </label>
        <p className="setting-impact">保存后从下一通电话开始使用，正在进行的通话不受影响。</p>
      </Modal>
    </section>
  );
}

export function SecretsPanel() {
  const api = useApi();
  const [rows, setRows] = useState<AdminSecretRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (): Promise<void> => {
    try {
      setRows(await api.secrets());
      setError(null);
    } catch (e: unknown) {
      setError(errorText(e, '读取 Key 没有成功，请刷新页面。'));
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  if (error && !rows) return <Alert type="error" showIcon message={error} />;
  if (!rows) return <Spin />;
  return (
    <div className="secrets-panel">
      <h2 className="config-subtitle">Key</h2>
      {rows.map((row) => <SecretRow key={row.name} row={row} onSaved={() => void load()} />)}
    </div>
  );
}
