import { ACTION_NAMES, type ActionName } from '@anyidea/protocol';
import { MouthAnalyzer } from './audio/mouth.ts';
import type { ActionsLike, AvatarLike, DocLike } from './app.ts';
import { parseFromFlutter } from './bridgeValidate.ts';
import { postToFlutter, type NativeViewEvent, type ToFlutter } from './bridge.ts';
import type { AvatarState } from './avatar/stateMachine.ts';
import { ActionPlayer } from './avatar/actions.ts';
import { AvatarView } from './avatar/avatarView.ts';

export interface NativeAvatarDeps {
  createAvatar(el: HTMLElement): AvatarLike;
  createActions(avatar: AvatarLike): ActionsLike;
  post(event: ToFlutter): void;
  doc: DocLike;
}

export function browserNativeDeps(): NativeAvatarDeps {
  return {
    createAvatar: (el) => new AvatarView(el),
    createActions: (avatar) => new ActionPlayer(avatar.talkingHead, { waveFbx: './animations/waving.fbx' }),
    post: postToFlutter,
    doc: document,
  };
}

export class NativeAvatarController {
  private readonly mouth = new MouthAnalyzer();
  private avatar: AvatarLike | null = null;
  private actions: ActionsLike | null = null;
  private state: AvatarState = 'idle';
  private activeSeq: number | null = null;
  private liveAssistantText = '';
  private ended = false;
  private readonly onVisibilityChange = () => {
    if (!this.ended) this.avatar?.setRendering(!this.deps.doc.hidden);
  };
  private visibilityListenerAttached = false;

  constructor(
    private readonly el: HTMLElement,
    private readonly deps: NativeAvatarDeps,
    private readonly avatarUrl = './avatars/avatar.glb',
  ) {}

  async start(): Promise<void> {
    if (this.avatar) return;
    this.ended = false;
    this.deps.post({ type: 'status', status: 'loading' });
    const avatar = this.deps.createAvatar(this.el);
    await avatar.load(this.avatarUrl);
    this.avatar = avatar;
    this.actions = this.deps.createActions(avatar);
    avatar.setRendering(true);
    this.deps.doc.addEventListener('visibilitychange', this.onVisibilityChange);
    this.visibilityListenerAttached = true;
    this.transition('idle');
  }

  handleNativeEvent(raw: unknown): void {
    const event = parseNativeEvent(raw);
    if (!event || this.ended) {
      if (!event && !this.ended) this.deps.post({ type: 'error', code: 'bad_message' });
      return;
    }
    switch (event.type) {
      case 'status':
        this.deps.post({ type: 'status', status: event.status });
        break;
      case 'state':
        this.transition(event.state);
        break;
      case 'subtitle':
        if (event.role === 'assistant' && !event.final) this.liveAssistantText = event.text;
        if (event.role === 'assistant' && event.final) this.liveAssistantText = '';
        this.deps.post({ type: 'subtitle', role: event.role, text: event.text, final: event.final });
        break;
      case 'response.start':
        this.activeSeq = event.responseSeq;
        this.transition('thinking');
        break;
      case 'response.end':
      case 'response.cancelled':
        if (this.liveAssistantText) {
          this.deps.post({ type: 'subtitle', role: 'assistant', text: this.liveAssistantText, final: true });
          this.liveAssistantText = '';
        }
        if (this.activeSeq === event.responseSeq) this.activeSeq = null;
        this.actions?.stopAll();
        this.avatar?.setMouth(null);
        this.transition('idle');
        break;
      case 'avatar.action':
        this.actions?.play(event.action);
        break;
      case 'avatar.emotion':
        this.avatar?.setEmotion(event.emotion);
        break;
      case 'audio.level':
        const shape = this.mouth.update({ rms: event.rms / 32768, zcr: event.zcr }, event.dtMs);
        if (this.activeSeq !== null && this.state !== 'speaking') this.transition('speaking');
        this.avatar?.setMouth(shape);
        break;
      case 'metric':
        this.deps.post({ type: 'metric', name: event.name, ms: event.ms });
        break;
      case 'error':
        this.deps.post({ type: 'error', code: event.code });
        break;
    }
  }

  stop(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.visibilityListenerAttached) {
      this.deps.doc.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.visibilityListenerAttached = false;
    }
    this.actions?.stopAll();
    this.avatar?.setMouth(null);
    this.avatar?.setRendering(false);
    this.avatar = null;
    this.actions = null;
  }

  private transition(next: AvatarState): void {
    if (this.state === next) return;
    this.state = next;
    this.avatar?.enterState(next);
    this.deps.post({ type: 'state', state: next });
  }
}

function parseNativeEvent(raw: unknown): NativeViewEvent | null {
  const message = parseFromFlutter(raw);
  if (!message) return null;
  switch (message.type) {
    case 'status':
    case 'state':
    case 'subtitle':
    case 'response.start':
    case 'response.end':
    case 'response.cancelled':
    case 'avatar.action':
    case 'avatar.emotion':
    case 'audio.level':
    case 'metric':
    case 'error':
      return message;
    default:
      return null;
  }
}

export function isNativeViewEvent(raw: unknown): raw is NativeViewEvent {
  return parseNativeEvent(raw) !== null;
}

export function isActionName(value: string): value is ActionName {
  return (ACTION_NAMES as readonly string[]).includes(value);
}
