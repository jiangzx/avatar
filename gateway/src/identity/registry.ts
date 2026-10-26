import { fileURLToPath } from 'node:url';
import { DEFAULT_CHARACTER_ID } from '@anyidea/protocol';
import { DEFAULT_I18N } from '../i18n/load.ts';
import type { I18nBundle } from '../i18n/types.ts';
import { log } from '../log.ts';
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

export type RegisterError = 'unknown_style' | 'owner_capacity' | 'register_daily_cap';
export type RegisterResult = { ok: true; deviceToken: string } | { ok: false; error: RegisterError };
export type SetStyleResult = 'ok' | 'unauthorized' | 'unknown_style';

/** What the HTTP layer needs from identity. */
export interface IdentityService {
  register(style: string | undefined): RegisterResult;
  setStyle(bearer: string, style: string): SetStyleResult;
  deleteOwner(ownerId: string): boolean;
}

export interface DeviceRegistryDeps {
  store: MemoryStore;
  roles: RoleCatalog;
  limits: IdentityLimits;
  now?: () => number;
  /** Defaults to instructions.snapshotMaxChars in gateway/config/memory.json. */
  snapshotMaxChars?: number;
  /** Language packs for the initial snapshot. Defaults to DEFAULT_I18N. */
  i18n?: I18nBundle;
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
        if (ctx.agentId !== undefined) deps.store.recordSessionStart(sessionId, ctx.agentId, this.now());
      },
      ended: (sessionId, ctx) => {
        if (ctx.agentId !== undefined) deps.store.recordSessionEnd(sessionId, ctx.agentId, this.now());
      },
    };
  }

  register(style: string | undefined): RegisterResult {
    const { store, roles, limits } = this.deps;
    const roleId = roles.defaultRole();
    const styleId = style ?? roles.defaultStyle(roleId);
    if (!roles.hasStyle(roleId, styleId)) return this.reject('unknown_style');
    if (store.countOwners() >= limits.maxOwners) return this.reject('owner_capacity');
    const now = this.now();
    // Store bound is inclusive; +1 excludes owners created exactly 24 h ago.
    if (store.countOwnersCreatedSince(now - DAY_MS + 1) >= limits.dailyCap) return this.reject('register_daily_cap');
    const deviceToken = newDeviceToken();
    // Agents are created per character on resolve. Styles are no longer stored; Task 7 removes them.
    const created = store.createOwner({ tokenHash: hashToken(deviceToken), now });
    log('device_registered', { device: shortHash(created.deviceId), style: styleId });
    return { ok: true, deviceToken };
  }

  resolve(bearer: string | undefined): ResolveResult {
    const { store, roles } = this.deps;
    if (bearer === undefined) return { ok: true, ctx: devContext(roles), noticePending: false }; // dev / Mock: no owner, no memory
    const device = store.findDevice(hashToken(bearer));
    if (!device) {
      log('device_unknown', {});
      return { ok: false };
    }
    const now = this.now();
    const roleId = roles.defaultRole();
    // Task 7 resolves the requested character; until then every session uses the default one.
    const agent = store.ensureAgent(device.ownerId, DEFAULT_CHARACTER_ID, now);
    const styleId = roles.defaultStyle(roleId);
    store.touchDevice(device.ownerId, device.deviceId, now);
    log('device_resolved', { agent: shortHash(agent.id), style: styleId });
    const owner = store.getOwner(device.ownerId);
    const language = roles.defaultLanguage(roleId);
    const ctx: SessionContext = { ownerId: device.ownerId, agentId: agent.id, roleId, styleId, voice: roles.voiceFor(roleId, styleId, language), language };
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

  setStyle(bearer: string, style: string): SetStyleResult {
    const { store, roles } = this.deps;
    const device = store.findDevice(hashToken(bearer));
    if (!device) return 'unauthorized';
    if (!roles.hasStyle(roles.defaultRole(), style)) return 'unknown_style';
    // The baseline has no style column; Task 7 deletes PATCH /agent/style.
    log('agent_style_ignored', { style });
    return 'ok';
  }

  deleteOwner(ownerId: string): boolean {
    const deleted = this.deps.store.deleteOwner(ownerId);
    log('dev_owner_deleted', { deleted });
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
      log('orphan_cleanup_batch', { deleted, ms: Math.round(performance.now() - started) });
      if (deleted < limits.orphanCleanupBatch) return total;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private reject(error: RegisterError): RegisterResult {
    log('device_register_rejected', { reason: error });
    return { ok: false, error };
  }
}
