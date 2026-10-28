# P2-T8: 排查页（会话时间线与日志筛选）、审计页、临时日志级别

**目标：** 实现「查问题」一组：
- 排查页：粘贴手机上的诊断编号或通话编号即可打开一通会话的时间线；没有编号时按用户、事件、级别、时间筛选日志；
- 时间线沿用节奏尺的刻度语言：左侧相对时间，横条长度是首音延迟，超过提醒线标朱砂；
- 审计页：按操作和时间筛选后台操作记录；
- 临时把日志调到更详细（全局或某位用户），到时自动恢复。

**实现的 spec 章节：** 「界面设计」的「排查（会话时间线）」线框、「其他页面」中的审计；「日志」中级别与按 owner 覆盖；决策 Q25、Q26、Q27、Q30。

**前置：** P2-T4、P2-T5、P2-T6、P2-T7 已合入（本任务复用 P2-T7 的 `format.ts`、`labels.ts`、`usePaged`、`PagedTable`、`LoadError`）。开始前跑：

```bash
npm test -w admin && npm run typecheck -w admin
```

预期全绿（53 个用例）。

**Files:**
- Create: `admin/src/diag.ts`
- Create: `admin/src/components/Timeline.tsx`、`admin/src/components/LogLevelControl.tsx`
- Create: `admin/src/pages/TracePage.tsx`、`admin/src/pages/AuditPage.tsx`
- Modify: `admin/src/format.ts`（追加 `formatTimeOfDay`）
- Modify: `admin/src/labels.ts`（追加事件、级别、审计动作标签）
- Modify: `admin/src/styles.css`（追加时间线样式）
- Modify: `admin/src/routes.tsx`（接上排查、审计）
- Test: `admin/test/diag.test.ts`、`admin/test/timeline.test.tsx`、`admin/test/trace.test.tsx`、`admin/test/audit.test.tsx`、`admin/test/log-level.test.tsx`；`admin/test/format.test.ts`（追加一个用例）

**Interfaces:**
- Consumes（P2-T6/T7）：`useApi()`、`href()`、`navigate()`、`useRoute()`、`usePaged`、`PagedTable`、`LoadError`、`useLoad`、`errorMessage`、`formatClock`、`formatDateTime`、`formatDuration`、`formatMoney`、`formatSeconds`、`characterName`、`endReasonLabel`、`palette`、`fakeFetch`、`renderWithProviders`；`AdminApi` 中的 `timeline`、`logs`、`audit`、`logLevel`、`setLogLevel`，类型 `LogQuery`、`LogLevelName`；C6 类型 `AdminTimeline`（含 `firstAudioAlertMs`）、`AdminTimelineItem`、`AdminLogRow`、`AdminAuditRow`；P2-T1 类型 `AdminLogLevelState`、`AdminLogLevelRequest`。
- 对后端的假设（与 P1、P2-T4/T5 对齐，不一致以后端为准）：
  - 时间线事件名沿用网关现有日志事件：`session_created`、`session_destroyed`、`reply_metrics`（字段 `speech_to_first_audio_ms`、`vad_to_first_audio_ms`）、`adapter_error`（`code`）、`upstream_error`（`code`、`attempt`）、`response_cancel`、`model_rebuild`。未知事件按原名显示，不丢弃。
  - 提醒线：`AdminTimeline.firstAudioAlertMs`（毫秒，P2-T1 加入类型、P2-T4 从 `admin.json` 的 `alerts.firstAudioP95Ms` 填入）。首音超过它的回复标朱砂。
  - 日志级别：`GET /admin/api/log-level` 返回 `AdminLogLevelState`（`global` 是此刻对没有用户覆盖的日志生效的级别，`overrides` 只含未过期的覆盖）；`POST` 返回同一形状（P2-T5）。
  - 诊断编号格式由 P4 决定；本页只要求编号里含一段通话编号（UUID），可选再含 12 位十六进制的用户短 id，分隔符不限。
- Produces：
  - `admin/src/diag.ts`：`parseDiagInput(raw)` → `DiagTarget`
  - `admin/src/components/Timeline.tsx`：`Timeline`、`sortTimeline(items)`、`timelineLabel(item)`
  - `admin/src/components/LogLevelControl.tsx`：`LogLevelControl`
  - `admin/src/format.ts`：`formatTimeOfDay(ts, withSeconds?)`
  - `admin/src/labels.ts`：`levelLabel(level)`、`actionLabel(action)`、`AUDIT_ACTION_LABELS`

## 文案（逐字使用）

| 位置 | 文案 |
|---|---|
| 排查标题 | `排查` |
| 搜索 | 标签 `诊断编号或通话编号`；按钮 `查找`；认不出：`没认出这个编号。请粘贴手机设置页「复制诊断编号」得到的内容，或者一段通话编号。` |
| 时间线标题 | `小暖和用户 3f9a1c2b4d5e 的通话` |
| 时间线说明 | `10月27日 14:02 开始，时长 12 分 40 秒，用户挂断`；进行中：`10月27日 14:02 开始，还在进行` |
| 时间线汇总 | `回复 21 次，出错 1 次，费用 0.43 元。` |
| 时间线条目 | `开始通话`、`结束通话`、`第 3 次回复`、`首音 3.4 秒`、`上游出错 rate_limited（第 2 次尝试）`、`模型出错 qwen_socket_error`、`回复被打断`、`重新连接模型`；展开 `详情`；返回 `看全部日志` |
| 日志筛选 | 标签 `用户编号`、`事件`、`级别`；`全部级别`、`错误`、`警告`、`一般`、`详细`；按钮 `筛选`；空：`这个时间段没有日志，试试放宽时间范围。` |
| 日志级别控件 | 标题 `临时调高日志详细程度`；说明 `排查某位用户的问题时，可以临时记录更多细节（仍然不含对话内容），到时间会自动恢复。`；`某位用户`、`全部用户`；级别 `详细`、`一般`、`只看警告`、`只看错误`；按钮 `应用`；缺编号：`请填写 12 位用户编号。`；成功：`已应用，30 分钟后自动恢复`；生效中：`用户 3f9a1c2b4d5e 详细，到 14:32 恢复` / `全部用户 详细，到 14:32 恢复` |
| 审计 | 标题 `审计`；列 `时间`、`操作`、`对象`、`详情`；`全部操作`；空：`这个时间段没有后台操作。` |

