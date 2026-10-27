import { fileURLToPath } from 'node:url';
import type { CharacterId } from '@anyidea/protocol';
import type { CharacterRegistry } from '../characters/registry.ts';
import { DEFAULT_I18N } from '../i18n/load.ts';
import type { I18nBundle } from '../i18n/types.ts';
import { defaultLogger, type Logger } from '../log/logger.ts';
import { ownerShortId } from '../log/ownerId.ts';
import { memoryViewSource, renderMemoryViews } from '../memory/snapshot.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { RoleCatalog } from '../roles/catalog.ts';
import { PROMPT_LABELS } from '../roles/labels.ts';
import { devContext, type ContextResolver, type ResolveResult, type SessionContext } from '../session/context.ts';
import type { SessionLifecycle } from '../session/manager.ts';
import { loadMemoryBudget } from '../session/pacing.ts';
import { hashToken, newDeviceToken, shortHash } from './tokens.ts';

const DAY_MS = 24 * 60 * 60_000;

/** How often index.ts runs orphan cleanup (also once at startup). */
export const ORPHAN_CLEANUP_INTERVAL_MS = DAY_MS;

export interface IdentityLimits {
  maxOwners: number;
  /** Rolling 24 h cap, counted from the DB so it survives restarts. */
  dailyCap: number;
  /** Owners that registered but never started a session are deleted after this many days. */
  orphanOwnerDays: number;
  orphanCleanupBatch: number;
}

export type RegisterError = 'owner_capacity' | 'register_daily_cap';
export type RegisterResult = { ok: true; deviceToken: string } | { ok: false; error: RegisterError };

/** What the HTTP layer needs from identity. */
export interface IdentityService {
  register(): RegisterResult;
  deleteOwner(ownerId: string): boolean;
}

export interface DeviceRegistryDeps {
  store: MemoryStore;
  roles: RoleCatalog;
  /** Character cards: role pack and default language per character. */
  characters: CharacterRegistry;
  limits: IdentityLimits;
  /** pacing.json restReminder.continuityGapMs: closer sessions count as one continuous stretch. */
  continuityGapMs: number;
  /** Realtime adapter name stored on each session row (config ADAPTER). */
  adapterName?: string;
  now?: () => number;
  /** Defaults to instructions.snapshotMaxChars in gateway/config/memory.json. */
  snapshotMaxChars?: number;
  /** Language packs for the initial snapshot. Defaults to DEFAULT_I18N. */
  i18n?: I18nBundle;
  /** Root logger. Omitted in tests: the stdout default. */
  logger?: Logger;
}

/** Device registration and bearer → owner/agent resolution. Only token hashes are stored. */
export class DeviceRegistry implements ContextResolver, IdentityService {
  /** Persists session start/end so orphan cleanup can spot never-connected owners. */
  readonly lifecycle: SessionLifecycle;
  private readonly now: () => number;
  private readonly snapshotMaxChars: number;
  private readonly i18n: I18nBundle;

  constructor(private readonly deps: DeviceRegistryDeps) {
    const memory = loadMemoryBudget(fileURLToPath(new URL('../../config/memory.json', import.meta.url)));
    this.now = deps.now ?? Date.now;
    this.snapshotMaxChars = deps.snapshotMaxChars ?? memory.instructions.snapshotMaxChars;
    this.i18n = deps.i18n ?? DEFAULT_I18N;
    this.lifecycle = {
      started: (sessionId, ctx) => {
        if (ctx.agentId !== undefined) deps.store.recordSessionStart(sessionId, ctx.agentId, this.now(), deps.adapterName);
      },
      ended: (sessionId, ctx, reason) => {
        if (ctx.agentId !== undefined) deps.store.recordSessionEnd(sessionId, ctx.agentId, this.now(), reason);
      },
    };
  }

