import type { AdminConfigDraft, AdminConfigItem, AdminConfigValue } from '@anyidea/protocol';

export interface DraftEntry { value: AdminConfigValue; reset: boolean }
export type DraftMap = Readonly<Record<string, DraftEntry>>;

export function sameValue(a: AdminConfigValue, b: AdminConfigValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

function without(draft: DraftMap, key: string): DraftMap {
  const next = { ...draft };
  delete next[key];
  return next;
}

/** A value equal to the published one is not a change. */
export function setValue(draft: DraftMap, item: AdminConfigItem, value: AdminConfigValue): DraftMap {
  if (sameValue(value, item.current)) return without(draft, item.key);
  return { ...draft, [item.key]: { value, reset: false } };
}

/** Items changed in the admin go back to the repo default on publish; untouched defaults just drop the edit. */
export function resetToDefault(draft: DraftMap, item: AdminConfigItem): DraftMap {
  if (!item.changed) return without(draft, item.key);
  return { ...draft, [item.key]: { value: item.baseline, reset: true } };
}

export function effectiveValue(item: AdminConfigItem, draft: DraftMap): AdminConfigValue {
  return draft[item.key]?.value ?? item.current;
}

/** Request body for preview and publish (P3-T5 AdminConfigDraft). */
export function toDraft(draft: DraftMap, baseVersion: number): AdminConfigDraft {
  const entries = Object.entries(draft);
  return {
    baseVersion,
    changes: entries.filter(([, entry]) => !entry.reset).map(([key, entry]) => ({ key, value: entry.value })),
    resets: entries.filter(([, entry]) => entry.reset).map(([key]) => key),
  };
}
