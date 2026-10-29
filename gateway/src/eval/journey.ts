import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CHARACTER_IDS, LANGUAGES, type CharacterId, type Language, type ResponseKind } from '@anyidea/protocol';
import { DeviceRegistry } from '../identity/registry.ts';
import type { Logger } from '../log/logger.ts';
import { openDatabase } from '../memory/db.ts';
import { SqliteMemoryStore } from '../memory/store.ts';
import type { TextModelClient } from '../memory/textClient.ts';
import { MemoryWorker } from '../memory/worker.ts';
import { SqliteTranscriptWriter } from '../memory/writer.ts';
import type { ConfigSnapshot } from '../session/configSnapshot.ts';
import { Session } from '../session/session.ts';
import { sessionDepsFromSnapshot, type SessionRuntimeDeps, type SnapshotFactories } from '../session/snapshotDeps.ts';
import { SimTransport, playResponses, playSilence, type EvalConfig, type Played } from './harness.ts';
import { SimClock } from './simClock.ts';

export const DAY_MS = 86_400_000;

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const JourneySessionSchema = z.object({
  /** Days after the journey start (0 = first day). */
  day: z.number().int().min(0).max(13),
  /** Asia/Shanghai wall time, HH:mm. */
  time: Time,
  /** Defaults to the journey character. */
  character: z.enum(CHARACTER_IDS).optional(),
  /** What the user says, in order. Empty = the user only listens. */
  turns: z.array(z.string().min(1).max(200)).max(10),
  /** After the last turn, keep collecting proactive lines this long. */
  silenceAfterMs: z.number().int().min(1_000).max(60_000).optional(),
  /** What this session tests; shown to the judge, never spoken. */
  note: z.string().min(1).max(80).optional(),
}).strict();

const minuteOf = (s: { day: number; time: string }) => {
  const [h, m] = s.time.split(':').map(Number);
  return s.day * 1440 + h! * 60 + m!;
};

const JourneySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  title: z.string().min(1).max(40),
  character: z.enum(CHARACTER_IDS),
  /** First day, YYYY-MM-DD (Asia/Shanghai). */
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sessions: z.array(JourneySessionSchema).min(2).max(8),
}).strict().superRefine((j, ctx) => {
  // Rejects 2026-13-40 (Invalid Date) and 2026-02-30 (JS rolls it over to March).
  const at = Date.parse(`${j.start}T00:00:00+08:00`);
  if (Number.isNaN(at) || shanghaiDate(at) !== j.start) {
    ctx.addIssue({ code: 'custom', path: ['start'], message: 'start must be a real calendar date' });
  }
  for (let i = 1; i < j.sessions.length; i++) {
    if (minuteOf(j.sessions[i]!) <= minuteOf(j.sessions[i - 1]!)) {
      ctx.addIssue({ code: 'custom', path: ['sessions', i], message: 'sessions must be in strictly increasing day/time order' });
    }
  }
});

export type JourneySession = z.infer<typeof JourneySessionSchema>;
export type Journey = z.infer<typeof JourneySchema>;

