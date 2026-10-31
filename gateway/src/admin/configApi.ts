import type { DatabaseSync } from 'node:sqlite';
import type {
  AdminConfigDraft, AdminConfigImpactLine, AdminConfigItem, AdminConfigOverview, AdminConfigPreview,
  AdminConfigPublishRequest, AdminConfigResetRequest, AdminConfigRollbackRequest, AdminConfigScene, AdminConfigValue,
  AdminConfigVersion, AdminConfigVersionDiff, AdminPage, AdminPriceCreate, AdminPriceRow, AdminPricing, AdminSecretReveal, AdminSecretRow,
} from '@anyidea/protocol';
import type { LogFields } from '../log/logger.ts';
import type { AdminAudit, AdminAuditAction } from './audit.ts';
import { SCENE_IDS, extractPlaceholders, type ConcreteItem, type DescriptorCatalog, type SceneId } from '../config-store/descriptors.ts';
import { ConfigConflictError, ConfigInvalidError, type ConfigIssue } from '../config-store/errors.ts';
import { parseOverlayKey, readTargetValue, type ModelDefaults, type Overlay, type OverlayValue } from '../config-store/keys.ts';
import { optionsFor, type QwenOptions } from '../config-store/options.ts';
import { SECRET_NAMES, SecretStoreReadonlyError, SecretValueInvalidError, isSecretName, type SqliteSecretStore } from '../config-store/secrets.ts';
import type { ConfigVersionRow, SqliteConfigStore } from '../config-store/store.ts';
import { toDisplay } from '../config-store/units.ts';
import { TOKEN_MEANINGS, UNIT_WORDS, validateDisplayValue } from '../config-store/validate.ts';
import type { ConfigSnapshot } from '../session/configSnapshot.ts';
import type { PriceEntry, SqlitePriceBook } from '../usage/pricing.ts';

export const CONFIRM_PHRASE = '确认发布';
const LANGUAGE_NAMES = { zh: '中文', ja: '日语', en: '英语' } as const;
const SECRET_LABELS: Record<string, string> = { DASHSCOPE_API_KEY: '通义千问（阿里云百炼）API Key' };
const NOT_EDITABLE = '这一项不能在后台修改。';

/** A refusal the admin page can show as is. `userMessage` is Chinese; `code` is stable for the client. */
export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly userMessage: string, readonly issues: readonly ConfigIssue[] = []) {
    super(code);
  }
}

export interface ConfigAdminDeps {
  db: DatabaseSync;
  store: SqliteConfigStore<ConfigSnapshot>;
  catalog: DescriptorCatalog;
  options: QwenOptions;
  secrets: SqliteSecretStore | null;
  prices: SqlitePriceBook;
  /** P2-T3 audit writer; detail must be flat LogFields. */
  audit: AdminAudit;
  gatewayRoot: string;
  models: ModelDefaults;
  activeSessions: () => number;
  now?: () => number;
}

/** At most this many changed items are listed one by one in an audit row; the rest are counted. */
const AUDIT_ITEMS = 10;

interface Touched { item: ConcreteItem; before: OverlayValue; after: OverlayValue }
interface Evaluation { issues: ConfigIssue[]; changes: Record<string, OverlayValue>; removals: string[]; touched: Touched[] }

const conflict = () => new AdminApiError(409, 'config_conflict', '配置已在别处更新，请刷新页面后再改。');
const same = (a: OverlayValue | undefined, b: OverlayValue | undefined) => JSON.stringify(a) === JSON.stringify(b);
const chars = (value: OverlayValue) => Array.from(Array.isArray(value) ? value.join('\n') : String(value)).length;
const yuan = (micro: number | null) => (micro === null ? '—' : String(Number((micro / 1e6).toFixed(4))));

export class ConfigAdminApi {
  private readonly baselines = new Map<string, OverlayValue>();
  private readonly now: () => number;

  constructor(private readonly deps: ConfigAdminDeps) {
    this.now = deps.now ?? Date.now;
    // Repo files do not change while the process runs; read every baseline once.
    for (const item of deps.catalog.all()) this.baselines.set(item.key, readTargetValue(deps.gatewayRoot, parseOverlayKey(item.key), deps.models));
  }

