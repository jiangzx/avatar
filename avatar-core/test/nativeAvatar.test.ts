import { describe, expect, it, vi } from 'vitest';
import { NativeAvatarController, type NativeAvatarDeps } from '../src/nativeAvatar.ts';

function nativeAvatarFakes(): { deps: NativeAvatarDeps; avatar: { mouthCalls: unknown[] }; posts: unknown[]; removedListeners: number } {
  const avatar = {
    mouthCalls: [] as unknown[],
    talkingHead: {} as never,
    async load() {},
    setMouth(shape: unknown) { this.mouthCalls.push(shape); },
    setEmotion() {},
    enterState() {},
    setActing() {},
    setRendering() {},
  };
  const actions = { play() {}, stopAll() {}, nod() {} };
  const posts: unknown[] = [];
  let removedListeners = 0;
  const deps: NativeAvatarDeps = {
    createAvatar: () => avatar,
    createActions: () => actions,
    post: (event) => posts.push(event),
    doc: { hidden: false, addEventListener() {}, removeEventListener() { removedListeners++; } },
  };
  return { deps, avatar, posts, get removedListeners() { return removedListeners; } };
}

describe('NativeAvatarController', () => {
  it('moves the mouth with assistant subtitle characters and ignores the microphone', async () => {
    vi.useFakeTimers();
    const f = nativeAvatarFakes();
    const c = new NativeAvatarController({} as HTMLElement, f.deps);
    await c.start();
    c.handleNativeEvent({ type: 'response.start', responseSeq: 1, kind: 'reply' });
    c.handleNativeEvent({ type: 'subtitle', role: 'assistant', text: '你', final: false });
    expect(f.avatar.mouthCalls).toHaveLength(1);
    expect((f.avatar.mouthCalls[0] as { jawOpen: number }).jawOpen).toBeGreaterThan(0.3);
    c.handleNativeEvent({ type: 'audio.level', rms: 9000, zcr: 0.2, dtMs: 20 });
    expect(f.avatar.mouthCalls).toHaveLength(1);
    c.handleNativeEvent({ type: 'subtitle', role: 'assistant', text: '你啊', final: false });
    vi.advanceTimersByTime(200);
    expect(f.avatar.mouthCalls.length).toBeGreaterThan(1);
    c.handleNativeEvent({ type: 'response.end', responseSeq: 1, playedMs: 10 });
    expect(f.avatar.mouthCalls.at(-1)).toBeNull();
    vi.useRealTimers();
  });

  it('finalizes the active subtitle when a response is interrupted', async () => {
    const f = nativeAvatarFakes();
    const c = new NativeAvatarController({} as HTMLElement, f.deps);
    await c.start();
    c.handleNativeEvent({ type: 'subtitle', role: 'assistant', text: '你好', final: false });
    c.handleNativeEvent({ type: 'response.cancelled', responseSeq: 2, playedMs: 0 });
    expect(f.posts.at(-1)).toMatchObject({ type: 'subtitle', role: 'assistant', final: true });
  });

  it('plays an action through the end of a reply and stops it only when cancelled', async () => {
    const f = nativeAvatarFakes();
    const plays: string[] = [];
    const stops: string[] = [];
    f.deps.createActions = () => ({
      play(action: string) { plays.push(action); },
      stopAll() { stops.push('stop'); },
      nod() {},
    });
    const c = new NativeAvatarController({} as HTMLElement, f.deps);
    await c.start();
    c.handleNativeEvent({ type: 'avatar.action', action: 'heart', source: 'tool' });
    c.handleNativeEvent({ type: 'response.end', responseSeq: 1, playedMs: 0 });
    expect(plays).toEqual(['heart']);
    expect(stops).toEqual([]);
    c.handleNativeEvent({ type: 'response.cancelled', responseSeq: 1, playedMs: 0 });
    expect(stops).toEqual(['stop']);
  });

  it('removes the visibility listener when stopped', async () => {
    const f = nativeAvatarFakes();
    const c = new NativeAvatarController({} as HTMLElement, f.deps);
    await c.start();

    c.stop();

    expect(f.removedListeners).toBe(1);
  });
});
