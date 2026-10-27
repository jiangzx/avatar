import type {
  AdminAuditRow,
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
  AdminRange,
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
  };
}

export type AdminApi = ReturnType<typeof adminApi>;
