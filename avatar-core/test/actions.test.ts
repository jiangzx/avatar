import { describe, expect, it, vi } from 'vitest';
import type { TalkingHead } from '@met4citizen/talkinghead';
import { ActionPlayer, looksLikeFbx } from '../src/avatar/actions.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const FBX_HEAD = bytes('Kaydara FBX Binary  \0\x1a\0');

function createHead() {
  const head = {
    stopGesture: vi.fn(),
    stopAnimation: vi.fn(),
    playGesture: vi.fn(),
    playAnimation: vi.fn(),
    setFixedValue: vi.fn(),
    mtAvatar: { headRotateX: { realtime: null as number | null, needsUpdate: false } },
    armature: { rotation: { y: 0 } },
    gestureTemplates: { handup: {} },
  };
  return head as unknown as TalkingHead;
}

describe('looksLikeFbx', () => {
  it('rejects an SPA index.html fallback', () => {
    expect(looksLikeFbx('text/html; charset=utf-8', bytes('<!doctype html><html>'))).toBe(false);
    expect(looksLikeFbx(null, bytes('<!doctype html><html>'))).toBe(false);
  });

  it('accepts the FBX binary magic with a missing or generic content-type', () => {
    expect(looksLikeFbx(null, FBX_HEAD)).toBe(true);
    expect(looksLikeFbx('application/octet-stream', FBX_HEAD)).toBe(true);
  });

  it('rejects html content-type, truncated or empty bodies even near the magic', () => {
    expect(looksLikeFbx('TEXT/HTML', FBX_HEAD)).toBe(false);
    expect(looksLikeFbx('application/octet-stream', bytes('Kaydara'))).toBe(false);
    expect(looksLikeFbx('', new Uint8Array(0))).toBe(false);
  });
});

describe('ActionPlayer lifecycle', () => {
  it('does not play a wave after stopAll cancels its FBX probe', async () => {
    let resolveProbe!: (response: Response) => void;
    const probe = new Promise<Response>((resolve) => {
      resolveProbe = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(() => probe));
    const head = createHead();
    const actions = new ActionPlayer(head, { waveFbx: '/animations/waving.fbx' });

    const wave = actions.wave();
    actions.stopAll();
    resolveProbe(new Response(FBX_HEAD, { headers: { 'content-type': 'application/octet-stream' } }));
    await wave;

    expect(head.playAnimation).not.toHaveBeenCalled();
    expect(head.playGesture).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does not let a cancelled nod RAF modify the avatar', () => {
    const callbacks: Array<(now: number) => void> = [];
    vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const head = createHead();
    const target = head.mtAvatar.headRotateX!;
    const actions = new ActionPlayer(head, {});

    actions.nod();
    const staleFrame = callbacks[0];
    target.realtime = 42;
    target.needsUpdate = false;
    actions.stopAll();
    staleFrame(100);

    expect(target.realtime).toBe(42);
    expect(target.needsUpdate).toBe(false);
    vi.unstubAllGlobals();
  });

  it('does not let a cancelled turn RAF modify the avatar', () => {
    const callbacks: Array<(now: number) => void> = [];
    vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const head = createHead();
    const root = head.armature!;
    const actions = new ActionPlayer(head, {});

    actions.turn();
    const staleFrame = callbacks[0];
    root.rotation.y = 42;
    actions.stopAll();
    staleFrame(100);

    expect(root.rotation.y).toBe(42);
    vi.unstubAllGlobals();
  });

  it('does not let a cancelled smile timer change the avatar', () => {
    vi.useFakeTimers();
    const head = createHead();
    const actions = new ActionPlayer(head, {});

    actions.smile();
    actions.stopAll();
    expect(head.setFixedValue).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2_000);

    expect(head.setFixedValue).toHaveBeenCalledTimes(2);
    expect(head.setFixedValue).toHaveBeenNthCalledWith(1, 'mouthSmile', 0.8);
    expect(head.setFixedValue).toHaveBeenNthCalledWith(2, 'mouthSmile', null);
    vi.useRealTimers();
  });
});
