# P3-T8: 节奏尺（对话节奏页右栏）

**目标：** 把「老人停下说话后，AI 过多久说什么」画成一条横向刻度，放在对话节奏页右栏。刻度按累计秒数定位，下方按时间顺序列出每一步和备用话；管理员改秒数或备用话时，尺子跟着草稿实时变化。下面再画一条「休息提醒」尺（0–120 分钟）。

**实现的 spec 章节：** 「界面设计 → 第一版方案与自查」第 2 点（力气集中在节奏尺）、「布局 → 对话节奏（配置页）」线框；配置覆盖层中「沉默阶梯：只能改各步秒数和话术，不能改结构」。

**前置：** P3-T7 完成（`ConfigScenePage` 的 `aside`、`SceneView`、`formatSeconds`、测试夹具）。

**沉默阶梯的真实语义（读 `gateway/src/session/director.ts:360-420, 693-700` 确认）：**
- 每一步的等待时间都从**上一步说完**开始计（`arm()` 在上一步结束后才启动计时），所以尺上的位置是累计值：第一句 = `contextAfterMs`；第二句 = 前者 + `checkAfterMs`；第三句 = 再 + `leaveAfterMs`；问「还在听吗」= 再 + `checkinAfterMs`（**只有聊过天才有**，没聊起来时第三句之后直接到最后一句）；最后一句 = 再 + `restAfterMs`；之后停止。
- 现在的默认值：6 秒、8 秒、10 秒、10 秒、3 分钟 → 累计 6、14、24、34、214 秒（3 分 34 秒）。实际时间还要加上 AI 每句说话的时长，尺子下方用一句话说明。
- 每一步的实际说法由模型按上下文规划，备用话（`contextText`、`checkContextText`、`leaveText`、`checkinText`、`restText`）只在规划失败时才说。尺上显示备用话，并说明这一点。
- 休息提醒：`pacing:restReminder.firstAfterMs` 后第一次，之后每 `everyMs` 一次。

**Files:**
- Create: `admin/src/config/pacingRuler.ts`（步骤表、累计时间、刻度位置）
- Create: `admin/src/config/PacingRuler.tsx`
- Modify: `admin/src/config/config.css`（追加节奏尺样式）
- Modify: `admin/src/routes.tsx`（对话节奏页带右栏）
- Test: `admin/test/pacing-ruler.test.tsx`（新建）

**Interfaces:**
- Consumes：
  - T7：`ConfigScenePage`、`SceneView`（`read(key)` 返回草稿生效后的**显示单位**值，`item(key)` 返回说明行，含 `unitId`）、`formatSeconds(totalSeconds)`、`admin/test/fixtures/config.ts`；P2-T6 的 `fakeFetch`、`renderWithProviders`（`admin/test/helpers.tsx`）。
  - P3-T1 说明卡 key（`gateway/config/admin/descriptors/pacing.json`）：
    - 等待时间（不分语言）：`role:elder-companion/*/director.{contextAfterMs,checkAfterMs,leaveAfterMs,checkinAfterMs,restAfterMs}`，前四个 `unitId: 'second'`，`restAfterMs` 是 `unitId: 'minute'`。
    - 备用话（按语言展开，尺子读中文）：`role:elder-companion/zh/director.{contextText,checkContextText,leaveText,checkinText,restText}`。
    - 休息提醒：`pacing:restReminder.firstAfterMs`、`pacing:restReminder.everyMs`（`unitId: 'minute'`）。
    某个 key 不在白名单里（`item(key)` 为 `undefined`）时：等待时间缺失就不画这一步，备用话缺失就写「按聊天内容决定说什么」。
- Produces：
  ```ts
  // admin/src/config/pacingRuler.ts
  export interface LadderStep { step: 'context' | 'check' | 'leave' | 'checkin' | 'rest'; label: string; delayKey: string; lineKey: string; onlyAfterChat: boolean }
  export const LADDER_STEPS: readonly LadderStep[];
  export const REST_KEYS: { first: string; every: string };
  export interface LadderMark { step: LadderStep['step']; label: string; atSec: number; line: string | null; onlyAfterChat: boolean }
  export function secondsOf(view: SceneView, key: string): number | null;   // display value -> seconds by unitId
  export function buildLadder(view: SceneView): LadderMark[];
  export function rulerX(sec: number, maxSec: number, width: number, kneeSec?: number, kneeShare?: number): number;
  export function restMarks(firstMin: number, everyMin: number, horizonMin?: number): number[]; // minutes
  // admin/src/config/PacingRuler.tsx
  export function PacingRuler(props: { view: SceneView }): JSX.Element;
  ```

