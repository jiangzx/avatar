import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CharacterId, Language } from '@anyidea/protocol';

export const SCENE_IDS = ['pacing', 'affect', 'proactivity', 'memory', 'characters', 'copy', 'model'] as const;
export type SceneId = (typeof SCENE_IDS)[number];

const PerLanguageInt = z.object({
  zh: z.number().int().positive(),
  ja: z.number().int().positive(),
  en: z.number().int().positive(),
}).strict();

export const DescriptorItemSchema = z.object({
  /** Template; `{lang}` and `{char}` expand to concrete overlay keys. */
  key: z.string().min(3).max(120),
  label: z.string().min(2).max(24),
  /** What the elder notices, in plain words. */
  purpose: z.string().min(4).max(90),
  impact: z.object({
    characters: z.enum(['all', 'each']),
    stage: z.string().min(2).max(12),
    effective: z.literal('next_session'),
  }).strict(),
  control: z.enum(['number', 'switch', 'text', 'textarea', 'list', 'select']),
  unit: z.enum(['second', 'minute', 'day', 'count', 'char', 'level']).optional(),
  storageUnit: z.enum(['ms', 'day', 'count', 'char', 'level']).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  maxChars: PerLanguageInt.optional(),
  minItems: z.number().int().min(0).max(50).optional(),
  maxItems: z.number().int().min(1).max(50).optional(),
  itemMaxChars: PerLanguageInt.optional(),
  /** Literal tokens every text (or every list item) must keep, e.g. "{name}". */
  requiredTokens: z.array(z.string().min(1)).optional(),
  /** 'auto': keep every placeholder found in the baseline text and allow no new one. */
  placeholders: z.literal('auto').optional(),
  /** Path into qwen-options.json: realtimeModels | textModels | voices.{lang}. */
  options: z.string().optional(),
  pattern: z.enum(['wss_url', 'https_url']).optional(),
  rule: z.enum(['checkin']).optional(),
  complianceNote: z.string().max(90).nullable(),
  risk: z.enum(['low', 'medium', 'high']),
  riskNote: z.string().max(90).nullable(),
}).strict().superRefine((item, ctx) => {
  const need = (ok: boolean, message: string) => { if (!ok) ctx.addIssue({ code: 'custom', message: `${item.key}: ${message}` }); };
  if (item.control === 'number') need(item.unit !== undefined && item.storageUnit !== undefined && item.min !== undefined && item.max !== undefined && item.step !== undefined, 'number needs unit, storageUnit, min, max, step');
  if (item.control === 'text' || item.control === 'textarea') need(item.maxChars !== undefined, 'text needs maxChars');
  if (item.control === 'list') need(item.maxItems !== undefined && item.itemMaxChars !== undefined, 'list needs maxItems and itemMaxChars');
  if (item.control === 'select') need(item.options !== undefined, 'select needs options');
  if (item.risk === 'high') need(item.riskNote !== null, 'high risk needs riskNote');
  need(item.key.includes('{char}') === (item.impact.characters === 'each'), '{char} keys must use impact.characters=each');
});

export type DescriptorItem = z.infer<typeof DescriptorItemSchema>;

const ReadonlySchema = z.object({ label: z.string().min(2).max(30), purpose: z.string().min(4).max(90), note: z.string().min(2).max(120) }).strict();

const SceneFileSchema = z.object({
  scene: z.enum(SCENE_IDS),
  title: z.string().min(2).max(12),
  intro: z.string().min(4).max(80),
  order: z.number().int().min(1).max(20),
  items: z.array(DescriptorItemSchema).min(1),
  readonly: z.array(ReadonlySchema),
}).strict();

export interface ConcreteItem extends DescriptorItem {
  descriptorKey: string;
  scene: SceneId;
  language: Language | null;
  character: CharacterId | null;
}
export interface ReadonlyNote { label: string; purpose: string; note: string }
export interface SceneDescriptor {
  id: SceneId;
  title: string;
  intro: string;
  order: number;
  items: readonly ConcreteItem[];
  readonly: readonly ReadonlyNote[];
}
export interface DescriptorCatalog {
  scenes(): readonly SceneDescriptor[];
  scene(id: SceneId): SceneDescriptor;
  find(key: string): ConcreteItem | undefined;
  all(): readonly ConcreteItem[];
}

/** Loads gateway/config/admin/descriptors/*.json. Anything without a card is not editable from the admin. */
export function loadDescriptorCatalog(
  dir: string,
  opts: { languages: readonly Language[]; characters: readonly CharacterId[] },
): DescriptorCatalog {
  const scenes: SceneDescriptor[] = [];
  const byKey = new Map<string, ConcreteItem>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const parsed = SceneFileSchema.parse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    if (file !== `${parsed.scene}.json`) throw new Error(`descriptor_scene_mismatch:${file}`);
    const items: ConcreteItem[] = [];
    for (const item of parsed.items) {
      const languages: Array<Language | null> = item.key.includes('{lang}') ? [...opts.languages] : [null];
      const characters: Array<CharacterId | null> = item.key.includes('{char}') ? [...opts.characters] : [null];
      for (const character of characters) {
        for (const language of languages) {
          let key = item.key;
          if (language) key = key.replaceAll('{lang}', language);
          if (character) key = key.replaceAll('{char}', character);
          if (byKey.has(key)) throw new Error(`descriptor_key_duplicate:${key}`);
          const concrete: ConcreteItem = { ...item, key, descriptorKey: item.key, scene: parsed.scene, language, character };
          byKey.set(key, concrete);
          items.push(concrete);
        }
      }
    }
    scenes.push({ id: parsed.scene, title: parsed.title, intro: parsed.intro, order: parsed.order, items, readonly: parsed.readonly });
  }
  scenes.sort((a, b) => a.order - b.order);
  const ids = scenes.map((scene) => scene.id);
  if (ids.length !== SCENE_IDS.length || SCENE_IDS.some((id) => !ids.includes(id))) throw new Error(`descriptor_scene_set_mismatch:${ids.join(',')}`);
  return {
    scenes: () => scenes,
    scene: (id) => {
      const scene = scenes.find((candidate) => candidate.id === id);
      if (!scene) throw new Error(`descriptor_scene_unknown:${id}`);
      return scene;
    },
    find: (key) => byKey.get(key),
    all: () => [...byKey.values()],
  };
}

/** `{{x}}` and `{x}` placeholders, first-seen order, each once. */
export function extractPlaceholders(text: string): string[] {
  return [...new Set(text.match(/\{\{[A-Za-z]+\}\}|\{[A-Za-z]+\}/g) ?? [])];
}
