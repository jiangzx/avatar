import type { AdminConfigItem, AdminConfigPreview, AdminConfigScene, AdminConfigVersion } from '@anyidea/protocol';

export function item(over: Partial<AdminConfigItem> & Pick<AdminConfigItem, 'key' | 'label' | 'control'>): AdminConfigItem {
  return {
    descriptorKey: over.key,
    purpose: '用途说明',
    impact: { characters: '所有角色', stage: '休息提醒', effective: 'next_session' },
    unit: null,
    unitId: null,
    min: null,
    max: null,
    step: null,
    maxChars: null,
    minItems: null,
    maxItems: null,
    itemMaxChars: null,
    requiredTokens: [],
    tokenMeanings: {},
    options: [],
    pattern: null,
    complianceNote: null,
    risk: 'low',
    riskNote: null,
    language: null,
    character: null,
    model: null,
    baseline: 0,
    current: 0,
    changed: false,
    ...over,
  };
}

const minutes = { control: 'number', unit: '分钟', unitId: 'minute', step: 5 } as const;
const seconds = { control: 'number', unit: '秒', unitId: 'second', step: 1 } as const;
const silence = { characters: '所有角色', stage: '沉默接话', effective: 'next_session' } as const;
const D = 'role:elder-companion/*/director';
const ZH = 'role:elder-companion/zh/director';

export const restItem = item({
  ...minutes,
  key: 'pacing:restReminder.firstAfterMs',
  label: '连续聊多久提醒休息',
  purpose: '老人连续聊到这么久，AI 会温和地提醒他起来活动、喝口水。',
  min: 10, max: 120,
  baseline: 60, current: 90, changed: true,
  complianceNote: '监管要求连续使用不超过 2 小时就要提醒，所以最多 120 分钟。',
});
export const everyItem = item({ ...minutes, key: 'pacing:restReminder.everyMs', label: '之后每隔多久再提醒', min: 30, max: 120, baseline: 60, current: 60 });

export const contextItem = item({
  ...seconds, key: `${D}.contextAfterMs`, label: '老人停下后多久接第一句', impact: silence,
  purpose: '老人说完话安静下来，AI 等这么久，再顺着刚才的话轻轻接一句。',
  min: 3, max: 20, baseline: 6, current: 6, risk: 'medium', riskNote: '太短像在催老人，太长老人会以为 AI 走神了。',
});
export const checkItem = item({ ...seconds, key: `${D}.checkAfterMs`, label: '第二句再等多久', impact: silence, min: 4, max: 30, baseline: 8, current: 8, risk: 'medium' });
export const leaveItem = item({ ...seconds, key: `${D}.leaveAfterMs`, label: '第三句再等多久', impact: silence, min: 5, max: 60, baseline: 10, current: 10, risk: 'medium' });
export const checkinItem = item({ ...seconds, key: `${D}.checkinAfterMs`, label: '问「还在听吗」前再等多久', impact: silence, min: 5, max: 60, baseline: 10, current: 10, risk: 'medium' });
export const restAfterItem = item({ ...minutes, step: 1, key: `${D}.restAfterMs`, label: '最后一句前再等多久', impact: silence, min: 1, max: 10, baseline: 3, current: 3 });

export const contextTextItem = item({
  control: 'text', key: `${ZH}.contextText`, label: '第一句的备用话', impact: silence, language: 'zh', maxChars: 40,
  baseline: '您想接着聊点什么？我听着呢。', current: '您想接着聊点什么？我听着呢。',
});
export const jaContextTextItem = item({
  control: 'text', key: 'role:elder-companion/ja/director.contextText', label: '第一句的备用话', impact: silence, language: 'ja', maxChars: 60,
  baseline: '何か話したいことはありますか？', current: '何か話したいことはありますか？',
});
export const restTextItem = item({
  control: 'text', key: `${ZH}.restText`, label: '最后一句的备用话', impact: silence, language: 'zh', maxChars: 40,
  baseline: '你可以先自己放空一会儿，不用急着回我。', current: '你可以先自己放空一会儿，不用急着回我。',
});
export const lightItem = item({
  control: 'list', key: `${ZH}.lightPhrases`, label: '算作轻声答应的词', impact: silence, language: 'zh',
  minItems: 1, maxItems: 3, itemMaxChars: 6, baseline: ['嗯', '好'], current: ['嗯', '好'], risk: 'medium',
});

