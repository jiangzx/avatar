import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminApiError, CONFIRM_PHRASE, type ConfigAdminApi } from '../src/admin/configApi.ts';
import type { SqliteConfigStore } from '../src/config-store/store.ts';
import { openDatabase } from '../src/memory/db.ts';
import type { ConfigSnapshot } from '../src/session/configSnapshot.ts';
import { buildConfigAdmin } from './support/configAdmin.ts';

const FIRST = 'pacing:restReminder.firstAfterMs';
const PERSONA = 'role:elder-companion/zh/persona';
const KEY_VALUE = 'sk-test-abcdefghijklmnop1234';
const NOW = Date.UTC(2026, 9, 27);

let db: DatabaseSync;
let api: ConfigAdminApi;
let store: SqliteConfigStore<ConfigSnapshot>;
let sessions = 2;

function audits() {
  return db.prepare('SELECT actor, action, target, detail FROM admin_audit ORDER BY id').all() as Array<{ actor: string; action: string; target: string | null; detail: string }>;
}
function expectApiError(fn: () => unknown, status: number, code: string): AdminApiError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AdminApiError);
    expect((error as AdminApiError).status).toBe(status);
    expect((error as AdminApiError).code).toBe(code);
    return error as AdminApiError;
  }
  throw new Error(`expected ${code}`);
}

beforeEach(() => {
  db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  sessions = 2;
  ({ api, store } = buildConfigAdmin(db, { activeSessions: () => sessions, now: () => NOW }));
});
afterEach(() => { if (db.isOpen) db.close(); });

describe('reading', () => {
  it('lists seven scenes with change counts', () => {
    const overview = api.overview();
    expect(overview.activeVersion).toBe(0);
    expect(overview.startupIssues).toEqual([]);
    expect(overview.scenes.map((s) => [s.id, s.changedCount])).toEqual([
      ['pacing', 0], ['affect', 0], ['proactivity', 0], ['memory', 0], ['characters', 0], ['copy', 0], ['model', 0],
    ]);
  });

  it('shows items in display units with baseline and current values', () => {
    const scene = api.scene('pacing');
    const item = scene.items.find((i) => i.key === FIRST)!;
    expect(item).toMatchObject({ label: '连续聊多久提醒休息', unit: '分钟', unitId: 'minute', min: 10, max: 120, step: 5, baseline: 60, current: 60, changed: false, risk: 'low' });
    expect(item.impact).toEqual({ characters: '所有角色', stage: '休息提醒', effective: 'next_session' });
    expect(scene.readonly.length).toBeGreaterThan(0);
  });

  it('labels per-character items and lists required placeholders', () => {
    const scene = api.scene('characters');
    expect(scene.items.find((i) => i.key === 'character:xiaokai.enabled')!.impact.characters).toBe('小凯');
    const persona = scene.items.find((i) => i.key === PERSONA)!;
    expect(persona.requiredTokens).toContain('{{charIdentity}}');
    expect(persona.tokenMeanings['{{charIdentity}}']).toBe('角色性格介绍');
    expect(Object.keys(persona.tokenMeanings).sort()).toEqual([...persona.requiredTokens].sort());
  });

  it('annotates model options with prices or 未定价', () => {
    const item = api.scene('model').items.find((i) => i.key === 'memory:extractModel')!;
    const plus = item.options.find((o) => o.value === 'qwen-plus')!;
    expect(plus.priceNote === '未定价' || /^输入 .+ \/ 输出 .+ 元每百万 token$/.test(plus.priceNote!)).toBe(true);
    expect(api.scene('characters').items.find((i) => i.key === 'character:xiaonuan.voices.qwen.zh')!.options[0]!.priceNote).toBeNull();
  });

  it('rejects unknown scenes', () => {
    expectApiError(() => api.scene('nope'), 404, 'scene_not_found');
  });
});

