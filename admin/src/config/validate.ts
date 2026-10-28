import type { AdminConfigItem, AdminConfigValue } from '@anyidea/protocol';

const chars = (text: string) => Array.from(text).length;
const SCHEMES = { wss_url: 'wss:', https_url: 'https:' } as const;

function hasScheme(text: string, protocol: string): boolean {
  try {
    return new URL(text).protocol === protocol;
  } catch {
    return false;
  }
}

/** Inline problems for one row, in the words the admin will read. The gateway checks again on preview. */
export function rowErrors(item: AdminConfigItem, value: AdminConfigValue): string[] {
  const errors: string[] = [];
  if (typeof value === 'number' && item.min !== null && item.max !== null && (value < item.min || value > item.max)) {
    errors.push(`可以填 ${item.min} 到 ${item.max}${item.unit ? ` ${item.unit}` : ''}。`);
  }
  if (typeof value === 'string') {
    if (item.pattern && !hasScheme(value, SCHEMES[item.pattern])) errors.push(`地址必须以 ${SCHEMES[item.pattern]}// 开头。`);
    if (!item.pattern && value.trim() === '') errors.push('不能为空。');
    for (const token of item.requiredTokens) {
      if (!value.includes(token)) errors.push(`「${item.label}」里少了 ${token}，这是${item.tokenMeanings[token] ?? '程序要用的内容'}的位置，请加回去。`);
    }
    if (item.maxChars !== null && chars(value) > item.maxChars) errors.push(`最多 ${item.maxChars} 字，现在 ${chars(value)} 字。`);
  }
  if (Array.isArray(value)) {
    if (item.minItems !== null && value.length < item.minItems) errors.push(`至少要留 ${item.minItems} 个词。`);
    if (item.maxItems !== null && value.length > item.maxItems) errors.push(`最多 ${item.maxItems} 个词。`);
    if (item.itemMaxChars !== null && value.some((word) => chars(word) > item.itemMaxChars!)) errors.push(`每个词最多 ${item.itemMaxChars} 个字。`);
    for (const token of item.requiredTokens) {
      const index = value.findIndex((entry) => !entry.includes(token));
      if (index >= 0) errors.push(`「${item.label}」第 ${index + 1} 条里少了 ${token}，这是${item.tokenMeanings[token] ?? '程序要用的内容'}的位置，请加回去。`);
    }
  }
  return errors;
}