## Steps

- [x] **Step 1: 写失败的诊断编号与格式化测试**

新建 `admin/test/diag.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseDiagInput } from '../src/diag.ts';

const SID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

describe('parseDiagInput', () => {
  it('finds the session id in a pasted diagnostic code, with or without the owner id', () => {
    expect(parseDiagInput(` ${SID} `)).toEqual({ kind: 'session', sid: SID, oid: null });
    expect(parseDiagInput(`${SID}-3f9a1c2b4d5e`)).toEqual({ kind: 'session', sid: SID, oid: '3f9a1c2b4d5e' });
    expect(parseDiagInput(`诊断编号：${SID.toUpperCase()} / 3F9A1C2B4D5E`)).toEqual({ kind: 'session', sid: SID, oid: '3f9a1c2b4d5e' });
  });

  it('accepts a bare owner id', () => {
    expect(parseDiagInput('3f9a1c2b4d5e')).toEqual({ kind: 'owner', oid: '3f9a1c2b4d5e' });
  });

  it('rejects anything else', () => {
    expect(parseDiagInput('')).toEqual({ kind: 'invalid' });
    expect(parseDiagInput('hello')).toEqual({ kind: 'invalid' });
    expect(parseDiagInput('3f9a1c2b4d5e7')).toEqual({ kind: 'invalid' });
  });
});
```

在 `admin/test/format.test.ts` 的 `describe('dates in Asia/Shanghai', ...)` 里追加一个用例（顶部 import 加 `formatTimeOfDay`）：

```ts
  it('formats the time of day', () => {
    const ts = Date.parse('2026-10-27T06:02:31Z');
    expect(formatTimeOfDay(ts)).toBe('14:02');
    expect(formatTimeOfDay(ts, true)).toBe('14:02:31');
  });
```

- [x] **Step 2: 运行，确认失败**

```bash
npm test -w admin -- test/diag.test.ts test/format.test.ts
```

预期：FAIL，找不到 `../src/diag.ts`；`formatTimeOfDay` 不是导出。

- [x] **Step 3: 实现**

新建 `admin/src/diag.ts`：

```ts
const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const OWNER_ID = /(?<![0-9a-f])[0-9a-f]{12}(?![0-9a-f])/;

export type DiagTarget = { kind: 'session'; sid: string; oid: string | null } | { kind: 'owner'; oid: string } | { kind: 'invalid' };

/** Reads what an admin pastes from the phone: a session UUID, optionally with the owner short id. */
export function parseDiagInput(raw: string): DiagTarget {
  const text = raw.trim().toLowerCase();
  const sid = SESSION_ID.exec(text)?.[0];
  if (sid) {
    const rest = text.replace(sid, ' ');
    return { kind: 'session', sid, oid: OWNER_ID.exec(rest)?.[0] ?? null };
  }
  const oid = OWNER_ID.exec(text)?.[0];
  return oid ? { kind: 'owner', oid } : { kind: 'invalid' };
}
```

在 `admin/src/format.ts` 末尾追加：

```ts
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
```

- [x] **Step 4: 运行，确认通过**

```bash
npm test -w admin -- test/diag.test.ts test/format.test.ts
```

预期：PASS（diag 3、format 9）。

- [x] **Step 5: 写失败的时间线测试**

