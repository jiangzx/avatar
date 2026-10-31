import { CHARACTER_IDS, LANGUAGES, type CharacterId, type Language } from '@anyidea/protocol';
import { ZodError } from 'zod';
import { loadCharacterRegistry, type CharacterRegistry } from '../characters/registry.ts';
import { ConfigInvalidError, type ConfigIssue } from '../config-store/errors.ts';
import type { ModelDefaults, Overlay } from '../config-store/keys.ts';
import { materializeConfigTree, virtualSettings, type MaterializedTree, type VirtualSettings } from '../config-store/materialize.ts';
import { loadI18n } from '../i18n/load.ts';
import type { I18nBundle } from '../i18n/types.ts';
import { loadRealtimeRegistry, type RealtimeConfig, type RealtimeModel } from '../realtime/models.ts';
import { missingRoleLanguages } from '../roles/catalog.ts';
import { loadRoleCatalog, type FileRoleCatalog } from '../roles/fileCatalog.ts';
import { loadAffectConfig, type AffectConfig } from './affect.ts';
import { loadProactivity, type ProactivityConfig } from './proactive/config.ts';
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
  proactivity: ProactivityConfig;
  i18n: I18nBundle;
  roles: FileRoleCatalog;
  characters: CharacterRegistry;
  budgets: BudgetReport;
  model: ModelSettings;
  realtime: RealtimeConfig;
  disabledCharacters: ReadonlySet<CharacterId>;
}

export interface SnapshotInput {
  gatewayRoot: string;
  overlay: Overlay;
  version: number;
  ledger: LedgerOptions;
  sessionStartTimeoutMs: number;
  models: ModelDefaults;
  voiceDefaults: Record<Language, string>;
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
    const proactivity = loadProactivity(`${root}/config/proactivity.json`);
    const personas: Partial<Record<Language, string[]>> = {};
    for (const pair of roles.characterLanguagePairs()) {
      const persona = roles.buildPersona(pair.characterId, pair.language);
      // The longest familiarity tone rides on the persona at run time; budget for it here.
      const tones = roles.director(pair.characterId, pair.language).familiarityTones;
      const tone = tones ? [tones.new, tones.familiar, tones.oldFriend].reduce((a, b) => (b.length > a.length ? b : a)) : '';
      (personas[pair.language] ??= []).push(tone ? `${persona}\n\n${tone}` : persona);
    }
    const budgets = validateBudgets(pacing, memory, input.ledger, personas);
    checkAffectBudgets(budgets.budgets, i18n.affect);
    for (const pair of roles.characterLanguagePairs()) {
      const keywords = i18n.memory[pair.language].noticeKeywords;
      const text = roles.director(pair.characterId, pair.language).memoryNoticeText;
      if (!keywords.some((keyword) => text.includes(keyword))) throw new Error(`memory_notice_keyword_missing:${pair.characterId}:${pair.language}`);
    }
    // A fallback that waits longer than the shortest silence step would land on top of the next step.
    for (const pair of roles.characterLanguagePairs()) {
      const d = roles.director(pair.characterId, pair.language);
      const steps = [d.contextAfterMs, d.checkAfterMs, d.leaveAfterMs, d.checkinAfterMs].filter((v): v is number => v !== undefined);
      const shortest = Math.min(...steps);
      if (steps.length > 0 && proactivity.fallbackAfterMs > shortest) {
        throw new Error(`proactive_fallback_exceeds_silence: ${proactivity.fallbackAfterMs} > ${shortest}`);
      }
    }
    const registry = loadRealtimeRegistry(`${root}/config/realtime.json`, { defaultModel: input.models.realtimeModel });
    const activeId = virtual.models.realtimeModel;
    const active = registry.get(activeId);
    const realtime: RealtimeConfig = {
      model: activeId,
      turnDetection: active.turnDetection,
      speechRate: active.speechRate,
      voiceUpdate: active.voiceUpdate,
      voices: resolveVoices(active, input, characters, registry.defaultModel),
    };
    return {
      version: input.version,
      pacing,
      memory,
      affect,
      proactivity,
      i18n,
      roles,
      characters,
      budgets,
      model: { ...virtual.models, extractModel: memory.extractModel ?? 'qwen-plus' },
      realtime,
      disabledCharacters: virtual.disabledCharacters,
    };
  } catch (error) {
    throw new ConfigInvalidError(explainBuildError(error), { cause: error });
  } finally {
    tree.dispose();
  }
}

/** New voice overlay wins; the old character-card overlay stays effective only on the env default model. */
function resolveVoices(
  model: RealtimeModel,
  input: SnapshotInput,
  characters: CharacterRegistry,
  defaultModel: string,
): Record<CharacterId, Record<Language, string>> {
  const out = {} as Record<CharacterId, Record<Language, string>>;
  for (const characterId of CHARACTER_IDS) {
    out[characterId] = {} as Record<Language, string>;
    for (const language of LANGUAGES) {
      const newKey = `voice:${model.id}/${characterId}.${language}`;
      const oldKey = `character:${characterId}.voices.qwen.${language}`;
      const cardVoice = characters.voiceFor(characterId, 'qwen', language);
      const baseline = model.voices.byCharacter[characterId]?.[language];
      const useOld = !Object.hasOwn(input.overlay, newKey)
        && model.id === defaultModel
        && Object.hasOwn(input.overlay, oldKey)
        && cardVoice !== undefined;
      out[characterId][language] = useOld
        ? cardVoice!
        : baseline ?? cardVoice ?? input.voiceDefaults[language];
    }
  }
  return out;
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
  [/^proactive_fallback_exceeds_silence/, '主动开口的兜底等待时间比最短的沉默等待还长，请调短兜底等待或调长沉默等待。'],
  [/^all_characters_disabled/, '至少要留一个角色开着。'],
  [/^realtime_model_unknown/, '后台选择的通话模型不存在，请重新选择。'],
  [/^realtime_voice_invalid/, '角色音色不属于当前模型的音色列表。'],
  [/^realtime_voice_missing/, '当前模型缺少某个角色的音色配置。'],
  [/^realtime_speech_rate_invalid/, '语速配置超出允许范围。'],
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