export const careDaysItem = item({
  control: 'number', unit: '天', unitId: 'day', step: 1, key: 'affect:care.maxAgeDays', label: '关怀开场最多提起几天前的事',
  impact: { characters: '所有角色', stage: '关怀开场', effective: 'next_session' },
  min: 1, max: 14, baseline: 3, current: 3, risk: 'high',
  riskNote: '这也决定这些原话保存多久；调小后，更早的会在当晚清理中删除，删除后找不回来。',
});

export const personaItem = item({
  control: 'textarea', key: 'role:elder-companion/zh/persona', label: '三个角色共用的人设', language: 'zh',
  purpose: 'AI 陪老人聊天的总体要求：怎么说话、什么不能说。三个角色都用这段。',
  impact: { characters: '所有角色', stage: '说话方式', effective: 'next_session' },
  maxChars: 1600, requiredTokens: ['{{char}}'], tokenMeanings: { '{{char}}': '角色名字' },
  baseline: '你是{{char}}，陪老人聊天。', current: '你是{{char}}，陪老人聊天。', risk: 'high',
});

export const enabledItem = item({
  control: 'switch', key: 'character:xiaokai.enabled', label: '是否启用', character: 'xiaokai',
  impact: { characters: '小凯', stage: '选角色', effective: 'next_session' }, baseline: true, current: true, risk: 'medium',
});

export const endpointItem = item({
  control: 'text', key: 'model:qwen.realtimeEndpoint', label: '实时通话地址', pattern: 'wss_url', maxChars: 300,
  impact: { characters: '所有角色', stage: '模型', effective: 'next_session' },
  baseline: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', current: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  risk: 'high', riskNote: '地址填错，所有通话都会连不上。',
});

export const extractModelItem = item({
  control: 'select', key: 'memory:extractModel', label: '整理记忆用的模型',
  impact: { characters: '所有角色', stage: '模型', effective: 'next_session' },
  options: [
    { value: 'qwen-plus', label: '通义千问 Plus', priceNote: '输入 0.8 / 输出 2 元每百万 token' },
    { value: 'qwen-flash', label: '通义千问 Flash', priceNote: '未定价' },
  ],
  baseline: 'qwen-plus', current: 'qwen-plus', risk: 'medium',
});

export function scene(items: AdminConfigItem[], over: Partial<AdminConfigScene> = {}): AdminConfigScene {
  return {
    id: 'pacing',
    title: '对话节奏',
    intro: '老人不说话时，AI 什么时候开口、实在想不出话时说什么。改完下一通电话生效。',
    activeVersion: 7,
    items,
    readonly: [{ label: '沉默接话的顺序', purpose: '老人一直不说话时，AI 依次说三句接话、问一句还在不在听、几分钟后一句收尾。', note: '顺序固定，这里只能改等待时间和备用话。' }],
    ...over,
  };
}

export const IMPACT = '影响所有角色。下一通电话开始生效，现在正在进行的 3 通电话不受影响。';

export function preview(over: Partial<AdminConfigPreview> = {}): AdminConfigPreview {
  return {
    ok: true,
    issues: [],
    lines: [{ key: restItem.key, label: restItem.label, scene: '对话节奏', before: '90 分钟', after: '60 分钟', characters: '所有角色', risk: 'low', textDiff: null }],
    summary: IMPACT,
    activeSessions: 3,
    requiresConfirm: false,
    confirmPhrase: '确认发布',
    ...over,
  };
}

export function version(id: number, over: Partial<AdminConfigVersion> = {}): AdminConfigVersion {
  return { id, createdAt: Date.parse('2026-10-27T14:02:00+08:00'), kind: 'publish', actor: 'admin', note: null, changedKeys: [restItem.key], active: true, ...over };
}

/** Parsed JSON body of the n-th call to METHOD path (0-based). */
export function bodyOf(calls: Array<{ method: string; url: URL; init: RequestInit }>, method: string, path: string, n = 0): unknown {
  const match = calls.filter((c) => c.method === method && c.url.pathname === path)[n];
  return match ? JSON.parse(String(match.init.body)) : undefined;
}