新建 `admin/test/timeline.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { AdminTimeline } from '@anyidea/protocol';
import { Timeline, sortTimeline, timelineLabel } from '../src/components/Timeline.tsx';

const START = Date.parse('2026-10-27T06:02:00Z');

function timeline(overrides: Partial<AdminTimeline['session']> = {}): AdminTimeline {
  return {
    session: {
      sid: '1b4e28ba-2fa1-11d2-883f-0016d3cca427',
      oid: '3f9a1c2b4d5e',
      character: 'xiaonuan',
      adapter: 'qwen',
      startedAt: START,
      endedAt: START + 760_000,
      endReason: 'client_end',
      replies: 21,
      errors: 1,
      firstAudioP50Ms: 1100,
      usage: { tokens: 41_000, costMicroYuan: 430_000, unpricedCalls: 0 },
      ...overrides,
    },
    // Deliberately out of order: the page sorts by time.
    items: [
      { ts: START + 195_000, level: 'warn', event: 'upstream_error', seq: null, fields: { code: 'rate_limited', attempt: 2 } },
      { ts: START + 3_000, level: 'info', event: 'reply_metrics', seq: 1, fields: { speech_to_first_audio_ms: 1100 } },
      { ts: START, level: 'info', event: 'session_created', seq: null, fields: {} },
      { ts: START + 195_000, level: 'info', event: 'reply_metrics', seq: 3, fields: { speech_to_first_audio_ms: 3400 } },
      { ts: START + 41_000, level: 'info', event: 'reply_metrics', seq: 2, fields: { vad_to_first_audio_ms: 900 } },
      { ts: START + 760_000, level: 'info', event: 'session_destroyed', seq: null, fields: { reason: 'client_end' } },
    ],
    firstAudioAlertMs: 2000,
  };
}

describe('timeline helpers', () => {
  it('sorts by time, then by reply number, keeping unnumbered events after numbered ones at the same time', () => {
    const sorted = sortTimeline(timeline().items).map((i) => `${i.event}:${i.seq ?? '-'}`);
    expect(sorted).toEqual(['session_created:-', 'reply_metrics:1', 'reply_metrics:2', 'reply_metrics:3', 'upstream_error:-', 'session_destroyed:-']);
  });

  it('names events in plain words and keeps unknown names', () => {
    const t = timeline();
    expect(timelineLabel(t.items[0]!)).toBe('上游出错 rate_limited（第 2 次尝试）');
    expect(timelineLabel(t.items[1]!)).toBe('第 1 次回复');
    expect(timelineLabel({ ts: 0, level: 'error', event: 'adapter_error', seq: null, fields: { code: 'qwen_socket_error' } })).toBe('模型出错 qwen_socket_error');
    expect(timelineLabel({ ts: 0, level: 'info', event: 'tool_invoked', seq: null, fields: {} })).toBe('tool_invoked');
  });
});

describe('Timeline', () => {
  it('opens with who, when, how long and how it ended', () => {
    render(<Timeline timeline={timeline()} />);
    expect(screen.getByRole('heading', { name: '小暖和用户 3f9a1c2b4d5e 的通话' })).toBeTruthy();
    expect(screen.getByText('10月27日 14:02 开始，时长 12 分 40 秒，用户挂断')).toBeTruthy();
    expect(screen.getByText('回复 21 次，出错 1 次，费用 0.43 元。')).toBeTruthy();
  });

  it('says a call is still going', () => {
    render(<Timeline timeline={timeline({ endedAt: null, endReason: null })} />);
    expect(screen.getByText('10月27日 14:02 开始，还在进行')).toBeTruthy();
  });

  it('shows relative times and latency bars proportional to first-audio time', () => {
    render(<Timeline timeline={timeline()} />);
    // Only the timeline rows; the field lists under 详情 are list items too.
    const rows = Array.from(document.querySelectorAll('.timeline > li')) as HTMLElement[];
    expect(rows.map((r) => within(r).getByTestId('timeline-clock').textContent)).toEqual(['0:00', '0:03', '0:41', '3:15', '3:15', '12:40']);
    const bars = screen.getAllByTestId('latency-bar');
    const widths = bars.map((b) => parseInt(b.style.width, 10));
    expect(widths).toHaveLength(3);
    // 1.1 s : 0.9 s : 3.4 s
    expect(widths[2]! / widths[0]!).toBeCloseTo(3400 / 1100, 1);
    expect(widths[1]!).toBeLessThan(widths[0]!);
    expect(screen.getByText('首音 3.4 秒')).toBeTruthy();
  });

  it('marks replies slower than the alert line in cinnabar', () => {
    render(<Timeline timeline={timeline()} />);
    const bars = screen.getAllByTestId('latency-bar');
    expect(bars.map((b) => b.getAttribute('data-tone'))).toEqual(['normal', 'normal', 'danger']);
    expect(bars[2]!.style.background).toBe('rgb(180, 35, 24)');
  });

  it('follows the alert line the server sends', () => {
    const t = { ...timeline(), firstAudioAlertMs: 5000 };
    render(<Timeline timeline={t} />);
    expect(screen.getAllByTestId('latency-bar').every((b) => b.getAttribute('data-tone') === 'normal')).toBe(true);
  });

  it('keeps every field available under 详情', () => {
    render(<Timeline timeline={timeline()} />);
    const details = screen.getAllByText('详情');
    expect(details.length).toBe(6);
    expect(screen.getByText('reason：client_end')).toBeTruthy();
  });
});
```

- [x] **Step 6: 运行，确认失败**

```bash
npm test -w admin -- test/timeline.test.tsx
```

预期：FAIL，找不到 `../src/components/Timeline.tsx`。

- [x] **Step 7: 实现标签与时间线**

在 `admin/src/labels.ts` 末尾追加：

```ts
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
```

在 `admin/src/styles.css` 末尾追加：

```css
.timeline {
  list-style: none;
  margin: 24px 0 0;
  padding: 0;
  border-left: 2px solid #dce3e1;
}

.timeline li {
  display: grid;
  grid-template-columns: 64px minmax(240px, 1fr) 280px;
  align-items: start;
  column-gap: 16px;
  padding: 6px 0 6px 16px;
}

.timeline-clock {
  text-align: right;
  color: #4d5d63;
}

.timeline-bar {
  display: inline-block;
  height: 6px;
  margin-left: 8px;
  border-radius: 3px;
  vertical-align: middle;
}

.timeline details {
  grid-column: 2 / 4;
  font-size: 13px;
}

.timeline details ul {
  margin: 4px 0 0;
  padding-left: 16px;
}
```

新建 `admin/src/components/Timeline.tsx`：

