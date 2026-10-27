import type { AdminRange, MoneyTokens } from '@anyidea/protocol';

const TZ = 'Asia/Shanghai';
const DAY_MS = 86_400_000;
const MICRO_PER_FEN = 10_000; // 0.01 yuan

export function formatYuan(micro: number): string {
  if (micro === 0) return '0 元';
  if (micro < MICRO_PER_FEN) return '不到 0.01 元';
  return `${(micro / 1_000_000).toFixed(2)} 元`;
}

/** Unpriced calls never read as 0 yuan (spec Q21). */
export function formatMoney(m: MoneyTokens): string {
  if (m.costMicroYuan === 0 && m.unpricedCalls > 0) return '未定价';
  const base = formatYuan(m.costMicroYuan);
  return m.unpricedCalls > 0 ? `${base}（${m.unpricedCalls} 次未定价）` : base;
}

export function formatCount(n: number): string {
  if (n < 10_000) return Math.round(n).toLocaleString('en-US');
  const wan = n / 10_000;
  return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1)} 万`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

export function formatSeconds(ms: number | null): string {
  if (ms === null) return '—';
  const s = (ms / 1000).toFixed(1);
  return `${s.endsWith('.0') ? s.slice(0, -2) : s} 秒`;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Offset inside a session, m:ss. */
export function formatClock(offsetMs: number): string {
  const total = Math.max(0, Math.floor(offsetMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function shanghaiParts(ts: number): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** YYYY-MM-DD in Asia/Shanghai (spec Q35). */
export function shanghaiDay(ts: number): string {
  const p = shanghaiParts(ts);
  return `${p.year}-${p.month}-${p.day}`;
}

export function formatDayLabel(day: string, today: string): string {
  const [, month, date] = day.split('-');
  const label = `${Number(month)}月${Number(date)}日`;
  return day === today ? `${label}（今天）` : label;
}

export function formatDateTime(ts: number): string {
  const p = shanghaiParts(ts);
  return `${Number(p.month)}月${Number(p.day)}日 ${p.hour}:${p.minute}`;
}

export function formatTimeOfDay(ts: number, withSeconds = false): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' as const } : {}),
    hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return withSeconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
}

const RANGE_DAYS: Record<AdminRange, number> = { today: 1, '7d': 7, '30d': 30 };

/** First millisecond of the range, counted in whole Shanghai days ending today. */
export function rangeStart(range: AdminRange, now: number): number {
  const todayStart = Date.parse(`${shanghaiDay(now)}T00:00:00+08:00`);
  return todayStart - (RANGE_DAYS[range] - 1) * DAY_MS;
}
