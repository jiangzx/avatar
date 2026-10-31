import { readFileSync } from 'node:fs';
import { CHARACTER_IDS, LANGUAGES, type CharacterId, type Language } from '@anyidea/protocol';
import { z } from 'zod';

export const TURN_DETECTION_TYPES = ['semantic_vad', 'server_vad', 'smart_turn', 'smart_turn_v2'] as const;
export type TurnDetectionType = (typeof TURN_DETECTION_TYPES)[number];

export interface TurnDetection { type: TurnDetectionType; silenceDurationMs?: number }
export interface SpeechRateConfig { min: number; max: number; default: number; low: number }
export interface VoiceOption { value: string; label: string }

export interface RealtimeModel {
  id: string;
  label: string;
  turnDetection: TurnDetection;
  speechRate: SpeechRateConfig | null;
  voiceUpdate: 'live' | 'connect_only';
  voices: {
    catalog: Record<Language, VoiceOption[]>;
    byCharacter: Record<CharacterId, Record<Language, string>>;
  };
}

export interface RealtimeRegistry {
  models: Record<string, RealtimeModel>;
  ids: string[];
  defaultModel: string;
  get(id: string): RealtimeModel;
}

/** The selected model's capability plus its fully resolved voices for one session. */
export interface RealtimeConfig {
  model: string;
  turnDetection: TurnDetection;
  speechRate: SpeechRateConfig | null;
  voiceUpdate: 'live' | 'connect_only';
  voices: Record<CharacterId, Record<Language, string>>;
}

const ModelId = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/);
const VoiceOptionSchema = z.object({ value: z.string().min(1).max(64), label: z.string().min(1).max(40) }).strict();
const CatalogSchema = z.object({
  zh: z.array(VoiceOptionSchema).min(1),
  ja: z.array(VoiceOptionSchema).min(1),
  en: z.array(VoiceOptionSchema).min(1),
}).strict();
const ByLanguageVoiceSchema = z.object({
  zh: z.string().min(1),
  ja: z.string().min(1),
  en: z.string().min(1),
}).strict();
const SpeechRateSchema = z.object({
  min: z.number().min(0.5).max(2),
  max: z.number().min(0.5).max(2),
  default: z.number().min(0.5).max(2),
  low: z.number().min(0.5).max(2),
}).strict();
const TurnDetectionSchema = z.object({
  type: z.enum(TURN_DETECTION_TYPES),
  silenceDurationMs: z.number().int().positive().optional(),
}).strict();
const ModelSchema = z.object({
  label: z.string().min(1).max(40),
  turnDetection: TurnDetectionSchema,
  speechRate: SpeechRateSchema.nullable(),
  voiceUpdate: z.enum(['live', 'connect_only']),
  voices: z.object({
    catalog: CatalogSchema,
    byCharacter: z.record(z.enum(CHARACTER_IDS), ByLanguageVoiceSchema),
  }).strict(),
}).strict();
const RegistrySchema = z.object({ models: z.record(ModelId, ModelSchema) }).strict();

type ParsedModel = z.infer<typeof ModelSchema>;

/** Loads and cross-checks the realtime registry. Throws on the first invalid model. */
export function loadRealtimeRegistry(path: string, opts: { defaultModel?: string } = {}): RealtimeRegistry {
  const parsed = RegistrySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const models: Record<string, RealtimeModel> = {};
  for (const [id, model] of Object.entries(parsed.models)) {
    validateModel(id, model);
    models[id] = { ...model, id };
  }
  const ids = Object.keys(models);
  if (ids.length === 0) throw new Error('realtime_models_empty');
  if (opts.defaultModel !== undefined && !models[opts.defaultModel]) {
    throw new Error(`realtime_model_unknown:${opts.defaultModel}`);
  }
  return {
    models,
    ids,
    defaultModel: opts.defaultModel ?? ids[0]!,
    get(id) {
      const model = models[id];
      if (!model) throw new Error(`realtime_model_unknown:${id}`);
      return model;
    },
  };
}

function validateModel(id: string, model: ParsedModel): void {
  if (model.speechRate) {
    const r = model.speechRate;
    if (!(r.min <= r.low && r.low <= r.default && r.default <= r.max)) {
      throw new Error(`realtime_speech_rate_invalid:${id}`);
    }
  }
  for (const language of LANGUAGES) {
    const values = model.voices.catalog[language].map((option) => option.value);
    if (new Set(values).size !== values.length) throw new Error(`realtime_catalog_duplicate:${id}:${language}`);
    for (const characterId of CHARACTER_IDS) {
      const voice = model.voices.byCharacter[characterId]?.[language];
      if (!voice) throw new Error(`realtime_voice_missing:${id}:${characterId}:${language}`);
      if (!values.includes(voice)) throw new Error(`realtime_voice_invalid:${id}:${characterId}:${language}`);
    }
  }
}

export function voiceFor(model: RealtimeModel, characterId: CharacterId, language: Language): string {
  const voice = model.voices.byCharacter[characterId]?.[language];
  if (!voice) throw new Error(`realtime_voice_missing:${model.id}:${characterId}:${language}`);
  return voice;
}

/** Model ids that have no price entry; the startup check refuses to serve an unpriced realtime model. */
export function missingRealtimePrices(registry: RealtimeRegistry, pricedModels: ReadonlySet<string>): string[] {
  return registry.ids.filter((id) => !pricedModels.has(id));
}