```tsx
import type { AdminTimeline, AdminTimelineItem } from '@anyidea/protocol';
import { formatClock, formatDateTime, formatDuration, formatMoney, formatSeconds } from '../format.ts';
import { characterName, endReasonLabel } from '../labels.ts';
import { palette } from '../theme.ts';

/** The timeline payload; firstAudioAlertMs comes from admin.json alerts.firstAudioP95Ms. */
export type TimelineData = AdminTimeline;

const BAR_MAX_PX = 240;
const MIN_SCALE_MS = 1000;

export function sortTimeline(items: readonly AdminTimelineItem[]): AdminTimelineItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (a.item.ts !== b.item.ts) return a.item.ts - b.item.ts;
      const sa = a.item.seq ?? Number.POSITIVE_INFINITY;
      const sb = b.item.seq ?? Number.POSITIVE_INFINITY;
      return sa !== sb ? sa - sb : a.index - b.index;
    })
    .map(({ item }) => item);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstAudioMs(item: AdminTimelineItem): number | null {
  if (item.event !== 'reply_metrics') return null;
  return num(item.fields.speech_to_first_audio_ms) ?? num(item.fields.vad_to_first_audio_ms);
}

export function timelineLabel(item: AdminTimelineItem): string {
  const code = typeof item.fields.code === 'string' ? item.fields.code : '';
  switch (item.event) {
    case 'session_created':
      return '开始通话';
    case 'session_destroyed':
      return '结束通话';
    case 'reply_metrics': {
      const seq = item.seq ?? num(item.fields.seq);
      return seq === null ? '回复' : `第 ${seq} 次回复`;
    }
    case 'upstream_error': {
      const attempt = num(item.fields.attempt);
      return `上游出错 ${code}${attempt === null ? '' : `（第 ${attempt} 次尝试）`}`;
    }
    case 'adapter_error':
      return `模型出错 ${code}`;
    case 'response_cancel':
      return '回复被打断';
    case 'model_rebuild':
      return '重新连接模型';
    default:
      return item.event;
  }
}

export function Timeline({ timeline }: { timeline: TimelineData }) {
  const { session } = timeline;
  const items = sortTimeline(timeline.items);
  const slowMs = timeline.firstAudioAlertMs;
  const latencies = items.map(firstAudioMs).filter((v): v is number => v !== null);
  const scale = Math.max(MIN_SCALE_MS, slowMs, ...latencies);
  const when = `${formatDateTime(session.startedAt)} 开始`;
  const how = session.endedAt === null ? '还在进行' : `时长 ${formatDuration(session.endedAt - session.startedAt)}，${endReasonLabel(session)}`;

  return (
    <section aria-labelledby="timeline-title">
      <h2 id="timeline-title" style={{ fontSize: 22 }}>
        {characterName(session.character)}和用户 {session.oid} 的通话
      </h2>
      <p className="caption">
        {when}，{how}
      </p>
      <p className="prose">
        回复 {session.replies} 次，出错 {session.errors} 次，费用 {formatMoney(session.usage)}。
      </p>
      <ol className="timeline">
        {items.map((item, index) => {
          const ms = firstAudioMs(item);
          const slow = ms !== null && slowMs !== null && ms > slowMs;
          const danger = item.level === 'error';
          return (
            <li key={`${item.ts}-${index}`}>
              <span className="timeline-clock" data-testid="timeline-clock">
                {formatClock(item.ts - session.startedAt)}
              </span>
              <span style={danger ? { color: palette.cinnabar } : undefined}>{timelineLabel(item)}</span>
              <span>
                {ms !== null && (
                  <>
                    首音 {formatSeconds(ms)}
                    <span
                      className="timeline-bar"
                      data-testid="latency-bar"
                      data-tone={slow ? 'danger' : 'normal'}
                      style={{ width: `${Math.max(2, Math.round((ms / scale) * BAR_MAX_PX))}px`, background: slow ? palette.cinnabar : palette.celadon }}
                    />
                  </>
                )}
              </span>
              <details>
                <summary>详情</summary>
                <ul>
                  {Object.entries(item.fields).map(([key, value]) => (
                    <li key={key}>
                      {key}：{String(value)}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
```

`首音 {formatSeconds(ms)}` 渲染出 `首音 3.4 秒`，测试按完整文本查找；横条没有文字，不影响 `textContent`。

- [x] **Step 8: 运行，确认通过**

```bash
npm test -w admin -- test/timeline.test.tsx
```

预期：PASS（8）。

- [x] **Step 9: 写失败的排查页、日志级别、审计页测试**

新建 `admin/test/trace.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminLogRow } from '@anyidea/protocol';
import { TracePage } from '../src/pages/TracePage.tsx';
import { fakeFetch, renderWithProviders } from './helpers.tsx';

const SID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

function log(id: number, overrides: Partial<AdminLogRow> = {}): AdminLogRow {
  return {
    id,
    ts: Date.parse('2026-10-27T06:02:31Z') + id * 1000,
    level: 'error',
    event: 'adapter_error',
    seq: null,
    fields: { code: 'qwen_socket_error' },
    sid: SID,
    oid: '3f9a1c2b4d5e',
    char: 'xiaonuan',
    job: null,
    ...overrides,
  };
}

describe('TracePage search', () => {
  it('opens the timeline for a pasted diagnostic code', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/logs': { items: [], nextCursor: null } });
    renderWithProviders(<TracePage sid={undefined} query={new URLSearchParams()} />, fetch);
    await userEvent.type(screen.getByLabelText('诊断编号或通话编号'), `${SID}-3f9a1c2b4d5e{Enter}`);
    await waitFor(() => expect(window.location.hash).toBe(`#/trace/${SID}`));
  });

  it('filters logs by owner when only an owner id is pasted', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/logs': { items: [], nextCursor: null } });
    renderWithProviders(<TracePage sid={undefined} query={new URLSearchParams()} />, fetch);
    await userEvent.type(screen.getByLabelText('诊断编号或通话编号'), '3f9a1c2b4d5e');
    await userEvent.click(screen.getByRole('button', { name: '查找' }));
    await waitFor(() => expect(window.location.hash).toBe('#/trace?oid=3f9a1c2b4d5e'));
  });

  it('explains what to paste when the code is not recognised', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/logs': { items: [], nextCursor: null } });
    renderWithProviders(<TracePage sid={undefined} query={new URLSearchParams()} />, fetch);
    await userEvent.type(screen.getByLabelText('诊断编号或通话编号'), 'hello{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('没认出这个编号。请粘贴手机设置页「复制诊断编号」得到的内容，或者一段通话编号。');
  });
});

