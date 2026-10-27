/** Display names for ids the API returns. Kept with the UI, not the gateway config. */
const CHARACTER_NAMES: Record<string, string> = { xiaonuan: '小暖', xiaokai: '小凯', xiaoxin: '小欣' };

const KIND_LABELS: Record<string, string> = {
  realtime_reply: '实时通话',
  memory_extract: '记忆整理',
  summarize: '对话摘要',
  care: '关怀开场',
  affect: '情绪识别',
  silence_plan: '沉默时主动开口',
  recall_wrap: '回忆整理',
};

/**
 * Every reason the gateway writes to sessions.end_reason (P1-T10, P2-T5).
 * unclaimed/start_failed happen before a session row exists, so they never appear here.
 */
export const END_REASON_LABELS: Record<string, string> = {
  client_end: '用户挂断',
  grace_expired: '网络断开后没有回来',
  start_timeout: '重连后没有完成恢复',
  owner_replaced: '同一用户开始了新通话',
  owner_deleted: '用户数据被删除',
  owner_banned: '用户被封禁',
  memory_changed: '记忆更新后结束',
  shutdown: '网关正常关机',
  process_restart: '网关异常退出后补记',
};

const ADAPTER_LABELS: Record<string, string> = {
  qwen: '通义千问',
  seeduplex: 'Seeduplex',
  mock: 'Mock（测试）',
};

export function adapterLabel(id: string | null): string {
  if (!id) return '未记录';
  return ADAPTER_LABELS[id] ?? id;
}

export function characterName(id: string): string {
  return CHARACTER_NAMES[id] ?? id;
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export function endReasonLabel(row: { endedAt: number | null; endReason: string | null }): string {
  if (row.endedAt === null) return '进行中';
  if (row.endReason === null) return '未记录';
  return END_REASON_LABELS[row.endReason] ?? `其他（${row.endReason}）`;
}

const LEVEL_LABELS: Record<string, string> = { error: '错误', warn: '警告', info: '一般', debug: '详细' };

export function levelLabel(level: string): string {
  return LEVEL_LABELS[level] ?? level;
}

/** Actions written to admin_audit (spec「后台 HTTP API」审计动作). */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  login_succeeded: '登录成功',
  login_failed: '登录失败',
  logout: '退出登录',
  config_published: '发布配置',
  config_rolled_back: '回滚配置',
  config_reset: '恢复默认配置',
  secret_updated: '更新 Key',
  secret_revealed: '查看 Key',
  price_added: '新增价格',
  owner_banned: '封禁用户',
  owner_unbanned: '解封用户',
  owner_deleted: '删除用户数据',
  log_level_changed: '调整日志详细程度',
};

export function actionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}
