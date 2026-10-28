import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Language } from '@anyidea/protocol';

const OptionSchema = z.object({ value: z.string().min(1).max(64), label: z.string().min(1).max(30) }).strict();
const OptionList = z.array(OptionSchema).min(1);
const QwenOptionsSchema = z.object({
  realtimeModels: OptionList,
  textModels: OptionList,
  voices: z.object({ zh: OptionList, ja: OptionList, en: OptionList }).strict(),
}).strict();

export interface QwenOption { value: string; label: string }
export interface QwenOptions { realtimeModels: QwenOption[]; textModels: QwenOption[]; voices: Record<Language, QwenOption[]> }

export function loadQwenOptions(path: string): QwenOptions {
  return QwenOptionsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** ref: realtimeModels | textModels | voices.{lang} (resolved with the item's language). */
export function optionsFor(options: QwenOptions, ref: string, language: Language | null): readonly QwenOption[] {
  if (ref === 'realtimeModels') return options.realtimeModels;
  if (ref === 'textModels') return options.textModels;
  if (ref === 'voices.{lang}' && language) return options.voices[language];
  throw new Error(`descriptor_options_unknown:${ref}`);
}