describe('TracePage logs', () => {
  it('passes the address filters to the API and shows plain level names', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /admin/api/logs': { items: [log(1)], nextCursor: null } });
    renderWithProviders(<TracePage sid={undefined} query={new URLSearchParams('level=error&oid=3f9a1c2b4d5e')} />, fetch);
    expect(await screen.findByText('错误')).toBeTruthy();
    const call = calls.find((c) => c.url.pathname === '/admin/api/logs')!;
    expect(call.url.searchParams.get('level')).toBe('error');
    expect(call.url.searchParams.get('oid')).toBe('3f9a1c2b4d5e');
    expect(screen.getByRole('link', { name: '查看经过' }).getAttribute('href')).toBe(`#/trace/${SID}`);
    expect(screen.getByText('10月27日 14:02:32')).toBeTruthy();
  });

  it('loads more with the cursor and has an empty state', async () => {
    const first = fakeFetch({
      'GET /admin/api/logs': (url) =>
        url.searchParams.get('cursor') === 'n2' ? { body: { items: [log(2, { event: 'model_rebuild', level: 'info' })], nextCursor: null } } : { body: { items: [log(1)], nextCursor: 'n2' } },
    });
    renderWithProviders(<TracePage sid={undefined} query={new URLSearchParams()} />, first.fetch);
    await userEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('一般')).toBeTruthy();
  });

  it('shows the empty state', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/logs': { items: [], nextCursor: null } });
    renderWithProviders(<TracePage sid={undefined} query={new URLSearchParams()} />, fetch);
    expect(await screen.findByText('这个时间段没有日志，试试放宽时间范围。')).toBeTruthy();
  });
});

describe('TracePage timeline', () => {
  it('loads the session timeline and links back to all logs', async () => {
    const { fetch } = fakeFetch({
      [`GET /admin/api/sessions/${SID}/timeline`]: {
        session: {
          sid: SID, oid: '3f9a1c2b4d5e', character: 'xiaokai', adapter: 'qwen',
          startedAt: Date.parse('2026-10-27T06:02:00Z'), endedAt: null, endReason: null,
          replies: 0, errors: 0, firstAudioP50Ms: null, usage: { tokens: 0, costMicroYuan: 0, unpricedCalls: 0 },
        },
        items: [],
      },
    });
    renderWithProviders(<TracePage sid={SID} query={new URLSearchParams()} />, fetch);
    expect(await screen.findByRole('heading', { name: '小凯和用户 3f9a1c2b4d5e 的通话' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '看全部日志' }).getAttribute('href')).toBe('#/trace');
  });
});
```

新建 `admin/test/log-level.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogLevelControl } from '../src/components/LogLevelControl.tsx';
import { ME, fakeFetch, renderWithProviders } from './helpers.tsx';

describe('LogLevelControl', () => {
  const idle = { 'GET /admin/api/log-level': { global: 'info', overrides: [] } };

  it('shows the current level and the overrides that are still active', async () => {
    const until = Date.now() + 12 * 60_000;
    const { fetch } = fakeFetch({ 'GET /admin/api/log-level': { global: 'info', overrides: [{ scope: 'owner', oid: '3f9a1c2b4d5e', level: 'debug', until }] } });
    renderWithProviders(<LogLevelControl />, fetch);
    expect(await screen.findByText('现在全部用户按「一般」记录。')).toBeTruthy();
    expect(screen.getByText(/^用户 3f9a1c2b4d5e 详细，到 \d{2}:\d{2} 恢复$/)).toBeTruthy();
  });

  it('needs a 12-character user id for a single user', async () => {
    const { fetch, calls } = fakeFetch(idle);
    renderWithProviders(<LogLevelControl />, fetch);
    await screen.findByText('现在全部用户按「一般」记录。');
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    expect((await screen.findByRole('alert')).textContent).toBe('请填写 12 位用户编号。');
    expect(calls.some((c) => c.method === 'POST' && c.url.pathname === '/admin/api/log-level')).toBe(false);
  });

  it('sends the override with the CSRF header and says when it ends', async () => {
    const until = Date.now() + 30 * 60_000;
    const { fetch, calls } = fakeFetch({
      ...idle,
      'POST /admin/api/log-level': () => ({ body: { global: 'info', overrides: [{ scope: 'owner', oid: '3f9a1c2b4d5e', level: 'debug', until }] } }),
    });
    renderWithProviders(<LogLevelControl />, fetch);
    await userEvent.type(screen.getByLabelText('用户编号'), '3F9A1C2B4D5E');
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    await waitFor(() => expect(document.querySelector('.ant-message')?.textContent).toContain('已应用，30 分钟后自动恢复'));
    const call = calls.find((c) => c.method === 'POST' && c.url.pathname === '/admin/api/log-level')!;
    expect(JSON.parse(String(call.init.body))).toEqual({ scope: 'owner', oid: '3f9a1c2b4d5e', level: 'debug' });
    expect(new Headers(call.init.headers).get('x-csrf-token')).toBe(ME.csrfToken);
    expect(screen.getByText(/^用户 3f9a1c2b4d5e 详细，到 \d{2}:\d{2} 恢复$/)).toBeTruthy();
  });

  it('can raise the level for everyone without a user id', async () => {
    const until = Date.now() + 30 * 60_000;
    const { fetch, calls } = fakeFetch({
      ...idle,
      'POST /admin/api/log-level': () => ({ body: { global: 'debug', overrides: [{ scope: 'global', oid: null, level: 'debug', until }] } }),
    });
    renderWithProviders(<LogLevelControl />, fetch);
    await userEvent.click(screen.getByText('全部用户'));
    expect(screen.queryByLabelText('用户编号')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    await screen.findByText(/^全部用户 详细，到 \d{2}:\d{2} 恢复$/);
    expect(screen.getByText('现在全部用户按「详细」记录。')).toBeTruthy();
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ scope: 'global', level: 'debug' });
  });
});
```

新建 `admin/test/audit.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type { AdminAuditRow } from '@anyidea/protocol';
import { AuditPage, formatAuditDetail } from '../src/pages/AuditPage.tsx';
import { fakeFetch, renderWithProviders } from './helpers.tsx';

