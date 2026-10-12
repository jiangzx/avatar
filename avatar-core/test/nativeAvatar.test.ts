import { describe, expect, it } from 'vitest';
import { NativeAvatarController, type NativeAvatarDeps } from '../src/nativeAvatar.ts';

function nativeAvatarFakes(): { deps: NativeAvatarDeps; avatar: { mouthCalls: unknown[] }; posts: unknown[] } {
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
  const deps: NativeAvatarDeps = {
    createAvatar: () => avatar,
    createActions: () => actions,
    post: (event) => posts.push(event),
    doc: { hidden: false, addEventListener() {} },
  };
  return { deps, avatar, posts };
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
});
