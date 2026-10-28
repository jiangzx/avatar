import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHARACTER_IDS, type CharacterId, type Language } from '@anyidea/protocol';

/** Values an admin may store. Arrays are string lists only. */
export type OverlayValue = number | boolean | string | readonly string[];
/** Concrete overlay key -> stored (file-unit) value. */
export type Overlay = Readonly<Record<string, OverlayValue>>;

export const MODEL_FIELDS = ['realtimeEndpoint', 'realtimeModel', 'textEndpoint', 'summarizerModel'] as const;
export type ModelField = (typeof MODEL_FIELDS)[number];
/** Model settings from env (GatewayConfig); overlay `model:qwen.*` keys replace them. */
export type ModelDefaults = Record<ModelField, string>;

/** Where one overlay key lands. Files are relative to the gateway root. */
export type OverlayTarget =
  | { kind: 'json'; file: string; path: readonly string[] }
  | { kind: 'text'; file: string }
  | { kind: 'characterEnabled'; characterId: CharacterId }
  | { kind: 'model'; field: ModelField };

const CONFIG_FILES = {
  pacing: 'config/pacing.json',
  memory: 'config/memory.json',
  affect: 'config/affect.json',
  emotion: 'config/emotion.json',
} as const;
const SEGMENT = /^(?:[A-Za-z][A-Za-z0-9]*|\d+)$/;
const FORBIDDEN_SEGMENTS = new Set(['constructor', 'prototype', '__proto__']);

export function parseOverlayKey(key: string): OverlayTarget {
  const fail = (): never => { throw new Error(`overlay_key_invalid:${key}`); };
  const colon = key.indexOf(':');
  if (colon <= 0) return fail();
  const domain = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  const jsonPath = (text: string): string[] => {
    const parts = text.split('.');
    if (parts.some((part) => !SEGMENT.test(part) || FORBIDDEN_SEGMENTS.has(part))) fail();
    return parts;
  };
  switch (domain) {
    case 'pacing':
    case 'memory':
    case 'affect':
    case 'emotion':
      if (!rest) return fail();
      return { kind: 'json', file: CONFIG_FILES[domain], path: jsonPath(rest) };
    case 'i18n': {
      const match = /^(zh|ja|en)\/([a-z]+)\.(.+)$/.exec(rest);
      if (!match) return fail();
      return { kind: 'json', file: `config/i18n/${match[1]}/${match[2]}.json`, path: jsonPath(match[3]!) };
    }
    case 'role': {
      const match = /^([a-z][a-z0-9-]{0,39})\/(zh|ja|en|\*)\/(persona|director)(?:\.(.+))?$/.exec(rest);
      if (!match) return fail();
      const [, roleId, language, file, path] = match;
      if (file === 'persona') {
        if (path !== undefined || language === '*') return fail();
        return { kind: 'text', file: `roles/${roleId}/${language}/persona.md` };
      }
      if (path === undefined) return fail();
      return { kind: 'json', file: `roles/${roleId}/${language}/director.json`, path: jsonPath(path) };
    }
    case 'character': {
      const match = /^([a-z]+)\.(.+)$/.exec(rest);
      if (!match || !(CHARACTER_IDS as readonly string[]).includes(match[1]!)) return fail();
      const characterId = match[1] as CharacterId;
      if (match[2] === 'enabled') return { kind: 'characterEnabled', characterId };
      return { kind: 'json', file: `characters/${characterId}.json`, path: jsonPath(match[2]!) };
    }
    case 'model': {
      const match = /^qwen\.([A-Za-z]+)$/.exec(rest);
      if (!match || !(MODEL_FIELDS as readonly string[]).includes(match[1]!)) return fail();
      return { kind: 'model', field: match[1] as ModelField };
    }
    default:
      return fail();
  }
}

/** Files one target writes. A wildcard language segment expands to every language in that role's role.json. */
export function targetFiles(root: string, target: { file: string }): string[] {
  if (!target.file.includes('/*/')) return [target.file];
  const roleId = target.file.split('/')[1]!;
  const role = JSON.parse(readFileSync(join(root, 'roles', roleId, 'role.json'), 'utf8')) as { supportedLanguages: Language[] };
  return role.supportedLanguages.map((language) => target.file.replace('/*/', `/${language}/`));
}

export function getJsonPath(value: unknown, path: readonly string[]): unknown {
  let node: unknown = value;
  for (const segment of path) {
    if (Array.isArray(node) && /^\d+$/.test(segment)) node = node[Number(segment)];
    else if (node !== null && typeof node === 'object' && !Array.isArray(node) && Object.hasOwn(node, segment)) node = (node as Record<string, unknown>)[segment];
    else return undefined;
  }
  return node;
}

/** Replaces an existing value. A path the baseline does not have is an error, never a new key. */
export function setJsonPath(value: unknown, path: readonly string[], next: OverlayValue): void {
  const parent = getJsonPath(value, path.slice(0, -1));
  const last = path[path.length - 1]!;
  if (getJsonPath(value, path) === undefined || parent === null || typeof parent !== 'object') {
    throw new Error(`overlay_target_missing:${path.join('.')}`);
  }
  const copy = Array.isArray(next) ? [...next] : next;
  if (Array.isArray(parent)) parent[Number(last)] = copy;
  else (parent as Record<string, unknown>)[last] = copy;
}

export function isOverlayValue(value: unknown): value is OverlayValue {
  return typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string'
    || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

/** Current file value of a target. For a `*` target the first language is read (validateTimings keeps them equal). */
export function readTargetValue(root: string, target: OverlayTarget, models: ModelDefaults): OverlayValue {
  switch (target.kind) {
    case 'characterEnabled':
      return true;
    case 'model':
      return models[target.field];
    case 'text':
      return readFileSync(join(root, target.file), 'utf8').trim();
    case 'json': {
      const file = targetFiles(root, target)[0]!;
      const value = getJsonPath(JSON.parse(readFileSync(join(root, file), 'utf8')), target.path);
      if (!isOverlayValue(value)) throw new Error(`overlay_target_missing:${file}:${target.path.join('.')}`);
      return value;
    }
  }
}
