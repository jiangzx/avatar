import { describe, expect, it } from 'vitest';
import { NativeAvatarController, type NativeAvatarDeps } from '../src/nativeAvatar.ts';

function nativeAvatarFakes(): { deps: NativeAvatarDeps; avatar: { mouthCalls: unknown[] }; posts: unknown[]; removedListeners: number } {
  const avatar = {
    mouthCalls: [] as unknown[],
    talkingHead: {} as never,
    async load() {},
    setMouth(shape: unknown) { this.mouthCalls.push(shape); },
    setEmotion() {},
    enterState() {},
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
  it('routes native audio levels to mouth updates without PCM', async () => {
    const f = nativeAvatarFakes();
    const c = new NativeAvatarController({} as HTMLElement, f.deps);
    await c.start();
    c.handleNativeEvent({ type: 'audio.level', rms: 1200, zcr: 0.12, dtMs: 20 });
    expect(f.avatar.mouthCalls).toHaveLength(1);
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
