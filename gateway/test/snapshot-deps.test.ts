import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@anyidea/protocol';
import { MockAdapter, loadMockScript } from '../src/adapters/mock.ts';
import { loadConfig } from '../src/config.ts';
import type { ModelDefaults, Overlay } from '../src/config-store/keys.ts';
import type { ConfigSource } from '../src/config-store/store.ts';
import { buildConfigSnapshot, type ConfigSnapshot } from '../src/session/configSnapshot.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import type { SessionDeps } from '../src/session/session.ts';
import { makeSessionFactory, sessionDepsFromSnapshot, type SnapshotFactories } from '../src/session/snapshotDeps.ts';
import type { SessionContext } from '../src/session/context.ts';
import { createLogger, type LogLine } from '../src/log/logger.ts';
import { createLogLevelControl } from '../src/log/levels.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = loadConfig({ APP_SECRET: 'test-secret-0123456789' });
const models: ModelDefaults = {
  realtimeEndpoint: 'wss://example.invalid/realtime',
  realtimeModel: 'qwen3.8-omni-flash-realtime',
  textEndpoint: 'https://example.invalid/chat',
  summarizerModel: 'qwen-flash',
};
const script = loadMockScript(`${root}mock/script.json`);

function snap(overlay: Overlay = {}, version = 0): ConfigSnapshot {
  return buildConfigSnapshot({ gatewayRoot: root, overlay, version, ledger: env.ledger, sessionStartTimeoutMs: env.sessionStartTimeoutMs, models });
}

function factories(calls: { apiKey: number; adapter: string[] } = { apiKey: 0, adapter: [] }): SnapshotFactories {
  return {
    apiKey: () => { calls.apiKey++; return 'key'; },
    adapter: ({ snapshot, characterId }) => { calls.adapter.push(`${snapshot.version}:${characterId}`); return new MockAdapter({ script }); },
    summarizer: () => new MockSummarizer(),
    textClient: () => undefined,
    voiceFor: (snapshot, characterId, language) => snapshot.characters.voiceFor(characterId, 'qwen', language),
  };
}

const ctx = { characterId: 'xiaonuan', language: 'zh' } as SessionContext;
const ownedCtx = { characterId: 'xiaonuan', language: 'zh', ownerId: 'owner-1', agentId: 'agent-1' } as SessionContext;