## 设计要点

- 节奏尺是全后台唯一做重设计的地方，其余保持安静。用 SVG 画，不引入图表库。
- 横轴分两段：0–60 秒占 70% 宽度（线性），60 秒以后压缩进剩下 30%，在 60 秒处画一个断轴记号，避免 3 分钟的最后一句把前面几步挤成一团。轴线晨雾色，刻度和标签青瓷色，「只在聊过天时」的那一步用虚线刻度。
- SVG 上方的时间标签只给眼睛看（`aria-hidden`）；屏幕阅读器和测试读下方的有序列表（这是真实的先后顺序，所以用有序列表合理，但不显示 01/02 编号，左边写累计时间）。
- 没有进场动画；草稿变化时刻度位置直接跳到新位置。

## Steps

- [ ] **Step 1: 写失败测试**

新建 `admin/test/pacing-ruler.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminConfigItem } from '@anyidea/protocol';
import { ConfigScenePage, type SceneView } from '../src/config/ConfigScenePage.tsx';
import { PacingRuler } from '../src/config/PacingRuler.tsx';
import { buildLadder, restMarks, rulerX } from '../src/config/pacingRuler.ts';
import { fakeFetch, renderWithProviders } from './helpers.tsx';
import {
  checkinItem, checkItem, contextItem, contextTextItem, everyItem, leaveItem, restAfterItem, restItem, restTextItem, scene,
} from './fixtures/config.ts';

const ALL: AdminConfigItem[] = [contextItem, checkItem, leaveItem, checkinItem, restAfterItem, contextTextItem, restTextItem, restItem, everyItem];

function viewOf(items: AdminConfigItem[]): SceneView {
  const map = new Map(items.map((item) => [item.key, item]));
  return { item: (key) => map.get(key), read: (key) => map.get(key)?.current };
}

describe('pacing ruler math', () => {
  it('places each step at the cumulative time since the user went quiet', () => {
    const marks = buildLadder(viewOf(ALL));
    expect(marks.map((m) => [m.step, m.atSec])).toEqual([
      ['context', 6], ['check', 14], ['leave', 24], ['checkin', 34], ['rest', 214],
    ]);
    expect(marks[0]!.line).toBe('您想接着聊点什么？我听着呢。');
    expect(marks[1]!.line).toBeNull();
    expect(marks[3]!.onlyAfterChat).toBe(true);
  });

  it('skips a step whose wait time is not editable', () => {
    const marks = buildLadder(viewOf([contextItem, leaveItem]));
    expect(marks.map((m) => [m.step, m.atSec])).toEqual([['context', 6], ['leave', 16]]);
  });

  it('uses 70% of the width for the first minute and compresses the rest', () => {
    expect(rulerX(0, 214, 300)).toBe(0);
    expect(rulerX(30, 214, 300)).toBeCloseTo(105);
    expect(rulerX(60, 214, 300)).toBeCloseTo(210);
    expect(rulerX(214, 214, 300)).toBeCloseTo(300);
    expect(rulerX(40, 40, 300)).toBeCloseTo(300); // no knee when everything fits in a minute
  });

  it('lists rest reminders inside two hours', () => {
    expect(restMarks(60, 60)).toEqual([60, 120]);
    expect(restMarks(90, 30)).toEqual([90, 120]);
  });
});

describe('PacingRuler', () => {
  it('lists the ladder in order with times and fallback lines', () => {
    const { fetch } = fakeFetch({});
    renderWithProviders(<PacingRuler view={viewOf(ALL)} />, fetch);
    const list = screen.getByRole('list', { name: '沉默后 AI 依次会做的事' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('.ruler-time')!.textContent)).toEqual(['6 秒', '14 秒', '24 秒', '34 秒', '3 分 34 秒']);
    expect(within(items[0]!).getByText('您想接着聊点什么？我听着呢。')).toBeTruthy();
    expect(within(items[1]!).getByText('按聊天内容决定说什么')).toBeTruthy();
    expect(within(items[3]!).getByText('聊过天才有这一步')).toBeTruthy();
    // restItem in the fixture is published at 90 minutes, everyItem at 60.
    expect(screen.getByText('90 分钟第一次提醒，之后每 60 分钟一次')).toBeTruthy();
  });

  it('positions ticks by seconds', () => {
    const { fetch } = fakeFetch({});
    const { container } = renderWithProviders(<PacingRuler view={viewOf(ALL)} />, fetch);
    const tick = (step: string) => Number(container.querySelector(`line[data-step="${step}"]`)!.getAttribute('data-x'));
    expect(tick('context')).toBeCloseTo(rulerX(6, 214, 300));
    expect(tick('rest')).toBeCloseTo(300);
    expect(container.querySelector('line[data-step="checkin"]')!.getAttribute('stroke-dasharray')).toBe('3 3');
  });

  it('follows the draft on the pacing page', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/config/scenes/pacing': scene(ALL) });
    renderWithProviders(<ConfigScenePage scene="pacing" aside={(view) => <PacingRuler view={view} />} />, fetch);
    const row = await screen.findByRole('region', { name: '老人停下后多久接第一句' });
    const input = within(row).getByRole('spinbutton');
    await userEvent.clear(input);
    await userEvent.type(input, '10');
    const list = screen.getByRole('list', { name: '沉默后 AI 依次会做的事' });
    expect(within(list).getAllByRole('listitem')[0]!.querySelector('.ruler-time')!.textContent).toBe('10 秒');
    expect(within(list).getAllByRole('listitem')[4]!.querySelector('.ruler-time')!.textContent).toBe('3 分 38 秒');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -w admin -- test/pacing-ruler.test.tsx`
