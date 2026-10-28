import type { AdminConfigItem, AdminConfigValue } from '@anyidea/protocol';

const PREVIEW_CHARS = 24;

function trimNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** Plain-words value. Numbers already arrive in display units (分钟, 秒) from the gateway. */
export function formatValue(item: Pick<AdminConfigItem, 'control' | 'unit' | 'options' | 'pattern'>, value: AdminConfigValue): string {
  if (typeof value === 'boolean') return value ? '开' : '关';
  if (Array.isArray(value)) return value.join('、');
  if (typeof value === 'number') return item.unit ? `${trimNumber(value)} ${item.unit}` : trimNumber(value);
  if (item.control === 'select') return item.options.find((option) => option.value === value)?.label ?? value;
  if (item.pattern) return value;
  const chars = Array.from(value);
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : value;
}

export function formatSeconds(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

/** Per-character rows carry the character name, e.g. 是否启用（小凯）. */
export function rowLabel(item: Pick<AdminConfigItem, 'label' | 'character' | 'impact'>): string {
  return item.character ? `${item.label}（${item.impact.characters}）` : item.label;
}
