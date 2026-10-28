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