Expected: FAIL，报 `Failed to resolve import "../src/config/PacingRuler.tsx"`。

- [ ] **Step 3: 实现计算模块**

新建 `admin/src/config/pacingRuler.ts`：

```ts
import type { SceneView } from './ConfigScenePage.tsx';

export interface LadderStep {
  step: 'context' | 'check' | 'leave' | 'checkin' | 'rest';
  label: string;
  delayKey: string;
  lineKey: string;
  onlyAfterChat: boolean;
}

const WAIT = 'role:elder-companion/*/director';
const ZH = 'role:elder-companion/zh/director';

// Order and branch follow Director.onResponseEnd (gateway/src/session/director.ts); each wait starts after the previous step.
// Keys match gateway/config/admin/descriptors/pacing.json (P3-T1).
export const LADDER_STEPS: readonly LadderStep[] = [
  { step: 'context', label: '第一句', delayKey: `${WAIT}.contextAfterMs`, lineKey: `${ZH}.contextText`, onlyAfterChat: false },
  { step: 'check', label: '第二句', delayKey: `${WAIT}.checkAfterMs`, lineKey: `${ZH}.checkContextText`, onlyAfterChat: false },
  { step: 'leave', label: '第三句', delayKey: `${WAIT}.leaveAfterMs`, lineKey: `${ZH}.leaveText`, onlyAfterChat: false },
  { step: 'checkin', label: '问「还在听吗」', delayKey: `${WAIT}.checkinAfterMs`, lineKey: `${ZH}.checkinText`, onlyAfterChat: true },
  { step: 'rest', label: '最后一句', delayKey: `${WAIT}.restAfterMs`, lineKey: `${ZH}.restText`, onlyAfterChat: false },
];

export const REST_KEYS = { first: 'pacing:restReminder.firstAfterMs', every: 'pacing:restReminder.everyMs' };

export interface LadderMark {
  step: LadderStep['step'];
  label: string;
  atSec: number;
  line: string | null;
  onlyAfterChat: boolean;
}

const SECONDS_PER_UNIT: Record<string, number> = { second: 1, minute: 60 };

/** Draft value of a time item in seconds; null when the item is missing or not a duration. */
export function secondsOf(view: SceneView, key: string): number | null {
  const item = view.item(key);
  const value = view.read(key);
  const factor = item?.unitId ? SECONDS_PER_UNIT[item.unitId] : undefined;
  return typeof value === 'number' && factor !== undefined ? value * factor : null;
}

export function buildLadder(view: SceneView): LadderMark[] {
  const marks: LadderMark[] = [];
  let elapsed = 0;
  for (const step of LADDER_STEPS) {
    const delay = secondsOf(view, step.delayKey);
    if (delay === null) continue;
    elapsed += delay;
    const line = view.read(step.lineKey);
    marks.push({
      step: step.step,
      label: step.label,
      atSec: Math.round(elapsed),
      line: typeof line === 'string' && line.trim() ? line : null,
      onlyAfterChat: step.onlyAfterChat,
    });
  }
  return marks;
}

/** Linear up to the knee (70% of the width), compressed after it. */
export function rulerX(sec: number, maxSec: number, width: number, kneeSec = 60, kneeShare = 0.7): number {
  if (maxSec <= kneeSec) return maxSec === 0 ? 0 : (sec / maxSec) * width;
  if (sec <= kneeSec) return (sec / kneeSec) * kneeShare * width;
  return kneeShare * width + ((sec - kneeSec) / (maxSec - kneeSec)) * (1 - kneeShare) * width;
}

export function restMarks(firstMin: number, everyMin: number, horizonMin = 120): number[] {
  const marks: number[] = [];
  if (firstMin <= 0 || everyMin <= 0) return marks;
  for (let at = firstMin; at <= horizonMin; at += everyMin) marks.push(Math.round(at));
  return marks;
}
```

