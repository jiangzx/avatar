import { CHARACTER_IDS, LANGUAGES, type CharacterId, type Language } from '@anyidea/protocol';
import { ZodError } from 'zod';
import { loadCharacterRegistry, type CharacterRegistry } from '../characters/registry.ts';
import { ConfigInvalidError, type ConfigIssue } from '../config-store/errors.ts';
import type { ModelDefaults, Overlay } from '../config-store/keys.ts';
import { materializeConfigTree, virtualSettings, type MaterializedTree, type VirtualSettings } from '../config-store/materialize.ts';
import { loadI18n } from '../i18n/load.ts';
import type { I18nBundle } from '../i18n/types.ts';
import { missingRoleLanguages } from '../roles/catalog.ts';
import { loadRoleCatalog, type FileRoleCatalog } from '../roles/fileCatalog.ts';
import { loadAffectConfig, type AffectConfig } from './affect.ts';
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
  i18n: I18nBundle;
  roles: FileRoleCatalog;
  characters: CharacterRegistry;
  budgets: BudgetReport;
  model: ModelSettings;
  disabledCharacters: ReadonlySet<CharacterId>;
}

export interface SnapshotInput {
  gatewayRoot: string;
  overlay: Overlay;
  version: number;
  ledger: LedgerOptions;
  sessionStartTimeoutMs: number;
  models: ModelDefaults;
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
    const personas: Partial<Record<Language, string[]>> = {};
    for (const pair of roles.characterLanguagePairs()) {
      (personas[pair.language] ??= []).push(roles.buildPersona(pair.characterId, pair.language));
    }
    const budgets = validateBudgets(pacing, memory, input.ledger, personas);
    checkAffectBudgets(budgets.budgets, i18n.affect);
    for (const pair of roles.characterLanguagePairs()) {
      const keywords = i18n.memory[pair.language].noticeKeywords;
      const text = roles.director(pair.characterId, pair.language).memoryNoticeText;
      if (!keywords.some((keyword) => text.includes(keyword))) throw new Error(`memory_notice_keyword_missing:${pair.characterId}:${pair.language}`);
    }
    if (affect.enabled && affect.care.timeoutMs >= input.sessionStartTimeoutMs) {
      throw new Error(`care_timeout_exceeds_session_start: ${affect.care.timeoutMs} >= ${input.sessionStartTimeoutMs}`);
    }
    return {
      version: input.version,
      pacing,
      memory,
      affect,
      i18n,
      roles,
      characters,
      budgets,
      model: { ...virtual.models, extractModel: memory.extractModel ?? 'qwen-plus' },
      disabledCharacters: virtual.disabledCharacters,
    };
  } catch (error) {
    throw new ConfigInvalidError(explainBuildError(error), { cause: error });
  } finally {
    tree.dispose();
  }
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
  [/^care_timeout_exceeds_session_start/, '关怀开场的等待时间超过了通话启动时间。'],
  [/^all_characters_disabled/, '至少要留一个角色开着。'],
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
