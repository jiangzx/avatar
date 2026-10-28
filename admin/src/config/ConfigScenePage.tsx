import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Segmented, Spin } from 'antd';
import type { AdminConfigItem, AdminConfigScene, AdminConfigValue } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { effectiveValue, resetToDefault, setValue, toDraft, type DraftMap } from './draft.ts';
import { PublishDialog } from './PublishDialog.tsx';
import { SettingRow } from './SettingRow.tsx';
import { UnpublishedBar } from './UnpublishedBar.tsx';
import { rowErrors } from './validate.ts';
import './config.css';

type Language = 'zh' | 'ja' | 'en';
const LANGUAGE_OPTIONS: Array<{ value: Language; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日语' },
  { value: 'en', label: '英语' },
];

export interface SceneView { read(key: string): AdminConfigValue | undefined; item(key: string): AdminConfigItem | undefined }

export interface ConfigScenePageProps {
  scene: string;
  aside?: (view: SceneView) => ReactNode;
  below?: ReactNode;
}

export function ConfigScenePage({ scene, aside, below }: ConfigScenePageProps) {
  const api = useApi();
  const [data, setData] = useState<AdminConfigScene | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftMap>({});
  const [language, setLanguage] = useState<Language>('zh');
  const [reviewing, setReviewing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await api.configScene(scene));
      setLoadError(null);
    } catch (e: unknown) {
      setLoadError(e instanceof Error && e.message ? e.message : '读取配置没有成功，请刷新页面。');
    }
  }, [api, scene]);

  useEffect(() => {
    setDraft({});
    void load();
  }, [load]);

  const count = Object.keys(draft).length;
  const requestDraft = useMemo(() => toDraft(draft, data?.activeVersion ?? 0), [draft, data]);
  const view = useMemo<SceneView>(() => ({
    item: (key) => data?.items.find((candidate) => candidate.key === key),
    read: (key) => {
      const found = data?.items.find((candidate) => candidate.key === key);
      return found ? effectiveValue(found, draft) : undefined;
    },
  }), [data, draft]);
  const blocked = useMemo(
    () => (data?.items ?? []).some((item) => item.key in draft && rowErrors(item, effectiveValue(item, draft)).length > 0),
    [data, draft],
  );

  if (loadError) return <Alert type="error" showIcon message={loadError} />;
  if (!data) return <Spin />;

  const perLanguage = data.items.some((item) => item.language !== null);
  const visible = data.items.filter((item) => item.language === null || item.language === language);

  return (
    <div className={`config-page${aside ? ' has-aside' : ''}`}>
      <div className="config-main">
        <h1 className="config-title">{data.title}</h1>
        <p className="config-summary">{data.intro}</p>
        {perLanguage && (
          <Segmented<Language> className="config-language" options={LANGUAGE_OPTIONS} value={language} onChange={setLanguage} />
        )}
        {visible.map((item) => (
          <SettingRow
            key={item.key}
            item={item}
            draft={draft}
            onChange={(value) => setDraft((d) => setValue(d, item, value))}
            onReset={() => setDraft((d) => resetToDefault(d, item))}
          />
        ))}
        {data.readonly.length > 0 && (
          <section className="config-readonly" aria-label="只读说明">
            <h2>这些只能看，不能在这里改</h2>
            {data.readonly.map((note) => (
              <div key={note.label} className="config-readonly-row">
                <h3>{note.label}</h3>
                <p>{note.purpose}</p>
                <p className="caption">{note.note}</p>
              </div>
            ))}
          </section>
        )}
        {below}
      </div>
      {aside && <aside className="config-aside">{aside(view)}</aside>}
      <UnpublishedBar count={count} blocked={blocked} onDiscard={() => setDraft({})} onReview={() => setReviewing(true)} />
      <PublishDialog
        open={reviewing}
        draft={requestDraft}
        count={count}
        onClose={() => setReviewing(false)}
        onPublished={() => {
          setReviewing(false);
          setDraft({});
          void load();
        }}
      />
    </div>
  );
}
