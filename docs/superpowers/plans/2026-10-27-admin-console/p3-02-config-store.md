# P3-T2: ConfigStore 与配置快照

**目标：** 把「仓库 JSON 基线 + 覆盖层」合成为一份经过完整启动校验的不可变快照，并把覆盖层按版本存进 SQLite：发布、预览、回滚、恢复默认、基线版本冲突检测。本任务不接线到会话（P3-T3 做）。

**实现的 spec 章节：** 「配置覆盖层」（基线、覆盖层、合成与校验、并发、回滚与恢复默认）；决策 Q11；总览 C1 的 `config_versions` 表和 `meta.active_config_version`。

**前置：** P3-T1 已提交。开始前跑 `npm test -w gateway && npm run typecheck -w gateway`，确认全绿。

**做法：** 不改任何现有 loader。合成时把 `config/`、`roles/`、`characters/` 三个目录复制到一个私有临时目录（`mkdtemp`，权限 0700），把覆盖层的值写进临时目录里的对应文件，再用**和启动时完全相同**的 loader 与交叉校验去读这个临时目录；读完立即删除临时目录。loader 在加载时就把文本全部读进内存，之后不再读文件，所以删除是安全的。容器的 `/tmp` 是 tmpfs，可写。

**Files:**
- Create: `gateway/src/config-store/errors.ts`（`ConfigIssue`、`ConfigInvalidError`、`ConfigConflictError`）
- Create: `gateway/src/config-store/materialize.ts`（临时目录合成、虚拟设置）
- Create: `gateway/src/config-store/store.ts`（`SqliteConfigStore`、`ConfigSource`、`fixedConfigSource`）
- Create: `gateway/src/session/configSnapshot.ts`（`ConfigSnapshot`、`buildConfigSnapshot`、`explainBuildError`；放在 session 层，因为它调用 session 层的 loader）
- Test: `gateway/test/config-snapshot.test.ts`
- Test: `gateway/test/config-store.test.ts`

**Interfaces:**
- Consumes：P3-T1 的 `Overlay`、`OverlayValue`、`ModelDefaults`、`parseOverlayKey`、`setJsonPath`、`targetFiles`、`isOverlayValue`、`loadDescriptorCatalog`、`toStored`；现有 `loadCharacterRegistry`、`loadRoleCatalog`、`missingRoleLanguages`、`loadPacing`、`loadMemoryBudget`、`validateBudgets`、`loadI18n`、`loadAffectConfig`、`checkAffectBudgets`、`LedgerOptions`；总览 C2 的 `Logger`；P1-T2 的迁移 v7。
- Produces（P3-T3、P3-T4、P3-T5、P3-T6 依赖）：

```ts
// errors.ts
export interface ConfigIssue { key: string | null; message: string }   // message: user-facing Chinese, never a config text value
export class ConfigInvalidError extends Error { constructor(issues: readonly ConfigIssue[], options?: { cause?: unknown }); readonly issues: readonly ConfigIssue[] }   // message 'config_invalid'
export class ConfigConflictError extends Error { readonly activeVersion: number }           // message 'config_conflict'

// materialize.ts
export interface MaterializedTree { root: string; dispose(): void }
export function materializeConfigTree(gatewayRoot: string, overlay: Overlay, tmpRoot?: string): MaterializedTree;
export interface VirtualSettings { disabledCharacters: ReadonlySet<CharacterId>; models: ModelDefaults }
export function virtualSettings(overlay: Overlay, defaults: ModelDefaults): VirtualSettings;  // throws ConfigInvalidError

// store.ts
export interface ConfigSource<S> { snapshot(): S }
export function fixedConfigSource<S>(snapshot: S): ConfigSource<S>;
export type ConfigVersionKind = 'publish' | 'rollback' | 'reset';
export interface ConfigVersionRow { id: number; createdAt: number; baseVersion: number | null; kind: ConfigVersionKind; note: string | null; actor: string; overlay: Overlay }
export interface ConfigDraft { baseVersion: number; changes: Overlay; removals?: readonly string[] }
export class SqliteConfigStore<S> implements ConfigSource<S> {
  constructor(opts: { db: DatabaseSync; build: (overlay: Overlay, version: number) => S; logger: Logger; now?: () => number });
  readonly startupIssues: readonly ConfigIssue[];
  snapshot(): S;
  activeVersion(): number;                 // 0 = repo baseline, no overlay
  activeOverlay(): Overlay;
  overlayOf(version: number): Overlay | null;
  preview(draft: ConfigDraft): { overlay: Overlay; snapshot: S };
  publish(draft: ConfigDraft & { note?: string; actor: string }): ConfigVersionRow;
  rollback(input: { toVersion: number; baseVersion: number; actor: string }): ConfigVersionRow;
  reset(input: { keys: readonly string[] | 'all'; baseVersion: number; actor: string }): ConfigVersionRow;
  versions(input: { limit: number; before?: number }): ConfigVersionRow[];   // newest first
}

// session/configSnapshot.ts
export interface ModelSettings extends ModelDefaults { extractModel: string }
export interface ConfigSnapshot {
  version: number;
  pacing: PacingConfig;
  memory: MemoryBudgetConfig;
  affect: AffectConfig;
  i18n: I18nBundle;
  roles: FileRoleCatalog;
  characters: CharacterRegistry;
  budgets: BudgetReport;
  model: ModelSettings;
  disabledCharacters: ReadonlySet<CharacterId>;
}
export interface SnapshotInput {
  gatewayRoot: string;
  overlay: Overlay;
  version: number;
  ledger: LedgerOptions;
  sessionStartTimeoutMs: number;
  models: ModelDefaults;
  tmpRoot?: string;
}
export function buildConfigSnapshot(input: SnapshotInput): ConfigSnapshot;   // throws ConfigInvalidError only
export function explainBuildError(error: unknown): ConfigIssue[];
```

