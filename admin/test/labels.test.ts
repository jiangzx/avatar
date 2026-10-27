import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/color.ts';
import { END_REASON_LABELS, adapterLabel, characterName, endReasonLabel, kindLabel } from '../src/labels.ts';
import { CHARACTER_COLORS, palette } from '../src/theme.ts';

describe('labels', () => {
  it('covers every end reason the gateway writes (P1-T10 table)', () => {
    // P1-T10: only started sessions get a row, so these are the only values end_reason can hold.
    expect(Object.keys(END_REASON_LABELS).sort()).toEqual(
      [
        'client_end',
        'grace_expired',
        'memory_changed',
        'owner_banned',
        'owner_deleted',
        'owner_replaced',
        'process_restart',
        'shutdown',
        'start_timeout',
      ].sort(),
    );
  });

  it('reads end reasons in plain words, including unknown and open sessions', () => {
    expect(endReasonLabel({ endedAt: 1, endReason: 'client_end' })).toBe('用户挂断');
    expect(endReasonLabel({ endedAt: 1, endReason: 'shutdown' })).toBe('网关正常关机');
    expect(endReasonLabel({ endedAt: 1, endReason: 'owner_replaced' })).toBe('同一用户开始了新通话');
    expect(endReasonLabel({ endedAt: null, endReason: null })).toBe('进行中');
    expect(endReasonLabel({ endedAt: 1, endReason: null })).toBe('未记录');
    expect(endReasonLabel({ endedAt: 1, endReason: 'new_reason' })).toBe('其他（new_reason）');
  });

  it('names the adapter that carried each call', () => {
    expect(adapterLabel('qwen')).toBe('通义千问');
    expect(adapterLabel('seeduplex')).toBe('Seeduplex');
    expect(adapterLabel('mock')).toBe('Mock（测试）');
    expect(adapterLabel('other')).toBe('other');
    expect(adapterLabel(null)).toBe('未记录');
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
