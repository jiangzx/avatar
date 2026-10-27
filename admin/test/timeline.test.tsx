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

  it('names the merged gateway rows and reads first_audio_ms for usage', () => {
    // P2-T4 merges log_events with usage rows: response_start, reply_metrics and usage_recorded.
    const t: AdminTimeline = {
      ...timeline(),
      items: [
        { ts: START + 1_000, level: 'info', event: 'response_start', seq: 1, fields: { kind: 'reply' } },
        { ts: START + 2_000, level: 'info', event: 'reply_metrics', seq: 1, fields: { speech_to_first_audio_ms: 1100 } },
        { ts: START + 3_000, level: 'info', event: 'usage_recorded', seq: null, fields: { kind: 'realtime_reply', first_audio_ms: 2600, cost_micro_yuan: 1200 } },
        { ts: START + 4_000, level: 'info', event: 'response_start', seq: null, fields: { kind: 'greeting' } },
        { ts: START + 5_000, level: 'info', event: 'session_destroyed', seq: null, fields: { reason: 'client_end' } },
      ],
    };
    render(<Timeline timeline={t} />);
    expect(screen.getByText('第 1 次回复开始')).toBeTruthy();
    expect(screen.getByText('开始回复')).toBeTruthy();
    expect(screen.getByText('记录用量')).toBeTruthy();
    expect(screen.getByText('第 1 次回复')).toBeTruthy();
    const usageRow = screen.getByText('记录用量').closest('li') as HTMLElement;
    const bar = within(usageRow).getByTestId('latency-bar');
    // Scale is the 2.6 s usage row (above the 2 s alert line), so it spans the full bar.
    expect(bar.style.width).toBe('240px');
    expect(bar.getAttribute('data-tone')).toBe('danger');
    expect(within(usageRow).getByText('首音 2.6 秒')).toBeTruthy();
  });
});