## Steps

- [x] **Step 1: 写失败的快照测试**

新建 `gateway/test/config-snapshot.test.ts`：

```ts
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { CHARACTER_IDS, LANGUAGES } from '@anyidea/protocol';
import { loadConfig } from '../src/config.ts';
import { loadDescriptorCatalog } from '../src/config-store/descriptors.ts';
import { ConfigInvalidError } from '../src/config-store/errors.ts';
import type { ModelDefaults, Overlay } from '../src/config-store/keys.ts';
import { toStored } from '../src/config-store/units.ts';
import { loadI18n } from '../src/i18n/load.ts';
import { loadAffectConfig } from '../src/session/affect.ts';
import { buildConfigSnapshot } from '../src/session/configSnapshot.ts';
import { loadMemoryBudget, loadPacing } from '../src/session/pacing.ts';
import { shippedRoles } from './support/shipped.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = loadConfig({ APP_SECRET: 'test-secret-0123456789' });
const models: ModelDefaults = {
  realtimeEndpoint: 'wss://example.invalid/api-ws/v1/realtime',
  realtimeModel: 'qwen3.8-omni-flash-realtime',
  textEndpoint: 'https://example.invalid/compatible-mode/v1/chat/completions',
  summarizerModel: 'qwen-flash',
};
const tmpRoot = mkdtempSync(join(tmpdir(), 'snapshot-test-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function build(overlay: Overlay, version = 1) {
  return buildConfigSnapshot({ gatewayRoot: root, overlay, version, ledger: env.ledger, sessionStartTimeoutMs: env.sessionStartTimeoutMs, models, tmpRoot });
}

function issuesOf(overlay: Overlay): string[] {
  try {
    build(overlay);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigInvalidError);
    return (error as ConfigInvalidError).issues.map((issue) => issue.message);
  }
  throw new Error('expected ConfigInvalidError');
}

describe('buildConfigSnapshot', () => {
  it('with an empty overlay equals the startup loaders', () => {
    const snap = build({}, 0);
    expect(snap.version).toBe(0);
    expect(snap.pacing).toEqual(loadPacing(`${root}config/pacing.json`));
    expect(snap.memory).toEqual(loadMemoryBudget(`${root}config/memory.json`));
    expect(snap.affect).toEqual(loadAffectConfig(`${root}config/affect.json`));
    expect(snap.i18n).toEqual(loadI18n(`${root}config`));
    const roles = shippedRoles();
    for (const { characterId, language } of roles.characterLanguagePairs()) {
      expect(snap.roles.buildPersona(characterId, language)).toBe(roles.buildPersona(characterId, language));
      expect(snap.roles.director(characterId, language)).toEqual(roles.director(characterId, language));
    }
    expect(snap.model).toEqual({ ...models, extractModel: 'qwen-plus' });
    expect([...snap.disabledCharacters]).toEqual([]);
  });

  it('applies json, text, character and model overlay values', () => {
    const snap = build({
      'role:elder-companion/*/director.contextAfterMs': 9000,
      'role:elder-companion/zh/persona': '标记ABC\n{{charIdentity}}\n{{char}}',
      'character:xiaokai.voices.qwen.zh': 'Tina',
      'character:xiaoxin.enabled': false,
      'model:qwen.realtimeModel': 'qwen3.8-omni-flash-realtime',
      'memory:extractModel': 'qwen-flash',
      'pacing:restReminder.firstAfterMs': 5_400_000,
    });
    for (const language of LANGUAGES) expect(snap.roles.director('xiaonuan', language).contextAfterMs).toBe(9000);
    expect(snap.roles.buildPersona('xiaonuan', 'zh')).toContain('标记ABC');
    expect(snap.roles.buildPersona('xiaonuan', 'ja')).not.toContain('标记ABC');
    expect(snap.characters.voiceFor('xiaokai', 'qwen', 'zh')).toBe('Tina');
    expect([...snap.disabledCharacters]).toEqual(['xiaoxin']);
    expect(snap.model.extractModel).toBe('qwen-flash');
    expect(snap.pacing.restReminder.firstAfterMs).toBe(5_400_000);
  });

  it('explains cross-field and placeholder failures in Chinese', () => {
    expect(issuesOf({ 'pacing:restReminder.everyMs': 600_000 })).toEqual(['「之后每隔多久再提醒」不能短于「连续聊多久提醒休息」的一半。']);
    expect(issuesOf({ 'role:elder-companion/zh/persona': '没有占位符的人设' })).toEqual(['人设里少了 {{charIdentity}}（角色性格插入的位置），请加回去。']);
    expect(issuesOf({ 'character:xiaonuan.enabled': false, 'character:xiaokai.enabled': false, 'character:xiaoxin.enabled': false })).toEqual(['至少要留一个角色开着。']);
    expect(issuesOf({ 'model:qwen.realtimeEndpoint': 'http://example.invalid' })).toEqual(['「通话服务地址」必须以 wss:// 开头。']);
    expect(issuesOf({ 'pacing:noSuchField': 1 })).toEqual(['有一项配置在当前版本的默认配置里已经不存在（pacing:noSuchField）。']);
  });

  it('removes its temp directory on success and failure', () => {
    build({});
    issuesOf({ 'pacing:restReminder.everyMs': 600_000 });
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('every numeric descriptor builds at its min and max', { timeout: 120_000 }, () => {
    const catalog = loadDescriptorCatalog(`${root}config/admin/descriptors`, { languages: LANGUAGES, characters: CHARACTER_IDS });
    for (const item of catalog.all().filter((i) => i.control === 'number')) {
      for (const shown of [item.min!, item.max!]) {
        expect(() => build({ [item.key]: toStored(item, shown) }), `${item.key}=${shown}`).not.toThrow();
      }
    }
  });
});
```

