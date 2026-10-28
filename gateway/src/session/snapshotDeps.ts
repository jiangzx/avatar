import { LANGUAGES, type CharacterId, type Language } from '@anyidea/protocol';
import type { ConfigSource } from '../config-store/store.ts';
import { defaultLogger } from '../log/logger.ts';
import { ownerShortId } from '../log/ownerId.ts';
import type { TextModelClient } from '../memory/textClient.ts';
import type { ConfigSnapshot } from './configSnapshot.ts';
import type { SessionContext } from './context.ts';
import { Session, type SessionDeps } from './session.ts';

/** SessionDeps fields that come from the config snapshot. Every other field passes through from the runtime. */
export type SnapshotSessionKey = 'adapterFactory' | 'summarizer' | 'roles' | 'characters' | 'textClient' | 'voiceFor'
  | 'budget' | 'budgets' | 'i18n' | 'recallClipChars' | 'recallPhraseTimeoutMs' | 'noticeKeywordsByLanguage'
  | 'modelContextTokenLimit' | 'rebuildTriggerRatio' | 'rebuildAfterTurns' | 'summarizePolicy' | 'maxOutputTokens'
  | 'tailGuardMs' | 'slim' | 'push' | 'restReminder' | 'toolTurnTimeoutMs' | 'pin' | 'listMaxItems' | 'emotion'
  | 'affect' | 'languageRules' | 'extractEveryUserTurns' | 'extractSilenceMs';

export type SessionRuntimeDeps = Omit<SessionDeps, SnapshotSessionKey>;

/** How index.ts turns a snapshot into model clients. Env decides the adapter kind; the snapshot decides the settings. */
export interface SnapshotFactories {
  apiKey(): string | undefined;
  adapter(input: { snapshot: ConfigSnapshot; characterId: CharacterId; apiKey: string | undefined }): ReturnType<SessionDeps['adapterFactory']>;
  /** ctx and sessionId are only for usage attribution (P1-T9 summarize tag). */
  summarizer(input: { snapshot: ConfigSnapshot; apiKey: string | undefined; ctx: SessionContext; sessionId: string }): SessionDeps['summarizer'];
  textClient(snapshot: ConfigSnapshot): TextModelClient | undefined;
  voiceFor(snapshot: ConfigSnapshot, characterId: CharacterId, language: Language): string | undefined;
}

/** The same values index.ts used to pass from startup config, now taken from one snapshot. */
export function sessionDepsFromSnapshot(
  snapshot: ConfigSnapshot,
  ctx: SessionContext,
  sessionId: string,
  factories: SnapshotFactories,
  runtime: SessionRuntimeDeps,
): SessionDeps {
  const { pacing, memory, i18n } = snapshot;
  const characterId = ctx.characterId;
  // Read once: a Key saved mid-call applies from the next session, rebuilds included.
  const apiKey = factories.apiKey();
  const textClient = factories.textClient(snapshot);
  return {
    ...runtime,
    // Usage must be priced with the model this session actually uses.
    ...(runtime.usageSource?.adapter === 'qwen'
      ? { usageSource: { adapter: 'qwen' as const, model: snapshot.model.realtimeModel } }
      : {}),
    adapterFactory: () => factories.adapter({ snapshot, characterId, apiKey }),
    summarizer: factories.summarizer({ snapshot, apiKey, ctx, sessionId }),
    roles: snapshot.roles,
    characters: snapshot.characters,
    ...(textClient ? { textClient } : {}),
    voiceFor: (language) => factories.voiceFor(snapshot, characterId, language),
    budget: snapshot.budgets.budget,
    budgets: snapshot.budgets.budgets,
    i18n,
    ...(memory.recallClipChars !== undefined ? { recallClipChars: memory.recallClipChars } : {}),
    ...(memory.recallPhraseTimeoutMs !== undefined ? { recallPhraseTimeoutMs: memory.recallPhraseTimeoutMs } : {}),
    noticeKeywordsByLanguage: Object.fromEntries(
      LANGUAGES.map((language) => [language, i18n.memory[language].noticeKeywords]),
    ) as Record<Language, readonly string[]>,
    modelContextTokenLimit: pacing.rebuild.contextChars,
    rebuildTriggerRatio: pacing.rebuild.triggerRatio,
    rebuildAfterTurns: pacing.rebuild.afterTurns,
    summarizePolicy: pacing.policies.summarize,
    ...(pacing.output.maxTokens !== null ? { maxOutputTokens: pacing.output.maxTokens } : {}),
    tailGuardMs: pacing.tailGuardMs,
    slim: pacing.slim,
    push: pacing.push,
    restReminder: pacing.restReminder,
    toolTurnTimeoutMs: memory.toolTurnTimeoutMs,
    pin: { maxPerCharacter: memory.pinMaxPerCharacter, maxChars: memory.pinMaxChars, finalWaitMs: memory.pinFinalWaitMs },
    listMaxItems: memory.listMaxItems,
    emotion: i18n.emotion,
    affect: snapshot.affect,
    languageRules: i18n.language,
    ...(runtime.worker ? {
      extractEveryUserTurns: memory.extractEveryUserTurns ?? 10,
      extractSilenceMs: memory.extractSilenceMs ?? 180_000,
    } : {}),
  };
}

export type SessionConstructor = (deps: SessionDeps, ctx: SessionContext, sessionId: string, noticePending: boolean) => Session;

const newSession: SessionConstructor = (deps, ctx, sessionId, noticePending) => new Session(deps, ctx, sessionId, noticePending);

/** SessionManager factory. The snapshot is read once, when the session is created, and kept for its whole life. */
export function makeSessionFactory(
  source: ConfigSource<ConfigSnapshot>,
  factories: SnapshotFactories,
  runtime: SessionRuntimeDeps,
  construct: SessionConstructor = newSession,
): (ctx: SessionContext, sessionId: string, noticePending?: boolean) => Session {
  return (ctx, sessionId, noticePending = false) => {
    const snapshot = source.snapshot();
    // Content-free: which published config this call runs on (P3-T10 isolation check).
    (runtime.logger ?? defaultLogger())
      .child({ sid: sessionId, char: ctx.characterId, ...(ctx.ownerId ? { oid: ownerShortId(ctx.ownerId) } : {}) })
      .info('session_config', { version: snapshot.version });
    return construct(sessionDepsFromSnapshot(snapshot, ctx, sessionId, factories, runtime), ctx, sessionId, noticePending);
  };
}
