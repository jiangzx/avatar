# P2-T7: 总览、用户、通话页面

**目标：** 实现「看情况」一组的三个页面：总览（今日简报句、需要留意、首音延迟、每天的情况、钱花在哪里）、用户列表与详情（含封禁、解封、删除全部数据）、通话列表。金额一律从微元换算成元；没有价格的显示「未定价」；超过提醒线的指标标红。

**实现的 spec 章节：** 「界面设计」的「总览」线框、「其他页面」中的用户；「文案规则」；决策 Q2、Q10、Q21、Q31、Q32、Q35、Q36。

**前置：** P2-T4、P2-T5、P2-T6 已合入。开始前跑：

```bash
npm test -w admin && npm run typecheck -w admin
```

预期全绿（P2-T6 的 18 个用例）。

**Files:**
- Create: `admin/src/format.ts`、`admin/src/labels.ts`
- Create: `admin/src/useLoad.ts`、`admin/src/usePaged.ts`
- Create: `admin/src/components/LoadError.tsx`、`admin/src/components/InlineBar.tsx`、`admin/src/components/PagedTable.tsx`、`admin/src/components/Brief.tsx`
- Create: `admin/src/pages/OverviewPage.tsx`、`admin/src/pages/UsersPage.tsx`、`admin/src/pages/UserDetailPage.tsx`、`admin/src/pages/SessionsPage.tsx`
- Modify: `admin/src/theme.ts`（追加 `CHARACTER_COLORS`）
- Modify: `admin/src/styles.css`（追加页面样式）
- Modify: `admin/src/routes.tsx`（接上三个页面）
- Test: `admin/test/format.test.ts`、`admin/test/labels.test.ts`、`admin/test/brief.test.tsx`、`admin/test/overview.test.tsx`、`admin/test/users.test.tsx`、`admin/test/user-detail.test.tsx`、`admin/test/sessions.test.tsx`

**Interfaces:**
- Consumes（P2-T6）：`useApi()`、`useViewOptions()`、`href()`、`navigate()`、`useRoute()`、`AdminApiError`、`palette`、`fakeFetch`、`renderWithProviders`、`ME`；C6 类型 `AdminOverview`、`AdminRange`、`AdminOwnerRow`、`AdminOwnerDetail`、`AdminSessionRow`、`MoneyTokens`、`AdminPage`。
- 对后端的假设（与 P2-T4 对齐，不一致以后端为准）：
  - `AdminOverview.alerts[].value/threshold`：`error_rate_1h` 用 0–1 的小数（0.12 表示 12%），`first_audio_p95` 用毫秒。
  - `AdminOverview.days` 的顺序不作要求，页面自己按日期倒序。
  - `AdminSessionRow.endReason` 取值见 P1-T10 的结束原因表；已知取值写在 `labels.ts`。
- Produces（P2-T8、P3 使用）：
  - `admin/src/format.ts`：`formatYuan(micro)`、`formatMoney(m)`、`formatCount(n)`、`formatDuration(ms)`、`formatSeconds(ms)`、`formatPercent(fraction)`、`formatClock(offsetMs)`、`shanghaiDay(ts)`、`formatDayLabel(day, today)`、`formatDateTime(ts)`、`rangeStart(range, now)`
  - `admin/src/labels.ts`：`characterName(id)`、`kindLabel(kind)`、`endReasonLabel(row)`、`END_REASON_LABELS`
  - `admin/src/useLoad.ts`：`useLoad(load, deps)` → `{ state: Load<T>; reload() }`、`errorMessage(error)`、类型 `Load<T>`
  - `admin/src/usePaged.ts`：`usePaged(fetchPage, deps)` → `Paged<T>`
  - `admin/src/components/*`：`LoadError`、`InlineBar`、`PagedTable`、`Brief`
  - `admin/src/theme.ts`：`CHARACTER_COLORS`

## 文案（逐字使用）

| 位置 | 文案 |
|---|---|
| 简报句 | `今天 12 位老人聊了 86 分钟，花费约 4.30 元，出错 2 次。`；没出错时结尾是 `没有出错。`；`近 7 天`、`近 30 天` 替换开头 |
| 简报第二句 | `比昨天多 18 分钟。` / `比昨天少 5 分钟。` / `和昨天一样。`（7 天、30 天用 `前 7 天`、`前 30 天`） |
| 没人通话 | `今天还没有人通话。` |
| 费用不足一分 | `花费不到 0.01 元` |
| 未定价 | `未定价`；部分未定价：`4.30 元（3 次未定价）` |
| 需要留意 | 标题 `需要留意`；`近 1 小时出错率 12%，超过 5% 的提醒线`；`近 1 小时首音延迟 p95 2.8 秒，超过 2 秒的提醒线`；链接 `查看` |
| 首音延迟 | `首音延迟：一半的回复在 1.1 秒内开口，95% 在 2.8 秒内。`；没数据：`首音延迟：还没有数据。` |
| Seeduplex | `当前使用 Seeduplex，通话用量不统计。` |
| 每天 | 标题 `每天的情况`；列 `日期`、`老人`、`通话分钟`、`token`、`费用`、`出错`；今天的日期 `10月27日（今天）`；空：`这段时间还没有通话。` |
| 钱花在哪里 | 标题 `钱花在哪里`；空：`还没有产生费用。` |
| 用户列表 | 标题 `用户`；灰字 `同一台手机重新注册后会显示成新用户。`；空：`还没有用户注册。`；`加载更多`；`已封禁`；没用过：`还没用过` |
| 用户详情 | 按钮 `封禁这位用户` / `解封这位用户` / `删除全部数据`；链接 `查看这位用户的通话` |
| 封禁弹窗 | 标题 `封禁这位用户？`；正文 `封禁后，这位用户正在进行的通话会立即结束，之后不能开始新通话。数据不会删除，解封后一切恢复。`；按钮 `封禁`、`取消`；提示 `已封禁` |
| 解封弹窗 | 标题 `解封这位用户？`；正文 `解封后，这位用户可以重新开始通话。`；按钮 `解封`；提示 `已解封` |
| 删除弹窗 | 标题 `删除这位用户的全部数据？`；正文 `会删除这位用户的记忆、通话记录、用量和日志，不能恢复。后台操作记录会保留。`；输入框标签 `请输入用户编号 <oid> 确认`；按钮 `删除`；提示 `已删除` |
| 通话列表 | 标题 `通话`；空：`这段时间没有通话。`；进行中：`进行中`；链接 `查看经过` |
| 加载失败 | 后端 `AdminError.message` 原样显示；按钮 `重试` |

不用全大写、`→`、`·` 拼接、渐变、统计卡网格。数字一律 `tabular-nums`（全局已设）。

## Steps

- [ ] **Step 1: 写失败的格式化与标签测试**

