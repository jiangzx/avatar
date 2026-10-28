import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigScenePage } from '../src/config/ConfigScenePage.tsx';
import { PromptDiff } from '../src/config/PromptDiff.tsx';
import { fakeFetch, renderWithProviders } from './helpers.tsx';
import {
  bodyOf, careDaysItem, contextItem, contextTextItem, IMPACT, jaContextTextItem, personaItem, preview, restItem, scene, version,
} from './fixtures/config.ts';

const SCENE = 'GET /admin/api/config/scenes/pacing';

async function typeInto(input: HTMLElement, text: string): Promise<void> {
  await userEvent.clear(input);
  await userEvent.type(input, text);
}

describe('ConfigScenePage', () => {
  it('turns an edited row into “已改，原来 X” and counts it in the bar', async () => {
    const { fetch } = fakeFetch({ [SCENE]: scene([restItem, contextItem]) });
    renderWithProviders(<ConfigScenePage scene="pacing" />, fetch);
    const row = await screen.findByRole('region', { name: '连续聊多久提醒休息' });
    const input = within(row).getByRole('spinbutton') as HTMLInputElement;
    expect(input.value).toBe('90');
    expect(within(row).getByText('影响：所有角色，休息提醒')).toBeTruthy();
    expect(within(row).getByText('后台改过，默认 60 分钟')).toBeTruthy();
    expect(screen.queryByText(/项改动还没发布/)).toBeNull();

    await typeInto(input, '60');
    expect(within(row).getByText('已改，原来 90 分钟')).toBeTruthy();
    expect(row.className).toContain('is-modified');
    expect(screen.getByText('有 1 项改动还没发布')).toBeTruthy();

    const other = screen.getByRole('region', { name: '老人停下后多久接第一句' });
    await typeInto(within(other).getByRole('spinbutton'), '10');
    expect(screen.getByText('有 2 项改动还没发布')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '放弃改动' }));
    expect(screen.queryByText(/项改动还没发布/)).toBeNull();
    expect((within(row).getByRole('spinbutton') as HTMLInputElement).value).toBe('90');
  });

  it('marks the risk level on the row and explains out-of-range values', async () => {
    const { fetch } = fakeFetch({ [SCENE]: scene([careDaysItem, restItem]) });
    renderWithProviders(<ConfigScenePage scene="pacing" />, fetch);
    const high = await screen.findByRole('region', { name: '关怀开场最多提起几天前的事' });
    expect(high.className).toContain('risk-high');
    expect(within(high).getByText(careDaysItem.riskNote!)).toBeTruthy();

    const rest = screen.getByRole('region', { name: '连续聊多久提醒休息' });
    await typeInto(within(rest).getByRole('spinbutton'), '150');
    expect(within(rest).getByRole('alert').textContent).toBe('可以填 10 到 120 分钟。');
    expect((screen.getByRole('button', { name: '查看并发布' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists old → new and the impact sentence before publishing', async () => {
    let scenes = 0;
    const { fetch, calls } = fakeFetch({
      [SCENE]: () => { scenes++; return { body: scene([restItem]) }; },
      'POST /admin/api/config/preview': preview(),
      'POST /admin/api/config/publish': version(8),
    });
    renderWithProviders(<ConfigScenePage scene="pacing" />, fetch);
    const row = await screen.findByRole('region', { name: '连续聊多久提醒休息' });
    await typeInto(within(row).getByRole('spinbutton'), '60');
    await userEvent.click(screen.getByRole('button', { name: '查看并发布' }));

    expect(await screen.findByText('发布这 1 项改动？')).toBeTruthy();
    expect(screen.getByText('90 分钟 → 60 分钟')).toBeTruthy();
    expect(screen.getByText(IMPACT)).toBeTruthy();
    expect(bodyOf(calls, 'POST', '/admin/api/config/preview')).toEqual({ baseVersion: 7, changes: [{ key: restItem.key, value: 60 }], resets: [] });

    await userEvent.click(screen.getByRole('button', { name: '发布' }));
    await waitFor(() => expect(bodyOf(calls, 'POST', '/admin/api/config/publish')).toEqual({ baseVersion: 7, changes: [{ key: restItem.key, value: 60 }], resets: [] }));
    expect(await screen.findByText('已发布')).toBeTruthy();
    await waitFor(() => expect(scenes).toBe(2));
  });

  it('asks to type the confirm phrase when a change is high risk', async () => {
    const { fetch, calls } = fakeFetch({
      [SCENE]: scene([careDaysItem]),
      'POST /admin/api/config/preview': preview({
        requiresConfirm: true,
        lines: [{ key: careDaysItem.key, label: careDaysItem.label, scene: '情绪与关怀', before: '3 天', after: '5 天', characters: '所有角色', risk: 'high', textDiff: null }],
      }),
      'POST /admin/api/config/publish': version(8),
    });
    renderWithProviders(<ConfigScenePage scene="pacing" />, fetch);
    const row = await screen.findByRole('region', { name: '关怀开场最多提起几天前的事' });
    await typeInto(within(row).getByRole('spinbutton'), '5');
    await userEvent.click(screen.getByRole('button', { name: '查看并发布' }));

    const publish = await screen.findByRole('button', { name: '发布' }) as HTMLButtonElement;
    expect(screen.getByText(/这次有高风险改动，请输入「确认发布」/)).toBeTruthy();
    expect(publish.disabled).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: '确认文字' }), '确认发布');
    expect(publish.disabled).toBe(false);
    await userEvent.click(publish);
    await waitFor(() => expect(bodyOf(calls, 'POST', '/admin/api/config/publish')).toEqual({
      baseVersion: 7, changes: [{ key: careDaysItem.key, value: 5 }], resets: [], confirmText: '确认发布',
    }));
  });

  it('shows the server message when the config changed elsewhere', async () => {
    const { fetch } = fakeFetch({
      [SCENE]: scene([restItem]),
      'POST /admin/api/config/preview': preview(),
      'POST /admin/api/config/publish': () => ({ status: 409, body: { error: 'config_conflict', message: '配置已在别处更新，请刷新页面后再改。' } }),
    });
    renderWithProviders(<ConfigScenePage scene="pacing" />, fetch);
    const row = await screen.findByRole('region', { name: '连续聊多久提醒休息' });
    await typeInto(within(row).getByRole('spinbutton'), '60');
    await userEvent.click(screen.getByRole('button', { name: '查看并发布' }));
    await userEvent.click(await screen.findByRole('button', { name: '发布' }));
    expect(await screen.findByText('配置已在别处更新，请刷新页面后再改。')).toBeTruthy();
  });

  it('blocks publishing when a prompt loses a placeholder', async () => {
    const { fetch } = fakeFetch({ 'GET /admin/api/config/scenes/characters': scene([personaItem], { id: 'characters', title: '角色' }) });
    renderWithProviders(<ConfigScenePage scene="characters" />, fetch);
    const row = await screen.findByRole('region', { name: '三个角色共用的人设' });
    await typeInto(within(row).getByRole('textbox'), '你是小暖，陪老人聊天。');
    expect(within(row).getByRole('alert').textContent).toBe('「三个角色共用的人设」里少了 {{char}}，这是角色名字的位置，请加回去。');
    expect(screen.getByText('有 1 项改动还没发布')).toBeTruthy();
    expect(screen.getByText('先改好标红的项')).toBeTruthy();
    expect((screen.getByRole('button', { name: '查看并发布' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('restores the repo default through the resets list', async () => {
    const { fetch, calls } = fakeFetch({ [SCENE]: scene([restItem]), 'POST /admin/api/config/preview': preview() });
    renderWithProviders(<ConfigScenePage scene="pacing" />, fetch);
    const row = await screen.findByRole('region', { name: '连续聊多久提醒休息' });
    await userEvent.click(within(row).getByRole('button', { name: '恢复默认' }));
    expect((within(row).getByRole('spinbutton') as HTMLInputElement).value).toBe('60');
    expect(within(row).getByText('已改，原来 90 分钟')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '查看并发布' }));
    await waitFor(() => expect(bodyOf(calls, 'POST', '/admin/api/config/preview')).toEqual({ baseVersion: 7, changes: [], resets: [restItem.key] }));
  });

  it('switches languages for per-language rows and lists read-only notes', async () => {
    const { fetch } = fakeFetch({ [SCENE]: scene([restItem, contextTextItem, jaContextTextItem]) });
    renderWithProviders(<ConfigScenePage scene="pacing" />, fetch);
    expect(await screen.findAllByRole('region', { name: '第一句的备用话' })).toHaveLength(1);
    expect((screen.getByRole('textbox', { name: '第一句的备用话' }) as HTMLInputElement).value).toBe(contextTextItem.current);
    await userEvent.click(screen.getByText('日语'));
    expect((screen.getByRole('textbox', { name: '第一句的备用话' }) as HTMLInputElement).value).toBe(jaContextTextItem.current);
    expect(screen.getByRole('region', { name: '连续聊多久提醒休息' })).toBeTruthy();
    expect(screen.getByText('这些只能看，不能在这里改')).toBeTruthy();
    expect(screen.getByText('顺序固定，这里只能改等待时间和备用话。')).toBeTruthy();
  });
});

describe('PromptDiff', () => {
  it('shows deletions struck through on the left and insertions highlighted on the right', () => {
    const { fetch } = fakeFetch({});
    const { container } = renderWithProviders(<PromptDiff before="慢慢说，不着急。" after="慢慢说，我在。" />, fetch);
    const [left, right] = Array.from(container.querySelectorAll('.prompt-diff-col'));
    expect(left!.querySelector('h4')!.textContent).toBe('原来');
    expect(right!.querySelector('h4')!.textContent).toBe('改后');
    expect(Array.from(left!.querySelectorAll('del')).map((n) => n.textContent).join('')).toBe('不着急');
    expect(Array.from(right!.querySelectorAll('ins')).map((n) => n.textContent).join('')).toBe('我在');
    expect(left!.querySelector('ins')).toBeNull();
    expect(right!.querySelector('del')).toBeNull();
  });
});