  overview(): AdminConfigOverview {
    const overlay = this.deps.store.activeOverlay();
    return {
      activeVersion: this.deps.store.activeVersion(),
      startupIssues: this.deps.store.startupIssues.map((issue) => issue.message),
      scenes: this.deps.catalog.scenes().map((scene) => ({
        id: scene.id, title: scene.title, intro: scene.intro,
        changedCount: scene.items.filter((item) => Object.hasOwn(overlay, item.key)).length,
      })),
    };
  }

  scene(id: string): AdminConfigScene {
    if (!(SCENE_IDS as readonly string[]).includes(id)) throw new AdminApiError(404, 'scene_not_found', '没有这个设置分组。');
    const scene = this.deps.catalog.scene(id as SceneId);
    const overlay = this.deps.store.activeOverlay();
    return {
      id: scene.id, title: scene.title, intro: scene.intro,
      activeVersion: this.deps.store.activeVersion(),
      items: scene.items.map((item) => this.itemView(item, overlay)),
      readonly: scene.readonly.map((note) => ({ ...note })),
    };
  }

  preview(draft: AdminConfigDraft): AdminConfigPreview {
    const evaluation = this.evaluate(draft);
    const lines = evaluation.issues.length > 0 ? [] : evaluation.touched.map((t) => this.line(t.item, t.before, t.after));
    return {
      ok: evaluation.issues.length === 0,
      issues: evaluation.issues.map((issue) => ({ ...issue })),
      lines,
      summary: lines.length > 0 ? this.summary(lines) : '',
      activeSessions: this.deps.activeSessions(),
      requiresConfirm: lines.some((line) => line.risk === 'high'),
      confirmPhrase: CONFIRM_PHRASE,
    };
  }

  publish(request: AdminConfigPublishRequest, actor: string): AdminConfigVersion {
    const evaluation = this.evaluate(request);
    if (evaluation.issues.length > 0) throw new AdminApiError(400, 'config_invalid', '有几项设置没通过检查。', evaluation.issues);
    if (evaluation.touched.some((t) => t.item.risk === 'high') && request.confirmText !== CONFIRM_PHRASE) {
      throw new AdminApiError(400, 'confirm_required', `这次改动有高风险项，请输入「${CONFIRM_PHRASE}」。`);
    }
    const row = this.guard(() => this.deps.store.publish({
      baseVersion: request.baseVersion, changes: evaluation.changes, removals: evaluation.removals,
      ...(request.note ? { note: request.note } : {}), actor,
    }));
    this.audit(actor, 'config_published', `v${row.id}`, publishDetail(row.id, evaluation.touched));
    return this.versionView(row);
  }

  versions(limit: number, before?: number): AdminPage<AdminConfigVersion> {
    const rows = this.deps.store.versions({ limit: limit + 1, ...(before !== undefined ? { before } : {}) });
    const items = rows.slice(0, limit).map((row) => this.versionView(row));
    return { items, nextCursor: rows.length > limit ? String(items.at(-1)!.id) : null };
  }

  versionDiff(id: number): AdminConfigVersionDiff {
    const row = this.deps.store.versions({ limit: 1, before: id + 1 })[0];
    if (!row || row.id !== id) throw new AdminApiError(404, 'version_not_found', '没有这个版本。');
    const previous = this.deps.store.overlayOf(row.baseVersion ?? 0) ?? {};
    return {
      id,
      lines: diffKeys(previous, row.overlay).map((key) => {
        const item = this.deps.catalog.find(key);
        if (!item) return { key, label: key, scene: '已下线的设置', before: '—', after: '—', characters: '—', risk: 'low' as const, textDiff: null };
        const baseline = this.baseline(item);
        return this.line(item, previous[key] ?? baseline, row.overlay[key] ?? baseline);
      }),
    };
  }

  rollback(request: AdminConfigRollbackRequest, actor: string): AdminConfigVersion {
    const row = this.guard(() => this.deps.store.rollback({ toVersion: request.toVersion, baseVersion: request.baseVersion, actor }));
    this.audit(actor, 'config_rolled_back', `v${row.id}`, { version: row.id, toVersion: request.toVersion });
    return this.versionView(row);
  }

  reset(request: AdminConfigResetRequest, actor: string): AdminConfigVersion {
    if (request.keys !== 'all') {
      const unknown = request.keys.filter((key) => !this.deps.catalog.find(key));
      if (unknown.length > 0) throw new AdminApiError(400, 'config_invalid', '有几项设置没通过检查。', unknown.map((key) => ({ key, message: NOT_EDITABLE })));
    }
    const keys = request.keys;
    const row = this.guard(() => this.deps.store.reset({ keys, baseVersion: request.baseVersion, actor }));
    this.audit(actor, 'config_reset', `v${row.id}`, { version: row.id, keys: keys === 'all' ? 'all' : keys.length });
    return this.versionView(row);
  }