describe('preview', () => {
  it('explains a valid change in plain words', () => {
    const preview = api.preview({ baseVersion: 0, changes: [{ key: FIRST, value: 90 }], resets: [] });
    expect(preview).toEqual({
      ok: true,
      issues: [],
      lines: [{ key: FIRST, label: '连续聊多久提醒休息', scene: '对话节奏', before: '60 分钟', after: '90 分钟', characters: '所有角色', risk: 'low', textDiff: null }],
      summary: '影响所有角色。下一通电话开始生效，现在正在进行的 2 通电话不受影响。',
      activeSessions: 2,
      requiresConfirm: false,
      confirmPhrase: CONFIRM_PHRASE,
    });
  });

  it('collects per-item problems without throwing', () => {
    const preview = api.preview({ baseVersion: 0, changes: [{ key: FIRST, value: 125 }, { key: 'pacing:tailGuardMs', value: 1 }], resets: [] });
    expect(preview.ok).toBe(false);
    expect(preview.issues).toEqual([
      { key: FIRST, message: '「连续聊多久提醒休息」最大 120 分钟。' },
      { key: 'pacing:tailGuardMs', message: '这一项不能在后台修改。' },
    ]);
  });

  it('reports cross-field failures from the snapshot build', () => {
    const preview = api.preview({ baseVersion: 0, changes: [{ key: FIRST, value: 120 }, { key: 'pacing:restReminder.everyMs', value: 30 }], resets: [] });
    expect(preview.issues).toEqual([{ key: null, message: '「之后每隔多久再提醒」不能短于「连续聊多久提醒休息」的一半。' }]);
  });

  it('treats a value equal to the current one as no change', () => {
    expect(api.preview({ baseVersion: 0, changes: [{ key: FIRST, value: 60 }], resets: [] }).issues).toEqual([{ key: null, message: '没有需要发布的改动。' }]);
  });

  it('marks high-risk drafts and shows text diffs for prompts', () => {
    const before = api.scene('characters').items.find((i) => i.key === PERSONA)!.current as string;
    const preview = api.preview({ baseVersion: 0, changes: [{ key: PERSONA, value: `${before}\n多用短句。` }], resets: [] });
    expect(preview.requiresConfirm).toBe(true);
    expect(preview.lines[0]!.textDiff).toEqual({ before, after: `${before}\n多用短句。` });
    expect(preview.lines[0]!.label).toBe('三个角色共用的人设（中文）');
  });

  it('refuses a stale draft', () => {
    api.publish({ baseVersion: 0, changes: [{ key: FIRST, value: 90 }], resets: [] }, 'admin');
    expectApiError(() => api.preview({ baseVersion: 0, changes: [{ key: FIRST, value: 100 }], resets: [] }), 409, 'config_conflict');
  });
});

describe('publish, versions, rollback, reset', () => {
  it('publishes and audits numbers with values', () => {
    const version = api.publish({ baseVersion: 0, changes: [{ key: FIRST, value: 90 }], resets: [], note: '试一下' }, 'admin');
    expect(version).toMatchObject({ id: 1, kind: 'publish', actor: 'admin', note: '试一下', changedKeys: [FIRST], active: true });
    expect(store.snapshot().pacing.restReminder.firstAfterMs).toBe(5_400_000);
    expect(api.overview().scenes.find((s) => s.id === 'pacing')!.changedCount).toBe(1);
    const [row] = audits();
    expect(row).toMatchObject({ actor: 'admin', action: 'config_published', target: 'v1' });
    expect(JSON.parse(row!.detail)).toEqual({ version: 1, count: 1, item1: `${FIRST}=3600000→5400000` });
  });

  it('requires the confirm phrase for high-risk items and never audits prompt text', () => {
    const before = api.scene('characters').items.find((i) => i.key === PERSONA)!.current as string;
    const draft = { baseVersion: 0, changes: [{ key: PERSONA, value: `${before}\n多用短句。` }], resets: [] };
    expectApiError(() => api.publish(draft, 'admin'), 400, 'confirm_required');
    api.publish({ ...draft, confirmText: CONFIRM_PHRASE }, 'admin');
    const detail = audits()[0]!.detail;
    expect(detail).not.toContain('多用短句');
    const n = Array.from(before).length;
    expect(JSON.parse(detail)).toEqual({ version: 1, count: 1, item1: `${PERSONA} 已修改 ${n}→${n + 6} 字` });
    expect(store.snapshot().roles.buildPersona('xiaonuan', 'zh')).toContain('多用短句。');
  });

  it('turns invalid publishes into config_invalid with issues', () => {
    const error = expectApiError(() => api.publish({ baseVersion: 0, changes: [
      { key: 'character:xiaonuan.enabled', value: false },
      { key: 'character:xiaokai.enabled', value: false },
      { key: 'character:xiaoxin.enabled', value: false },
    ], resets: [] }, 'admin'), 400, 'config_invalid');
    expect(error.issues).toEqual([{ key: null, message: '至少要留一个角色开着。' }]);
  });

  it('stores a value equal to the baseline as a removal', () => {
    api.publish({ baseVersion: 0, changes: [{ key: FIRST, value: 90 }], resets: [] }, 'admin');
    api.publish({ baseVersion: 1, changes: [{ key: FIRST, value: 60 }], resets: [] }, 'admin');
    expect(store.activeOverlay()).toEqual({});
  });

  it('pages versions, diffs, rolls back and resets', () => {
    api.publish({ baseVersion: 0, changes: [{ key: FIRST, value: 90 }], resets: [] }, 'admin');
    api.publish({ baseVersion: 1, changes: [{ key: 'memory:listMaxItems', value: 3 }], resets: [] }, 'admin');
    const page = api.versions(1);
    expect(page.items.map((v) => [v.id, v.active, v.changedKeys])).toEqual([[2, true, ['memory:listMaxItems']]]);
    expect(page.nextCursor).toBe('2');
    expect(api.versions(10, 2).items.map((v) => v.id)).toEqual([1]);
    expect(api.versionDiff(2).lines).toEqual([
      { key: 'memory:listMaxItems', label: '问「你都记得我什么」时说几条', scene: '记忆', before: '5 条', after: '3 条', characters: '所有角色', risk: 'low', textDiff: null },
    ]);
    expectApiError(() => api.versionDiff(9), 404, 'version_not_found');
    expect(api.rollback({ toVersion: 1, baseVersion: 2 }, 'admin')).toMatchObject({ id: 3, kind: 'rollback', changedKeys: ['memory:listMaxItems'] });
    expect(api.reset({ keys: [FIRST], baseVersion: 3 }, 'admin')).toMatchObject({ id: 4, kind: 'reset', changedKeys: [FIRST] });
    expect(api.reset({ keys: 'all', baseVersion: 4 }, 'admin').changedKeys).toEqual([]);
    expectApiError(() => api.reset({ keys: ['pacing:tailGuardMs'], baseVersion: 5 }, 'admin'), 400, 'config_invalid');
    expect(audits().map((a) => a.action)).toEqual(['config_published', 'config_published', 'config_rolled_back', 'config_reset', 'config_reset']);
  });
});

