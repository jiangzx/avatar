export interface AdminMe { actor: string; csrfToken: string; idleExpiresAt: number }
export type AdminRange = 'today' | '7d' | '30d';
export interface MoneyTokens { tokens: number; costMicroYuan: number; unpricedCalls: number }
export interface AdminOverview {
  range: AdminRange;
  brief: { owners: number; callMinutes: number; costMicroYuan: number; errors: number; deltaMinutesVsPrev: number };
  days: Array<{ day: string; owners: number; callMinutes: number; tokens: number; costMicroYuan: number; errors: number }>; // day = YYYY-MM-DD Asia/Shanghai
  byKind: Array<{ kind: string; costMicroYuan: number; share: number }>;
  latency: { firstAudioP50Ms: number | null; firstAudioP95Ms: number | null };
  alerts: Array<{ code: 'error_rate_1h' | 'first_audio_p95'; value: number; threshold: number }>;
  adapter: string; // current gateway adapter; 'seeduplex' shows the not-counted notice
}
export interface AdminOwnerRow {
  oid: string; createdAt: number; lastSeenAt: number | null; banned: boolean;
  sessions: number; memoryItems: number; usage: MoneyTokens;
}
export interface AdminOwnerDetail extends AdminOwnerRow {
  characters: Array<{ character: string; sessions: number; memoryItems: number; usage: MoneyTokens }>;
  daily: Array<{ day: string; tokens: number; costMicroYuan: number }>;
}
export interface AdminSessionRow {
  sid: string; oid: string; character: string; adapter: string | null;
  startedAt: number; endedAt: number | null; endReason: string | null;
  replies: number; errors: number; firstAudioP50Ms: number | null; usage: MoneyTokens;
}
export interface AdminTimelineItem { ts: number; level: string; event: string; seq: number | null; fields: Record<string, string | number | boolean | null> }
export interface AdminTimeline { session: AdminSessionRow; items: AdminTimelineItem[]; firstAudioAlertMs: number } // alert line from admin.json alerts.firstAudioP95Ms
export interface AdminLogRow extends AdminTimelineItem { id: number; sid: string | null; oid: string | null; char: string | null; job: string | null }
export interface AdminAuditRow { id: number; ts: number; actor: string; action: string; target: string | null; detail: Record<string, unknown> }
export interface AdminPage<T> { items: T[]; nextCursor: string | null }
export interface AdminError { error: string; message: string } // message is user-facing Chinese
export interface AdminLoginRequest { password: string }
export type AdminLogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface AdminLogLevelState { global: AdminLogLevel; overrides: Array<{ scope: 'global' | 'owner'; oid: string | null; level: AdminLogLevel; until: number }> }
export interface AdminLogLevelRequest { scope: 'global' | 'owner'; oid?: string; level: AdminLogLevel | 'reset' }
export interface AdminDeleteOwnerRequest { confirm: string } // must equal the oid