  secretList(): AdminSecretRow[] {
    return SECRET_NAMES.map((name) => this.secretRow(name));
  }

  putSecret(name: string, value: string, actor: string): AdminSecretRow {
    if (!isSecretName(name)) throw new AdminApiError(404, 'secret_not_found', '没有这个 Key。');
    const secrets = this.deps.secrets;
    if (!secrets) throw new AdminApiError(409, 'secret_store_readonly', '服务器没有配置 ADMIN_SECRET_KEY，Key 只能在部署时设置。');
    try {
      secrets.put(name, value, actor);
    } catch (error) {
      if (error instanceof SecretStoreReadonlyError) throw new AdminApiError(409, 'secret_store_readonly', '服务器没有配置 ADMIN_SECRET_KEY，Key 只能在部署时设置。');
      if (error instanceof SecretValueInvalidError) throw new AdminApiError(400, 'secret_value_invalid', 'Key 格式不对：应为 8–256 位、不含空格的字符。');
      throw error;
    }
    this.audit(actor, 'secret_updated', name, {});
    return this.secretRow(name);
  }

  revealSecret(name: string, actor: string): AdminSecretReveal {
    if (!isSecretName(name)) throw new AdminApiError(404, 'secret_not_found', '没有这个 Key。');
    const value = this.deps.secrets?.resolve(name);
    if (!value) throw new AdminApiError(404, 'secret_missing', '还没有设置这个 Key。');
    this.audit(actor, 'secret_revealed', name, { source: this.deps.secrets!.info(name).source });
    return { name, value };
  }

  pricing(): AdminPricing {
    const adminIds = new Set((this.deps.db.prepare('SELECT id FROM price_entries').all() as Array<{ id: string }>).map((row) => row.id));
    const now = this.now();
    // Real calls the price book could not price (cost NULL). Mock rows are synthetic and never priced.
    const unpriced = this.deps.db.prepare(`SELECT model, COUNT(*) AS calls FROM usage_events
      WHERE cost_micro_yuan IS NULL AND adapter <> 'mock' GROUP BY model ORDER BY calls DESC, model`).all() as Array<{ model: string; calls: number }>;
    return {
      prices: this.deps.prices.list().map((entry) => this.priceRow(entry, adminIds, now)),
      unpricedModels: unpriced.map((row) => ({ model: row.model, calls: Number(row.calls) })),
    };
  }

  addPrice(request: AdminPriceCreate, actor: string): AdminPriceRow {
    const now = this.now();
    const entry = this.deps.prices.add({ ...request }, actor, now);
    this.audit(actor, 'price_added', entry.model, { model: entry.model, effectiveFrom: entry.effectiveFrom });
    return this.priceRow(entry, new Set([entry.id]), now);
  }

  private evaluate(draft: AdminConfigDraft): Evaluation {
    const store = this.deps.store;
    if (draft.baseVersion !== store.activeVersion()) throw conflict();
    const overlay = store.activeOverlay();
    const silence = store.snapshot().i18n.silence;
    const issues: ConfigIssue[] = [];
    const changes: Record<string, OverlayValue> = {};
    const removals: string[] = [];
    const touched: Touched[] = [];
    const seen = new Set<string>();
    const claim = (key: string, label: string): boolean => {
      if (!seen.has(key)) { seen.add(key); return true; }
      issues.push({ key, message: `「${label}」重复提交了。` });
      return false;
    };
    for (const change of draft.changes) {
      const item = this.deps.catalog.find(change.key);
      if (!item) { issues.push({ key: change.key, message: NOT_EDITABLE }); continue; }
      if (!claim(item.key, item.label)) continue;
      const baseline = this.baseline(item);
      const result = validateDisplayValue(item, change.value, { baseline, silence, options: this.deps.options });
      if (!result.ok) { issues.push({ key: item.key, message: result.message }); continue; }
      const before = Object.hasOwn(overlay, item.key) ? overlay[item.key]! : baseline;
      if (same(result.stored, before)) continue;
      // Keep the overlay minimal: a value equal to the repo default is stored as "no override".
      if (same(result.stored, baseline)) removals.push(item.key);
      else changes[item.key] = result.stored;
      touched.push({ item, before, after: result.stored });
    }
    for (const key of draft.resets) {
      const item = this.deps.catalog.find(key);
      if (!item) { issues.push({ key, message: NOT_EDITABLE }); continue; }
      if (!claim(item.key, item.label) || !Object.hasOwn(overlay, key)) continue;
      removals.push(key);
      touched.push({ item, before: overlay[key]!, after: this.baseline(item) });
    }
    if (issues.length === 0 && touched.length === 0) issues.push({ key: null, message: '没有需要发布的改动。' });
    if (issues.length === 0) {
      try {
        store.preview({ baseVersion: draft.baseVersion, changes, removals });
      } catch (error) {
        if (error instanceof ConfigConflictError) throw conflict();
        if (!(error instanceof ConfigInvalidError)) throw error;
        issues.push(...error.issues);
      }
    }
    return { issues, changes, removals, touched };
  }