新建 `admin/test/format.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatCount,
  formatDateTime,
  formatDayLabel,
  formatDuration,
  formatMoney,
  formatPercent,
  formatSeconds,
  formatYuan,
  rangeStart,
  shanghaiDay,
} from '../src/format.ts';

describe('money', () => {
  it('converts micro-yuan to yuan with two decimals', () => {
    expect(formatYuan(4_300_000)).toBe('4.30 元');
    expect(formatYuan(10_000)).toBe('0.01 元');
    expect(formatYuan(9_999)).toBe('不到 0.01 元');
    expect(formatYuan(0)).toBe('0 元');
  });

  it('says 未定价 instead of 0 when nothing was priced', () => {
    expect(formatMoney({ tokens: 900, costMicroYuan: 0, unpricedCalls: 3 })).toBe('未定价');
    expect(formatMoney({ tokens: 900, costMicroYuan: 4_300_000, unpricedCalls: 3 })).toBe('4.30 元（3 次未定价）');
    expect(formatMoney({ tokens: 900, costMicroYuan: 4_300_000, unpricedCalls: 0 })).toBe('4.30 元');
    expect(formatMoney({ tokens: 0, costMicroYuan: 0, unpricedCalls: 0 })).toBe('0 元');
  });
});

describe('numbers and durations', () => {
  it('formats counts with 万 above ten thousand', () => {
    expect(formatCount(8231)).toBe('8,231');
    expect(formatCount(412_000)).toBe('41.2 万');
    expect(formatCount(3_456_789)).toBe('346 万');
  });

  it('formats durations and seconds in plain Chinese', () => {
    expect(formatDuration(760_000)).toBe('12 分 40 秒');
    expect(formatDuration(42_000)).toBe('42 秒');
    expect(formatDuration(3_900_000)).toBe('1 小时 5 分');
    expect(formatSeconds(1100)).toBe('1.1 秒');
    expect(formatSeconds(2000)).toBe('2 秒');
    expect(formatSeconds(null)).toBe('—');
    expect(formatPercent(0.123)).toBe('12%');
    expect(formatClock(195_400)).toBe('3:15');
    expect(formatClock(0)).toBe('0:00');
  });
});

describe('dates in Asia/Shanghai', () => {
  // 2026-10-26T16:30:00Z is 2026-10-27 00:30 in Shanghai.
  const justAfterMidnight = Date.parse('2026-10-26T16:30:00Z');

  it('cuts days at Shanghai midnight', () => {
    expect(shanghaiDay(justAfterMidnight)).toBe('2026-10-27');
    expect(shanghaiDay(Date.parse('2026-10-26T15:59:00Z'))).toBe('2026-10-26');
  });

  it('labels today', () => {
    expect(formatDayLabel('2026-10-27', '2026-10-27')).toBe('10月27日（今天）');
    expect(formatDayLabel('2026-10-03', '2026-10-27')).toBe('10月3日');
  });

  it('formats a timestamp as month, day and 24h time', () => {
    expect(formatDateTime(Date.parse('2026-10-27T06:02:00Z'))).toBe('10月27日 14:02');
  });

  it('starts ranges at Shanghai midnight', () => {
    expect(rangeStart('today', justAfterMidnight)).toBe(Date.parse('2026-10-26T16:00:00Z'));
    expect(rangeStart('7d', justAfterMidnight)).toBe(Date.parse('2026-10-20T16:00:00Z'));
    expect(rangeStart('30d', justAfterMidnight)).toBe(Date.parse('2026-09-27T16:00:00Z'));
  });
});
```

新建 `admin/test/labels.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/color.ts';
import { END_REASON_LABELS, characterName, endReasonLabel, kindLabel } from '../src/labels.ts';
import { CHARACTER_COLORS, palette } from '../src/theme.ts';

describe('labels', () => {
  it('covers every end reason the gateway writes (P1-T10 table)', () => {
    expect(Object.keys(END_REASON_LABELS).sort()).toEqual(
      ['client_end', 'grace_expired', 'owner_banned', 'shutdown', 'start_failed', 'start_timeout', 'unclaimed'].sort(),
    );
  });

  it('reads end reasons in plain words, including unknown and open sessions', () => {
    expect(endReasonLabel({ endedAt: 1, endReason: 'client_end' })).toBe('用户挂断');
    expect(endReasonLabel({ endedAt: null, endReason: null })).toBe('进行中');
    expect(endReasonLabel({ endedAt: 1, endReason: null })).toBe('未记录');
    expect(endReasonLabel({ endedAt: 1, endReason: 'new_reason' })).toBe('其他（new_reason）');
  });

  it('names characters and usage kinds', () => {
    expect(characterName('xiaonuan')).toBe('小暖');
    expect(characterName('unknown')).toBe('unknown');
    expect(kindLabel('realtime_reply')).toBe('实时通话');
    expect(kindLabel('memory_extract')).toBe('记忆整理');
    expect(kindLabel('other_kind')).toBe('other_kind');
  });

  it('gives each character a bar colour visible on white and on the page (WCAG 1.4.11, 3:1)', () => {
    const colours = Object.values(CHARACTER_COLORS);
    expect(new Set(colours).size).toBe(colours.length);
    for (const colour of colours) {
      expect(contrastRatio(colour, '#FFFFFF')).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(colour, palette.paper)).toBeGreaterThanOrEqual(3);
    }
  });
});
```

`END_REASON_LABELS` 的 7 个取值来自 `gateway/src/session/manager.ts` 里 `destroy(..., reason)` 的全部调用和 P2-T5 新增的 `owner_banned`。打开 `p1-10-session-columns-retention.md` 的结束原因取值表核对一次：表里多出的取值，同时补进测试数组和 `labels.ts`。

- [ ] **Step 2: 运行，确认失败**

```bash
npm test -w admin -- test/format.test.ts test/labels.test.ts
```

预期：FAIL，找不到 `../src/format.ts`、`../src/labels.ts`。

- [ ] **Step 3: 实现格式化与标签**

新建 `admin/src/format.ts`：

```ts
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

const RANGE_DAYS: Record<AdminRange, number> = { today: 1, '7d': 7, '30d': 30 };

/** First millisecond of the range, counted in whole Shanghai days ending today. */
export function rangeStart(range: AdminRange, now: number): number {
  const todayStart = Date.parse(`${shanghaiDay(now)}T00:00:00+08:00`);
  return todayStart - (RANGE_DAYS[range] - 1) * DAY_MS;
}
```

新建 `admin/src/labels.ts`：

```ts
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

/** Every reason the gateway writes to sessions.end_reason (P1-T10, P2-T5). */
export const END_REASON_LABELS: Record<string, string> = {
  client_end: '用户挂断',
  grace_expired: '网络断开后没有回来',
  unclaimed: '手机没有连上',
  start_timeout: '开始通话超时',
  start_failed: '开始通话失败',
  shutdown: '网关重启',
  owner_banned: '用户被封禁',
};

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
```

- [ ] **Step 4: 用 dataviz 选角色色**

调用 dataviz skill（`Skill("dataviz")`），任务描述：「三个类别（小暖、小凯、小欣）的横条颜色，放在白底和 `#F6F8F7` 底上；主色已是 `#2F6F68`（青瓷），错误色 `#B42318`（朱砂）、警示色 `#B7791F`（秋香）不能被占用；需要和青瓷协调、彼此可区分（含色觉障碍）」。按它的方法选色，并运行它附带的校验器。

在 `admin/src/theme.ts` 末尾追加（下面是起始值；dataviz 校验不通过或给出更好的组合时，换成它的结果，并在提交说明里记录校验器输出摘要）：

```ts
/** Bar colours per character, chosen and checked with the dataviz method (P2-T7 Step 4). */
export const CHARACTER_COLORS: Record<string, string> = {
  xiaonuan: '#2F6F68',
  xiaokai: '#3D5A80',
  xiaoxin: '#8E5572',
};
```

- [ ] **Step 5: 运行，确认通过**

```bash
npm test -w admin -- test/format.test.ts test/labels.test.ts
```

预期：PASS（format 8、labels 4）。

- [ ] **Step 6: 加载钩子与通用组件**

新建 `admin/src/useLoad.ts`：

```ts
import { useCallback, useEffect, useState } from 'react';
import { AdminApiError } from './api/client.ts';

export type Load<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

export function errorMessage(error: unknown): string {
  return error instanceof AdminApiError ? error.message : '后台出错了，请稍后再试。';
}

/** Loads once per deps change; stale responses are dropped. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): { state: Load<T>; reload: () => void } {
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    load().then(
      (data) => {
        if (live) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (live) setState({ status: 'error', message: errorMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { state, reload };
}
```

新建 `admin/src/usePaged.ts`：

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminPage } from '@anyidea/protocol';
import { errorMessage } from './useLoad.ts';

