import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationLedger } from '../src/session/ledger.ts';
import { NO_TURN, TurnFinals } from '../src/session/turnAccess.ts';

function setup() {
  const ledger = new ConversationLedger();
  const turns = new TurnFinals(() => ledger.recent);
  /** What Session does for a final that enters the ledger. */
  const stored = (text: string, id: string | null) => {
    ledger.addUser(text, Date.now());
    turns.onFinal(text, id, true);
  };
  return { ledger, turns, stored };
}

describe('TurnFinals', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns a final that arrived before the tool call at once', async () => {
    const { turns, stored } = setup();
    stored('记住我女儿叫小芳', 'm1');
    await expect(turns.access().currentFinal(3_000)).resolves.toEqual({ text: '记住我女儿叫小芳', messageId: 'm1' });
  });

  it('waits for a final that arrives after the tool call', async () => {
    const { turns, stored } = setup();
    const pending = turns.access().currentFinal(3_000);
    stored('记住我女儿叫小芳', 'm2');
    await expect(pending).resolves.toEqual({ text: '记住我女儿叫小芳', messageId: 'm2' });
  });

  it('gives null on timeout, and a later final does not reach the timed-out call', async () => {
    const { turns, stored } = setup();
    const access = turns.access();
    const pending = access.currentFinal(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toBeNull();
    stored('迟到的一句', 'm3');
    expect(access.previousFinal()).toBeNull();
  });

  it('gives null when interrupted, and never hangs', async () => {
    const { turns } = setup();
    const pending = turns.access().currentFinal(3_000);
    turns.interrupt();
    await expect(pending).resolves.toBeNull();
  });

  it('does not bind a tool call to a final from a closed turn', async () => {
    const { turns, stored } = setup();
    stored('上一轮的话', 'm1');
    turns.onTurnClosed();
    const pending = turns.access().currentFinal(3_000);
    stored('把刚才那句记下来', 'm2');
    await expect(pending).resolves.toEqual({ text: '把刚才那句记下来', messageId: 'm2' });
  });

  it('reads previous from the ledger, with the message id of that line', async () => {
    const { turns, stored } = setup();
    stored('我孙子下个月结婚', 'm1');
    turns.onTurnClosed();
    stored('把刚才那句记下来', 'm2');
    const access = turns.access();
    await access.currentFinal(3_000);
    expect(access.previousFinal()).toEqual({ text: '我孙子下个月结婚', messageId: 'm1' });
  });

  it('uses the newest ledger line as previous when this final was dropped', async () => {
    const { turns, stored } = setup();
    stored('我孙子下个月结婚', 'm1');
    turns.onTurnClosed();
    const access = turns.access();
    const pending = access.currentFinal(3_000);
    turns.onFinal('把刚才那句记下来', null, false);
    await expect(pending).resolves.toEqual({ text: '把刚才那句记下来', messageId: null });
    expect(access.previousFinal()).toEqual({ text: '我孙子下个月结婚', messageId: 'm1' });
  });

  it('has no previous after the ledger forgot that line', async () => {
    const { ledger, turns, stored } = setup();
    stored('我孙子下个月结婚', 'm1');
    turns.onTurnClosed();
    stored('把刚才那句记下来', 'm2');
    ledger.clear();
    const access = turns.access();
    await access.currentFinal(3_000);
    expect(access.previousFinal()).toBeNull();
  });

  it('keeps a null message id when the line was never written', async () => {
    const { turns, stored } = setup();
    stored('没写进库的话', null);
    turns.onTurnClosed();
    stored('把刚才那句记下来', 'm2');
    const access = turns.access();
    await access.currentFinal(3_000);
    expect(access.previousFinal()).toEqual({ text: '没写进库的话', messageId: null });
  });

  it('NO_TURN never yields a final', async () => {
    await expect(NO_TURN.currentFinal(10)).resolves.toBeNull();
    expect(NO_TURN.previousFinal()).toBeNull();
  });
});