  private guard(run: () => ConfigVersionRow): ConfigVersionRow {
    try {
      return run();
    } catch (error) {
      if (error instanceof ConfigConflictError) throw conflict();
      if (error instanceof ConfigInvalidError) throw new AdminApiError(400, 'config_invalid', '有几项设置没通过检查。', error.issues);
      throw error;
    }
  }

  private baseline(item: ConcreteItem): OverlayValue {
    return this.baselines.get(item.key)!;
  }

  private itemView(item: ConcreteItem, overlay: Overlay): AdminConfigItem {
    const baseline = this.baseline(item);
    const current = Object.hasOwn(overlay, item.key) ? overlay[item.key]! : baseline;
    const language = item.language ?? 'zh';
    const placeholders = item.placeholders === 'auto' && typeof baseline === 'string' ? extractPlaceholders(baseline) : [];
    const tokens = [...new Set([...(item.requiredTokens ?? []), ...placeholders])];
    return {
      key: item.key,
      descriptorKey: item.descriptorKey,
      label: this.itemLabel(item),
      purpose: item.purpose,
      impact: { characters: this.characterText(item), stage: item.impact.stage, effective: 'next_session' },
      control: item.control,
      advanced: item.advanced ?? false,
      unit: item.unit ? UNIT_WORDS[item.unit] ?? null : null,
      unitId: item.unit ?? null,
      min: item.min ?? null,
      max: item.max ?? null,
      step: item.step ?? null,
      maxChars: item.maxChars?.[language] ?? null,
      minItems: item.minItems ?? null,
      maxItems: item.maxItems ?? null,
      itemMaxChars: item.itemMaxChars?.[language] ?? null,
      requiredTokens: tokens,
      tokenMeanings: Object.fromEntries(tokens.map((token) => [token, TOKEN_MEANINGS[token] ?? '程序要用的内容'])),
      options: item.options
        ? optionsFor(this.deps.options, item.options, item.language, item.model)
            .map((option) => ({ ...option, priceNote: this.priceNote(item, option.value) }))
        : [],
      pattern: item.pattern ?? null,
      complianceNote: item.complianceNote,
      risk: item.risk,
      riskNote: item.riskNote,
      language: item.language,
      character: item.character,
      model: item.model,
      baseline: viewValue(item, baseline),
      current: viewValue(item, current),
      changed: Object.hasOwn(overlay, item.key),
    };
  }

  private line(item: ConcreteItem, before: OverlayValue, after: OverlayValue): AdminConfigImpactLine {
    const textual = item.control === 'textarea' || item.control === 'list';
    return {
      key: item.key,
      label: this.lineLabel(item),
      scene: this.deps.catalog.scene(item.scene).title,
      before: this.display(item, before),
      after: this.display(item, after),
      characters: this.characterText(item),
      risk: item.risk,
      textDiff: textual ? { before: asText(before), after: asText(after) } : null,
    };
  }

  private itemLabel(item: ConcreteItem): string {
    if (!item.model) return item.label;
    const model = this.deps.options.realtimeModels.find((option) => option.value === item.model)?.label ?? item.model;
    return `${item.label}（${model}）`;
  }

  private lineLabel(item: ConcreteItem): string {
    const who = item.character ? `（${this.deps.store.snapshot().characters.name(item.character, 'zh')}）` : '';
    const language = item.language ? `（${LANGUAGE_NAMES[item.language]}）` : '';
    return `${this.itemLabel(item)}${who}${language}`;
  }

