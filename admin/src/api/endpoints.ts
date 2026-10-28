import type {
  AdminAuditRow,
  AdminConfigDraft,
  AdminConfigOverview,
  AdminConfigPreview,
  AdminConfigPublishRequest,
  AdminConfigResetRequest,
  AdminConfigRollbackRequest,
  AdminConfigScene,
  AdminConfigVersion,
  AdminConfigVersionDiff,
  AdminDeleteOwnerRequest,
  AdminLoginRequest,
  AdminLogLevel,
  AdminLogLevelRequest,
  AdminLogLevelState,
  AdminLogRow,
  AdminMe,
  AdminOverview,
  AdminOwnerDetail,
  AdminOwnerRow,
  AdminPage,
  AdminPriceCreate,
  AdminPriceRow,
  AdminPricing,
  AdminRange,
  AdminSecretReveal,
  AdminSecretRow,
  AdminSessionRow,
  AdminTimeline,
} from '@anyidea/protocol';
import type { ApiClient } from './client.ts';

export type LogLevelName = AdminLogLevel;

export interface SessionQuery { oid?: string; character?: string; from?: number; to?: number; cursor?: string | null; includeMock: boolean }
export interface LogQuery { sid?: string; oid?: string; event?: string; level?: LogLevelName; from?: number; to?: number; cursor?: string | null }
export interface AuditQuery { action?: string; from?: number; to?: number; cursor?: string | null }
// The backend query schemas are strict: the flag must be sent as `mock=1`, or omitted.
const mock = (includeMock: boolean) => (includeMock ? 1 : undefined);
const seg = (value: string) => encodeURIComponent(value);

/** One place that maps screens to admin API routes (spec「后台 HTTP API」). */
export function adminApi(client: ApiClient) {
  return {
    me: () => client.get<AdminMe>('/me'),
    login: (password: string) => client.post<AdminMe>('/login', { password } satisfies AdminLoginRequest),
    logout: () => client.post<void>('/logout'),
    overview: (range: AdminRange, includeMock: boolean) => client.get<AdminOverview>('/overview', { range, mock: mock(includeMock) }),
    owners: (cursor: string | null, includeMock: boolean) => client.get<AdminPage<AdminOwnerRow>>('/owners', { cursor, mock: mock(includeMock) }),
    owner: (oid: string, includeMock: boolean) => client.get<AdminOwnerDetail>(`/owners/${seg(oid)}`, { mock: mock(includeMock) }),
    banOwner: (oid: string) => client.post<void>(`/owners/${seg(oid)}/ban`),
    unbanOwner: (oid: string) => client.post<void>(`/owners/${seg(oid)}/unban`),
    deleteOwner: (oid: string) => client.del<void>(`/owners/${seg(oid)}`, { confirm: oid } satisfies AdminDeleteOwnerRequest),
    sessions: (q: SessionQuery) =>
      client.get<AdminPage<AdminSessionRow>>('/sessions', { oid: q.oid, character: q.character, from: q.from, to: q.to, cursor: q.cursor, mock: mock(q.includeMock) }),
    timeline: (sid: string) => client.get<AdminTimeline>(`/sessions/${seg(sid)}/timeline`),
    logs: (q: LogQuery) => client.get<AdminPage<AdminLogRow>>('/logs', { sid: q.sid, oid: q.oid, event: q.event, level: q.level, from: q.from, to: q.to, cursor: q.cursor }),
    logLevel: () => client.get<AdminLogLevelState>('/log-level'),
    setLogLevel: (body: AdminLogLevelRequest) => client.post<AdminLogLevelState>('/log-level', body),
    audit: (q: AuditQuery) => client.get<AdminPage<AdminAuditRow>>('/audit', { action: q.action, from: q.from, to: q.to, cursor: q.cursor }),
    // Plan 3: config overlay, keys, prices.
    configOverview: () => client.get<AdminConfigOverview>('/config/scenes'),
    configScene: (id: string) => client.get<AdminConfigScene>(`/config/scenes/${seg(id)}`),
    configPreview: (draft: AdminConfigDraft) => client.post<AdminConfigPreview>('/config/preview', draft),
    configPublish: (body: AdminConfigPublishRequest) => client.post<AdminConfigVersion>('/config/publish', body),
    configVersions: (before: number | null) => client.get<AdminPage<AdminConfigVersion>>('/config/versions', { before, limit: 20 }),
    configVersionDiff: (id: number) => client.get<AdminConfigVersionDiff>(`/config/versions/${id}/diff`),
    configRollback: (body: AdminConfigRollbackRequest) => client.post<AdminConfigVersion>('/config/rollback', body),
    configReset: (body: AdminConfigResetRequest) => client.post<AdminConfigVersion>('/config/reset', body),
    secrets: () => client.get<AdminSecretRow[]>('/secrets'),
    putSecret: (name: string, value: string) => client.put<AdminSecretRow>(`/secrets/${seg(name)}`, { value }),
    revealSecret: (name: string) => client.post<AdminSecretReveal>(`/secrets/${seg(name)}/reveal`),
    pricing: () => client.get<AdminPricing>('/pricing'),
    addPrice: (body: AdminPriceCreate) => client.post<AdminPriceRow>('/pricing', body),
  };
}

export type AdminApi = ReturnType<typeof adminApi>;
