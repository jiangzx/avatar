import { Button, Input, InputNumber, Select, Switch } from 'antd';
import type { AdminConfigItem, AdminConfigValue } from '@anyidea/protocol';
import { effectiveValue, type DraftMap } from './draft.ts';
import { formatValue, rowLabel } from './format.ts';
import { rowErrors } from './validate.ts';

interface ControlProps { item: AdminConfigItem; label: string; value: AdminConfigValue; onChange: (value: AdminConfigValue) => void }

function Control({ item, label, value, onChange }: ControlProps) {
  switch (item.control) {
    case 'switch':
      return <Switch aria-label={label} checked={value === true} onChange={(v) => onChange(v)} />;
    case 'select':
      return (
        <Select
          aria-label={label}
          value={String(value)}
          style={{ minWidth: 320 }}
          options={item.options.map((o) => ({ value: o.value, label: o.priceNote ? `${o.label}（${o.priceNote}）` : o.label }))}
          onChange={(v: string) => onChange(v)}
        />
      );
    case 'list':
      return (
        <Select aria-label={label} mode="tags" value={Array.isArray(value) ? value : []} style={{ minWidth: 320 }} onChange={(v: string[]) => onChange(v)} />
      );
    case 'textarea':
      return <Input.TextArea aria-label={label} value={String(value)} autoSize={{ minRows: 6, maxRows: 24 }} onChange={(e) => onChange(e.target.value)} />;
    case 'text':
      return (
        <Input
          aria-label={label}
          value={String(value)}
          style={{ minWidth: 320 }}
          onChange={(e) => onChange(item.pattern ? e.target.value.trim() : e.target.value)}
        />
      );
    case 'number':
      return (
        <InputNumber<number>
          aria-label={label}
          value={typeof value === 'number' ? value : null}
          step={item.step ?? 1}
          addonAfter={item.unit ?? undefined}
          onChange={(v) => { if (typeof v === 'number') onChange(v); }}
        />
      );
  }
}

export interface SettingRowProps {
  item: AdminConfigItem;
  draft: DraftMap;
  onChange: (value: AdminConfigValue) => void;
  onReset: () => void;
}

export function SettingRow({ item, draft, onChange, onReset }: SettingRowProps) {
  const label = rowLabel(item);
  const modified = item.key in draft;
  const value = effectiveValue(item, draft);
  const errors = modified ? rowErrors(item, value) : [];
  const wide = item.control === 'textarea' || item.control === 'list';
  const counter = (item.control === 'textarea' || item.control === 'text') && typeof value === 'string' && item.maxChars !== null
    ? `${Array.from(value).length} / ${item.maxChars} 字` : null;
  return (
    <section aria-label={label} className={`setting-row risk-${item.risk}${modified ? ' is-modified' : ''}${wide ? ' is-wide' : ''}`}>
      <div className="setting-head">
        <h3 className="setting-label">{label}</h3>
        <div className="setting-control"><Control item={item} label={label} value={value} onChange={onChange} /></div>
      </div>
      <p className="setting-purpose">{item.purpose}</p>
      <p className="setting-impact">影响：{item.impact.characters}，{item.impact.stage}</p>
      {counter && <p className="setting-counter">{counter}</p>}
      {item.changed && !modified && <p className="setting-changed">后台改过，默认 {formatValue(item, item.baseline)}</p>}
      {modified && <p className="setting-was">已改，原来 {formatValue(item, item.current)}</p>}
      {item.riskNote && <p className="setting-risk-note">{item.riskNote}</p>}
      {item.complianceNote && <p className="setting-compliance">{item.complianceNote}</p>}
      {errors.map((error) => <p key={error} role="alert" className="setting-error">{error}</p>)}
      {(item.changed || modified) && <Button type="link" className="setting-reset" onClick={onReset}>恢复默认</Button>}
    </section>
  );
}
