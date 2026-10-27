// Shape-only helpers for the admin usage probe. Output never contains string content.

/** Dotted leaf paths: numbers keep their value, strings become `string(<length>)`, arrays show length + first element. */
export function leafShape(value: unknown, prefix = ''): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  walk(value, prefix, out);
  return out;
}

function walk(value: unknown, path: string, out: Record<string, number | string>): void {
  if (typeof value === 'number') { out[path] = value; return; }
  if (typeof value === 'string') { out[path] = `string(${[...value].length})`; return; }
  if (typeof value === 'boolean') { out[path] = 'boolean'; return; }
  if (value === null || value === undefined) { out[path] = 'null'; return; }
  if (Array.isArray(value)) {
    out[`${path}.length`] = value.length;
    if (value.length > 0) walk(value[0], `${path}[0]`, out);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) walk(child, path ? `${path}.${key}` : key, out);
  }
}

/** Paths of every object stored under a `usage` key, depth-first in key order. */
export function usagePaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (key === 'usage' && child && typeof child === 'object') found.push(path);
    found.push(...usagePaths(child, path));
  }
  return found;
}

const ID_KEY = /(^|_)(id|request_?id|trace_?id)$/i;

/** Paths of id-like keys holding a non-empty string. Values are never returned. */
export function idLikePaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (ID_KEY.test(key) && typeof child === 'string' && child.length > 0) found.push(path);
    found.push(...idLikePaths(child, path));
  }
  return found;
}

const ID_HEADER = /(request|trace)/i;

/** Lower-cased header names that look like upstream request or trace ids. */
export function idLikeHeaderNames(names: Iterable<string>): string[] {
  return [...names].map((name) => name.toLowerCase()).filter((name) => ID_HEADER.test(name));
}

/** Official rule: partial seconds count as a full second. */
export function expectedAudioTokens(seconds: number, perSecond: number): number {
  return Math.ceil(Math.ceil(seconds) * perSecond);
}
