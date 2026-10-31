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
  adapter: string; // current gateway adapter: 'qwen' | 'mock'
}
export interface AdminOwnerRow {
  oid: string; createdAt: number; lastSeenAt: number | null; banned: boolean;
  sessions: number; memoryItems: number; usage: MoneyTokens;
}
export interface AdminOwnerDetail extends AdminOwnerRow {
  characters: Array<{ character: string; sessions: number; memoryItems: number; usage: MoneyTokens }>;
  daily: Array<{ day: string; tokens: number; costMicroYuan: number }>;
  /** Today's proactive line count per character (Asia/Shanghai). */
  proactiveDaily: Array<{ character: string; count: number }>;
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
export type AdminConfigSceneId = 'pacing' | 'affect' | 'proactivity' | 'memory' | 'characters' | 'copy' | 'model';
export type AdminConfigValue = number | boolean | string | string[];
export type AdminConfigRisk = 'low' | 'medium' | 'high';
export type AdminConfigControl = 'number' | 'switch' | 'text' | 'textarea' | 'list' | 'select';
export interface AdminConfigSceneSummary { id: AdminConfigSceneId; title: string; intro: string; changedCount: number }
export interface AdminConfigOverview { activeVersion: number; startupIssues: string[]; scenes: AdminConfigSceneSummary[] }
export interface AdminConfigOption { value: string; label: string; priceNote: string | null }
export interface AdminConfigItem {
  key: string; descriptorKey: string; label: string; purpose: string;
  impact: { characters: string; stage: string; effective: 'next_session' };
  control: AdminConfigControl;
  /** Hidden behind the scene's advanced toggle by default. */
  advanced?: boolean;
  unit: string | null;                 // display word: '秒' | '分钟' | '天' | '条' | '字' | '级'
  unitId: 'second' | 'minute' | 'day' | 'count' | 'char' | 'level' | null; // stable id for client logic (pacing ruler)
  min: number | null; max: number | null; step: number | null;
  maxChars: number | null; minItems: number | null; maxItems: number | null; itemMaxChars: number | null;
  requiredTokens: string[]; tokenMeanings: Record<string, string>; // e.g. { '{{char}}': '角色名字' } for every required token
  options: AdminConfigOption[]; pattern: 'wss_url' | 'https_url' | null;
  complianceNote: string | null; risk: AdminConfigRisk; riskNote: string | null;
  language: 'zh' | 'ja' | 'en' | null; character: string | null;
  /** Realtime model id for per-model voice items; null for all other items. */
  model: string | null;
  baseline: AdminConfigValue; current: AdminConfigValue; changed: boolean;
}
export interface AdminConfigReadonlyNote { label: string; purpose: string; note: string }
export interface AdminConfigScene { id: AdminConfigSceneId; title: string; intro: string; activeVersion: number; items: AdminConfigItem[]; readonly: AdminConfigReadonlyNote[] }
export interface AdminConfigChange { key: string; value: AdminConfigValue }
export interface AdminConfigDraft { baseVersion: number; changes: AdminConfigChange[]; resets: string[] }
export interface AdminConfigIssue { key: string | null; message: string }
export interface AdminConfigImpactLine {
  key: string; label: string; scene: string; before: string; after: string; characters: string;
  risk: AdminConfigRisk; textDiff: { before: string; after: string } | null;
}
export interface AdminConfigPreview {
  ok: boolean; issues: AdminConfigIssue[]; lines: AdminConfigImpactLine[]; summary: string;
  activeSessions: number; requiresConfirm: boolean; confirmPhrase: string;
}
export interface AdminConfigPublishRequest extends AdminConfigDraft { note?: string; confirmText?: string }
export interface AdminConfigVersion { id: number; createdAt: number; kind: 'publish' | 'rollback' | 'reset'; actor: string; note: string | null; changedKeys: string[]; active: boolean }
export interface AdminConfigVersionDiff { id: number; lines: AdminConfigImpactLine[] }
export interface AdminConfigRollbackRequest { toVersion: number; baseVersion: number }
export interface AdminConfigResetRequest { keys: string[] | 'all'; baseVersion: number }
export interface AdminConfigInvalid extends AdminError { issues: AdminConfigIssue[] }
export interface AdminSecretRow { name: string; label: string; source: 'admin' | 'env' | 'missing'; last4: string | null; updatedAt: number | null; writable: boolean }
export interface AdminSecretUpdate { value: string }
export interface AdminSecretReveal { name: string; value: string }
export interface AdminPriceRow {
  id: string; model: string; effectiveFrom: number;
  inputText: number; inputAudio: number | null; outputText: number; outputAudio: number | null; cached: number | null;
  source: string; checkedAt: string; origin: 'baseline' | 'admin'; active: boolean;
}
export interface AdminPricing { prices: AdminPriceRow[]; unpricedModels: Array<{ model: string; calls: number }> } // unpriced: real (non-mock) calls with no price
export interface AdminPriceCreate {
  model: string; effectiveFrom: number;
  inputText: number; inputAudio: number | null; outputText: number; outputAudio: number | null; cached: number | null;
  source: string; checkedAt: string;
}