const rows: AdminAuditRow[] = [
  { id: 2, ts: Date.parse('2026-10-27T06:10:00Z'), actor: 'admin', action: 'owner_banned', target: '3f9a1c2b4d5e', detail: {} },
  { id: 1, ts: Date.parse('2026-10-27T06:00:00Z'), actor: 'admin', action: 'log_level_changed', target: null, detail: { scope: 'global', level: 'debug' } },
];

describe('formatAuditDetail', () => {
  it('reads key/value pairs and from/to changes', () => {
    expect(formatAuditDetail({})).toBe('—');
    expect(formatAuditDetail({ scope: 'global', level: 'debug' })).toBe('scope：global；level：debug');
    expect(formatAuditDetail({ 'pacing:restReminder.firstAfterMs': { from: 5_400_000, to: 3_600_000 } })).toBe('pacing:restReminder.firstAfterMs：5400000 → 3600000');
  });
});

describe('AuditPage', () => {
  it('lists admin actions in plain words', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/audit': { items: rows, nextCursor: null } });
    renderWithProviders(<AuditPage />, fetch);
    expect(await screen.findByText('封禁用户')).toBeTruthy();
    expect(screen.getByText('调整日志详细程度')).toBeTruthy();
    expect(screen.getByText('scope：global；level：debug')).toBeTruthy();
    expect(screen.getByText('3f9a1c2b4d5e')).toBeTruthy();
  });

  it('has an empty state', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/audit': { items: [], nextCursor: null } });
    renderWithProviders(<AuditPage />, fetch);
    expect(await screen.findByText('这个时间段没有后台操作。')).toBeTruthy();
  });
});
```

审计里的旧值→新值是配置项的数值和开关（spec「后台 HTTP API」审计说明），提示词只记「已修改」和字数，所以这里原样显示不会带出内容。

- [x] **Step 10: 运行，确认失败**

```bash
npm test -w admin -- test/trace.test.tsx test/log-level.test.tsx test/audit.test.tsx
```

预期：FAIL，找不到 `TracePage.tsx`、`LogLevelControl.tsx`、`AuditPage.tsx`。

- [x] **Step 11: 实现日志级别控件**

新建 `admin/src/components/LogLevelControl.tsx`：

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { App, Button, Input, Segmented, Select } from 'antd';
import type { AdminLogLevelState } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import type { LogLevelName } from '../api/endpoints.ts';
import { formatTimeOfDay } from '../format.ts';
import { levelLabel } from '../labels.ts';
import { errorMessage } from '../useLoad.ts';

type Scope = 'owner' | 'global';

const SCOPE_OPTIONS: Array<{ label: string; value: Scope }> = [
  { label: '某位用户', value: 'owner' },
  { label: '全部用户', value: 'global' },
];

const LEVEL_OPTIONS: Array<{ label: string; value: LogLevelName }> = [
  { label: '详细', value: 'debug' },
  { label: '一般', value: 'info' },
  { label: '只看警告', value: 'warn' },
  { label: '只看错误', value: 'error' },
];

const OWNER_ID = /^[0-9a-f]{12}$/;

export function LogLevelControl() {
  const api = useApi();
  const { message } = App.useApp();
  const [scope, setScope] = useState<Scope>('owner');
  const [oid, setOid] = useState('');
  const [level, setLevel] = useState<LogLevelName>('debug');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<AdminLogLevelState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.logLevel().then(
      (current) => live && setState(current),
      (err: unknown) => live && setLoadError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [api]);

  async function apply(event: FormEvent) {
    event.preventDefault();
    const owner = oid.trim().toLowerCase();
    if (scope === 'owner' && !OWNER_ID.test(owner)) {
      setError('请填写 12 位用户编号。');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await api.setLogLevel(scope === 'owner' ? { scope, oid: owner, level } : { scope, level });
      setState(result);
      setLoadError(null);
      const mine = result.overrides.find((o) => o.scope === scope && (scope === 'global' || o.oid === owner));
      const minutes = mine ? Math.max(1, Math.round((mine.until - Date.now()) / 60_000)) : null;
      message.success(minutes === null ? '已应用' : `已应用，${minutes} 分钟后自动恢复`);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section" aria-labelledby="log-level-title">
      <h2 id="log-level-title">临时调高日志详细程度</h2>
      <p className="caption prose">排查某位用户的问题时，可以临时记录更多细节（仍然不含对话内容），到时间会自动恢复。</p>
      {state && <p className="prose">现在全部用户按「{levelLabel(state.global)}」记录。</p>}
      {loadError && <p className="caption prose">读不到当前设置：{loadError}</p>}
      <form className="toolbar" onSubmit={apply} noValidate>
        <Segmented<Scope> options={SCOPE_OPTIONS} value={scope} onChange={setScope} aria-label="范围" />
        {scope === 'owner' && (
          <>
            <label htmlFor="log-level-oid">用户编号</label>
            <Input id="log-level-oid" value={oid} onChange={(e) => setOid(e.target.value)} style={{ width: 180 }} autoComplete="off" />
          </>
        )}
        <Select value={level} options={LEVEL_OPTIONS} onChange={setLevel} style={{ width: 120 }} aria-label="详细程度" />
        <Button type="primary" htmlType="submit" loading={busy}>
          应用
        </Button>
      </form>
      {error && (
        <p role="alert" className="login-error">
          {error}
        </p>
      )}
      {state && state.overrides.length > 0 && (
        <ul className="prose">
          {state.overrides.map((o) => (
            <li key={`${o.scope}-${o.oid ?? 'all'}`}>
              {o.scope === 'global' ? '全部用户' : `用户 ${o.oid}`} {levelLabel(o.level)}，到 {formatTimeOfDay(o.until)} 恢复
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

`<li>` 内 `{...} {levelLabel(...)}，到 {...} 恢复` 渲染出 `用户 3f9a1c2b4d5e 详细，到 14:32 恢复`，测试用正则匹配整段文本。

- [x] **Step 12: 实现排查页与审计页**

新建 `admin/src/pages/TracePage.tsx`：

```tsx
import { useState, type FormEvent } from 'react';
import { Button, Input, Select, Spin, type TableColumnsType } from 'antd';
import type { AdminLogRow } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import type { LogLevelName } from '../api/endpoints.ts';
import { LoadError } from '../components/LoadError.tsx';
import { LogLevelControl } from '../components/LogLevelControl.tsx';
import { PagedTable } from '../components/PagedTable.tsx';
import { Timeline, timelineLabel, type TimelineData } from '../components/Timeline.tsx';
import { parseDiagInput } from '../diag.ts';
import { formatDateTime, formatTimeOfDay } from '../format.ts';
import { levelLabel } from '../labels.ts';
import { href, navigate } from '../router.ts';
import { palette } from '../theme.ts';
import { useLoad } from '../useLoad.ts';
import { usePaged } from '../usePaged.ts';