- [x] **Step 2: 写失败的 store 测试**

新建 `gateway/test/config-store.test.ts`：

```ts
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigConflictError, ConfigInvalidError } from '../src/config-store/errors.ts';
import type { Overlay } from '../src/config-store/keys.ts';
import { SqliteConfigStore, fixedConfigSource } from '../src/config-store/store.ts';
import { defaultLogger } from '../src/log/logger.ts';
import { openDatabase } from '../src/memory/db.ts';

interface FakeSnapshot { version: number; overlay: Overlay }

let db: DatabaseSync;
let clock = 1_000;
const builds: Overlay[] = [];
function build(overlay: Overlay, version: number): FakeSnapshot {
  builds.push(overlay);
  if ('pacing:bad' in overlay) throw new ConfigInvalidError([{ key: 'pacing:bad', message: '不行' }]);
  return { version, overlay };
}
function makeStore() {
  return new SqliteConfigStore<FakeSnapshot>({ db, build, logger: defaultLogger(), now: () => clock });
}

beforeEach(() => { db = openDatabase(':memory:', { busyTimeoutMs: 1000 }); builds.length = 0; clock = 1_000; });
afterEach(() => { if (db.isOpen) db.close(); });

describe('SqliteConfigStore', () => {
  it('starts at version 0 with an empty overlay', () => {
    const store = makeStore();
    expect(store.activeVersion()).toBe(0);
    expect(store.activeOverlay()).toEqual({});
    expect(store.snapshot()).toEqual({ version: 0, overlay: {} });
    expect(store.startupIssues).toEqual([]);
  });

  it('publishes, persists and reloads the active overlay', () => {
    const store = makeStore();
    clock = 2_000;
    const row = store.publish({ baseVersion: 0, changes: { 'pacing:restReminder.firstAfterMs': 5_400_000 }, actor: 'admin', note: '调休息提醒' });
    expect(row).toEqual({ id: 1, createdAt: 2_000, baseVersion: 0, kind: 'publish', note: '调休息提醒', actor: 'admin', overlay: { 'pacing:restReminder.firstAfterMs': 5_400_000 } });
    expect(store.snapshot()).toEqual({ version: 1, overlay: { 'pacing:restReminder.firstAfterMs': 5_400_000 } });
    const reloaded = makeStore();
    expect(reloaded.activeVersion()).toBe(1);
    expect(reloaded.snapshot().overlay).toEqual({ 'pacing:restReminder.firstAfterMs': 5_400_000 });
  });

  it('merges changes and removals onto the active overlay', () => {
    const store = makeStore();
    store.publish({ baseVersion: 0, changes: { 'memory:listMaxItems': 3, 'affect:enabled': false }, actor: 'admin' });
    store.publish({ baseVersion: 1, changes: { 'memory:listMaxItems': 4 }, removals: ['affect:enabled'], actor: 'admin' });
    expect(store.activeOverlay()).toEqual({ 'memory:listMaxItems': 4 });
  });

  it('rejects a stale baseVersion without building', () => {
    const store = makeStore();
    store.publish({ baseVersion: 0, changes: { 'memory:listMaxItems': 3 }, actor: 'admin' });
    builds.length = 0;
    expect(() => store.publish({ baseVersion: 0, changes: { 'memory:listMaxItems': 4 }, actor: 'admin' })).toThrow(ConfigConflictError);
    expect(builds).toEqual([]);
    try { store.preview({ baseVersion: 0, changes: {} }); } catch (error) { expect((error as ConfigConflictError).activeVersion).toBe(1); }
  });

  it('keeps the old snapshot when the build fails', () => {
    const store = makeStore();
    expect(() => store.publish({ baseVersion: 0, changes: { 'pacing:bad': 1 }, actor: 'admin' })).toThrow(ConfigInvalidError);
    expect(store.activeVersion()).toBe(0);
    expect(store.versions({ limit: 10 })).toEqual([]);
  });

  it('rejects unknown keys, bad values and empty publishes', () => {
    const store = makeStore();
    expect(() => store.publish({ baseVersion: 0, changes: { 'nope:x': 1 }, actor: 'admin' })).toThrow(ConfigInvalidError);
    expect(() => store.publish({ baseVersion: 0, changes: { 'memory:listMaxItems': { a: 1 } as never }, actor: 'admin' })).toThrow(ConfigInvalidError);
    try {
      store.publish({ baseVersion: 0, changes: {}, actor: 'admin' });
    } catch (error) {
      expect((error as ConfigInvalidError).issues).toEqual([{ key: null, message: '没有需要发布的改动。' }]);
    }
  });

  it('previews without persisting', () => {
    const store = makeStore();
    const result = store.preview({ baseVersion: 0, changes: { 'memory:listMaxItems': 3 } });
    expect(result.overlay).toEqual({ 'memory:listMaxItems': 3 });
    expect(store.activeVersion()).toBe(0);
  });

  it('rolls back by copying an older overlay into a new version', () => {
    const store = makeStore();
    store.publish({ baseVersion: 0, changes: { 'memory:listMaxItems': 3 }, actor: 'admin' });
    store.publish({ baseVersion: 1, changes: { 'memory:listMaxItems': 4 }, actor: 'admin' });
    const row = store.rollback({ toVersion: 1, baseVersion: 2, actor: 'admin' });
    expect(row.kind).toBe('rollback');
    expect(row.id).toBe(3);
    expect(row.note).toBe('回滚到版本 1');
    expect(store.activeOverlay()).toEqual({ 'memory:listMaxItems': 3 });
    expect(store.rollback({ toVersion: 0, baseVersion: 3, actor: 'admin' }).overlay).toEqual({});
    expect(() => store.rollback({ toVersion: 99, baseVersion: 4, actor: 'admin' })).toThrow(ConfigInvalidError);
  });

  it('resets one key or everything', () => {
    const store = makeStore();
    store.publish({ baseVersion: 0, changes: { 'memory:listMaxItems': 3, 'affect:enabled': false }, actor: 'admin' });
    expect(store.reset({ keys: ['affect:enabled'], baseVersion: 1, actor: 'admin' }).overlay).toEqual({ 'memory:listMaxItems': 3 });
    expect(store.reset({ keys: 'all', baseVersion: 2, actor: 'admin' }).overlay).toEqual({});
    expect(store.versions({ limit: 2 }).map((v) => v.kind)).toEqual(['reset', 'reset']);
    expect(store.versions({ limit: 10, before: 2 }).map((v) => v.id)).toEqual([1]);
  });

  it('falls back to the baseline when the stored overlay no longer builds', () => {
    const store = makeStore();
    store.publish({ baseVersion: 0, changes: { 'memory:listMaxItems': 3 }, actor: 'admin' });
    // Simulate a repo change that makes version 1 invalid.
    db.prepare("UPDATE config_versions SET overlay = ? WHERE id = 1").run(JSON.stringify({ 'pacing:bad': 1 }));
    const reloaded = makeStore();
    expect(reloaded.activeVersion()).toBe(0);
    expect(reloaded.snapshot()).toEqual({ version: 0, overlay: {} });
    expect(reloaded.startupIssues).toEqual([{ key: 'pacing:bad', message: '不行' }]);
  });

  it('fixedConfigSource always returns the same snapshot', () => {
    const snap = { version: 0, overlay: {} };
    expect(fixedConfigSource(snap).snapshot()).toBe(snap);
  });
});
```

