import { useEffect, useState } from 'react';
import { Alert, App, Button, Input, Modal, Spin } from 'antd';
import type { AdminConfigDraft, AdminConfigImpactLine, AdminConfigPreview } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { PromptDiff } from './PromptDiff.tsx';

export interface PublishDialogProps {
  open: boolean;
  draft: AdminConfigDraft;
  count: number;
  onClose: () => void;
  onPublished: (version: number) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '发布没有成功，请稍后再试。';
}

function groupByScene(lines: AdminConfigImpactLine[]): Array<[string, AdminConfigImpactLine[]]> {
  const groups = new Map<string, AdminConfigImpactLine[]>();
  for (const line of lines) groups.set(line.scene, [...(groups.get(line.scene) ?? []), line]);
  return [...groups.entries()];
}

export function PublishDialog({ open, draft, count, onClose, onPublished }: PublishDialogProps) {
  const api = useApi();
  const { message } = App.useApp();
  const [preview, setPreview] = useState<AdminConfigPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPreview(null);
    setError(null);
    setConfirm('');
    if (!open) return undefined;
    let live = true;
    api.configPreview(draft)
      .then((result) => { if (live) setPreview(result); })
      .catch((e: unknown) => { if (live) setError(messageOf(e)); });
    return () => { live = false; };
  }, [open, draft, api]);

  const canPublish = preview?.ok === true && !busy && (!preview.requiresConfirm || confirm === preview.confirmPhrase);

  const publish = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await api.configPublish({ ...draft, ...(preview.requiresConfirm ? { confirmText: confirm } : {}) });
      void message.success('已发布');
      onPublished(result.id);
    } catch (e: unknown) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`发布这 ${count} 项改动？`}
      onCancel={onClose}
      width={720}
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="publish" type="primary" disabled={!canPublish} loading={busy} onClick={() => void publish()}>发布</Button>,
      ]}
    >
      {error && <Alert type="error" showIcon message={error} />}
      {!preview && !error && <Spin />}
      {preview && (
        <div className="publish-body">
          {preview.issues.map((issue) => <Alert key={`${issue.key ?? 'all'}:${issue.message}`} type="error" showIcon message={issue.message} />)}
          {groupByScene(preview.lines).map(([title, lines]) => (
            <section key={title} className="publish-group">
              <h4>{title}</h4>
              {lines.map((line) => (
                <div key={line.key} className={`publish-row risk-${line.risk}`}>
                  <span className="publish-label">{line.label}</span>
                  {line.textDiff
                    ? <PromptDiff before={line.textDiff.before} after={line.textDiff.after} />
                    : <span className="publish-change">{line.before} → {line.after}</span>}
                </div>
              ))}
            </section>
          ))}
          {preview.summary && <p className="publish-impact">{preview.summary}</p>}
          {preview.requiresConfirm && (
            <label className="publish-confirm">
              这次有高风险改动，请输入「{preview.confirmPhrase}」
              <Input aria-label="确认文字" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
            </label>
          )}
        </div>
      )}
    </Modal>
  );
}
