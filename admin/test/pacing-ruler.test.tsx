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