- [x] **Step 3: 运行两个测试，确认失败**

Run: `npm test -w gateway -- test/config-snapshot.test.ts test/config-store.test.ts`
Expected: FAIL，报 `Failed to load url ../src/config-store/errors.ts` 和 `../src/session/configSnapshot.ts`。

- [x] **Step 4: 实现 `errors.ts`**

新建 `gateway/src/config-store/errors.ts`：

```ts
/** One reason a config change was refused. `message` is shown to the admin and never echoes config text. */
export interface ConfigIssue { key: string | null; message: string }

/** `cause` keeps the original loader error (a code, never config text) for startup crashes and tests. */
export class ConfigInvalidError extends Error {
  constructor(readonly issues: readonly ConfigIssue[], options?: { cause?: unknown }) {
    super('config_invalid', options);
  }
}

/** The draft was made against an older version; the admin must reload before changing again. */
export class ConfigConflictError extends Error {
  constructor(readonly activeVersion: number) {
    super('config_conflict');
  }
}
```

- [x] **Step 5: 实现 `materialize.ts`**

新建 `gateway/src/config-store/materialize.ts`：

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterId } from '@anyidea/protocol';
import { ConfigInvalidError } from './errors.ts';
import { parseOverlayKey, setJsonPath, targetFiles, type ModelDefaults, type Overlay, type OverlayValue } from './keys.ts';