/** YYYY-MM-DD of an instant in Asia/Shanghai (UTC+8, no DST). */
function shanghaiDate(at: number): string {
  return new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function parseJourneys(raw: unknown): Journey[] {
  const journeys = z.array(JourneySchema).min(1).parse(raw);
  const seen = new Set<string>();
  for (const j of journeys) {
    if (seen.has(j.id)) throw new Error(`duplicate journey id ${j.id}`);
    seen.add(j.id);
  }
  return journeys;
}

export function loadJourneys(path: string): Journey[] {
  return parseJourneys(JSON.parse(readFileSync(path, 'utf8')));
}

/** Epoch ms when the session starts, from the journey start date and the session's day and wall time. */
export function sessionStartAt(journey: Journey, session: JourneySession): number {
  return Date.parse(`${journey.start}T${session.time}:00+08:00`) + session.day * DAY_MS;
}

export interface JourneyReply { turn: number; kind: ResponseKind; text: string }

export interface SessionRun {
  index: number;
  day: number;
  time: string;
  /** Simulated epoch ms the session started at. */
  startedAt: number;
  character: CharacterId;
  firstMeet: boolean;
  replies: JourneyReply[];
}

export interface JourneyRun { journeyId: string; sessions: SessionRun[] }

export interface JourneyEnv {
  snapshot: ConfigSnapshot;
  factories: SnapshotFactories;
  runtime: Omit<SessionRuntimeDeps, 'store' | 'writer' | 'worker' | 'now' | 'onReplyMetrics'>;
  /** Extraction client; undefined = no memory extraction (Mock runs). */
  extractClient?: TextModelClient;
  logger?: Logger;
}

const byLanguage = <T>(make: (language: Language) => T): Record<Language, T> =>
  Object.fromEntries(LANGUAGES.map((language) => [language, make(language)])) as Record<Language, T>;

/** Same worker settings as src/index.ts, with the simulated clock. */
function journeyWorker(env: JourneyEnv, store: SqliteMemoryStore, clock: SimClock): MemoryWorker | undefined {
  const { snapshot, extractClient } = env;
  if (!extractClient) return undefined;
  return new MemoryWorker({
    store,
    client: extractClient,
    systemPrompts: byLanguage((language) => snapshot.roles.extractPrompt(language)),
    labels: byLanguage((language) => snapshot.i18n.memory[language].extractLabels),
    maxTokens: snapshot.memory.extractMaxTokens ?? 800,
    policy: snapshot.memory.extractPolicy ?? snapshot.pacing.policies.summarize,
    transcriptMaxChars: snapshot.memory.extractTranscriptMaxChars ?? 6_000,
    contextMaxChars: snapshot.memory.extractContextMaxChars ?? 4_000,
    // Thread quotes are stored only while proactivity is on (data minimization).
    quote: { maxChars: snapshot.proactivity.threads.quoteMaxChars, safety: snapshot.i18n.safety, evidence: snapshot.i18n.evidence },
    quoteEnabled: () => snapshot.proactivity.enabled,
    reflectPrompts: byLanguage((language) => snapshot.roles.reflectPrompt(language)),
    ...(snapshot.memory.reflect ? { reflect: snapshot.memory.reflect } : {}),
    now: clock.now,
    ...(env.logger ? { logger: env.logger } : {}),
  });
}

/** Opening, each user turn, then the silence window; like runScenario, on a session the caller built. */
async function driveSession(session: Session, script: JourneySession, cfg: EvalConfig): Promise<JourneyReply[]> {
  const t = new SimTransport();
  const replies: JourneyReply[] = [];
  const collect = (turn: number, played: Played[]) => {
    for (const p of played) replies.push({ turn, kind: p.kind, text: t.text.get(p.seq) ?? '' });
  };
  try {
    await session.start(t);
    collect(0, await playResponses(session, t, cfg.run, null));
    for (let i = 0; i < script.turns.length; i++) {
      session.handleClientMessage({ type: 'debug.userText', text: script.turns[i]! });
      collect(i + 1, await playResponses(session, t, cfg.run, Date.now()));
    }
    if (script.silenceAfterMs !== undefined) collect(script.turns.length + 1, await playSilence(session, t, cfg.run, script.silenceAfterMs));
    session.flush();
  } finally {
    session.end();
  }
  return replies;
}

/**
 * Runs one journey on a fresh in-memory database: one owner, sessions in order, extraction finished
 * before the next session starts. Synthetic input only; nothing here is logged with content.
 */
export async function runJourney(env: JourneyEnv, journey: Journey, cfg: EvalConfig): Promise<JourneyRun> {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1_000 });
  const clock = new SimClock();
  const sessions: SessionRun[] = [];
  try {
    const { snapshot } = env;
    const store = new SqliteMemoryStore(db);
    // The device registers a minute before the first session.
    clock.setTo(sessionStartAt(journey, journey.sessions[0]!) - 60_000);
    const registry = new DeviceRegistry({
      store,
      roles: snapshot.roles,
      characters: snapshot.characters,
      limits: { maxOwners: 1, dailyCap: 1, orphanOwnerDays: 30, orphanCleanupBatch: 1 },
      continuityGapMs: snapshot.pacing.restReminder.continuityGapMs,
      adapterName: 'eval',
      now: clock.now,
      snapshotMaxChars: snapshot.memory.instructions.snapshotMaxChars,
      i18n: snapshot.i18n,
      ...(env.logger ? { logger: env.logger } : {}),
    });
    const registered = registry.register();
    if (!registered.ok) throw new Error('journey_register_failed');
    // Omit a missing logger so the writer keeps its default.
    const writer = env.logger
      ? new SqliteTranscriptWriter(store, snapshot.i18n.safety, env.logger)
      : new SqliteTranscriptWriter(store, snapshot.i18n.safety);
    const worker = journeyWorker(env, store, clock);
    let notified = false;
    for (const [index, script] of journey.sessions.entries()) {
      const startedAt = sessionStartAt(journey, script);
      clock.setTo(startedAt);
      const characterId = script.character ?? journey.character;
      const resolved = registry.resolve(registered.deviceToken, characterId);
      if (!resolved.ok) throw new Error('journey_resolve_failed');
      const ctx = resolved.ctx;
      if (!notified && ctx.ownerId) {
        // The memory notice is out of scope; without it the writer stores nothing.
        store.markNotified(ctx.ownerId, clock.now());
        notified = true;
      }
      const sessionId = `${journey.id}-${index}`;
      const deps = sessionDepsFromSnapshot(snapshot, ctx, sessionId, env.factories, {
        ...env.runtime,
        store,
        writer,
        ...(worker ? { worker } : {}),
        now: clock.now,
      });
      const session = new Session(deps, ctx, sessionId, false);
      registry.lifecycle.started(sessionId, ctx);
      const replies = await driveSession(session, script, cfg);
      registry.lifecycle.ended(sessionId, ctx, 'client_end');
      if (worker && ctx.ownerId && ctx.agentId) {
        await worker.enqueue(ctx.ownerId, ctx.agentId, 'session_end', ctx.language);
        await worker.reflectSession(ctx.ownerId, ctx.agentId, sessionId, ctx.language);
      }
      sessions.push({ index, day: script.day, time: script.time, startedAt, character: characterId, firstMeet: ctx.firstMeet, replies });
    }
  } finally {
    db.close();
  }
  return { journeyId: journey.id, sessions };
}