- [ ] **Step 4: 实现组件**

新建 `admin/src/config/PacingRuler.tsx`：

```tsx
import type { SceneView } from './ConfigScenePage.tsx';
import { formatSeconds } from './format.ts';
import { buildLadder, REST_KEYS, restMarks, rulerX } from './pacingRuler.ts';

const WIDTH = 300;
const KNEE_SEC = 60;
const REST_HORIZON_MIN = 120;

export function PacingRuler({ view }: { view: SceneView }) {
  const marks = buildLadder(view);
  const maxSec = Math.max(1, ...marks.map((m) => m.atSec));
  const first = view.read(REST_KEYS.first);
  const every = view.read(REST_KEYS.every);
  const hasRest = typeof first === 'number' && typeof every === 'number';
  const reminders = hasRest ? restMarks(first, every, REST_HORIZON_MIN) : [];

  return (
    <div className="pacing-ruler">
      <h2 className="ruler-title">节奏尺</h2>
      <p className="ruler-lead">老人停下说话后……</p>
      <svg className="ruler-svg" viewBox={`-8 0 ${WIDTH + 24} 56`} role="img" aria-label="沉默节奏刻度">
        <line x1={0} y1={32} x2={WIDTH} y2={32} className="ruler-axis" />
        {maxSec > KNEE_SEC && (
          <text x={rulerX(KNEE_SEC, maxSec, WIDTH)} y={36} className="ruler-break" textAnchor="middle" aria-hidden="true">≈</text>
        )}
        {marks.map((mark) => {
          const x = rulerX(mark.atSec, maxSec, WIDTH);
          return (
            <g key={mark.step}>
              <line
                data-step={mark.step}
                data-x={x}
                x1={x} y1={22} x2={x} y2={42}
                className="ruler-tick"
                {...(mark.onlyAfterChat ? { strokeDasharray: '3 3' } : {})}
              />
              <text x={x} y={14} className="ruler-label" textAnchor="middle" aria-hidden="true">{formatSeconds(mark.atSec)}</text>
            </g>
          );
        })}
        <text x={WIDTH + 12} y={36} className="ruler-end" textAnchor="middle" aria-hidden="true">停</text>
      </svg>
      <ol className="ruler-steps" aria-label="沉默后 AI 依次会做的事">
        {marks.map((mark) => (
          <li key={mark.step} className={mark.onlyAfterChat ? 'is-conditional' : undefined}>
            <span className="ruler-time">{formatSeconds(mark.atSec)}</span>
            <span className="ruler-step">{mark.label}</span>
            {mark.line
              ? <q className="ruler-line">{mark.line}</q>
              : <span className="ruler-line is-planned">按聊天内容决定说什么</span>}
            {mark.onlyAfterChat && <span className="ruler-note">聊过天才有这一步</span>}
          </li>
        ))}
      </ol>
      <p className="ruler-caption">实际说法会按聊天内容变化，这里显示的是备用话；时间还要加上 AI 每句说话的时长。</p>

      <h2 className="ruler-title">休息提醒</h2>
      <svg className="ruler-svg" viewBox={`-8 0 ${WIDTH + 24} 48`} role="img" aria-label="休息提醒刻度">
        <line x1={0} y1={28} x2={WIDTH} y2={28} className="ruler-axis" />
        {[0, 60, 120].map((min) => (
          <text key={min} x={(min / REST_HORIZON_MIN) * WIDTH} y={46} className="ruler-scale" textAnchor="middle" aria-hidden="true">{min} 分</text>
        ))}
        {reminders.map((min) => {
          const x = (min / REST_HORIZON_MIN) * WIDTH;
          return <line key={min} data-minute={min} x1={x} y1={18} x2={x} y2={34} className="ruler-tick" />;
        })}
      </svg>
      {hasRest && <p className="ruler-caption">{`${first} 分钟第一次提醒，之后每 ${every} 分钟一次`}</p>}
    </div>
  );
}
```

