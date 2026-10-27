import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { AppLayout } from '../src/layout/AppLayout.tsx';
import { fakeFetch, renderWithProviders } from './helpers.tsx';

describe('sidebar navigation', () => {
  it('renders every entry as a focusable link', async () => {
    const { fetch } = fakeFetch({});
    renderWithProviders(<AppLayout><div /></AppLayout>, fetch);
    const links = await screen.findAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '#/overview', '#/users', '#/sessions', '#/trace', '#/audit',
    ]);
    for (const link of links) expect((link as HTMLAnchorElement).tabIndex).toBe(0);
  });
});