export interface Paged<T> {
  items: T[];
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  hasMore: boolean;
  more(): Promise<void>;
  reload(): void;
}

/** Cursor pagination for AdminPage<T> lists; deps change restarts from the first page. */
export function usePaged<T>(fetchPage: (cursor: string | null) => Promise<AdminPage<T>>, deps: readonly unknown[]): Paged<T> {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Paged<T>['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  useEffect(() => {
    let live = true;
    setStatus('loading');
    setItems([]);
    setError(null);
    fetchRef.current(null).then(
      (page) => {
        if (!live) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setStatus('ready');
      },
      (err: unknown) => {
        if (!live) return;
        setError(errorMessage(err));
        setStatus('error');
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);

  const more = useCallback(async () => {
    if (!cursor) return;
    try {
      const page = await fetchRef.current(cursor);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
      setStatus('error');
    }
  }, [cursor]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { items, status, error, hasMore: cursor !== null, more, reload };
}
```

新建 `admin/src/components/LoadError.tsx`：

```tsx
import { Alert, Button } from 'antd';

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert
      type="error"
      showIcon
      message={message}
      action={
        <Button size="small" onClick={onRetry}>
          重试
        </Button>
      }
      style={{ margin: '24px 0' }}
    />
  );
}
```

新建 `admin/src/components/InlineBar.tsx`：

```tsx
import { palette } from '../theme.ts';

export interface InlineBarProps { value: number; max: number; tone?: 'normal' | 'danger'; color?: string }

/** Thin bar next to a number showing its size relative to the column maximum. Decorative: the number carries the value. */
export function InlineBar({ value, max, tone = 'normal', color }: InlineBarProps) {
  const percent = max > 0 && value > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  const background = tone === 'danger' ? palette.cinnabar : color ?? palette.celadon;
  return (
    <span className="inline-bar" aria-hidden="true">
      <span data-testid="inline-bar-fill" data-tone={tone} style={{ width: `${percent}%`, background }} />
    </span>
  );
}
```

新建 `admin/src/components/PagedTable.tsx`：

```tsx
import { Button, Table, type TableColumnsType, type TableProps } from 'antd';
import type { Paged } from '../usePaged.ts';
import { LoadError } from './LoadError.tsx';

export interface PagedTableProps<T extends object> {
  paged: Paged<T>;
  columns: TableColumnsType<T>;
  rowKey: (row: T) => string;
  empty: string;
  expandable?: TableProps<T>['expandable'];
}

export function PagedTable<T extends object>({ paged, columns, rowKey, empty, expandable }: PagedTableProps<T>) {
  if (paged.status === 'error' && paged.items.length === 0) return <LoadError message={paged.error ?? ''} onRetry={paged.reload} />;
  if (paged.status === 'ready' && paged.items.length === 0) return <p className="caption">{empty}</p>;
  return (
    <>
      <Table<T>
        rowKey={rowKey}
        columns={columns}
        dataSource={paged.items}
        loading={paged.status === 'loading'}
        pagination={false}
        size="middle"
        {...(expandable ? { expandable } : {})}
      />
      {paged.hasMore && (
        <Button style={{ marginTop: 16 }} onClick={() => void paged.more()}>
          加载更多
        </Button>
      )}
    </>
  );
}
```

在 `admin/src/styles.css` 末尾追加：

```css
.section {
  margin-top: 40px;
}

.section h2 {
  font-size: 17px;
  margin-bottom: 12px;
}

.brief {
  margin: 24px 0 32px;
}

.brief-line {
  font-size: 30px;
  line-height: 1.5;
  margin: 0;
  max-width: 28em;
}

.brief-line a,
.brief-line .link-button {
  color: #2f6f68;
  text-decoration: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 6px;
}

.brief-delta {
  margin: 8px 0 0;
}

.link-button {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  cursor: pointer;
}

.alert-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.alert-list li {
  display: flex;
  align-items: center;
  gap: 8px;
}

.alert-list a {
  margin-left: 16px;
}

.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

.inline-bar {
  display: inline-block;
  width: 64px;
  height: 6px;
  margin-left: 8px;
  border-radius: 3px;
  background: #dce3e1;
  vertical-align: middle;
  overflow: hidden;
}

.inline-bar > span {
  display: block;
  height: 100%;
}

.num-cell {
  white-space: nowrap;
}

.spend-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 32px;
}

.spend-list li {
  display: flex;
  align-items: center;
  gap: 8px;
}

.page-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 0 24px;
}

.swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 8px;
  border-radius: 2px;
  vertical-align: middle;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}
```

- [ ] **Step 7: 写失败的简报句测试**

新建 `admin/test/brief.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Brief } from '../src/components/Brief.tsx';

const base = { owners: 12, callMinutes: 86, costMicroYuan: 4_300_000, errors: 2, deltaMinutesVsPrev: 18 };

