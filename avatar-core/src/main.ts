import { AppController, type AppConfig } from './app.ts';
import { hasFlutter, onFlutterMessage, postToFlutter, setDevSink, type ToFlutter } from './bridge.ts';
import { parseFromFlutter } from './bridgeValidate.ts';
import { NativeAvatarController, browserNativeDeps } from './nativeAvatar.ts';
import { DEFAULT_AVATAR_URL } from './avatar/catalog.ts';

const el = document.getElementById('avatar');
if (!el) throw new Error('#avatar missing');
let app: AppController | null = null;
let nativeApp: NativeAvatarController | null = null;

async function boot(cfg: AppConfig, audioMode?: 'native'): Promise<void> {
  if (app || nativeApp) return;
  if (audioMode === 'native') {
    const current = new NativeAvatarController(el!, browserNativeDeps(), cfg.avatarUrl);
    nativeApp = current;
    try {
      await current.start();
    } catch {
      if (nativeApp === current) nativeApp = null;
      el!.replaceChildren();
    }
    return;
  }
  const current = new AppController(el!, cfg);
  app = current;
  try {
    await current.start(); // posts the bridge error itself and releases mic/VAD on failure
  } catch {
    // Allow a later config message to retry with a clean element.
    if (app === current) app = null;
    el!.replaceChildren();
  }
}

// window.avatarBridge is reachable by any page script: validate before dispatch, never echo values.
onFlutterMessage((raw: unknown) => {
  const m = parseFromFlutter(raw);
  if (!m) {
    const isConfig = typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'config';
    postToFlutter({ type: 'error', code: isConfig ? 'bad_config' : 'bad_message' });
    return;
  }
  if (m.type === 'config') {
    void boot(
      { gatewayUrl: m.gatewayUrl, appSecret: m.appSecret, audioPath: m.audioPath, avatarUrl: m.avatarUrl, echo: m.echo ?? 'true' },
      m.audioMode,
    );
  } else if (nativeApp) {
    nativeApp.handleNativeEvent(m);
  } else {
    app?.handleFlutter(m);
  }
});

if (hasFlutter()) {
  postToFlutter({ type: 'ready' });
} else if (import.meta.env.DEV) {
  installDevPanel();
}

/** Desktop Chrome debugging only (never in the APK build): start button, subtitles, metrics, debug text. */
function installDevPanel(): void {
  const panel = document.getElementById('dev');
  const log = document.getElementById('dev-log');
  const startBtn = document.getElementById('dev-start');
  const input = document.getElementById('dev-text') as HTMLInputElement | null;
  if (!panel || !log || !startBtn || !input) return;
  panel.hidden = false;
  const lines: string[] = [];
  setDevSink((m: ToFlutter) => {
    const line =
      m.type === 'subtitle' ? `${m.role === 'user' ? '你' : 'AI'}${m.final ? '' : '…'}：${m.text}`
      : m.type === 'metric' ? `⏱ ${m.name} = ${m.ms} ms`
      : m.type === 'state' ? `● ${m.state}`
      : m.type === 'status' ? `[${m.status}]`
      : m.type === 'diag' ? `diag ${m.key}=${m.value}`
      : m.type === 'error' ? `✖ ${m.code}`
      : m.type;
    lines.push(line);
    log.textContent = lines.slice(-14).join('\n'); // textContent only: never innerHTML
  });
  startBtn.addEventListener('click', () => {
    startBtn.hidden = true;
    void boot({
      gatewayUrl: import.meta.env.VITE_GATEWAY_URL ?? 'http://127.0.0.1:8787',
      appSecret: import.meta.env.VITE_APP_SECRET ?? '',
      audioPath: 'A',
      avatarUrl: DEFAULT_AVATAR_URL,
      echo: new URLSearchParams(location.search).get('echo') === 'all' ? 'all' : 'true',
    });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    app?.handleFlutter({ type: 'debugText', text: input.value.trim() });
    input.value = '';
  });
}
