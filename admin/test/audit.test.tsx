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
