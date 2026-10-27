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
