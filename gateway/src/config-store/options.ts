import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Language } from '@anyidea/protocol';
import { loadRealtimeRegistry } from '../realtime/models.ts';

const OptionSchema = z.object({ value: z.string().min(1).max(64), label: z.string().min(1).max(40) }).strict();
const OptionList = z.array(OptionSchema).min(1);
const TextOptionsSchema = z.object({ textModels: OptionList }).strict();

export interface QwenOption { value: string; label: string }
export interface QwenOptions {
  realtimeModels: QwenOption[];
  textModels: QwenOption[];
  voices: Record<string, Record<Language, QwenOption[]>>;
}

/** Realtime models and their voice catalogs come from realtime.json; only text models stay in qwen-options.json. */
export function loadAdminOptions(gatewayRoot: string): QwenOptions {
  const text = TextOptionsSchema.parse(JSON.parse(readFileSync(join(gatewayRoot, 'config/admin/qwen-options.json'), 'utf8')));
  const registry = loadRealtimeRegistry(join(gatewayRoot, 'config/realtime.json'));
  const voices: QwenOptions['voices'] = {};
  for (const id of registry.ids) {
    const model = registry.get(id);
    voices[id] = { zh: model.voices.catalog.zh, ja: model.voices.catalog.ja, en: model.voices.catalog.en };
  }
  return {
    realtimeModels: registry.ids.map((id) => ({ value: id, label: registry.get(id).label })),
    textModels: text.textModels,
    voices,
  };
}

/** ref: realtimeModels | textModels | voices.{lang} (resolved with the item's language and model). */
export function optionsFor(
  options: QwenOptions,
  ref: string,
  language: Language | null,
  model: string | null = null,
): readonly QwenOption[] {
  if (ref === 'realtimeModels') return options.realtimeModels;
  if (ref === 'textModels') return options.textModels;
  if (ref === 'voices.{lang}' && language && model) return options.voices[model]?.[language] ?? [];
  throw new Error(`descriptor_options_unknown:${ref}`);
}