/** Directories the loaders read. Everything else (mock audio, admin descriptors) is not copied. */
const TREE_DIRS = ['config', 'roles', 'characters'] as const;
const ENDPOINT_RULES: Record<string, { protocol: string; label: string }> = {
  realtimeEndpoint: { protocol: 'wss:', label: '「通话服务地址」必须以 wss:// 开头。' },
  textEndpoint: { protocol: 'https:', label: '「文本服务地址」必须以 https:// 开头。' },
};

export interface MaterializedTree { root: string; dispose(): void }

/** Copies the config tree into a private temp dir and writes the overlay into it. Caller must dispose(). */
export function materializeConfigTree(gatewayRoot: string, overlay: Overlay, tmpRoot = tmpdir()): MaterializedTree {
  const root = mkdtempSync(join(tmpRoot, 'avatar-config-'));
  const dispose = () => rmSync(root, { recursive: true, force: true });
  try {
    for (const dir of TREE_DIRS) cpSync(join(gatewayRoot, dir), join(root, dir), { recursive: true });
    const edits = new Map<string, Array<{ key: string; path: readonly string[]; value: OverlayValue }>>();
    for (const [key, value] of Object.entries(overlay)) {
      const target = parseOverlayKey(key);
      if (target.kind === 'text') {
        if (typeof value !== 'string') throw new Error(`overlay_value_invalid:${key}`);
        writeFileSync(join(root, target.file), `${value}\n`);
      } else if (target.kind === 'json') {
        for (const file of targetFiles(root, target)) {
          const list = edits.get(file) ?? [];
          list.push({ key, path: target.path, value });
          edits.set(file, list);
        }
      }
    }
    for (const [file, list] of edits) {
      const path = join(root, file);
      const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
      for (const edit of list) {
        try {
          setJsonPath(doc, edit.path, edit.value);
        } catch {
          throw new Error(`overlay_target_missing:${edit.key}`);
        }
      }
      writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
    }
    return { root, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

export interface VirtualSettings { disabledCharacters: ReadonlySet<CharacterId>; models: ModelDefaults }

/** Overlay keys that never touch a file: character switches and Qwen model settings. */
export function virtualSettings(overlay: Overlay, defaults: ModelDefaults): VirtualSettings {
  const disabled = new Set<CharacterId>();
  const models: ModelDefaults = { ...defaults };
  const issues: Array<{ key: string; message: string }> = [];
  for (const [key, value] of Object.entries(overlay)) {
    const target = parseOverlayKey(key);
    if (target.kind === 'characterEnabled') {
      if (typeof value !== 'boolean') issues.push({ key, message: '有一项配置的值类型不对。' });
      else if (!value) disabled.add(target.characterId);
    } else if (target.kind === 'model') {
      if (typeof value !== 'string' || !value.trim()) {
        issues.push({ key, message: '有一项配置的值类型不对。' });
        continue;
      }
      const rule = ENDPOINT_RULES[target.field];
      if (rule && !hasProtocol(value, rule.protocol)) issues.push({ key, message: rule.label });
      models[target.field] = value.trim();
    }
  }
  if (issues.length > 0) throw new ConfigInvalidError(issues);
  return { disabledCharacters: disabled, models };
}

function hasProtocol(value: string, protocol: string): boolean {
  try {
    return new URL(value).protocol === protocol;
  } catch {
    return false;
  }
}
```

- [x] **Step 6: 实现 `session/configSnapshot.ts`**

新建 `gateway/src/session/configSnapshot.ts`。启动校验的内容与 `gateway/src/index.ts` 第 33–77 行和第 137–139 行一致（角色卡、角色包语言完整性、pacing、memory、i18n、affect、各语言人设预算、affect 预算、记忆告知关键词、关怀超时），只是读的是临时目录：

```ts
import { CHARACTER_IDS, LANGUAGES, type CharacterId, type Language } from '@anyidea/protocol';
import { ZodError } from 'zod';
import { loadCharacterRegistry, type CharacterRegistry } from '../characters/registry.ts';
import { ConfigInvalidError, type ConfigIssue } from '../config-store/errors.ts';
import type { ModelDefaults, Overlay } from '../config-store/keys.ts';
import { materializeConfigTree, virtualSettings, type MaterializedTree, type VirtualSettings } from '../config-store/materialize.ts';
import { loadI18n } from '../i18n/load.ts';
import type { I18nBundle } from '../i18n/types.ts';
import { missingRoleLanguages } from '../roles/catalog.ts';
import { loadRoleCatalog, type FileRoleCatalog } from '../roles/fileCatalog.ts';
import { loadAffectConfig, type AffectConfig } from './affect.ts';
import { checkAffectBudgets } from './affectRender.ts';
import type { LedgerOptions } from './ledger.ts';
import { loadMemoryBudget, loadPacing, validateBudgets, type BudgetReport, type MemoryBudgetConfig, type PacingConfig } from './pacing.ts';

export interface ModelSettings extends ModelDefaults { extractModel: string }

/** Everything a new session reads from config. Immutable; a publish builds a new one. */
export interface ConfigSnapshot {
  version: number;
  pacing: PacingConfig;
  memory: MemoryBudgetConfig;
  affect: AffectConfig;
  i18n: I18nBundle;
  roles: FileRoleCatalog;
  characters: CharacterRegistry;
  budgets: BudgetReport;
  model: ModelSettings;
  disabledCharacters: ReadonlySet<CharacterId>;
}

export interface SnapshotInput {
  gatewayRoot: string;
  overlay: Overlay;
  version: number;
  ledger: LedgerOptions;
  sessionStartTimeoutMs: number;
  models: ModelDefaults;
  tmpRoot?: string;
}

/** Same checks as startup, run on baseline + overlay. Any failure is a ConfigInvalidError with Chinese messages. */
export function buildConfigSnapshot(input: SnapshotInput): ConfigSnapshot {
  let virtual: VirtualSettings;
  let tree: MaterializedTree;
  try {
    virtual = virtualSettings(input.overlay, input.models);
    const disabled = virtual.disabledCharacters;
    if (CHARACTER_IDS.every((id) => disabled.has(id))) throw new Error('all_characters_disabled');
    tree = materializeConfigTree(input.gatewayRoot, input.overlay, input.tmpRoot);
  } catch (error) {
    throw error instanceof ConfigInvalidError ? error : new ConfigInvalidError(explainBuildError(error), { cause: error });
  }
  try {
    const root = tree.root;
    const characters = loadCharacterRegistry(`${root}/characters`, LANGUAGES);
    const roles = loadRoleCatalog(`${root}/roles`, characters);
    for (const characterId of characters.ids()) {
      const roleId = characters.roleOf(characterId);
      const missing = missingRoleLanguages(roles, roleId, LANGUAGES);
      if (missing.length > 0) throw new Error(`role_languages_incomplete:${roleId}:${missing.join(',')}`);
    }
    const pacing = loadPacing(`${root}/config/pacing.json`);
    const memory = loadMemoryBudget(`${root}/config/memory.json`);
    const i18n = loadI18n(`${root}/config`);
    const affect = loadAffectConfig(`${root}/config/affect.json`);
    const personas: Partial<Record<Language, string[]>> = {};
    for (const pair of roles.characterLanguagePairs()) {
      (personas[pair.language] ??= []).push(roles.buildPersona(pair.characterId, pair.language));
    }
    const budgets = validateBudgets(pacing, memory, input.ledger, personas);
    checkAffectBudgets(budgets.budgets, i18n.affect);
    for (const pair of roles.characterLanguagePairs()) {
      const keywords = i18n.memory[pair.language].noticeKeywords;
      const text = roles.director(pair.characterId, pair.language).memoryNoticeText;
      if (!keywords.some((keyword) => text.includes(keyword))) throw new Error(`memory_notice_keyword_missing:${pair.characterId}:${pair.language}`);
    }
    if (affect.enabled && affect.care.timeoutMs >= input.sessionStartTimeoutMs) {
      throw new Error(`care_timeout_exceeds_session_start: ${affect.care.timeoutMs} >= ${input.sessionStartTimeoutMs}`);
    }
    return {
      version: input.version,
      pacing,
      memory,
      affect,
      i18n,
      roles,
      characters,
      budgets,
      model: { ...virtual.models, extractModel: memory.extractModel ?? 'qwen-plus' },
      disabledCharacters: virtual.disabledCharacters,
    };
  } catch (error) {
    throw new ConfigInvalidError(explainBuildError(error), { cause: error });
  } finally {
    tree.dispose();
  }
}

const CODE_MESSAGES: ReadonlyArray<[RegExp, string]> = [
  [/^instruction_budget_too_small/, '提示词太长了，留给聊天记录的空间不够。请缩短人设或性格描述，或调小「每次带进聊天的记忆有多长」。'],
  [/^affect_budget_too_small/, '情绪提示太长，放不进提示词。'],
  [/^persona_identity_missing/, '人设里少了 {{charIdentity}}（角色性格插入的位置），请加回去。'],
  [/^placeholder_unresolved/, '提示词里有无法识别的 {{…}} 占位符，请删掉。'],
  [/^memory_notice_keyword_missing/, '记忆告知的话缺少必须的关键词。'],
  [/^language_timing_mismatch/, '三种语言的等待时间必须一样。'],
  [/^character_first_meet_invalid/, '「第一次知道称呼时的开场白」每句都要有 {name}，并且不能太长。'],
  [/^character_foreign_name/, '角色的性格描述或开场白里出现了其他角色的名字。'],
  [/^character_card_invalid/, '角色设置的格式不对。'],
  [/^care_timeout_exceeds_session_start/, '关怀开场的等待时间超过了通话启动时间。'],
  [/^all_characters_disabled/, '至少要留一个角色开着。'],
  [/^overlay_key_invalid/, '有一项配置的名字无法识别'],
  [/^overlay_target_missing/, '有一项配置在当前版本的默认配置里已经不存在'],
  [/^overlay_value_invalid/, '有一项配置的值类型不对'],
];
const KEYED_CODES = new Set(['overlay_key_invalid', 'overlay_target_missing', 'overlay_value_invalid']);
const ZOD_MESSAGES: Readonly<Record<string, string>> = {
  'restReminder.everyMs must be >= firstAfterMs / 2': '「之后每隔多久再提醒」不能短于「连续聊多久提醒休息」的一半。',
  'revertAfterMs must exceed debounceMs': '「形象表情保持多久」太短了。',
};

/** Error -> admin-facing issues. Only codes and field paths are used; config text is never echoed. */
export function explainBuildError(error: unknown): ConfigIssue[] {
  if (error instanceof ConfigInvalidError) return [...error.issues];
  if (error instanceof ZodError) {
    return error.issues.map((issue) => ({
      key: null,
      message: ZOD_MESSAGES[issue.message] ?? `配置值超出允许范围（${issue.path.join('.')}）。`,
    }));
  }
  const code = error instanceof Error ? error.message : String(error);
  for (const [pattern, message] of CODE_MESSAGES) {
    if (!pattern.test(code)) continue;
    const name = code.split(':')[0]!;
    if (KEYED_CODES.has(name)) {
      const key = code.slice(name.length + 1);
      return [{ key, message: `${message}（${key}）。` }];
    }
    return [{ key: null, message }];
  }
  return [{ key: null, message: `配置检查没通过（${code.split(':')[0]}）。` }];
}
```

注意：`virtualSettings` 抛出的 `ConfigInvalidError` 已经带 key 和中文，原样上抛；`all_characters_disabled` 由上面的映射表翻译。

- [x] **Step 7: 运行快照测试**

Run: `npm test -w gateway -- test/config-snapshot.test.ts`
Expected: PASS。

如果「every numeric descriptor builds at its min and max」失败，报错里会写出 `key=值`：说明 P3-T1 的说明卡范围超出了 zod 或交叉校验。把那张说明卡的 `min`/`max` 收窄到能通过，同时确认基线值仍在范围内（P3-T1 的测试会再检查一遍），一并提交并在提交说明里写明。不要放宽 zod schema。

- [x] **Step 8: 实现 `store.ts`**

新建 `gateway/src/config-store/store.ts`：

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../log/logger.ts';
import { ConfigConflictError, ConfigInvalidError, type ConfigIssue } from './errors.ts';
import { isOverlayValue, parseOverlayKey, type Overlay, type OverlayValue } from './keys.ts';

export interface ConfigSource<S> { snapshot(): S }

export function fixedConfigSource<S>(snapshot: S): ConfigSource<S> {
  return { snapshot: () => snapshot };
}

export type ConfigVersionKind = 'publish' | 'rollback' | 'reset';
export interface ConfigVersionRow {
  id: number;
  createdAt: number;
  baseVersion: number | null;
  kind: ConfigVersionKind;
  note: string | null;
  actor: string;
  overlay: Overlay;
}
export interface ConfigDraft { baseVersion: number; changes: Overlay; removals?: readonly string[] }

interface Row { id: number; created_at: number; base_version: number | null; overlay: string; note: string | null; actor: string; kind: ConfigVersionKind }

const ACTIVE_KEY = 'active_config_version';

/** Versioned overlay over the repo baseline. This process is the only writer of config_versions. */
export class SqliteConfigStore<S> implements ConfigSource<S> {
  readonly startupIssues: readonly ConfigIssue[];
  private current: S;
  private active: number;
  private overlay: Overlay;
  private readonly db: DatabaseSync;
  private readonly build: (overlay: Overlay, version: number) => S;
  private readonly now: () => number;

  constructor(opts: { db: DatabaseSync; build: (overlay: Overlay, version: number) => S; logger: Logger; now?: () => number }) {
    this.db = opts.db;
    this.build = opts.build;
    this.now = opts.now ?? Date.now;
    const stored = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(ACTIVE_KEY) as { value: string } | undefined;
    const version = stored ? Number(stored.value) : 0;
    const overlay = version > 0 ? this.overlayOf(version) ?? {} : {};
    try {
      this.current = this.build(overlay, version);
      this.active = version;
      this.overlay = overlay;
      this.startupIssues = [];
    } catch (error) {
      if (!(error instanceof ConfigInvalidError)) throw error;
      // A repo update can invalidate a stored overlay. Serve the baseline; the admin page shows why.
      opts.logger.error('config_overlay_rejected', { version, issues: error.issues.length });
      this.current = this.build({}, 0);
      this.active = 0;
      this.overlay = {};
      this.startupIssues = error.issues;
    }
  }

  snapshot(): S { return this.current; }
  activeVersion(): number { return this.active; }
  activeOverlay(): Overlay { return this.overlay; }

  overlayOf(version: number): Overlay | null {
    if (version === 0) return {};
    const row = this.db.prepare('SELECT overlay FROM config_versions WHERE id = ?').get(version) as { overlay: string } | undefined;
    return row ? parseOverlay(row.overlay) : null;
  }

  preview(draft: ConfigDraft): { overlay: Overlay; snapshot: S } {
    this.checkBase(draft.baseVersion);
    const overlay = this.merge(draft);
    return { overlay, snapshot: this.build(overlay, this.active) };
  }

  publish(draft: ConfigDraft & { note?: string; actor: string }): ConfigVersionRow {
    this.checkBase(draft.baseVersion);
    const overlay = this.merge(draft);
    if (sameOverlay(overlay, this.overlay)) throw new ConfigInvalidError([{ key: null, message: '没有需要发布的改动。' }]);
    return this.commit(overlay, 'publish', draft.baseVersion, draft.note ?? null, draft.actor);
  }

  rollback(input: { toVersion: number; baseVersion: number; actor: string }): ConfigVersionRow {
    this.checkBase(input.baseVersion);
    const overlay = this.overlayOf(input.toVersion);
    if (!overlay) throw new ConfigInvalidError([{ key: null, message: `版本 ${input.toVersion} 不存在。` }]);
    return this.commit(overlay, 'rollback', input.baseVersion, `回滚到版本 ${input.toVersion}`, input.actor);
  }

  reset(input: { keys: readonly string[] | 'all'; baseVersion: number; actor: string }): ConfigVersionRow {
    this.checkBase(input.baseVersion);
    const overlay = input.keys === 'all' ? {} : this.merge({ baseVersion: input.baseVersion, changes: {}, removals: input.keys });
    const note = input.keys === 'all' ? '全部恢复默认' : `恢复默认 ${input.keys.length} 项`;
    return this.commit(overlay, 'reset', input.baseVersion, note, input.actor);
  }

  versions(input: { limit: number; before?: number }): ConfigVersionRow[] {
    const rows = this.db.prepare(
      'SELECT id, created_at, base_version, overlay, note, actor, kind FROM config_versions WHERE id < ? ORDER BY id DESC LIMIT ?',
    ).all(input.before ?? Number.MAX_SAFE_INTEGER, input.limit) as unknown as Row[];
    return rows.map(toVersionRow);
  }

  private checkBase(baseVersion: number): void {
    if (baseVersion !== this.active) throw new ConfigConflictError(this.active);
  }

  private merge(draft: ConfigDraft): Overlay {
    const next: Record<string, OverlayValue> = { ...this.overlay };
    const issues: ConfigIssue[] = [];
    for (const key of draft.removals ?? []) delete next[key];
    for (const [key, value] of Object.entries(draft.changes)) {
      try {
        parseOverlayKey(key);
      } catch {
        issues.push({ key, message: `有一项配置的名字无法识别（${key}）。` });
        continue;
      }
      if (!isOverlayValue(value)) {
        issues.push({ key, message: `有一项配置的值类型不对（${key}）。` });
        continue;
      }
      next[key] = Array.isArray(value) ? [...value] : value;
    }
    if (issues.length > 0) throw new ConfigInvalidError(issues);
    return next;
  }

  /** Builds first (slow, outside any transaction), then records the version and swaps the snapshot. */
  private commit(overlay: Overlay, kind: ConfigVersionKind, baseVersion: number, note: string | null, actor: string): ConfigVersionRow {
    const max = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM config_versions').get() as { id: number };
    const id = max.id + 1;
    const snapshot = this.build(overlay, id);
    const createdAt = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO config_versions (id, created_at, base_version, overlay, note, actor, kind) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, createdAt, baseVersion, JSON.stringify(overlay), note, actor, kind);
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(ACTIVE_KEY, String(id));
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    this.current = snapshot;
    this.active = id;
    this.overlay = overlay;
    return { id, createdAt, baseVersion, kind, note, actor, overlay };
  }
}

function parseOverlay(text: string): Overlay {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('config_overlay_corrupt');
  for (const entry of Object.values(value)) if (!isOverlayValue(entry)) throw new Error('config_overlay_corrupt');
  return value as Overlay;
}

function toVersionRow(row: Row): ConfigVersionRow {
  return { id: row.id, createdAt: row.created_at, baseVersion: row.base_version, kind: row.kind, note: row.note, actor: row.actor, overlay: parseOverlay(row.overlay) };
}

function sameOverlay(a: Overlay, b: Overlay): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}
```

- [x] **Step 9: 运行 store 测试和全量回归**

Run: `npm test -w gateway -- test/config-store.test.ts`
Expected: PASS。

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部 PASS，typecheck 无输出。

- [x] **Step 10: 提交**

```bash
git add gateway/src/config-store/errors.ts gateway/src/config-store/materialize.ts gateway/src/config-store/store.ts \
  gateway/src/session/configSnapshot.ts gateway/test/config-snapshot.test.ts gateway/test/config-store.test.ts
git commit -m "feat(config-store): versioned overlay and validated config snapshots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（若 Step 7 收窄了说明卡范围，同时 `git add` 对应的 `gateway/config/admin/descriptors/<scene>.json`。）