describe('sessionDepsFromSnapshot', () => {
  it('maps the baseline snapshot to the same values index.ts used to pass', () => {
    const s = snap();
    const deps = sessionDepsFromSnapshot(s, ctx, 'sid-test', factories(), { confirmWindowMs: 1234, ledger: env.ledger });
    expect(deps.roles).toBe(s.roles);
    expect(deps.characters).toBe(s.characters);
    expect(deps.budget).toBe(s.budgets.budget);
    expect(deps.budgets).toBe(s.budgets.budgets);
    expect(deps.i18n).toBe(s.i18n);
    expect(deps.modelContextTokenLimit).toBe(s.pacing.rebuild.contextChars);
    expect(deps.rebuildTriggerRatio).toBe(s.pacing.rebuild.triggerRatio);
    expect(deps.rebuildAfterTurns).toBe(s.pacing.rebuild.afterTurns);
    expect(deps.summarizePolicy).toBe(s.pacing.policies.summarize);
    expect(deps.tailGuardMs).toBe(s.pacing.tailGuardMs);
    expect(deps.slim).toBe(s.pacing.slim);
    expect(deps.push).toBe(s.pacing.push);
    expect(deps.restReminder).toBe(s.pacing.restReminder);
    expect(deps.toolTurnTimeoutMs).toBe(s.memory.toolTurnTimeoutMs);
    expect(deps.pin).toEqual({ maxPerCharacter: s.memory.pinMaxPerCharacter, maxChars: s.memory.pinMaxChars, finalWaitMs: s.memory.pinFinalWaitMs });
    expect(deps.listMaxItems).toBe(s.memory.listMaxItems);
    expect(deps.recallClipChars).toBe(s.memory.recallClipChars);
    expect(deps.recallPhraseTimeoutMs).toBe(s.memory.recallPhraseTimeoutMs);
    expect(deps.emotion).toBe(s.i18n.emotion);
    expect(deps.affect).toBe(s.affect);
    expect(deps.languageRules).toBe(s.i18n.language);
    expect(deps.noticeKeywordsByLanguage).toEqual(Object.fromEntries(LANGUAGES.map((l) => [l, s.i18n.memory[l].noticeKeywords])));
    expect(deps.voiceFor!('zh')).toBe(s.characters.voiceFor('xiaonuan', 'qwen', 'zh'));
    expect(deps.confirmWindowMs).toBe(1234);
    expect('textClient' in deps).toBe(false);
    expect('extractEveryUserTurns' in deps).toBe(false);
    expect('maxOutputTokens' in deps).toBe(s.pacing.output.maxTokens !== null);
  });

  it('adds extraction pacing only when a worker is present', () => {
    const s = snap();
    const worker = { enqueue: async () => undefined } as unknown as NonNullable<SessionDeps['worker']>;
    const deps = sessionDepsFromSnapshot(s, ctx, 'sid-test', factories(), { worker });
    expect(deps.extractEveryUserTurns).toBe(s.memory.extractEveryUserTurns ?? 10);
    expect(deps.extractSilenceMs).toBe(s.memory.extractSilenceMs ?? 180_000);
  });

  it('reads the API key once per session even when the adapter is rebuilt', () => {
    const calls = { apiKey: 0, adapter: [] as string[] };
    const deps = sessionDepsFromSnapshot(snap({}, 3), { ...ctx, characterId: 'xiaokai' } as SessionContext, 'sid-test', factories(calls), {});
    deps.adapterFactory();
    deps.adapterFactory();
    expect(calls.apiKey).toBe(1);
    expect(calls.adapter).toEqual(['3:xiaokai', '3:xiaokai']);
  });

  it('hands the session identity to the summarizer factory for usage attribution', () => {
    const seen: Array<{ owner: string | undefined; sid: string }> = [];
    const f: SnapshotFactories = { ...factories(), summarizer: ({ ctx: c, sessionId }) => { seen.push({ owner: c.ownerId, sid: sessionId }); return new MockSummarizer(); } };
    sessionDepsFromSnapshot(snap(), ownedCtx, 'sid-9', f, {});
    expect(seen).toEqual([{ owner: 'owner-1', sid: 'sid-9' }]);
  });
});

describe('makeSessionFactory', () => {
  it('gives each new session the snapshot current at creation; old sessions keep theirs', () => {
    let current = snap({}, 1);
    const source: ConfigSource<ConfigSnapshot> = { snapshot: () => current };
    const seen: SessionDeps[] = [];
    const make = makeSessionFactory(source, factories(), {}, (deps) => { seen.push(deps); return {} as never; });

    make(ctx, 'sid-1');
    current = snap({ 'role:elder-companion/*/director.contextAfterMs': 9000 }, 2);
    make(ctx, 'sid-2', true);

    expect(seen[0]!.roles.director('xiaonuan', 'zh').contextAfterMs).toBe(6000);
    expect(seen[1]!.roles.director('xiaonuan', 'zh').contextAfterMs).toBe(9000);
    // The first session's view did not move.
    expect(seen[0]!.roles.director('xiaonuan', 'zh').contextAfterMs).toBe(6000);
  });

  it('logs session_config with the snapshot version for every new session', () => {
    let current = snap({}, 1);
    const lines: LogLine[] = [];
    const logger = createLogger({ sinks: [{ write: (line) => { lines.push(line); } }], levels: createLogLevelControl('info'), strict: true });
    const make = makeSessionFactory({ snapshot: () => current }, factories(), { logger }, () => ({}) as never);
    make(ownedCtx, 'sid-1');
    current = snap({}, 2);
    make(ctx, 'sid-2');
    const config = lines.filter((line) => line.event === 'session_config');
    expect(config.map((line) => [line.level, line.binding.sid, line.binding.char, line.fields.version])).toEqual([
      ['info', 'sid-1', 'xiaonuan', 1],
      ['info', 'sid-2', 'xiaonuan', 2],
    ]);
    // oid is the short hash, never the raw owner id; dev sessions without an owner carry none.
    expect(config[0]!.binding.oid).toMatch(/^[0-9a-f]{12}$/);
    expect(config[1]!.binding.oid).toBeUndefined();
  });
});
