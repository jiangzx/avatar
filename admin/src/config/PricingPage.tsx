import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Input, InputNumber, Modal, Spin, Table } from 'antd';
import type { AdminPriceCreate, AdminPriceRow, AdminPricing } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { formatDateTime } from '../format.ts';
import { formatPerMillion, shanghaiDayStart, yuanToMicro } from './priceFormat.ts';
import './config.css';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
type PriceKey = 'inputText' | 'inputAudio' | 'outputText' | 'outputAudio' | 'cached';

interface FormState { model: string; effectiveDay: string; checkedAt: string; source: string; prices: Record<PriceKey, number | null> }

const EMPTY_PRICES: Record<PriceKey, number | null> = { inputText: null, inputAudio: null, outputText: null, outputAudio: null, cached: null };
const PRICE_FIELDS: Array<[PriceKey, string]> = [
  ['inputText', '输入文本'], ['inputAudio', '输入音频'], ['outputText', '输出文本'], ['outputAudio', '输出音频'], ['cached', '缓存'],
];

function formErrors(form: FormState): string[] {
  const errors: string[] = [];
  if (!form.model.trim()) errors.push('请填写模型名');
  if (!DAY.test(form.effectiveDay)) errors.push('生效日期请按 2026-10-27 这样填写');
  if (form.prices.inputText === null || form.prices.outputText === null) errors.push('输入文本和输出文本的单价必须填写');
  if (Object.values(form.prices).some((v) => v !== null && v < 0)) errors.push('单价不能是负数');
  if (!form.source.startsWith('https://')) errors.push('来源网址必须以 https:// 开头');
  if (!DAY.test(form.checkedAt)) errors.push('查询日期请按 2026-10-27 这样填写');
  return errors;
}

function toCreate(form: FormState): AdminPriceCreate {
  const micro = (v: number | null) => (v === null ? null : yuanToMicro(v));
  return {
    model: form.model.trim(),
    effectiveFrom: shanghaiDayStart(form.effectiveDay),
    inputText: yuanToMicro(form.prices.inputText ?? 0),
    inputAudio: micro(form.prices.inputAudio),
    outputText: yuanToMicro(form.prices.outputText ?? 0),
    outputAudio: micro(form.prices.outputAudio),
    cached: micro(form.prices.cached),
    source: form.source.trim(),
    checkedAt: form.checkedAt,
  };
}

function columns() {
  const price = (key: PriceKey, title: string) => ({
    title, dataIndex: key, key, align: 'right' as const,
    render: (v: number | null) => formatPerMillion(v),
  });
  return [
    {
      title: '生效时间', dataIndex: 'effectiveFrom', key: 'effectiveFrom',
      render: (v: number, row: AdminPriceRow) => (
        <span>{formatDateTime(v)}{row.active && <span className="price-badge">正在使用</span>}</span>
      ),
    },
    ...PRICE_FIELDS.map(([key, title]) => price(key, title)),
    {
      title: '来源', dataIndex: 'source', key: 'source',
      render: (v: string, row: AdminPriceRow) => (
        <span>
          <a href={v} target="_blank" rel="noreferrer noopener">官方价格页</a>
          <span className="price-checked">{row.checkedAt} 查询{row.origin === 'admin' ? '，后台添加' : ''}</span>
        </span>
      ),
    },
  ];
}

export function PricingPage() {
  const api = useApi();
  const { message } = App.useApp();
  const [data, setData] = useState<AdminPricing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await api.pricing());
      setLoadError(null);
    } catch (e: unknown) {
      setLoadError(e instanceof Error && e.message ? e.message : '读取价格表没有成功，请刷新页面。');
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const submit = async (): Promise<void> => {
    if (!form) return;
    const problems = formErrors(form);
    setErrors(problems);
    if (problems.length > 0) return;
    try {
      await api.addPrice(toCreate(form));
      setForm(null);
      void message.success('已添加价格');
      void load();
    } catch (e: unknown) {
      setErrors([e instanceof Error && e.message ? e.message : '添加没有成功，请稍后再试。']);
    }
  };

  const open = (model = '') => { setErrors([]); setForm({ model, effectiveDay: '', checkedAt: '', source: '', prices: { ...EMPTY_PRICES } }); };

  if (loadError) return <Alert type="error" showIcon message={loadError} />;
  if (!data) return <Spin />;

  const models = [...new Set(data.prices.map((p) => p.model))];
  return (
    <div className="pricing-page">
      <h1 className="config-title">价格表</h1>
      <p className="config-summary">单价单位是「元/百万 token」，按官方标价算，不扣免费额度。改价只影响之后的通话，以前的费用不重算。</p>
      <Button type="primary" onClick={() => open()}>新增价格</Button>

      {data.unpricedModels.length > 0 && (
        <section className="unpriced" aria-label="还没有价格的模型">
          <h2 className="config-subtitle">还没有价格的模型</h2>
          <p className="setting-impact">这些模型的费用在总览和用户页里显示为「未定价」。</p>
          {data.unpricedModels.map((m) => (
            <div key={m.model} className="unpriced-row">
              <span className="unpriced-model">{m.model}</span>
              <span className="unpriced-note">未定价，{m.calls} 次调用</span>
              <Button type="link" onClick={() => open(m.model)}>给它定价</Button>
            </div>
          ))}
        </section>
      )}

      {models.map((model) => (
        <section key={model} aria-label={model} className="price-group">
          <h2 className="config-subtitle">{model}</h2>
          <Table<AdminPriceRow>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={data.prices.filter((p) => p.model === model).sort((a, b) => b.effectiveFrom - a.effectiveFrom)}
            columns={columns()}
            rowClassName={(row) => (row.active ? 'price-active' : '')}
          />
        </section>
      ))}

      <Modal
        open={form !== null}
        title="新增价格"
        onCancel={() => setForm(null)}
        footer={[
          <Button key="cancel" onClick={() => setForm(null)}>取消</Button>,
          <Button key="add" type="primary" onClick={() => void submit()}>添加</Button>,
        ]}
      >
        {form && (
          <div className="price-form">
            <label>模型<Input aria-label="模型" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></label>
            <label>生效日期<Input aria-label="生效日期" placeholder="2026-10-27" value={form.effectiveDay} onChange={(e) => setForm({ ...form, effectiveDay: e.target.value.trim() })} /></label>
            {PRICE_FIELDS.map(([key, label]) => (
              <label key={key}>
                {label}
                <InputNumber<number>
                  aria-label={label}
                  min={0}
                  step={0.01}
                  addonAfter="元/百万 token"
                  value={form.prices[key]}
                  onChange={(v) => setForm({ ...form, prices: { ...form.prices, [key]: typeof v === 'number' ? v : null } })}
                />
              </label>
            ))}
            <label>来源网址<Input aria-label="来源网址" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} /></label>
            <label>查询日期<Input aria-label="查询日期" placeholder="2026-10-27" value={form.checkedAt} onChange={(e) => setForm({ ...form, checkedAt: e.target.value.trim() })} /></label>
            {errors.map((error) => <p key={error} role="alert" className="setting-error">{error}</p>)}
          </div>
        )}
      </Modal>
    </div>
  );
}
