import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterId, Language } from '@anyidea/protocol';
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
    const voiceEdits: Array<{ key: string; model: string; character: CharacterId; language: Language; value: string }> = [];
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
      } else if (target.kind === 'voice') {
        if (typeof value !== 'string') throw new Error(`overlay_value_invalid:${key}`);
        voiceEdits.push({
          key, model: target.model, character: target.character, language: target.language, value,
        });
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
    if (voiceEdits.length > 0) {
      const file = join(root, 'config/realtime.json');
      const doc = JSON.parse(readFileSync(file, 'utf8')) as {
        models?: Record<string, { voices?: { byCharacter?: Record<string, Record<string, unknown>> } }>;
      };
      for (const edit of voiceEdits) {
        const node = doc.models?.[edit.model]?.voices?.byCharacter?.[edit.character];
        if (!node || !Object.hasOwn(node, edit.language)) throw new Error(`overlay_target_missing:${edit.key}`);
        node[edit.language] = edit.value;
      }
      writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
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
