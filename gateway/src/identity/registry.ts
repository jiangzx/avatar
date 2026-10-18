import { log } from '../log.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { RoleCatalog } from '../roles/catalog.ts';
import { devContext, type ContextResolver, type ResolveResult } from '../session/context.ts';
import type { SessionLifecycle } from '../session/manager.ts';
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
}

/** Device registration and bearer → owner/agent resolution. Only token hashes are stored. */
export class DeviceRegistry implements ContextResolver, IdentityService {
  /** Persists session start/end so orphan cleanup can spot never-connected owners. */
  readonly lifecycle: SessionLifecycle;
  private readonly now: () => number;

  constructor(private readonly deps: DeviceRegistryDeps) {
    this.now = deps.now ?? Date.now;
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
    const created = store.createOwner({ tokenHash: hashToken(deviceToken), roleId, styleId, now });
    log('device_registered', { agent: shortHash(created.agentId), style: styleId });
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
    const agent = store.ensureAgent(device.ownerId, roleId, roles.defaultStyle(roleId), now);
    // A style that left the catalog falls back to the default instead of failing the session.
    const styleId = roles.hasStyle(roleId, agent.styleId) ? agent.styleId : roles.defaultStyle(roleId);
    store.touchDevice(device.ownerId, device.deviceId, now);
    log('device_resolved', { agent: shortHash(agent.id), style: styleId });
    const owner = store.getOwner(device.ownerId);
    return {
      ok: true,
      ctx: { ownerId: device.ownerId, agentId: agent.id, roleId, styleId, voice: roles.voiceFor(roleId, styleId) },
      noticePending: owner !== undefined && owner.notifiedAt === null,
    };
  }

  setStyle(bearer: string, style: string): SetStyleResult {
    const { store, roles } = this.deps;
    const device = store.findDevice(hashToken(bearer));
    if (!device) return 'unauthorized';
    const roleId = roles.defaultRole();
    if (!roles.hasStyle(roleId, style)) return 'unknown_style';
    const agent = store.ensureAgent(device.ownerId, roleId, roles.defaultStyle(roleId), this.now());
    store.setAgentStyle(device.ownerId, agent.id, style);
    log('agent_style_changed', { agent: shortHash(agent.id), style });
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