const NOT_RECOGNISED = '没认出这个编号。请粘贴手机设置页「复制诊断编号」得到的内容，或者一段通话编号。';
const LEVELS: LogLevelName[] = ['error', 'warn', 'info', 'debug'];

function levelColor(level: string): string | undefined {
  if (level === 'error') return palette.cinnabar;
  if (level === 'warn') return palette.amberText;
  return undefined;
}

const columns: TableColumnsType<AdminLogRow> = [
  { title: '时间', dataIndex: 'ts', render: (ts: number) => `${formatDateTime(ts).split(' ')[0]} ${formatTimeOfDay(ts, true)}` },
  { title: '级别', dataIndex: 'level', render: (level: string) => <span style={{ color: levelColor(level) }}>{levelLabel(level)}</span> },
  { title: '事件', key: 'event', render: (_: unknown, row: AdminLogRow) => timelineLabel(row) },
  { title: '用户', dataIndex: 'oid', render: (oid: string | null) => (oid ? <a href={href(`/users/${oid}`)}>{oid}</a> : '—') },
  { title: '通话', dataIndex: 'sid', render: (sid: string | null) => (sid ? <a href={href(`/trace/${sid}`)}>查看经过</a> : '—') },
];

function DiagSearch() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    const target = parseDiagInput(value);
    if (target.kind === 'invalid') {
      setError(NOT_RECOGNISED);
      return;
    }
    setError(null);
    if (target.kind === 'session') navigate(`/trace/${target.sid}`);
    else navigate('/trace', { oid: target.oid });
  }
  return (
    <form onSubmit={submit} noValidate style={{ marginBottom: 24 }}>
      <div className="toolbar">
        <label htmlFor="diag-input">诊断编号或通话编号</label>
        <Input id="diag-input" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 420 }} autoComplete="off" />
        <Button type="primary" htmlType="submit">
          查找
        </Button>
      </div>
      {error && (
        <p role="alert" className="login-error">
          {error}
        </p>
      )}
    </form>
  );
}

function LogFilters({ query }: { query: URLSearchParams }) {
  const [oid, setOid] = useState(query.get('oid') ?? '');
  const [event, setEvent] = useState(query.get('event') ?? '');
  const [level, setLevel] = useState(query.get('level') ?? '');
  function submit(e: FormEvent) {
    e.preventDefault();
    navigate('/trace', { oid: oid.trim().toLowerCase() || undefined, event: event.trim() || undefined, level: level || undefined });
  }
  return (
    <form className="toolbar" onSubmit={submit} noValidate>
      <label htmlFor="filter-oid">用户编号</label>
      <Input id="filter-oid" value={oid} onChange={(e) => setOid(e.target.value)} style={{ width: 160 }} autoComplete="off" />
      <label htmlFor="filter-event">事件</label>
      <Input id="filter-event" value={event} onChange={(e) => setEvent(e.target.value)} style={{ width: 180 }} autoComplete="off" />
      <Select
        value={level}
        onChange={setLevel}
        style={{ width: 120 }}
        aria-label="级别"
        options={[{ label: '全部级别', value: '' }, ...LEVELS.map((l) => ({ label: levelLabel(l), value: l }))]}
      />
      <Button htmlType="submit">筛选</Button>
    </form>
  );
}

function LogList({ query }: { query: URLSearchParams }) {
  const api = useApi();
  const oid = query.get('oid') ?? undefined;
  const event = query.get('event') ?? undefined;
  const levelParam = query.get('level');
  const level = LEVELS.find((l) => l === levelParam);
  const paged = usePaged(
    (cursor) => api.logs({ ...(oid ? { oid } : {}), ...(event ? { event } : {}), ...(level ? { level } : {}), cursor }),
    [api, oid, event, level],
  );
  return (
    <>
      <LogFilters key={query.toString()} query={query} />
      <PagedTable
        paged={paged}
        columns={columns}
        rowKey={(row) => String(row.id)}
        empty="这个时间段没有日志，试试放宽时间范围。"
        expandable={{
          expandedRowRender: (row) => (
            <ul className="prose" style={{ margin: 0 }}>
              {Object.entries(row.fields).map(([key, value]) => (
                <li key={key}>
                  {key}：{String(value)}
                </li>
              ))}
            </ul>
          ),
        }}
      />
    </>
  );
}