  private display(item: ConcreteItem, value: OverlayValue): string {
    switch (item.control) {
      case 'number': return `${toDisplay(item, value) as number} ${UNIT_WORDS[item.unit!] ?? ''}`.trim();
      case 'switch': return value ? '开' : '关';
      case 'select': return optionsFor(this.deps.options, item.options!, item.language, item.model).find((o) => o.value === value)?.label ?? String(value);
      case 'list': return `${(value as readonly string[]).length} 条`;
      case 'textarea': return `${chars(value)} 字`;
      case 'text': return item.pattern ? String(value) : `「${String(value)}」`;
    }
  }

  private characterText(item: ConcreteItem): string {
    return item.character ? this.deps.store.snapshot().characters.name(item.character, 'zh') : '所有角色';
  }

  private summary(lines: readonly AdminConfigImpactLine[]): string {
    const who = lines.some((line) => line.characters === '所有角色') ? '所有角色' : [...new Set(lines.map((line) => line.characters))].join('、');
    const active = this.deps.activeSessions();
    const running = active > 0 ? `现在正在进行的 ${active} 通电话不受影响。` : '现在没有正在进行的电话。';
    return `影响${who}。下一通电话开始生效，${running}`;
  }

  private versionView(row: ConfigVersionRow): AdminConfigVersion {
    const previous = this.deps.store.overlayOf(row.baseVersion ?? 0) ?? {};
    return {
      id: row.id, createdAt: row.createdAt, kind: row.kind, actor: row.actor, note: row.note,
      changedKeys: diffKeys(previous, row.overlay),
      active: row.id === this.deps.store.activeVersion(),
    };
  }

  private priceNote(item: ConcreteItem, model: string): string | null {
    if (item.options !== 'realtimeModels' && item.options !== 'textModels') return null;
    const price = this.deps.prices.priceFor(model, this.now());
    if (!price) return '未定价';
    if (item.options === 'realtimeModels' && price.inputAudio !== null && price.outputAudio !== null) {
      return `音频输入 ${yuan(price.inputAudio)} / 音频输出 ${yuan(price.outputAudio)} 元每百万 token`;
    }
    return `输入 ${yuan(price.inputText)} / 输出 ${yuan(price.outputText)} 元每百万 token`;
  }

  private priceRow(entry: PriceEntry, adminIds: ReadonlySet<string>, now: number): AdminPriceRow {
    return {
      ...entry,
      origin: adminIds.has(entry.id) ? 'admin' : 'baseline',
      active: this.deps.prices.priceFor(entry.model, now)?.id === entry.id,
    };
  }

  private secretRow(name: (typeof SECRET_NAMES)[number]): AdminSecretRow {
    const label = SECRET_LABELS[name] ?? name;
    const info = this.deps.secrets?.info(name);
    if (!info) return { name, label, source: 'missing', last4: null, updatedAt: null, writable: false };
    return { name, label, source: info.source, last4: info.last4, updatedAt: info.updatedAt, writable: info.writable };
  }

  private audit(actor: string, action: AdminAuditAction, target: string | null, detail: LogFields): void {
    this.deps.audit.record({ actor, action, target, detail });
  }
}

/** Flat audit detail: item1..itemN, numbers/switches/models as stored values, text only as "changed" plus lengths. */
function publishDetail(version: number, touched: readonly Touched[]): LogFields {
  const detail: LogFields = { version, count: touched.length };
  touched.slice(0, AUDIT_ITEMS).forEach((t, index) => { detail[`item${index + 1}`] = auditItem(t); });
  if (touched.length > AUDIT_ITEMS) detail.more = touched.length - AUDIT_ITEMS;
  return detail;
}

function auditItem(t: Touched): string {
  if (t.item.control === 'number' || t.item.control === 'switch' || t.item.control === 'select') {
    return `${t.item.key}=${String(t.before)}→${String(t.after)}`;
  }
  return `${t.item.key} 已修改 ${chars(t.before)}→${chars(t.after)} 字`;
}

function viewValue(item: ConcreteItem, stored: OverlayValue): AdminConfigValue {
  const shown = toDisplay(item, stored);
  return Array.isArray(shown) ? [...shown] : (shown as AdminConfigValue);
}

function asText(value: OverlayValue): string {
  return Array.isArray(value) ? value.join('\n') : String(value);
}

function diffKeys(a: Overlay, b: Overlay): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !same(a[key], b[key])).sort();
}