describe('secrets', () => {
  it('lists, updates and reveals with audits that never hold the value', () => {
    expect(api.secretList()).toEqual([{ name: 'DASHSCOPE_API_KEY', label: '通义千问（阿里云百炼）API Key', source: 'env', last4: '1111', updatedAt: null, writable: true }]);
    expect(api.putSecret('DASHSCOPE_API_KEY', KEY_VALUE, 'admin')).toMatchObject({ source: 'admin', last4: '1234' });
    expect(api.revealSecret('DASHSCOPE_API_KEY', 'admin')).toEqual({ name: 'DASHSCOPE_API_KEY', value: KEY_VALUE });
    expect(audits().map((a) => [a.action, a.target, a.detail])).toEqual([
      ['secret_updated', 'DASHSCOPE_API_KEY', '{}'],
      ['secret_revealed', 'DASHSCOPE_API_KEY', JSON.stringify({ source: 'admin' })],
    ]);
  });

  it('maps store errors', () => {
    expectApiError(() => api.putSecret('OTHER', KEY_VALUE, 'admin'), 404, 'secret_not_found');
    expectApiError(() => api.putSecret('DASHSCOPE_API_KEY', 'short', 'admin'), 400, 'secret_value_invalid');
    const readonly = buildConfigAdmin(db, { masterKey: null, env: {} }).api;
    expectApiError(() => readonly.putSecret('DASHSCOPE_API_KEY', KEY_VALUE, 'admin'), 409, 'secret_store_readonly');
    expectApiError(() => readonly.revealSecret('DASHSCOPE_API_KEY', 'admin'), 404, 'secret_missing');
  });
});

describe('prices', () => {
  it('lists baseline prices and adds an admin price', () => {
    const before = api.pricing().prices;
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((p) => p.origin === 'baseline')).toBe(true);
    const added = api.addPrice({
      model: 'qwen-plus', effectiveFrom: Date.UTC(2026, 9, 27), inputText: 900_000, inputAudio: null,
      outputText: 2_200_000, outputAudio: null, cached: null, source: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-10-27',
    }, 'admin');
    expect(added).toMatchObject({ model: 'qwen-plus', origin: 'admin', active: true });
    expect(api.pricing().prices.filter((p) => p.model === 'qwen-plus' && p.active)).toHaveLength(1);
    expect(audits().at(-1)).toMatchObject({ action: 'price_added', target: 'qwen-plus' });
  });

  it('lists real models that were called without a price, never mock', () => {
    const insert = db.prepare(`INSERT INTO usage_events (ts, kind, adapter, model, estimated, price_id, cost_micro_yuan)
      VALUES (?, 'memory_extract', ?, ?, 0, NULL, NULL)`);
    insert.run(NOW, 'text', 'qwen-max');
    insert.run(NOW, 'text', 'qwen-max');
    insert.run(NOW, 'mock', 'mock');
    expect(api.pricing().unpricedModels).toEqual([{ model: 'qwen-max', calls: 2 }]);
  });
});