- [ ] **Step 5: 追加样式**

在 `admin/src/config/config.css` 末尾追加：

```css
.pacing-ruler { padding: 16px 0; }
.ruler-title { font-size: 17px; font-weight: 600; color: #24343b; margin: 0 0 4px; }
.ruler-lead,
.ruler-caption { font-size: 13px; line-height: 1.7; color: #4d5d63; margin: 0 0 8px; }
.ruler-svg { width: 100%; height: auto; display: block; margin: 8px 0; }
.ruler-axis { stroke: #dce3e1; stroke-width: 2; }
.ruler-tick { stroke: #2f6f68; stroke-width: 2; }
.ruler-label,
.ruler-scale { font-size: 10px; fill: #2f6f68; font-variant-numeric: tabular-nums; }
.ruler-scale { fill: #4d5d63; }
.ruler-break,
.ruler-end { font-size: 12px; fill: #4d5d63; }
.ruler-steps { list-style: none; padding: 0; margin: 8px 0 12px; }
.ruler-steps li {
  display: grid;
  grid-template-columns: 5.5em 1fr;
  column-gap: 8px;
  padding: 6px 0;
  border-top: 1px solid #dce3e1;
  font-size: 13px;
  line-height: 1.6;
}
.ruler-steps li.is-conditional { color: #4d5d63; }
.ruler-time { grid-row: span 3; font-variant-numeric: tabular-nums; color: #2f6f68; font-weight: 600; }
.ruler-step { font-weight: 600; color: #24343b; }
.ruler-line { grid-column: 2; }
.ruler-line.is-planned { color: #4d5d63; }
.ruler-note { grid-column: 2; font-size: 12px; color: #4d5d63; }
```

- [ ] **Step 6: 运行，确认通过**

Run: `npm test -w admin -- test/pacing-ruler.test.tsx`
Expected: PASS（7 个用例）。

- [ ] **Step 7: 对话节奏页带右栏**

修改 `admin/src/routes.tsx`：import `PacingRuler`（`./config/PacingRuler.tsx`），把 T7 加的 `case 'settings':` 分支替换为：

```tsx
    case 'settings': {
      const scene = id ?? 'pacing';
      // key resets the draft when switching scenes.
      if (scene === 'pacing') return <ConfigScenePage key="pacing" scene="pacing" aside={(view) => <PacingRuler view={view} />} />;
      return <ConfigScenePage key={scene} scene={scene} />;
    }
```

- [ ] **Step 8: 全量验证**

Run: `npm test -w admin && npm run typecheck -w admin && npm run build -w admin`
Expected: 全部通过。

- [ ] **Step 9: 提交**

```bash
git add admin/src/config/pacingRuler.ts admin/src/config/PacingRuler.tsx admin/src/config/config.css admin/src/routes.tsx admin/test/pacing-ruler.test.tsx
git commit -m "feat(admin): pacing ruler that shows the silence ladder in seconds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收

- 默认配置下尺子列出 6 秒、14 秒、24 秒、34 秒、3 分 34 秒五步；「问『还在听吗』」标明聊过天才有、刻度为虚线。
- 改第一步秒数后尺子立刻更新，后面各步一起顺延。
- 休息提醒尺按当前值显示，例如默认配置下是「60 分钟第一次提醒，之后每 60 分钟一次」。
- 浏览器里 1280px 宽度下右栏 320px，不遮挡说明行；本组件没有动画。