  register(): RegisterResult {
    const { store, limits } = this.deps;
    if (store.countOwners() >= limits.maxOwners) return this.reject('owner_capacity');
    const now = this.now();
    // Store bound is inclusive; +1 excludes owners created exactly 24 h ago.
    if (store.countOwnersCreatedSince(now - DAY_MS + 1) >= limits.dailyCap) return this.reject('register_daily_cap');
    const deviceToken = newDeviceToken();
    const created = store.createOwner({ tokenHash: hashToken(deviceToken), now });
    // Agents are created per character on POST /session. Log only a short device hash.
    this.log.child({ oid: ownerShortId(created.ownerId) }).info('device_registered', { device: shortHash(created.deviceId) });
    return { ok: true, deviceToken };
  }

  resolve(bearer: string | undefined, characterId: CharacterId): ResolveResult {
    const { store, roles, characters } = this.deps;
    // dev / Mock: no owner, no memory.
    if (bearer === undefined) return { ok: true, ctx: devContext(roles, characters, characterId), noticePending: false };
    const device = store.findDevice(hashToken(bearer));
    if (!device) {
      this.log.info('device_unknown');
      return { ok: false };
    }
    const now = this.now();
    // One agent per owner × character, created at the first meeting. The character only selects among this owner's agents.
    const agent = store.ensureAgent(device.ownerId, characterId, now);
    store.touchDevice(device.ownerId, device.deviceId, now);
    this.log.child({ oid: ownerShortId(device.ownerId), char: characterId }).info('device_resolved', { agent: shortHash(agent.id) });
    const owner = store.getOwner(device.ownerId);
    const language = roles.defaultLanguage(characters.roleOf(characterId));
    const ctx: SessionContext = {
      ownerId: device.ownerId,
      agentId: agent.id,
      characterId,
      language,
      firstMeet: !store.hasEndedSession(agent.id),
      // Per phone, across characters: sessions less than continuityGapMs apart are one stretch.
      continuousSince: store.continuousSince(device.ownerId, now, this.deps.continuityGapMs),
    };
    // Read the store, not the live Session. The server flushes the previous owner before this resolve is used.
    // User-grounded only. Episodes, notes, extracted sensitive facts, and assistant lines stay out.
    // A pin the user asked to keep may be sensitive; it travels in pinnedMemory, not the three views.
    const views = renderMemoryViews({
      ...memoryViewSource(store, device.ownerId, agent.id),
      maxChars: this.snapshotMaxChars,
      labels: PROMPT_LABELS[language],
      rules: { addressingPatterns: this.i18n.memory[language].addressingPatterns, evidence: this.i18n.evidence },
    });
    if (views.full) ctx.memorySnapshot = views.full;
    if (views.greeting) {
      ctx.greetingMemorySnapshot = views.greeting;
      ctx.greetingHasTopic = views.hasTopic;
    }
    if (views.proactive) ctx.proactiveMemorySnapshot = views.proactive;
    if (views.pinnedBlock) ctx.pinnedMemory = views.pinnedBlock;
    return {
      ok: true,
      ctx,
      // Declining memory also ends the notice obligation: asking again would contradict the choice.
      noticePending: owner !== undefined && owner.notifiedAt === null && owner.memoryConsent !== 'declined',
    };
  }

  deleteOwner(ownerId: string): boolean {
    const deleted = this.deps.store.deleteOwner(ownerId);
    this.log.child({ oid: ownerShortId(ownerId) }).warn('dev_owner_deleted', { deleted });
    return deleted;
  }

  /** Deletes never-connected owners older than the cutoff in batches, yielding to the event loop between batches. */
  async cleanupOrphans(): Promise<number> {
    const { store, limits } = this.deps;
    const cutoff = this.now() - limits.orphanOwnerDays * DAY_MS;
    let total = 0;
    for (;;) {
      const started = performance.now();
      const deleted = store.deleteOrphanOwners(cutoff, limits.orphanCleanupBatch);
      total += deleted;
      // Synchronous batch time = event loop blocking time.
      this.log.child({ job: 'orphan_cleanup' }).info('orphan_cleanup_batch', { deleted, ms: Math.round(performance.now() - started) });
      if (deleted < limits.orphanCleanupBatch) return total;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private reject(error: RegisterError): RegisterResult {
    this.log.warn('device_register_rejected', { reason: error });
    return { ok: false, error };
  }

  private get log(): Logger {
    return this.deps.logger ?? defaultLogger();
  }
}