function SessionTimeline({ sid }: { sid: string }) {
  const api = useApi();
  const { state, reload } = useLoad(() => api.timeline(sid), [api, sid]);
  return (
    <>
      <p>
        <a href={href('/trace')}>看全部日志</a>
      </p>
      {state.status === 'loading' && <Spin style={{ display: 'block', margin: '48px 0' }} />}
      {state.status === 'error' && <LoadError message={state.message} onRetry={reload} />}
      {state.status === 'ready' && <Timeline timeline={state.data as TimelineData} />}
    </>
  );
}

export function TracePage({ sid, query }: { sid: string | undefined; query: URLSearchParams }) {
  return (
    <div>
      <h1 className="page-title">排查</h1>
      <DiagSearch />
      {sid ? <SessionTimeline sid={sid} /> : <LogList query={query} />}
      <LogLevelControl />
    </div>
  );
}
```

`时间` 列由 `formatDateTime` 的日期部分加 `formatTimeOfDay(ts, true)` 组成，例如 `10月27日 14:02:32`。

新建 `admin/src/pages/AuditPage.tsx`：

```tsx
import { useState } from 'react';
import { Segmented, Select, type TableColumnsType } from 'antd';
import type { AdminAuditRow, AdminRange } from '@anyidea/protocol';
import { useApi } from '../auth/AuthContext.tsx';
import { PagedTable } from '../components/PagedTable.tsx';
import { formatDateTime, rangeStart } from '../format.ts';
import { AUDIT_ACTION_LABELS, actionLabel } from '../labels.ts';
import { usePaged } from '../usePaged.ts';

const RANGE_OPTIONS: Array<{ label: string; value: AdminRange }> = [
  { label: '今天', value: 'today' },
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
];

function display(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'from' in value && 'to' in value) {
    const change = value as { from: unknown; to: unknown };
    return `${String(change.from)} → ${String(change.to)}`;
  }
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

/** Audit detail holds keys and numeric/switch changes only; prompts appear as 已修改 (spec). */
export function formatAuditDetail(detail: Record<string, unknown>): string {
  const entries = Object.entries(detail);
  if (entries.length === 0) return '—';
  return entries.map(([key, value]) => `${key}：${display(value)}`).join('；');
}

const columns: TableColumnsType<AdminAuditRow> = [
  { title: '时间', dataIndex: 'ts', render: (ts: number) => formatDateTime(ts) },
  { title: '操作', dataIndex: 'action', render: (action: string) => actionLabel(action) },
  { title: '对象', dataIndex: 'target', render: (target: string | null) => target ?? '—' },
  { title: '详情', dataIndex: 'detail', render: (detail: Record<string, unknown>) => formatAuditDetail(detail) },
];

export function AuditPage({ now = Date.now }: { now?: () => number }) {
  const api = useApi();
  const [range, setRange] = useState<AdminRange>('7d');
  const [action, setAction] = useState('');
  const from = rangeStart(range, now());
  const paged = usePaged((cursor) => api.audit({ ...(action ? { action } : {}), from, cursor }), [api, action, from]);
  return (
    <div>
      <h1 className="page-title">审计</h1>
      <div className="toolbar">
        <Segmented<AdminRange> options={RANGE_OPTIONS} value={range} onChange={setRange} aria-label="时间范围" />
        <Select
          value={action}
          onChange={setAction}
          style={{ width: 180 }}
          aria-label="操作"
          options={[{ label: '全部操作', value: '' }, ...Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label }))]}
        />
      </div>
      <PagedTable paged={paged} columns={columns} rowKey={(row) => String(row.id)} empty="这个时间段没有后台操作。" />
    </div>
  );
}
```

审计默认看近 7 天（登录、配置这类操作不是每天都有）。

- [x] **Step 13: 接上路由**

把 `admin/src/routes.tsx` 改为：

```tsx
import { AuditPage } from './pages/AuditPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { SessionsPage } from './pages/SessionsPage.tsx';
import { TracePage } from './pages/TracePage.tsx';
import { UserDetailPage } from './pages/UserDetailPage.tsx';
import { UsersPage } from './pages/UsersPage.tsx';
import { useRoute } from './router.ts';

/** Route table. Plan 3 adds the 调设置 pages here. */
export function PageRoutes() {
  const route = useRoute();
  const [top, id] = route.segments;
  switch (top) {
    case 'users':
      return id ? <UserDetailPage oid={id} /> : <UsersPage />;
    case 'sessions':
      return <SessionsPage oid={route.query.get('oid') ?? undefined} />;
    case 'trace':
      return <TracePage sid={id} query={route.query} />;
    case 'audit':
      return <AuditPage />;
    default:
      return <OverviewPage />;
  }
}
```

- [x] **Step 14: 全量测试、typecheck、构建**

```bash
npm test -w admin
npm run typecheck -w admin
npm run build -w admin
```

预期：全部 PASS（53 + diag 3、format 新增 1、timeline 8、trace 7、log-level 4、audit 3，共 79）；typecheck 无输出；build 成功。

- [x] **Step 15: 自查**

在提交说明里写「已对照」：
- 时间线只有慢于提醒线的横条和 `error` 级别的条目是朱砂色；
- 任何地方都没有显示字段以外的内容（时间线和日志表只渲染 `fields` 的键值，后端已保证不含对话内容）；
- 搜索框、筛选、日志级别控件都能只用键盘完成（Tab 到输入框，回车提交）。

- [x] **Step 16: 提交**

```bash
git add admin/src/diag.ts admin/src/components/Timeline.tsx admin/src/components/LogLevelControl.tsx admin/src/pages/TracePage.tsx admin/src/pages/AuditPage.tsx admin/src/format.ts admin/src/labels.ts admin/src/styles.css admin/src/routes.tsx admin/test/diag.test.ts admin/test/timeline.test.tsx admin/test/trace.test.tsx admin/test/log-level.test.tsx admin/test/audit.test.tsx admin/test/format.test.ts
git commit -m "feat(admin): trace timeline, log filters, audit page and log level control

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
