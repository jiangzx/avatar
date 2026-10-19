import { ACTION_NAMES, type ActionName } from '@anyidea/protocol';
import { MouthAnalyzer } from './audio/mouth.ts';
import type { ActionsLike, AvatarLike, DocLike } from './app.ts';
import { parseFromFlutter } from './bridgeValidate.ts';
import { postToFlutter, type NativeViewEvent, type ToFlutter } from './bridge.ts';
import type { AvatarState } from './avatar/stateMachine.ts';
import { ActionPlayer } from './avatar/actions.ts';
import { AvatarView } from './avatar/avatarView.ts';
import { SubtitleMouth } from './avatar/subtitleMouth.ts';
import { DEFAULT_AVATAR_URL } from './avatar/catalog.ts';

/** Bridge `avatar.action` source used by Flutter for listening nods (local VAD backchannel). */
export const BACKCHANNEL_SOURCE = 'backchannel';

export interface NativeAvatarDeps {
  createAvatar(el: HTMLElement): AvatarLike;
  createActions(avatar: AvatarLike): ActionsLike;
  post(event: ToFlutter): void;
  doc: DocLike;
}

export function browserNativeDeps(): NativeAvatarDeps {
  return {
    createAvatar: (el) => new AvatarView(el),
    createActions: (avatar) => new ActionPlayer(avatar.talkingHead, { waveFbx: './animations/waving.fbx' }, { setActing: (active) => avatar.setActing(active) }),
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
  private readonly subtitleMouth = new SubtitleMouth();
  private speakTimer: ReturnType<typeof setInterval> | null = null;
  private ended = false;
  private readonly onVisibilityChange = () => {
    if (!this.ended) this.avatar?.setRendering(!this.deps.doc.hidden);
  };
  private visibilityListenerAttached = false;

  constructor(
    private readonly el: HTMLElement,
    private readonly deps: NativeAvatarDeps,
    private readonly avatarUrl = DEFAULT_AVATAR_URL,
  ) {}

  async start(): Promise<void> {
    if (this.avatar) return;
    this.ended = false;
    this.deps.post({ type: 'status', status: 'loading' });
    const avatar = this.deps.createAvatar(this.el);
    await avatar.load(this.avatarUrl, () => this.deps.post({ type: 'diag', key: 'avatar_fallback', value: '1' }));
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
        if (event.role === 'assistant' && !event.final) {
          this.liveAssistantText = event.text;
          this.speakSubtitle(event.text);
        }
        if (event.role === 'assistant' && event.final) this.liveAssistantText = '';
        this.deps.post({ type: 'subtitle', role: event.role, text: event.text, final: event.final });
        break;
      case 'response.start':
        this.activeSeq = event.responseSeq;
        this.transition('thinking');
        break;
      case 'response.end':
        // playedMs 0 = empty reply (e.g. before a tool call): keep the thinking pose.
        this.finishResponse(event.responseSeq, false, event.playedMs === 0);
        break;
      case 'response.cancelled':
        this.finishResponse(event.responseSeq, true);
        break;
      case 'avatar.action':
        if (event.action === 'nod' && event.source === BACKCHANNEL_SOURCE) this.actions?.nod(true);
        else this.actions?.play(event.action);
        break;
      case 'avatar.emotion':
        this.avatar?.setEmotion(event.emotion);
        break;
      case 'audio.level':
        break; // speaking follows the first reply audio frame (state message from Flutter), not mic levels
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
    this.stopSubtitleMouth();
    this.actions?.stopAll();
    this.avatar?.setMouth(null);
    this.avatar?.setRendering(false);
    this.avatar = null;
    this.actions = null;
  }

  private finishResponse(responseSeq: number, cancelled: boolean, keepState = false): void {
    if (this.liveAssistantText) {
      this.deps.post({ type: 'subtitle', role: 'assistant', text: this.liveAssistantText, final: true });
      this.liveAssistantText = '';
    }
    if (this.activeSeq === responseSeq) this.activeSeq = null;
    if (cancelled) this.actions?.stopAll();
    this.stopSubtitleMouth();
    this.avatar?.setMouth(null);
    if (!keepState) this.transition('idle');
  }

  /** Drive the mouth from new subtitle characters, one slot at a time. */
  private speakSubtitle(text: string): void {
    const shape = this.subtitleMouth.feed(text);
    if (shape) this.avatar?.setMouth(shape);
    if (this.subtitleMouth.pending && this.speakTimer === null) {
      this.speakTimer = setInterval(() => {
        const next = this.subtitleMouth.poll(40);
        if (next) this.avatar?.setMouth(next);
        if (!this.subtitleMouth.pending && this.speakTimer !== null) {
          clearInterval(this.speakTimer);
          this.speakTimer = null;
        }
      }, 40);
    }
  }

  private stopSubtitleMouth(): void {
    this.subtitleMouth.reset();
    if (this.speakTimer !== null) {
      clearInterval(this.speakTimer);
      this.speakTimer = null;
    }
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
