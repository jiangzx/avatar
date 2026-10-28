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