describe('Brief', () => {
  it('reads as one plain sentence with the numbers inline', () => {
    render(<Brief range="today" brief={base} />);
    const line = screen.getByText((_, el) => el?.classList.contains('brief-line') ?? false);
    expect(line.textContent).toBe('今天 12 位老人聊了 86 分钟，花费约 4.30 元，出错 2 次。');
    expect(screen.getByText('比昨天多 18 分钟。')).toBeTruthy();
  });

  it('links each number to its detail', () => {
    render(<Brief range="today" brief={base} />);
    expect(screen.getByRole('link', { name: '12 位老人' }).getAttribute('href')).toBe('#/users');
    expect(screen.getByRole('link', { name: '86 分钟' }).getAttribute('href')).toBe('#/sessions');
    expect(screen.getByRole('link', { name: '2 次' }).getAttribute('href')).toBe('#/trace?level=error');
    expect(screen.getByRole('button', { name: '4.30 元' })).toBeTruthy();
  });

  it('says 没有出错 when there were no errors', () => {
    render(<Brief range="7d" brief={{ ...base, errors: 0, deltaMinutesVsPrev: -5 }} />);
    const line = screen.getByText((_, el) => el?.classList.contains('brief-line') ?? false);
    expect(line.textContent).toBe('近 7 天 12 位老人聊了 86 分钟，花费约 4.30 元，没有出错。');
    expect(screen.getByText('比前 7 天少 5 分钟。')).toBeTruthy();
  });

  it('handles tiny costs, no change and an empty day', () => {
    const { rerender } = render(<Brief range="30d" brief={{ ...base, costMicroYuan: 3_000, deltaMinutesVsPrev: 0 }} />);
    const line = screen.getByText((_, el) => el?.classList.contains('brief-line') ?? false);
    expect(line.textContent).toBe('近 30 天 12 位老人聊了 86 分钟，花费不到 0.01 元，出错 2 次。');
    expect(screen.getByText('和前 30 天一样。')).toBeTruthy();
    rerender(<Brief range="today" brief={{ owners: 0, callMinutes: 0, costMicroYuan: 0, errors: 0, deltaMinutesVsPrev: 0 }} />);
    expect(screen.getByText('今天还没有人通话。')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
```

- [ ] **Step 8: 运行，确认失败**

```bash
npm test -w admin -- test/brief.test.tsx
```

预期：FAIL，找不到 `../src/components/Brief.tsx`。

- [ ] **Step 9: 实现简报句**

新建 `admin/src/components/Brief.tsx`：

```tsx
import type { AdminOverview, AdminRange } from '@anyidea/protocol';
import { formatCount, formatYuan } from '../format.ts';
import { href } from '../router.ts';

const RANGE_WORD: Record<AdminRange, string> = { today: '今天', '7d': '近 7 天', '30d': '近 30 天' };
const PREVIOUS_WORD: Record<AdminRange, string> = { today: '昨天', '7d': '前 7 天', '30d': '前 30 天' };

function deltaSentence(range: AdminRange, delta: number): string {
  const previous = PREVIOUS_WORD[range];
  if (delta > 0) return `比${previous}多 ${formatCount(delta)} 分钟。`;
  if (delta < 0) return `比${previous}少 ${formatCount(-delta)} 分钟。`;
  return `和${previous}一样。`;
}

function scrollToSpend(): void {
  document.getElementById('spend')?.scrollIntoView?.({ block: 'start' });
}

/** The overview opens with one sentence a non-technical admin can read (spec「第一版方案与自查」1). */
export function Brief({ range, brief }: { range: AdminRange; brief: AdminOverview['brief'] }) {
  const when = RANGE_WORD[range];
  if (brief.owners === 0) {
    return (
      <section className="brief" aria-label="简报">
        <p className="brief-line">{when}还没有人通话。</p>
      </section>
    );
  }
  const cost = formatYuan(brief.costMicroYuan);
  const costLead = brief.costMicroYuan === 0 ? '花费 ' : cost.startsWith('不到') ? '花费' : '花费约 ';
  return (
    <section className="brief" aria-label="简报">
      <p className="brief-line">
        {when} <a href={href('/users')}>{brief.owners} 位老人</a>聊了 <a href={href('/sessions')}>{formatCount(brief.callMinutes)} 分钟</a>，{costLead}
        <button type="button" className="link-button" onClick={scrollToSpend}>
          {cost}
        </button>
        ，
        {brief.errors > 0 ? (
          <>
            出错 <a href={href('/trace', { level: 'error' })}>{brief.errors} 次</a>。
          </>
        ) : (
          '没有出错。'
        )}
      </p>
      <p className="brief-delta">{deltaSentence(range, brief.deltaMinutesVsPrev)}</p>
    </section>
  );
}
```

JSX 换行会吃掉行首行尾空白：`，{costLead}` 后换行接 `<button>`、`</button>` 后换行接 `，` 都不会产生多余空格；`{when} <a` 和 `聊了 <a` 同一行里的空格会保留。测试断言的是完整 `textContent`，空格多一个少一个都会失败。

- [ ] **Step 10: 运行，确认通过**

```bash
npm test -w admin -- test/brief.test.tsx
```

预期：PASS（4）。

- [ ] **Step 11: 写失败的总览页测试**

新建 `admin/test/overview.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { AdminOverview } from '@anyidea/protocol';
import { OverviewPage } from '../src/pages/OverviewPage.tsx';
import { palette } from '../src/theme.ts';
import { fakeFetch, renderWithProviders } from './helpers.tsx';

const NOW = Date.parse('2026-10-27T06:00:00Z'); // 14:00 in Shanghai

const overview: AdminOverview = {
  range: 'today',
  brief: { owners: 12, callMinutes: 86, costMicroYuan: 4_300_000, errors: 2, deltaMinutesVsPrev: 18 },
  days: [
    { day: '2026-10-26', owners: 10, callMinutes: 68, tokens: 330_000, costMicroYuan: 3_410_000, errors: 0 },
    { day: '2026-10-27', owners: 12, callMinutes: 86, tokens: 412_000, costMicroYuan: 4_300_000, errors: 2 },
  ],
  byKind: [
    { kind: 'memory_extract', costMicroYuan: 258_000, share: 0.06 },
    { kind: 'realtime_reply', costMicroYuan: 3_956_000, share: 0.92 },
    { kind: 'summarize', costMicroYuan: 86_000, share: 0.02 },
  ],
  latency: { firstAudioP50Ms: 1100, firstAudioP95Ms: 2800 },
  alerts: [{ code: 'first_audio_p95', value: 2800, threshold: 2000 }],
  adapter: 'qwen',
};

function setup(data: AdminOverview = overview) {
  const fake = fakeFetch({ 'GET /admin/api/overview': () => ({ body: data }) });
  renderWithProviders(<OverviewPage now={() => NOW} />, fake.fetch);
  return fake;
}

describe('OverviewPage', () => {
  it('opens with the brief sentence', async () => {
    setup();
    expect(await screen.findByText('比昨天多 18 分钟。')).toBeTruthy();
  });

  it('marks alerts in cinnabar with a plain explanation', async () => {
    setup();
    const item = await screen.findByText('近 1 小时首音延迟 p95 2.8 秒，超过 2 秒的提醒线');
    const row = item.closest('li')!;
    expect(row.getAttribute('data-tone')).toBe('danger');
    expect(row.style.color).toBe('rgb(180, 35, 24)'); // palette.cinnabar
    expect(palette.cinnabar).toBe('#B42318');
    expect(within(row).getByRole('link', { name: '查看' }).getAttribute('href')).toBe('#/sessions');
  });

  it('formats the error-rate alert as a percentage', async () => {
    setup({ ...overview, alerts: [{ code: 'error_rate_1h', value: 0.12, threshold: 0.05 }] });
    expect(await screen.findByText('近 1 小时出错率 12%，超过 5% 的提醒线')).toBeTruthy();
  });

  it('hides 需要留意 when nothing is wrong', async () => {
    setup({ ...overview, alerts: [] });
    await screen.findByText('比昨天多 18 分钟。');
    expect(screen.queryByText('需要留意')).toBeNull();
  });

  it('explains first-audio latency in words', async () => {
    setup();
    expect(await screen.findByText('首音延迟：一半的回复在 1.1 秒内开口，95% 在 2.8 秒内。')).toBeTruthy();
  });

  it('lists days newest first and labels today', async () => {
    setup();
    const today = await screen.findByText('10月27日（今天）');
    const rows = screen.getAllByRole('row');
    expect(rows.findIndex((r) => r.contains(today))).toBeLessThan(rows.findIndex((r) => r.textContent?.includes('10月26日')));
    expect(screen.getByText('41.2 万')).toBeTruthy();
  });

  it('shows where the money goes, largest share first', async () => {
    setup();
    const section = (await screen.findByText('钱花在哪里')).closest('section')!;
    const items = within(section).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['实时通话92%', '记忆整理6%', '对话摘要2%']);
  });

  it('tells the admin when Seeduplex usage is not counted', async () => {
    setup({ ...overview, adapter: 'seeduplex' });
    expect(await screen.findByText('当前使用 Seeduplex，通话用量不统计。')).toBeTruthy();
  });

  it('asks for mock data only when the switch is on', async () => {
    window.localStorage.setItem('admin.includeMock', '1');
    const { calls } = setup();
    await screen.findByText('比昨天多 18 分钟。');
    const call = calls.find((c) => c.url.pathname === '/admin/api/overview')!;
    expect(call.url.searchParams.get('mock')).toBe('1');
    expect(call.url.searchParams.get('range')).toBe('today');
  });

  it('shows the server message and a retry button on failure', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/overview': () => ({ status: 500, body: { error: 'internal', message: '统计数据暂时读不出来，请稍后再试。' } }) });
    renderWithProviders(<OverviewPage now={() => NOW} />, fetch);
    expect(await screen.findByText('统计数据暂时读不出来，请稍后再试。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
```

- [ ] **Step 12: 运行，确认失败**

```bash
npm test -w admin -- test/overview.test.tsx
```

预期：FAIL，找不到 `../src/pages/OverviewPage.tsx`。

- [ ] **Step 13: 实现总览页**

新建 `admin/src/pages/OverviewPage.tsx`：

```tsx
import { useState } from 'react';
import { Alert, Segmented, Spin, Table, type TableColumnsType } from 'antd';
import type { AdminOverview, AdminRange } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { Brief } from '../components/Brief.tsx';
import { InlineBar } from '../components/InlineBar.tsx';
import { LoadError } from '../components/LoadError.tsx';
import { formatCount, formatDayLabel, formatPercent, formatSeconds, formatYuan, shanghaiDay } from '../format.ts';
import { kindLabel } from '../labels.ts';
import { useViewOptions } from '../layout/ViewOptions.tsx';
import { href } from '../router.ts';
import { palette } from '../theme.ts';
import { useLoad } from '../useLoad.ts';

const RANGE_OPTIONS: Array<{ label: string; value: AdminRange }> = [
  { label: '今天', value: 'today' },
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
];

export function OverviewPage({ now = Date.now }: { now?: () => number }) {
  const api = useApi();
  const { includeMock } = useViewOptions();
  const [range, setRange] = useState<AdminRange>('today');
  const { state, reload } = useLoad(() => api.overview(range, includeMock), [api, range, includeMock]);
  return (
    <div>
      <Segmented<AdminRange> options={RANGE_OPTIONS} value={range} onChange={setRange} aria-label="时间范围" />
      {state.status === 'loading' && <Spin style={{ display: 'block', margin: '48px 0' }} />}
      {state.status === 'error' && <LoadError message={state.message} onRetry={reload} />}
      {state.status === 'ready' && <OverviewBody data={state.data} today={shanghaiDay(now())} />}
    </div>
  );
}

function OverviewBody({ data, today }: { data: AdminOverview; today: string }) {
  return (
    <>
      <Brief range={data.range} brief={data.brief} />
      {data.adapter === 'seeduplex' && <Alert type="info" showIcon message="当前使用 Seeduplex，通话用量不统计。" style={{ marginBottom: 24 }} />}
      {data.alerts.length > 0 && <AlertList alerts={data.alerts} />}
      <LatencyLine latency={data.latency} />
      <DaysTable days={data.days} today={today} />
      <SpendList byKind={data.byKind} />
    </>
  );
}

type OverviewAlert = AdminOverview['alerts'][number];

function alertText(alert: OverviewAlert): string {
  if (alert.code === 'error_rate_1h') return `近 1 小时出错率 ${formatPercent(alert.value)}，超过 ${formatPercent(alert.threshold)} 的提醒线`;
  return `近 1 小时首音延迟 p95 ${formatSeconds(alert.value)}，超过 ${formatSeconds(alert.threshold)} 的提醒线`;
}

function alertTarget(alert: OverviewAlert): string {
  return alert.code === 'error_rate_1h' ? href('/trace', { level: 'error' }) : href('/sessions');
}

function AlertList({ alerts }: { alerts: OverviewAlert[] }) {
  return (
    <section className="section" aria-labelledby="alerts-title">
      <h2 id="alerts-title">需要留意</h2>
      <ul className="alert-list">
        {alerts.map((alert) => (
          <li key={alert.code} data-tone="danger" style={{ color: palette.cinnabar }}>
            <span className="dot" aria-hidden="true" />
            <span>{alertText(alert)}</span>
            <a href={alertTarget(alert)}>查看</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LatencyLine({ latency }: { latency: AdminOverview['latency'] }) {
  const { firstAudioP50Ms: p50, firstAudioP95Ms: p95 } = latency;
  const text = p50 === null || p95 === null ? '首音延迟：还没有数据。' : `首音延迟：一半的回复在 ${formatSeconds(p50)}内开口，95% 在 ${formatSeconds(p95)}内。`;
  return <p className="prose">{text}</p>;
}

type DayRow = AdminOverview['days'][number];

function numberCell(text: string, value: number, max: number, tone: 'normal' | 'danger' = 'normal') {
  return (
    <span className="num-cell">
      {text}
      <InlineBar value={value} max={max} tone={tone} />
    </span>
  );
}

function DaysTable({ days, today }: { days: DayRow[]; today: string }) {
  const rows = [...days].sort((a, b) => b.day.localeCompare(a.day));
  const max = (pick: (d: DayRow) => number) => Math.max(0, ...rows.map(pick));
  const columns: TableColumnsType<DayRow> = [
    { title: '日期', dataIndex: 'day', render: (day: string) => formatDayLabel(day, today) },
    { title: '老人', dataIndex: 'owners', align: 'right', render: (v: number) => numberCell(formatCount(v), v, max((d) => d.owners)) },
    { title: '通话分钟', dataIndex: 'callMinutes', align: 'right', render: (v: number) => numberCell(formatCount(v), v, max((d) => d.callMinutes)) },
    { title: 'token', dataIndex: 'tokens', align: 'right', render: (v: number) => numberCell(formatCount(v), v, max((d) => d.tokens)) },
    { title: '费用', dataIndex: 'costMicroYuan', align: 'right', render: (v: number) => numberCell(formatYuan(v), v, max((d) => d.costMicroYuan)) },
    { title: '出错', dataIndex: 'errors', align: 'right', render: (v: number) => numberCell(String(v), v, max((d) => d.errors), v > 0 ? 'danger' : 'normal') },
  ];
  return (
    <section className="section" aria-labelledby="days-title">
      <h2 id="days-title">每天的情况</h2>
      {rows.length === 0 ? (
        <p className="caption">这段时间还没有通话。</p>
      ) : (
        <Table<DayRow> rowKey={(d) => d.day} size="middle" pagination={false} columns={columns} dataSource={rows} />
      )}
    </section>
  );
}

function SpendList({ byKind }: { byKind: AdminOverview['byKind'] }) {
  const rows = byKind.filter((r) => r.costMicroYuan > 0).sort((a, b) => b.share - a.share);
  return (
    <section id="spend" className="section" aria-labelledby="spend-title">
      <h2 id="spend-title">钱花在哪里</h2>
      {rows.length === 0 ? (
        <p className="caption">还没有产生费用。</p>
      ) : (
        <ul className="spend-list">
          {rows.map((row) => (
            <li key={row.kind}>
              <span>{kindLabel(row.kind)}</span>
              <span>{formatPercent(row.share)}</span>
              <InlineBar value={row.share} max={1} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

如果当前 Ant Design 版本的 `Segmented` 不支持泛型参数写法，改成 `<Segmented options={RANGE_OPTIONS} value={range} onChange={(v) => setRange(v as AdminRange)} />`，行为不变。

- [ ] **Step 14: 运行，确认通过**

```bash
npm test -w admin -- test/overview.test.tsx
```

预期：PASS（10）。

- [ ] **Step 15: 写失败的用户列表、用户详情、通话列表测试**

新建 `admin/test/users.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminOwnerRow } from '@anyidea/protocol';
import { UsersPage } from '../src/pages/UsersPage.tsx';
import { fakeFetch, renderWithProviders } from './helpers.tsx';

function owner(oid: string, overrides: Partial<AdminOwnerRow> = {}): AdminOwnerRow {
  return {
    oid,
    createdAt: Date.parse('2026-10-20T02:00:00Z'),
    lastSeenAt: Date.parse('2026-10-27T06:02:00Z'),
    banned: false,
    sessions: 9,
    memoryItems: 14,
    usage: { tokens: 120_000, costMicroYuan: 1_250_000, unpricedCalls: 0 },
    ...overrides,
  };
}

describe('UsersPage', () => {
  it('explains the re-register limitation above the table', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/owners': { items: [owner('3f9a1c2b4d5e')], nextCursor: null } });
    renderWithProviders(<UsersPage />, fetch);
    expect(await screen.findByText('同一台手机重新注册后会显示成新用户。')).toBeTruthy();
  });

  it('links each user to the detail page and shows status and money', async () => {
    const { fetch } = fakeFetch({
      'GET /admin/api/owners': {
        items: [owner('3f9a1c2b4d5e', { banned: true }), owner('aa11bb22cc33', { lastSeenAt: null, usage: { tokens: 10, costMicroYuan: 0, unpricedCalls: 2 } })],
        nextCursor: null,
      },
    });
    renderWithProviders(<UsersPage />, fetch);
    const link = await screen.findByRole('link', { name: '3f9a1c2b4d5e' });
    expect(link.getAttribute('href')).toBe('#/users/3f9a1c2b4d5e');
    expect(screen.getByText('已封禁')).toBeTruthy();
    expect(screen.getByText('1.25 元')).toBeTruthy();
    expect(screen.getByText('未定价')).toBeTruthy();
    expect(screen.getByText('还没用过')).toBeTruthy();
    expect(screen.getByText('10月27日 14:02')).toBeTruthy();
  });

  it('loads the next page with the cursor', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /admin/api/owners': (url) =>
        url.searchParams.get('cursor') === 'c2'
          ? { body: { items: [owner('bbbbbbbbbbbb')], nextCursor: null } }
          : { body: { items: [owner('aaaaaaaaaaaa')], nextCursor: 'c2' } },
    });
    renderWithProviders(<UsersPage />, fetch);
    await userEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    expect(await screen.findByRole('link', { name: 'bbbbbbbbbbbb' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'aaaaaaaaaaaa' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
    expect(calls.filter((c) => c.url.pathname === '/admin/api/owners').map((c) => c.url.searchParams.get('cursor'))).toEqual([null, 'c2']);
  });

  it('has an empty state', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/owners': { items: [], nextCursor: null } });
    renderWithProviders(<UsersPage />, fetch);
    expect(await screen.findByText('还没有用户注册。')).toBeTruthy();
  });
});
```

新建 `admin/test/user-detail.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminOwnerDetail } from '@anyidea/protocol';
import { UserDetailPage } from '../src/pages/UserDetailPage.tsx';
import { ME, fakeFetch, renderWithProviders } from './helpers.tsx';

const OID = '3f9a1c2b4d5e';

function detail(banned = false): AdminOwnerDetail {
  return {
    oid: OID,
    createdAt: Date.parse('2026-10-20T02:00:00Z'),
    lastSeenAt: Date.parse('2026-10-27T06:02:00Z'),
    banned,
    sessions: 9,
    memoryItems: 14,
    usage: { tokens: 120_000, costMicroYuan: 1_250_000, unpricedCalls: 0 },
    characters: [
      { character: 'xiaonuan', sessions: 6, memoryItems: 10, usage: { tokens: 90_000, costMicroYuan: 1_000_000, unpricedCalls: 0 } },
      { character: 'xiaokai', sessions: 3, memoryItems: 4, usage: { tokens: 30_000, costMicroYuan: 250_000, unpricedCalls: 0 } },
    ],
    daily: [{ day: '2026-10-27', tokens: 40_000, costMicroYuan: 420_000 }],
  };
}

describe('UserDetailPage', () => {
  it('summarises usage per character without any conversation content', async () => {
    const { fetch } = fakeFetch({ [`GET /admin/api/owners/${OID}`]: detail() });
    renderWithProviders(<UserDetailPage oid={OID} />, fetch);
    expect(await screen.findByText('累计 12.0 万 token，费用 1.25 元，通话 9 次，记忆 14 条。')).toBeTruthy();
    expect(screen.getByText('小暖')).toBeTruthy();
    expect(screen.getByText('小凯')).toBeTruthy();
    expect(screen.getByRole('link', { name: '查看这位用户的通话' }).getAttribute('href')).toBe(`#/sessions?oid=${OID}`);
  });

  it('bans after confirmation, with the CSRF header, then says 已封禁', async () => {
    let banned = false;
    const { fetch, calls } = fakeFetch({
      [`GET /admin/api/owners/${OID}`]: () => ({ body: detail(banned) }),
      [`POST /admin/api/owners/${OID}/ban`]: () => {
        banned = true;
        return { status: 204 };
      },
    });
    renderWithProviders(<UserDetailPage oid={OID} />, fetch);
    await userEvent.click(await screen.findByRole('button', { name: '封禁这位用户' }));
    expect(await screen.findByText('封禁后，这位用户正在进行的通话会立即结束，之后不能开始新通话。数据不会删除，解封后一切恢复。')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '封禁' }));
    // The page title also gets an 已封禁 tag after reload, so check the toast itself.
    await waitFor(() => expect(document.querySelector('.ant-message')?.textContent).toContain('已封禁'));
    const ban = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/ban'))!;
    expect(new Headers(ban.init.headers).get('x-csrf-token')).toBe(ME.csrfToken);
    expect(await screen.findByRole('button', { name: '解封这位用户' })).toBeTruthy();
  });

  it('deletes only after the exact user id is typed, then returns to the list', async () => {
    const { fetch, calls } = fakeFetch({
      [`GET /admin/api/owners/${OID}`]: detail(),
      [`DELETE /admin/api/owners/${OID}`]: () => ({ status: 204 }),
    });
    renderWithProviders(<UserDetailPage oid={OID} />, fetch);
    await userEvent.click(await screen.findByRole('button', { name: '删除全部数据' }));
    const confirm = await screen.findByRole('button', { name: '删除' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(`请输入用户编号 ${OID} 确认`), '3f9a1c');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(`请输入用户编号 ${OID} 确认`), '2b4d5e');
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() => expect(window.location.hash).toBe('#/users'));
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(JSON.parse(String(del.init.body))).toEqual({ confirm: OID });
    expect(new Headers(del.init.headers).get('x-csrf-token')).toBe(ME.csrfToken);
    expect(await screen.findByText('已删除')).toBeTruthy();
  });
});
```

新建 `admin/test/sessions.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type { AdminSessionRow } from '@anyidea/protocol';
import { SessionsPage } from '../src/pages/SessionsPage.tsx';
import { fakeFetch, renderWithProviders } from './helpers.tsx';

const SID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const NOW = Date.parse('2026-10-27T06:30:00Z');

function row(overrides: Partial<AdminSessionRow> = {}): AdminSessionRow {
  return {
    sid: SID,
    oid: '3f9a1c2b4d5e',
    character: 'xiaonuan',
    adapter: 'qwen',
    startedAt: Date.parse('2026-10-27T06:02:00Z'),
    endedAt: Date.parse('2026-10-27T06:14:40Z'),
    endReason: 'client_end',
    replies: 21,
    errors: 1,
    firstAudioP50Ms: 1100,
    usage: { tokens: 41_000, costMicroYuan: 430_000, unpricedCalls: 0 },
    ...overrides,
  };
}

describe('SessionsPage', () => {
  it('lists calls with plain duration, end reason and a link to the trace', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/sessions': { items: [row(), row({ sid: 'open-1', endedAt: null, endReason: null })], nextCursor: null } });
    renderWithProviders(<SessionsPage oid={undefined} now={() => NOW} />, fetch);
    expect(await screen.findByText('12 分 40 秒')).toBeTruthy();
    expect(screen.getByText('用户挂断')).toBeTruthy();
    expect(screen.getAllByText('进行中').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('link', { name: '查看经过' })[0]!.getAttribute('href')).toBe(`#/trace/${SID}`);
    expect(screen.getAllByText('小暖').length).toBe(2);
  });

  it('filters by the user from the address and by today in Shanghai', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /admin/api/sessions': { items: [], nextCursor: null } });
    renderWithProviders(<SessionsPage oid="3f9a1c2b4d5e" now={() => NOW} />, fetch);
    expect(await screen.findByText('这段时间没有通话。')).toBeTruthy();
    const call = calls.find((c) => c.url.pathname === '/admin/api/sessions')!;
    expect(call.url.searchParams.get('oid')).toBe('3f9a1c2b4d5e');
    expect(call.url.searchParams.get('from')).toBe(String(Date.parse('2026-10-26T16:00:00Z')));
  });
});
```

- [ ] **Step 16: 运行，确认失败**

```bash
npm test -w admin -- test/users.test.tsx test/user-detail.test.tsx test/sessions.test.tsx
```

预期：FAIL，找不到三个页面文件。

- [ ] **Step 17: 实现用户列表、用户详情、通话列表**

新建 `admin/src/pages/UsersPage.tsx`：

```tsx
import { Tag, type TableColumnsType } from 'antd';
import type { AdminOwnerRow } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { PagedTable } from '../components/PagedTable.tsx';
import { formatDateTime, formatMoney } from '../format.ts';
import { useViewOptions } from '../layout/ViewOptions.tsx';
import { href } from '../router.ts';
import { usePaged } from '../usePaged.ts';

const columns: TableColumnsType<AdminOwnerRow> = [
  { title: '用户编号', dataIndex: 'oid', render: (oid: string) => <a href={href(`/users/${oid}`)}>{oid}</a> },
  { title: '注册时间', dataIndex: 'createdAt', render: (ts: number) => formatDateTime(ts) },
  { title: '最后活跃', dataIndex: 'lastSeenAt', render: (ts: number | null) => (ts === null ? '还没用过' : formatDateTime(ts)) },
  { title: '通话次数', dataIndex: 'sessions', align: 'right' },
  { title: '记忆条数', dataIndex: 'memoryItems', align: 'right' },
  { title: '累计费用', key: 'usage', align: 'right', render: (_: unknown, row: AdminOwnerRow) => formatMoney(row.usage) },
  { title: '状态', dataIndex: 'banned', render: (banned: boolean) => (banned ? <Tag color="error">已封禁</Tag> : null) },
];

export function UsersPage() {
  const api = useApi();
  const { includeMock } = useViewOptions();
  const paged = usePaged((cursor) => api.owners(cursor, includeMock), [api, includeMock]);
  return (
    <div>
      <h1 className="page-title">用户</h1>
      <p className="caption">同一台手机重新注册后会显示成新用户。</p>
      <PagedTable paged={paged} columns={columns} rowKey={(row) => row.oid} empty="还没有用户注册。" />
    </div>
  );
}
```

新建 `admin/src/pages/UserDetailPage.tsx`：

```tsx
import { useState } from 'react';
import { App, Button, Input, Modal, Spin, Table, Tag, type TableColumnsType } from 'antd';
import type { AdminOwnerDetail } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { InlineBar } from '../components/InlineBar.tsx';
import { LoadError } from '../components/LoadError.tsx';
import { formatCount, formatDateTime, formatDayLabel, formatMoney, formatYuan, shanghaiDay } from '../format.ts';
import { characterName } from '../labels.ts';
import { useViewOptions } from '../layout/ViewOptions.tsx';
import { href, navigate } from '../router.ts';
import { CHARACTER_COLORS } from '../theme.ts';
import { errorMessage, useLoad } from '../useLoad.ts';

type CharacterRow = AdminOwnerDetail['characters'][number];
type DailyRow = AdminOwnerDetail['daily'][number];

export function UserDetailPage({ oid }: { oid: string }) {
  const api = useApi();
  const { includeMock } = useViewOptions();
  const { modal, message } = App.useApp();
  const [deleting, setDeleting] = useState(false);
  const { state, reload } = useLoad(() => api.owner(oid, includeMock), [api, oid, includeMock]);

  if (state.status === 'loading') return <Spin style={{ display: 'block', margin: '48px 0' }} />;
  if (state.status === 'error') return <LoadError message={state.message} onRetry={reload} />;
  const owner = state.data;

  function confirmBan() {
    modal.confirm({
      title: '封禁这位用户？',
      content: '封禁后，这位用户正在进行的通话会立即结束，之后不能开始新通话。数据不会删除，解封后一切恢复。',
      okText: '封禁',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.banOwner(oid);
          message.success('已封禁');
          reload();
        } catch (error) {
          message.error(errorMessage(error));
        }
      },
    });
  }

  function confirmUnban() {
    modal.confirm({
      title: '解封这位用户？',
      content: '解封后，这位用户可以重新开始通话。',
      okText: '解封',
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.unbanOwner(oid);
          message.success('已解封');
          reload();
        } catch (error) {
          message.error(errorMessage(error));
        }
      },
    });
  }

  return (
    <div>
      <h1 className="page-title">
        用户 {oid} {owner.banned && <Tag color="error">已封禁</Tag>}
      </h1>
      <p className="caption">
        注册于 {formatDateTime(owner.createdAt)}，{owner.lastSeenAt === null ? '还没用过' : `最后活跃 ${formatDateTime(owner.lastSeenAt)}`}。
      </p>
      <div className="page-actions">
        {owner.banned ? <Button onClick={confirmUnban}>解封这位用户</Button> : <Button onClick={confirmBan}>封禁这位用户</Button>}
        <Button danger onClick={() => setDeleting(true)}>
          删除全部数据
        </Button>
        <a href={href('/sessions', { oid })}>查看这位用户的通话</a>
      </div>
      <p className="prose">
        累计 {formatCount(owner.usage.tokens)} token，费用 {formatMoney(owner.usage)}，通话 {owner.sessions} 次，记忆 {owner.memoryItems} 条。
      </p>
      <CharacterTable rows={owner.characters} />
      <DailyTable rows={owner.daily} />
      <DeleteOwnerModal oid={oid} open={deleting} onClose={() => setDeleting(false)} />
    </div>
  );
}

function CharacterTable({ rows }: { rows: CharacterRow[] }) {
  const maxCost = Math.max(0, ...rows.map((r) => r.usage.costMicroYuan));
  const columns: TableColumnsType<CharacterRow> = [
    {
      title: '角色',
      dataIndex: 'character',
      render: (id: string) => (
        <span>
          <span className="swatch" style={{ background: CHARACTER_COLORS[id] ?? '#4D5D63' }} aria-hidden="true" />
          {characterName(id)}
        </span>
      ),
    },
    { title: '通话次数', dataIndex: 'sessions', align: 'right' },
    { title: '记忆条数', dataIndex: 'memoryItems', align: 'right' },
    { title: 'token', key: 'tokens', align: 'right', render: (_: unknown, r: CharacterRow) => formatCount(r.usage.tokens) },
    {
      title: '费用',
      key: 'cost',
      align: 'right',
      render: (_: unknown, r: CharacterRow) => (
        <span className="num-cell">
          {formatMoney(r.usage)}
          <InlineBar value={r.usage.costMicroYuan} max={maxCost} {...(CHARACTER_COLORS[r.character] ? { color: CHARACTER_COLORS[r.character] } : {})} />
        </span>
      ),
    },
  ];
  return (
    <section className="section" aria-labelledby="characters-title">
      <h2 id="characters-title">各角色</h2>
      {rows.length === 0 ? (
        <p className="caption">这位用户还没和任何角色通过话。</p>
      ) : (
        <Table<CharacterRow> rowKey={(r) => r.character} size="middle" pagination={false} columns={columns} dataSource={rows} />
      )}
    </section>
  );
}

function DailyTable({ rows }: { rows: DailyRow[] }) {
  const sorted = [...rows].sort((a, b) => b.day.localeCompare(a.day));
  const today = shanghaiDay(Date.now());
  const maxCost = Math.max(0, ...sorted.map((r) => r.costMicroYuan));
  const columns: TableColumnsType<DailyRow> = [
    { title: '日期', dataIndex: 'day', render: (day: string) => formatDayLabel(day, today) },
    { title: 'token', dataIndex: 'tokens', align: 'right', render: (v: number) => formatCount(v) },
    {
      title: '费用',
      dataIndex: 'costMicroYuan',
      align: 'right',
      render: (v: number) => (
        <span className="num-cell">
          {formatYuan(v)}
          <InlineBar value={v} max={maxCost} />
        </span>
      ),
    },
  ];
  return (
    <section className="section" aria-labelledby="daily-title">
      <h2 id="daily-title">每天的用量</h2>
      {sorted.length === 0 ? (
        <p className="caption">这段时间还没有用量。</p>
      ) : (
        <Table<DailyRow> rowKey={(r) => r.day} size="middle" pagination={false} columns={columns} dataSource={sorted} />
      )}
    </section>
  );
}

function DeleteOwnerModal({ oid, open, onClose }: { oid: string; open: boolean; onClose: () => void }) {
  const api = useApi();
  const { message } = App.useApp();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  function close() {
    setTyped('');
    onClose();
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteOwner(oid);
      message.success('已删除');
      close();
      navigate('/users');
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="删除这位用户的全部数据？"
      okText="删除"
      cancelText="取消"
      okButtonProps={{ danger: true, disabled: typed !== oid, loading: busy }}
      onOk={() => void remove()}
      onCancel={close}
    >
      <p>会删除这位用户的记忆、通话记录、用量和日志，不能恢复。后台操作记录会保留。</p>
      <label htmlFor="confirm-oid">请输入用户编号 {oid} 确认</label>
      <Input id="confirm-oid" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
    </Modal>
  );
}
```

`<label>` 里 `请输入用户编号 {oid} 确认` 渲染出的文本是 `请输入用户编号 3f9a1c2b4d5e 确认`，测试按这个完整文本找输入框。

新建 `admin/src/pages/SessionsPage.tsx`：

```tsx
import { useState } from 'react';
import { Segmented, Select, type TableColumnsType } from 'antd';
import type { AdminRange, AdminSessionRow } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { PagedTable } from '../components/PagedTable.tsx';
import { formatDateTime, formatDuration, formatMoney, formatSeconds, rangeStart } from '../format.ts';
import { characterName, endReasonLabel } from '../labels.ts';
import { useViewOptions } from '../layout/ViewOptions.tsx';
import { href } from '../router.ts';
import { palette } from '../theme.ts';
import { usePaged } from '../usePaged.ts';

const RANGE_OPTIONS: Array<{ label: string; value: AdminRange }> = [
  { label: '今天', value: 'today' },
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
];

const CHARACTER_OPTIONS = [
  { label: '全部角色', value: '' },
  { label: '小暖', value: 'xiaonuan' },
  { label: '小凯', value: 'xiaokai' },
  { label: '小欣', value: 'xiaoxin' },
];

const columns: TableColumnsType<AdminSessionRow> = [
  { title: '开始时间', dataIndex: 'startedAt', render: (ts: number) => formatDateTime(ts) },
  { title: '角色', dataIndex: 'character', render: (id: string) => characterName(id) },
  { title: '用户', dataIndex: 'oid', render: (oid: string) => <a href={href(`/users/${oid}`)}>{oid}</a> },
  { title: '时长', key: 'duration', render: (_: unknown, r: AdminSessionRow) => (r.endedAt === null ? '进行中' : formatDuration(r.endedAt - r.startedAt)) },
  { title: '回复', dataIndex: 'replies', align: 'right' },
  {
    title: '出错',
    dataIndex: 'errors',
    align: 'right',
    render: (v: number) => <span style={v > 0 ? { color: palette.cinnabar } : undefined}>{v}</span>,
  },
  { title: '首音（中位数）', dataIndex: 'firstAudioP50Ms', align: 'right', render: (v: number | null) => formatSeconds(v) },
  { title: '费用', key: 'usage', align: 'right', render: (_: unknown, r: AdminSessionRow) => formatMoney(r.usage) },
  { title: '结束方式', key: 'end', render: (_: unknown, r: AdminSessionRow) => endReasonLabel(r) },
  { title: '', key: 'trace', render: (_: unknown, r: AdminSessionRow) => <a href={href(`/trace/${r.sid}`)}>查看经过</a> },
];

export function SessionsPage({ oid, now = Date.now }: { oid: string | undefined; now?: () => number }) {
  const api = useApi();
  const { includeMock } = useViewOptions();
  const [range, setRange] = useState<AdminRange>('today');
  const [character, setCharacter] = useState('');
  const from = rangeStart(range, now());
  const paged = usePaged(
    (cursor) => api.sessions({ ...(oid ? { oid } : {}), ...(character ? { character } : {}), from, cursor, includeMock }),
    [api, oid, character, from, includeMock],
  );
  return (
    <div>
      <h1 className="page-title">通话</h1>
      <div className="toolbar">
        <Segmented<AdminRange> options={RANGE_OPTIONS} value={range} onChange={setRange} aria-label="时间范围" />
        <Select value={character} options={CHARACTER_OPTIONS} onChange={setCharacter} style={{ width: 140 }} aria-label="角色" />
        {oid && (
          <span className="caption">
            只看用户 {oid}，<a href={href('/sessions')}>看全部</a>
          </span>
        )}
      </div>
      <PagedTable paged={paged} columns={columns} rowKey={(r) => r.sid} empty="这段时间没有通话。" />
    </div>
  );
}
```

`from` 由 `rangeStart(range, now())` 算出，同一天内值不变，不会因为重新渲染反复请求。

- [ ] **Step 18: 接上路由**

把 `admin/src/routes.tsx` 改为：

```tsx
import { OverviewPage } from './pages/OverviewPage.tsx';
import { SessionsPage } from './pages/SessionsPage.tsx';
import { UserDetailPage } from './pages/UserDetailPage.tsx';
import { UsersPage } from './pages/UsersPage.tsx';
import { useRoute } from './router.ts';

function TitleOnly({ title }: { title: string }) {
  return <h1 className="page-title">{title}</h1>;
}

/** Route table. P2-T8 replaces the remaining TitleOnly entries. */
export function PageRoutes() {
  const route = useRoute();
  const [top, id] = route.segments;
  switch (top) {
    case 'users':
      return id ? <UserDetailPage oid={id} /> : <UsersPage />;
    case 'sessions':
      return <SessionsPage oid={route.query.get('oid') ?? undefined} />;
    case 'trace':
      return <TitleOnly title="排查" />;
    case 'audit':
      return <TitleOnly title="审计" />;
    default:
      return <OverviewPage />;
  }
}
```

- [ ] **Step 19: 全量测试、typecheck、构建**

```bash
npm test -w admin
npm run typecheck -w admin
npm run build -w admin
```

预期：全部 PASS（P2-T6 的 18 个 + 本任务 format 8、labels 4、brief 4、overview 10、users 4、user-detail 3、sessions 2，共 53）；typecheck 无输出；build 成功。

`user-detail` 的「已封禁」「已删除」提示是 Ant Design `message`，渲染进 `document.body` 下的 `.ant-message`。若因动画导致找不到，在 `renderWithProviders` 的 `ConfigProvider theme` 里加 `token: { ...adminTheme.token, motion: false }`（只改测试辅助），不要在页面里去掉提示。

- [ ] **Step 20: 自查文案与设计**

用 `npm run dev -w admin` 打开总览、用户、用户详情、通话四个页面（需要按 P2-T9 Step 2 的方法起一个带 Mock 数据的网关），逐条对照本文件「文案」表和 spec「文案规则」，在提交说明里写「已对照」：
- 没有统计卡网格，总览第一屏是简报句；
- 只有异常行是朱砂色，其他地方不出现红色；
- 金额都有「元」，未定价的地方写「未定价」；
- 按钮名和成功提示一致（封禁 / 已封禁，解封 / 已解封，删除 / 已删除）。

- [ ] **Step 21: 提交**

```bash
git add admin/src/format.ts admin/src/labels.ts admin/src/useLoad.ts admin/src/usePaged.ts admin/src/components admin/src/pages admin/src/theme.ts admin/src/styles.css admin/src/routes.tsx admin/test/format.test.ts admin/test/labels.test.ts admin/test/brief.test.tsx admin/test/overview.test.tsx admin/test/users.test.tsx admin/test/user-detail.test.tsx admin/test/sessions.test.tsx
git commit -m "feat(admin): overview brief, users and calls pages

Money in yuan from micro-yuan, 未定价 for unpriced calls, alerts in cinnabar.
Character bar colours checked with the dataviz method.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
