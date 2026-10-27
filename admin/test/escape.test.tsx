import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEscapeClose } from '../src/useEscapeClose.ts';

function Probe() {
  const [open, setOpen] = useState(true);
  useEscapeClose(open, () => setOpen(false));
  return <div>{open ? 'open' : 'closed'}</div>;
}

describe('useEscapeClose', () => {
  it('closes on Escape and ignores other keys', async () => {
    render(<Probe />);
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText('open')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('closed')).toBeTruthy();
  });
});
