# Plan 1 · 05 Flutter Android 壳（Task 15–16）

> 先读 [00-overview.md](00-overview.md) 的 Global Constraints。Task 15 需要 Task 0 Step 1（Flutter/Android 工具链），Task 16 另需 Step 2（模拟器；真机在检查点 ① 接上）。这两个任务不依赖任何 TypeScript 任务；按"先写代码"的推荐顺序放在 Task 14 之后，也可以与 TS 任务并行。模拟器和真机调试统一用 `adb reverse tcp:8787 tcp:8787`，App 通过 `http://127.0.0.1:8787` 访问电脑上的网关，与 release 版"只对 127.0.0.1 放行明文"的规则一致。

---

### Task 15: Flutter 工程、本地资源服务、Bridge 解析与指标统计

**Files:**
- Create（`flutter create` 生成后修改）: `app/pubspec.yaml`, `app/lib/config.dart`, `app/lib/local_asset_server.dart`, `app/lib/bridge.dart`, `app/lib/metrics.dart`, `app/dev.example.json`, `scripts/build-web.sh`, `spikes/webview-probe/index.html`, `spikes/webview-probe/probe-worklet.js`
- Modify: `.gitignore`
- Test: `app/test/local_asset_server_test.dart`, `app/test/bridge_test.dart`, `app/test/metrics_test.dart`

**Depends on:** Task 0（Flutter/Android 工具链；真机在 Task 16 才需要）。不依赖任何 TypeScript 任务：Bridge 契约按 Task 14 的文档编写，`app/assets/web` 先用 `build-web.sh --probe-only` 生成探针页与占位目录。可与 Task 1–13 并行。

**Interfaces:**
- Consumes: Task 14 的 Bridge 契约（`ToFlutter` / `FromFlutter`，以文档为准）
- Produces:
  - `scripts/build-web.sh [--probe-only]`：重建 `app/assets/web`。默认构建 avatar-core 并拷入；`--probe-only` 不构建，只放探针页与占位目录（pubspec 列出的 assets 目录不存在时 Flutter 构建和 `flutter test` 都会报错，而 `app/assets/web/` 不入库，干净克隆后必须先跑一次本脚本）。两种模式都会放入 `probe.html`
  - `class AppConfig`：`gatewayUrl`、`appSecret`、`audioPath`、`echo`、`page`（dart-define `PAGE`，默认 `index.html`）、`static String? validate()`
  - `typedef AssetLoader = Future<ByteData> Function(String key)`；`class LocalAssetServer({required AssetLoader loadAsset, String assetRoot = 'assets/web'})`：`start()`、`stop()`、`baseUri`、`token`
  - `String? resolveAssetPath(String path, String token)`、`ContentType contentTypeFor(String path)`
  - `sealed class JsEvent` 及子类 `JsReady`、`JsSubtitle(role, text, isFinal)`、`JsState(state)`、`JsMetric(name, ms)`、`JsStatus(status)`、`JsDiag(key, value)`、`JsError(code)`；`JsEvent.parse(String raw): JsEvent?`；`String jsCall(Map<String, Object?> message)`
  - `class MetricsStore`：`add(name, ms, {at})`、`summary(): Map<String, MetricSummary>`、`toCsv()`；`class MetricSummary(count, p50, p90)`；`double percentile(List<double> sorted, double p)`

- [ ] **Step 1: 创建工程与依赖**

```bash
cd /Users/JedJiang/SourceCode/anyidea
flutter create --org com.anyidea --project-name avatar_app --platforms android app
cd app
flutter pub add webview_flutter:4.14.1 webview_flutter_android:4.14.1 permission_handler:13.0.2 wakelock_plus:1.8.1 record:7.1.2 flutter_pcm_sound:3.3.3
```

把 `app/pubspec.yaml` 的 `flutter:` 段替换为：

```yaml
flutter:
  uses-material-design: true
  assets:
    - assets/web/
    - assets/web/assets/
    - assets/web/vad/
    - assets/web/avatars/
    - assets/web/animations/
    - assets/web/spike/
```

`app/dev.example.json`:

```json
{
  "GATEWAY_URL": "http://127.0.0.1:8787",
  "APP_SECRET": "same-as-gateway-APP_SECRET",
  "AUDIO_PATH": "A",
  "ECHO": "true"
}
```

在仓库根 `.gitignore` 末尾追加（`dev.json` 含密钥）：

```
app/dev.json
```

```bash
cp dev.example.json dev.json
# The secret is generated once: reuse gateway/.env if it exists, otherwise create it here (Task 8 Step 9 copies it back).
SECRET="$(grep -s '^APP_SECRET=' ../gateway/.env | cut -d= -f2)"
[ -n "$SECRET" ] || SECRET="$(openssl rand -hex 16)"
sed -i '' "s/same-as-gateway-APP_SECRET/$SECRET/" dev.json
rm -f test/widget_test.dart   # generated counter-app test, replaced below
```

- [ ] **Step 1b: Web 资源脚本与 WebView 能力探针页**

`scripts/build-web.sh`:

```bash
#!/usr/bin/env bash
# Rebuilds app/assets/web for the Flutter app.
#   ./scripts/build-web.sh               build avatar-core and copy it, plus the WebView probe page
#   ./scripts/build-web.sh --probe-only  no avatar-core build: probe page and placeholder directories only
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-full}"
rm -rf app/assets/web
mkdir -p app/assets/web
if [ "$mode" != "--probe-only" ]; then
  if [ ! -f avatar-core/public/avatars/avatar.glb ] && [ -x scripts/fetch-assets.sh ]; then ./scripts/fetch-assets.sh; fi
  [ -f avatar-core/public/spike/speech-24k.pcm ] || ./scripts/make-mock-speech.sh
  npm run build -w avatar-core
  cp -R avatar-core/dist/. app/assets/web/
fi
cp spikes/webview-probe/index.html app/assets/web/probe.html
cp spikes/webview-probe/probe-worklet.js app/assets/web/probe-worklet.js
printf '\000asm\001\000\000\000' > app/assets/web/probe.wasm   # smallest valid wasm module
# Flutter refuses to build when a directory listed under pubspec.yaml assets is missing.
for d in assets vad avatars animations spike; do
  mkdir -p "app/assets/web/$d"
  [ -n "$(ls -A "app/assets/web/$d")" ] || echo "placeholder" > "app/assets/web/$d/PLACEHOLDER.txt"
done
if [ "$mode" = "--probe-only" ] && [ -f avatar-core/public/spike/speech-24k.pcm ]; then
  cp avatar-core/public/spike/speech-24k.pcm app/assets/web/spike/   # lets the path-B spike run early
fi
echo "web bundle ($mode): $(du -sh app/assets/web | cut -f1)"
```

`spikes/webview-probe/probe-worklet.js`:

```js
// Minimal AudioWorklet used by the WebView probe.
class ProbeProcessor extends AudioWorkletProcessor {
  process() {
    return true;
  }
}
registerProcessor('probe', ProbeProcessor);
```

`spikes/webview-probe/index.html`（不依赖 avatar-core 构建；结果显示在页面上，并作为 `diag` 事件发给 Flutter 调试面板）:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WebView probe</title>
    <style>
      body { margin: 0; padding: 72px 16px 16px; background: #10131a; color: #e8ecf3; font: 16px system-ui, sans-serif; }
      #out { white-space: pre-wrap; font-family: ui-monospace, monospace; }
    </style>
  </head>
  <body>
    <div id="out"></div>
    <script type="module">
      // Day-1 capability probe: runs without any user gesture.
      const out = document.getElementById('out');
      const post = (m) => window.FlutterBridge?.postMessage(JSON.stringify(m));
      function report(key, ok, detail) {
        const value = `${ok ? 'OK' : 'FAIL'} ${detail}`.slice(0, 160);
        out.textContent += `${key}: ${value}\n`; // textContent only
        post({ type: 'diag', key: `probe_${key}`, value });
      }
      async function check(key, fn) {
        try {
          report(key, true, String((await fn()) ?? ''));
        } catch (e) {
          report(key, false, `${e?.name ?? 'Error'}: ${e?.message ?? e}`);
        }
      }

      await check('secure_context', () => {
        if (!window.isSecureContext) throw new Error('not a secure context');
        return location.origin;
      });
      await check('webview', () => navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent);
      await check('autoplay', async () => {
        const ctx = new AudioContext();
        if (ctx.state !== 'running') await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 500))]);
        if (ctx.state !== 'running') throw new Error(`AudioContext state=${ctx.state} without a gesture`);
        const osc = ctx.createOscillator();
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3); // audible beep
        return `running @ ${ctx.sampleRate} Hz`;
      });
      await check('audio_worklet', async () => {
        const ctx = new AudioContext({ sampleRate: 24000 });
        await ctx.audioWorklet.addModule('./probe-worklet.js');
        new AudioWorkletNode(ctx, 'probe');
        await ctx.close();
        return 'addModule ok, 24 kHz context ok';
      });
      await check('wasm', async () => {
        await WebAssembly.instantiateStreaming(fetch('./probe.wasm'));
        return 'instantiateStreaming ok (application/wasm)';
      });
      await check('webgl2', () => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) throw new Error('no WebGL2');
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'WebGL2';
      });
      await check('microphone', async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        const s = stream.getAudioTracks()[0]?.getSettings() ?? {};
        stream.getTracks().forEach((t) => t.stop());
        return `echoCancellation=${s.echoCancellation} sampleRate=${s.sampleRate}`;
      });
      // Flutter answers 'ready' with the config message; use it to test cleartext access to the gateway.
      window.avatarBridge = {
        receive: (m) => {
          if (m.type !== 'config') return;
          void check('gateway', async () => {
            const res = await fetch(`${m.gatewayUrl}/healthz`);
            if (!res.ok) throw new Error(`http_${res.status}`);
            return m.gatewayUrl;
          });
        },
      };
      post({ type: 'ready' });
    </script>
  </body>
</html>
```

```bash
cd /Users/JedJiang/SourceCode/anyidea
chmod +x scripts/build-web.sh && ./scripts/build-web.sh --probe-only
ls app/assets/web app/assets/web/spike
```

Expected: 打印 `web bundle (--probe-only): …`；`app/assets/web` 下有 `probe.html`、`probe-worklet.js`、`probe.wasm` 和 5 个子目录。

- [ ] **Step 2: 写失败的测试**

`app/test/local_asset_server_test.dart`:

```dart
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:avatar_app/local_asset_server.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('resolveAssetPath', () {
    test('maps token-prefixed paths to asset keys', () {
      expect(resolveAssetPath('/tok/', 'tok'), 'index.html');
      expect(resolveAssetPath('/tok/assets/main.js', 'tok'), 'assets/main.js');
    });
    test('rejects wrong tokens and traversal', () {
      expect(resolveAssetPath('/other/index.html', 'tok'), isNull);
      expect(resolveAssetPath('/tok/../secret', 'tok'), isNull);
      expect(resolveAssetPath('/tok/a/%2e%2e/b', 'tok'), isNull);
      expect(resolveAssetPath('/tok/a//b', 'tok'), isNull);
      expect(resolveAssetPath('/tok/a\\b', 'tok'), isNull);
    });
  });

  test('content types cover the web bundle', () {
    expect(contentTypeFor('index.html').mimeType, 'text/html');
    expect(contentTypeFor('a.js').mimeType, 'application/javascript');
    expect(contentTypeFor('a.mjs').mimeType, 'application/javascript');
    expect(contentTypeFor('ort.wasm').mimeType, 'application/wasm');
    expect(contentTypeFor('m.glb').mimeType, 'model/gltf-binary');
    expect(contentTypeFor('x.onnx').mimeType, 'application/octet-stream');
  });

  group('LocalAssetServer', () {
    late LocalAssetServer server;
    final files = {'assets/web/index.html': '<h1>hi</h1>', 'assets/web/vad/m.wasm': 'wasm'};

    setUp(() async {
      server = LocalAssetServer(loadAsset: (key) async {
        final v = files[key];
        if (v == null) throw StateError('missing $key');
        return ByteData.sublistView(Uint8List.fromList(utf8.encode(v)));
      });
      await server.start();
    });
    tearDown(() => server.stop());

    Future<HttpClientResponse> get(Uri uri) async {
      final client = HttpClient();
      final req = await client.getUrl(uri);
      final res = await req.close();
      client.close();
      return res;
    }

    test('binds to loopback with a random token', () {
      expect(server.baseUri.host, '127.0.0.1');
      expect(server.token.length, 32);
      expect(server.baseUri.path, '/${server.token}/');
    });

    test('serves assets with the right type and no caching', () async {
      final res = await get(server.baseUri.resolve('index.html'));
      expect(res.statusCode, 200);
      expect(res.headers.contentType?.mimeType, 'text/html');
      expect(res.headers.value('cache-control'), 'no-store');
      expect(await utf8.decodeStream(res), '<h1>hi</h1>');
      final wasm = await get(server.baseUri.resolve('vad/m.wasm'));
      expect(wasm.headers.contentType?.mimeType, 'application/wasm');
    });

    test('returns 404 for unknown files and wrong tokens', () async {
      expect((await get(server.baseUri.resolve('nope.js'))).statusCode, 404);
      final wrong = server.baseUri.replace(path: '/wrongtoken/index.html');
      expect((await get(wrong)).statusCode, 404);
    });
  });
}
```

`app/test/bridge_test.dart`:

```dart
import 'package:avatar_app/bridge.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('parses every JS event type', () {
    expect(JsEvent.parse('{"type":"ready"}'), isA<JsReady>());
    final sub = JsEvent.parse('{"type":"subtitle","role":"assistant","text":"你好","final":false}') as JsSubtitle;
    expect((sub.role, sub.text, sub.isFinal), ('assistant', '你好', false));
    expect((JsEvent.parse('{"type":"state","state":"speaking"}') as JsState).state, 'speaking');
    final m = JsEvent.parse('{"type":"metric","name":"greeting_ms","ms":812}') as JsMetric;
    expect((m.name, m.ms), ('greeting_ms', 812.0));
    expect((JsEvent.parse('{"type":"status","status":"open"}') as JsStatus).status, 'open');
    final d = JsEvent.parse('{"type":"diag","key":"mic_settings","value":"{}"}') as JsDiag;
    expect((d.key, d.value), ('mic_settings', '{}'));
    expect((JsEvent.parse('{"type":"error","code":"NotAllowedError"}') as JsError).code, 'NotAllowedError');
  });

  test('rejects malformed or unknown messages', () {
    expect(JsEvent.parse('not json'), isNull);
    expect(JsEvent.parse('[]'), isNull);
    expect(JsEvent.parse('{"type":"subtitle","role":"x","text":1}'), isNull);
    expect(JsEvent.parse('{"type":"metric","name":"a","ms":"fast"}'), isNull);
    expect(JsEvent.parse('{"type":"other"}'), isNull);
  });

  test('builds a safe JS call', () {
    final js = jsCall({'type': 'debugText', 'text': '"); alert(1); ("'});
    expect(js, r'window.avatarBridge && window.avatarBridge.receive({"type":"debugText","text":"\"); alert(1); (\""});');
  });
}
```

`app/test/metrics_test.dart`:

```dart
import 'package:avatar_app/metrics.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('nearest-rank percentiles', () {
    final s = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
    expect(percentile(s, 50), 5.0);
    expect(percentile(s, 90), 9.0);
    expect(percentile([7.0], 90), 7.0);
  });

  test('summarizes per metric and exports CSV', () {
    final m = MetricsStore();
    final t = DateTime.utc(2026, 10, 12, 8);
    for (final v in [300.0, 100.0, 200.0]) {
      m.add('interrupt_stop_ms', v, at: t);
    }
    m.add('greeting_ms', 900, at: t);
    final s = m.summary();
    expect(s['interrupt_stop_ms']!.count, 3);
    expect(s['interrupt_stop_ms']!.p50, 200);
    expect(s['interrupt_stop_ms']!.p90, 300);
    expect(m.toCsv().split('\n').first, 'time,name,ms');
    expect(m.toCsv().split('\n')[1], '2026-10-12T08:00:00.000Z,interrupt_stop_ms,300');
  });
}
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd app && flutter test`
Expected: FAIL，找不到 `package:avatar_app/local_asset_server.dart` 等。

- [ ] **Step 4: 实现**

`app/lib/config.dart`:

```dart
/// Build-time configuration injected with --dart-define-from-file (never committed).
class AppConfig {
  static const gatewayUrl = String.fromEnvironment('GATEWAY_URL');
  static const appSecret = String.fromEnvironment('APP_SECRET');
  static const audioPath = String.fromEnvironment('AUDIO_PATH', defaultValue: 'A');
  static const echo = String.fromEnvironment('ECHO', defaultValue: 'true');

  /// Page inside the web bundle to load: 'index.html' (product), 'probe.html' (Task 16), 'spike-aec.html' (Task 17).
  static const page = String.fromEnvironment('PAGE', defaultValue: 'index.html');

  /// Returns a user-facing problem description, or null when the config is usable.
  static String? validate() {
    if (!gatewayUrl.startsWith('http')) return 'GATEWAY_URL 未配置';
    if (appSecret.length < 16) return 'APP_SECRET 未配置';
    if (audioPath != 'A' && audioPath != 'B') return 'AUDIO_PATH 只能是 A 或 B';
    return null;
  }
}
```

`app/lib/local_asset_server.dart`:

```dart
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

typedef AssetLoader = Future<ByteData> Function(String key);

/// Serves the bundled avatar-core build on 127.0.0.1 so the WebView gets a secure context
/// (ES modules, AudioWorklet, wasm, getUserMedia) without enabling file access.
class LocalAssetServer {
  LocalAssetServer({required this.loadAsset, this.assetRoot = 'assets/web'});

  final AssetLoader loadAsset;
  final String assetRoot;
  final String token = _randomToken();
  HttpServer? _server;

  Uri get baseUri {
    final server = _server;
    if (server == null) throw StateError('LocalAssetServer not started');
    return Uri.parse('http://127.0.0.1:${server.port}/$token/');
  }

  Future<void> start() async {
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server!.listen(_handle);
  }

  Future<void> stop() async {
    await _server?.close(force: true);
    _server = null;
  }

  Future<void> _handle(HttpRequest req) async {
    final res = req.response;
    try {
      final rel = resolveAssetPath(req.uri.path, token);
      if (req.method != 'GET' || rel == null) {
        res.statusCode = HttpStatus.notFound;
      } else {
        final data = await loadAsset('$assetRoot/$rel');
        res.headers.contentType = contentTypeFor(rel);
        res.headers.set(HttpHeaders.cacheControlHeader, 'no-store');
        res.add(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
      }
    } catch (_) {
      res.statusCode = HttpStatus.notFound;
    }
    await res.close();
  }
}

/// Asset path relative to the web root, or null if outside the token prefix or attempting traversal.
String? resolveAssetPath(String path, String token) {
  final prefix = '/$token/';
  if (!path.startsWith(prefix)) return null;
  final String rel;
  try {
    rel = Uri.decodeComponent(path.substring(prefix.length));
  } on ArgumentError {
    return null;
  }
  if (rel.isEmpty) return 'index.html';
  final segments = rel.split('/');
  if (segments.any((s) => s.isEmpty || s == '.' || s == '..' || s.contains('\\'))) return null;
  return rel;
}

ContentType contentTypeFor(String path) {
  final dot = path.lastIndexOf('.');
  final ext = dot < 0 ? '' : path.substring(dot + 1).toLowerCase();
  return switch (ext) {
    'html' => ContentType('text', 'html', charset: 'utf-8'),
    'js' || 'mjs' => ContentType('application', 'javascript', charset: 'utf-8'),
    'css' => ContentType('text', 'css', charset: 'utf-8'),
    'json' => ContentType('application', 'json', charset: 'utf-8'),
    'wasm' => ContentType('application', 'wasm'),
    'glb' => ContentType('model', 'gltf-binary'),
    'png' => ContentType('image', 'png'),
    'md' => ContentType('text', 'plain', charset: 'utf-8'),
    _ => ContentType('application', 'octet-stream'),
  };
}

String _randomToken() {
  final r = Random.secure();
  return List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
}
```

`app/lib/bridge.dart`:

```dart
import 'dart:convert';

/// Messages posted by avatar-core through the `FlutterBridge` JavaScript channel.
sealed class JsEvent {
  const JsEvent();

  static JsEvent? parse(String raw) {
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      return null;
    }
    if (decoded is! Map<String, Object?>) return null;
    return switch (decoded) {
      {'type': 'ready'} => const JsReady(),
      {'type': 'subtitle', 'role': final String role, 'text': final String text, 'final': final bool isFinal}
          when role == 'user' || role == 'assistant' =>
        JsSubtitle(role, text, isFinal),
      {'type': 'state', 'state': final String state} => JsState(state),
      {'type': 'metric', 'name': final String name, 'ms': final num ms} => JsMetric(name, ms.toDouble()),
      {'type': 'status', 'status': final String status} => JsStatus(status),
      {'type': 'diag', 'key': final String key, 'value': final String value} => JsDiag(key, value),
      {'type': 'error', 'code': final String code} => JsError(code),
      _ => null,
    };
  }
}

final class JsReady extends JsEvent {
  const JsReady();
}

final class JsSubtitle extends JsEvent {
  const JsSubtitle(this.role, this.text, this.isFinal);
  final String role;
  final String text;
  final bool isFinal;
}

final class JsState extends JsEvent {
  const JsState(this.state);
  final String state;
}

final class JsMetric extends JsEvent {
  const JsMetric(this.name, this.ms);
  final String name;
  final double ms;
}

final class JsStatus extends JsEvent {
  const JsStatus(this.status);
  final String status;
}

final class JsDiag extends JsEvent {
  const JsDiag(this.key, this.value);
  final String key;
  final String value;
}

final class JsError extends JsEvent {
  const JsError(this.code);
  final String code;
}

/// JSON is a valid JS literal, so encoding the whole message avoids any string-concatenation injection.
String jsCall(Map<String, Object?> message) =>
    'window.avatarBridge && window.avatarBridge.receive(${jsonEncode(message)});';
```

`app/lib/metrics.dart`:

```dart
class MetricSummary {
  const MetricSummary(this.count, this.p50, this.p90);
  final int count;
  final double p50;
  final double p90;
}

/// Nearest-rank percentile of an ascending list.
double percentile(List<double> sorted, double p) {
  if (sorted.isEmpty) return 0;
  final rank = (p / 100 * sorted.length).ceil().clamp(1, sorted.length);
  return sorted[rank - 1];
}

/// Collects latency samples on device (timings only, no conversation content).
class MetricsStore {
  final _rows = <(DateTime, String, double)>[];

  void add(String name, double ms, {DateTime? at}) => _rows.add(((at ?? DateTime.now()).toUtc(), name, ms));

  Map<String, MetricSummary> summary() {
    final byName = <String, List<double>>{};
    for (final (_, name, ms) in _rows) {
      byName.putIfAbsent(name, () => []).add(ms);
    }
    return byName.map((name, values) {
      values.sort();
      return MapEntry(name, MetricSummary(values.length, percentile(values, 50), percentile(values, 90)));
    });
  }

  String toCsv() {
    final b = StringBuffer('time,name,ms');
    for (final (at, name, ms) in _rows) {
      b.write('\n${at.toIso8601String()},$name,${ms.round()}');
    }
    return b.toString();
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd app && flutter test`
Expected: 全部 PASS（local_asset_server 6 个、bridge 3 个、metrics 2 个）。若报 "unable to find directory entry in pubspec.yaml: …/assets/web/…" 之类的错误，说明还没生成 `app/assets/web`，先执行 `./scripts/build-web.sh --probe-only`。

- [ ] **Step 6: 静态检查与提交**

Run: `cd app && flutter analyze`
Expected: `No issues found!`

```bash
cd /Users/JedJiang/SourceCode/anyidea
git add .gitignore app scripts/build-web.sh spikes/webview-probe
git status --short app | grep -E 'dev\.json|assets/web' && echo "STOP: secret or generated assets staged" || true
git commit -m "feat(app): Flutter shell scaffold, loopback asset server, bridge parsing, metrics, web probe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: WebView 页面、Android 配置与真机能力探针（Day 1 ①）

**Files:**
- Create: `app/lib/overlay.dart`, `app/lib/avatar_page.dart`, `app/android/app/src/main/res/xml/network_security_config.xml`, `app/android/app/src/debug/res/xml/network_security_config.xml`
- Modify: `app/lib/main.dart`, `app/android/app/src/main/AndroidManifest.xml`
- Test: `app/test/overlay_test.dart`

**Depends on:** Task 15；Task 0 Step 2a（模拟器）。**不依赖 avatar-core**：首跑加载 Task 15 的探针页，验证 spec §9 Day 1 ① 的全部能力项。本任务在模拟器上完成即可提交，结果标【模拟器】；Step 8–9 必须在**真机检查点 ①** 用小米手机再跑一遍，以真机结果为准。完整虚拟人页面的首跑在 Task 18 Step 0。探针的 gateway 项需要 Task 8 的网关在跑。

**Interfaces:**
- Consumes: Task 15 的 `AppConfig`（含 `page`）、`LocalAssetServer`、`JsEvent`、`jsCall`、`MetricsStore`；Task 14 的 Bridge 契约
- Produces: 可安装的 debug APK；`AvatarOverlay` 组件（字幕、AI 标识、状态、静音、结束、长按 AI 标识打开调试面板）；能力探针结果（模拟器与真机分列，写入 ADR-001 的"其他 Day 1 验证项"；ADR 文件由 Task 17 创建，此前先记在 `docs/blockers.md` 或终端）

- [ ] **Step 1: 写失败的 widget 测试**

`app/test/overlay_test.dart`:

```dart
import 'package:avatar_app/overlay.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('shows AI badge, subtitles and status; buttons call back', (tester) async {
    var muteTaps = 0;
    var endTaps = 0;
    var debugToggles = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AvatarOverlay(
          userLine: '我叫老王',
          aiLine: '王叔好',
          status: '网络有点慢，稍等我一下',
          error: null,
          muted: false,
          onMute: () => muteTaps++,
          onEnd: () => endTaps++,
          onToggleDebug: () => debugToggles++,
        ),
      ),
    ));
    expect(find.text('AI 虚拟人'), findsOneWidget);
    expect(find.text('我叫老王'), findsOneWidget);
    expect(find.text('王叔好'), findsOneWidget);
    expect(find.text('网络有点慢，稍等我一下'), findsOneWidget);
    await tester.tap(find.byKey(const Key('mute')));
    await tester.tap(find.byKey(const Key('end')));
    await tester.longPress(find.text('AI 虚拟人'));
    expect((muteTaps, endTaps, debugToggles), (1, 1, 1));
  });

  testWidgets('shows errors prominently', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AvatarOverlay(
          userLine: '', aiLine: '', status: '', error: '需要麦克风权限才能聊天', muted: true,
          onMute: () {}, onEnd: () {}, onToggleDebug: () {},
        ),
      ),
    ));
    expect(find.text('需要麦克风权限才能聊天'), findsOneWidget);
    expect(find.byIcon(Icons.mic_off), findsOneWidget);
  });
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd app && flutter test test/overlay_test.dart`
Expected: FAIL，找不到 `package:avatar_app/overlay.dart`。

- [ ] **Step 3: 实现 AvatarOverlay**

`app/lib/overlay.dart`:

```dart
import 'package:flutter/material.dart';

/// Native UI drawn over the WebView avatar. Large text and touch targets (≥18 sp, ≥60 dp).
class AvatarOverlay extends StatelessWidget {
  const AvatarOverlay({
    super.key,
    required this.userLine,
    required this.aiLine,
    required this.status,
    required this.error,
    required this.muted,
    required this.onMute,
    required this.onEnd,
    required this.onToggleDebug,
    this.debugPanel,
  });

  final String userLine;
  final String aiLine;
  final String status;
  final String? error;
  final bool muted;
  final VoidCallback onMute;
  final VoidCallback onEnd;
  final VoidCallback onToggleDebug;
  final Widget? debugPanel;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Stack(
        children: [
          Positioned(
            top: 12,
            left: 12,
            child: GestureDetector(
              onLongPress: onToggleDebug,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(16)),
                child: const Text('AI 虚拟人', style: TextStyle(color: Colors.white, fontSize: 16)),
              ),
            ),
          ),
          if (status.isNotEmpty)
            Positioned(
              top: 16,
              right: 12,
              child: Text(status, style: const TextStyle(color: Colors.amberAccent, fontSize: 16)),
            ),
          Positioned(
            left: 16,
            right: 16,
            bottom: 104,
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(12)),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (userLine.isNotEmpty) Text(userLine, style: const TextStyle(color: Colors.white70, fontSize: 18)),
                  if (aiLine.isNotEmpty) Text(aiLine, style: const TextStyle(color: Colors.white, fontSize: 20)),
                ],
              ),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 24,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                _RoundButton(key: const Key('mute'), icon: muted ? Icons.mic_off : Icons.mic, color: Colors.white24, onTap: onMute),
                const SizedBox(width: 40),
                _RoundButton(key: const Key('end'), icon: Icons.call_end, color: Colors.redAccent, onTap: onEnd),
              ],
            ),
          ),
          if (error != null)
            Center(
              child: Container(
                margin: const EdgeInsets.all(24),
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(color: Colors.black87, borderRadius: BorderRadius.circular(12)),
                child: Text(error!, style: const TextStyle(color: Colors.white, fontSize: 20)),
              ),
            ),
          if (debugPanel != null) Positioned(top: 56, left: 8, right: 8, child: debugPanel!),
        ],
      ),
    );
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({super.key, required this.icon, required this.color, required this.onTap});

  final IconData icon;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: color,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: SizedBox(width: 64, height: 64, child: Icon(icon, color: Colors.white, size: 32)),
      ),
    );
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd app && flutter test test/overlay_test.dart`
Expected: 2 个测试 PASS。

- [ ] **Step 5: 实现 AvatarPage**

`app/lib/avatar_page.dart`:

```dart
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import 'bridge.dart';
import 'config.dart';
import 'local_asset_server.dart';
import 'metrics.dart';
import 'overlay.dart';

const _statusLabels = {
  'loading': '加载中…',
  'connecting': '连接中…',
  'open': '',
  'reconnecting': '网络有点慢，稍等我一下',
  'model_reconnecting': '网络有点慢，稍等我一下',
  'closed': '对话已结束',
};

String _errorLabel(String code) => switch (code) {
      'NotAllowedError' => '麦克风被拒绝，请在设置中允许',
      'NotFoundError' => '没有找到麦克风',
      _ => '出错了：$code',
    };

class AvatarPage extends StatefulWidget {
  const AvatarPage({super.key});

  @override
  State<AvatarPage> createState() => _AvatarPageState();
}

class _AvatarPageState extends State<AvatarPage> {
  final _server = LocalAssetServer(loadAsset: rootBundle.load);
  final _metrics = MetricsStore();
  final _diag = <String, String>{};
  final _debugText = TextEditingController();
  WebViewController? _controller;
  String _userLine = '';
  String _aiLine = '';
  String _status = '准备中…';
  String _state = 'idle';
  String? _error;
  bool _muted = false;
  bool _debug = false;

  @override
  void initState() {
    super.initState();
    WakelockPlus.enable();
    _init();
  }

  Future<void> _init() async {
    final mic = await Permission.microphone.request();
    if (!mic.isGranted) {
      setState(() => _error = '需要麦克风权限才能聊天');
      return;
    }
    await _server.start();
    final base = _server.baseUri;
    final controller = WebViewController(
      onPermissionRequest: (request) {
        final onlyMic = request.types.isNotEmpty && request.types.every((t) => t == WebViewPermissionResourceType.microphone);
        onlyMic ? request.grant() : request.deny();
      },
    );
    await controller.setJavaScriptMode(JavaScriptMode.unrestricted);
    await controller.setBackgroundColor(const Color(0xFF10131A));
    await controller.addJavaScriptChannel('FlutterBridge', onMessageReceived: (m) => _onJs(m.message));
    await controller.setNavigationDelegate(NavigationDelegate(
      onNavigationRequest: (req) =>
          req.url.startsWith(base.toString()) ? NavigationDecision.navigate : NavigationDecision.prevent,
    ));
    final platform = controller.platform;
    if (platform is AndroidWebViewController) {
      await platform.setMediaPlaybackRequiresUserGesture(false);
      await platform.setAllowFileAccess(false);
      await AndroidWebViewController.enableDebugging(kDebugMode);
    }
    await controller.loadRequest(base.resolve(AppConfig.page));
    if (mounted) setState(() => _controller = controller);
  }

  void _onJs(String raw) {
    final event = JsEvent.parse(raw);
    if (event == null || !mounted) return;
    switch (event) {
      case JsReady():
        _send({
          'type': 'config',
          'gatewayUrl': AppConfig.gatewayUrl,
          'appSecret': AppConfig.appSecret,
          'audioPath': AppConfig.audioPath,
          'echo': AppConfig.echo,
        });
      case JsSubtitle(:final role, :final text):
        setState(() => role == 'user' ? _userLine = text : _aiLine = text);
      case JsState(:final state):
        setState(() => _state = state);
      case JsMetric(:final name, :final ms):
        setState(() => _metrics.add(name, ms));
      case JsStatus(:final status):
        setState(() => _status = _statusLabels[status] ?? status);
      case JsDiag(:final key, :final value):
        setState(() => _diag[key] = value);
      case JsError(:final code):
        setState(() => _error = _errorLabel(code));
    }
  }

  void _send(Map<String, Object?> message) => _controller?.runJavaScript(jsCall(message));

  void _toggleMute() {
    setState(() => _muted = !_muted);
    _send({'type': 'mute', 'muted': _muted});
  }

  void _end() {
    _send({'type': 'end'});
    setState(() => _status = _statusLabels['closed']!);
  }

  Widget _debugPanel() {
    final summary = _metrics.summary().entries.map((e) => '${e.key}: n=${e.value.count} p50=${e.value.p50.round()} p90=${e.value.p90.round()}');
    return Container(
      padding: const EdgeInsets.all(8),
      color: Colors.black87,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('state=$_state  audioPath=${AppConfig.audioPath}  echo=${AppConfig.echo}', style: const TextStyle(color: Colors.white70)),
          ...summary.map((s) => Text(s, style: const TextStyle(color: Colors.white))),
          ..._diag.entries.map((e) => Text('${e.key}=${e.value}', style: const TextStyle(color: Colors.white54, fontSize: 12))),
          Row(children: [
            Expanded(
              child: TextField(
                controller: _debugText,
                style: const TextStyle(color: Colors.white),
                decoration: const InputDecoration(hintText: '输入文字代替语音', hintStyle: TextStyle(color: Colors.white38)),
                onSubmitted: (v) {
                  if (v.trim().isEmpty) return;
                  _send({'type': 'debugText', 'text': v.trim()});
                  _debugText.clear();
                },
              ),
            ),
            TextButton(
              onPressed: () => Clipboard.setData(ClipboardData(text: _metrics.toCsv())),
              child: const Text('复制 CSV'),
            ),
          ]),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _server.stop();
    _debugText.dispose();
    WakelockPlus.disable();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    return Scaffold(
      backgroundColor: const Color(0xFF10131A),
      body: Stack(
        children: [
          if (controller != null) Positioned.fill(child: WebViewWidget(controller: controller)),
          AvatarOverlay(
            userLine: _userLine,
            aiLine: _aiLine,
            status: _status,
            error: _error,
            muted: _muted,
            onMute: _toggleMute,
            onEnd: _end,
            onToggleDebug: () => setState(() => _debug = !_debug),
            debugPanel: _debug ? _debugPanel() : null,
          ),
        ],
      ),
    );
  }
}
```

注：若 `setAllowFileAccess` 在 webview_flutter_android 4.14.1 中不存在（编译报错），删除该行并记入 `docs/blockers.md`——WebView 只加载 127.0.0.1 页面且导航被限制，风险可接受。

`app/lib/main.dart`（替换生成的计数器示例）:

```dart
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'avatar_page.dart';
import 'config.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
  runApp(const AvatarApp());
}

class AvatarApp extends StatelessWidget {
  const AvatarApp({super.key});

  @override
  Widget build(BuildContext context) {
    final problem = AppConfig.validate();
    return MaterialApp(
      title: 'AI 虚拟人',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: Colors.teal, brightness: Brightness.dark),
      home: problem == null
          ? const AvatarPage()
          : Scaffold(body: Center(child: Text('配置错误：$problem', style: const TextStyle(fontSize: 20)))),
    );
  }
}
```

- [ ] **Step 6: Android 权限与网络安全配置**

`app/android/app/src/main/res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- Release: cleartext only to 127.0.0.1 (bundled page + adb-reversed dev gateway). Everything else must be HTTPS/WSS. -->
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
    </domain-config>
</network-security-config>
```

`app/android/app/src/debug/res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- Debug builds only: allow a LAN gateway (ws://192.168.x.x) during development. -->
<network-security-config>
    <base-config cleartextTrafficPermitted="true" />
</network-security-config>
```

修改 `app/android/app/src/main/AndroidManifest.xml`：

```bash
cd /Users/JedJiang/SourceCode/anyidea/app
python3 -I - android/app/src/main/AndroidManifest.xml <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
perms = (
    '    <uses-permission android:name="android.permission.INTERNET" />\n'
    '    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n'
    '    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />\n'
)
if 'RECORD_AUDIO' not in s:
    s = s.replace('    <application', perms + '    <application', 1)
if 'networkSecurityConfig' not in s:
    s = s.replace('<application', '<application\n        android:networkSecurityConfig="@xml/network_security_config"', 1)
open(p, 'w', encoding='utf-8').write(s)
PY
grep -n 'uses-permission\|networkSecurityConfig' android/app/src/main/AndroidManifest.xml
```

Expected: 打印 3 行 `uses-permission` 和 1 行 `android:networkSecurityConfig`。

- [ ] **Step 7: 准备 Web 资源**

```bash
cd /Users/JedJiang/SourceCode/anyidea
./scripts/build-web.sh --probe-only   # avatar-core 已能构建时也可以不带参数；两种模式都包含 probe.html
```

- [ ] **Step 8: 能力探针（debug 包；先模拟器，真机检查点 ① 再跑一遍）**

先启动模拟器（Task 0 Step 2a），依次在 `Medium_Phone_API_36.1` 和 `API31_Phone` 上跑；到真机检查点 ① 时接上小米手机，用同样的命令再跑（多台设备在线时 `adb -s`、`flutter run -d` 指定设备）。

```bash
cd /Users/JedJiang/SourceCode/anyidea
npm run dev -w gateway &                    # 可选：Task 8 完成后才有；没有就跳过，探针 gateway 项记"未测"
adb reverse tcp:8787 tcp:8787               # 设备上的 127.0.0.1:8787 → 电脑网关（模拟器同样支持；真机走 USB，不受手机网络影响）
cd app && flutter run --dart-define-from-file=dev.json --dart-define=PAGE=probe.html
```

真机首次安装时小米会弹"USB 安装"确认，点允许；App 首次启动弹麦克风权限，点允许。**之后不要触碰屏幕**，直到探针结果全部出现（autoplay 项要求无手势）。电脑 Chrome 打开 `chrome://inspect/#devices` 可以看到 WebView 并打开控制台。结果显示在页面上；长按左上角"AI 虚拟人"打开的调试面板里也有 `probe_*` 项。

通过标准与失败退路（结果记入 ADR-001 的"其他 Day 1 验证项"，标明【模拟器】或【真机】；任一项失败按阻塞规则记录，不要卡住）。**退路只按真机结果执行**：模拟器上某项失败，先记录并继续，到检查点 ① 用真机确认后再决定是否改方案；模拟器上通过也不能代替真机。模拟器 `microphone` 项需要先打开主机音频输入，`webview` 版本以小米真机为准：

| 探针项 | 通过标准 | 失败时 |
|---|---|---|
| `secure_context` | OK，origin 为 `http://127.0.0.1:<端口>` | 本地服务方案不成立：改用 spec 的 `WebViewAssetLoader` 退路，作为 Plan 1 的阻塞项上报 |
| `webview` | Chrome 主版本号 ≥120 | 记录版本；尝试在应用商店更新"Android System WebView" |
| `autoplay` | OK（无手势 `running`，并听到 0.3 秒提示音） | 降级为"首次打开点一下开始"：手势必须发生在 WebView 页面内（Flutter 覆盖层上的点击不算），做法同 Task 14 桌面调试页的"开始对话"按钮——点击后再创建 AudioContext；记入报告的"允许降级"项 |
| `audio_worklet` | OK | 记阻塞；退路是播放/采集改用 ScriptProcessorNode（Plan 1 内只记录，不实现） |
| `wasm` | OK | 先查 `LocalAssetServer` 是否返回 `application/wasm`；仍失败则 VAD 退回 `EnergyTrigger` 能量阈值（记入报告） |
| `webgl2` | OK，并记下 GPU 名称 | three.js r180 需要 WebGL2：记阻塞，换设备 |
| `microphone` | OK，`echoCancellation=true` | 检查 RECORD_AUDIO 运行时权限与 `onPermissionRequest` |
| `gateway` | OK（需网关在跑） | 查 `adb reverse`、CORS（网关日志）、`ERR_CLEARTEXT_NOT_PERMITTED` |

另外确认 `chrome://inspect` 控制台没有 `ERR_CLEARTEXT_NOT_PERMITTED`、`NotAllowedError` 之外的未预期报错。

- [ ] **Step 9: release 构建加载验证（spec §9 Day 1 ① 要求）**

```bash
cd /Users/JedJiang/SourceCode/anyidea/app
flutter build apk --release --dart-define-from-file=dev.json --dart-define=PAGE=probe.html
adb install -r build/app/outputs/flutter-apk/app-release.apk
adb shell am start -n com.anyidea.avatar_app/.MainActivity
```

Expected: release 包的探针结果与 debug 包一致（`adb reverse` 仍需保持）。模拟器上先验证一次，真机检查点 ① 必须再验证。若页面空白且 `adb logcat | grep -i cleartext` 出现 `CLEARTEXT_NOT_PERMITTED`：说明 WebView 没有按 `domain-config` 放行 127.0.0.1，按 spec 的退路改用 `WebViewAssetLoader`（`https://appassets.androidplatform.net`），把这件事记入 `docs/blockers.md` 并作为 Plan 2 的第一项；Plan 1 其余验收先用 debug 包继续。

- [ ] **Step 10: 提交**

```bash
cd /Users/JedJiang/SourceCode/anyidea
git add app/lib app/test app/android/app/src/main/AndroidManifest.xml app/android/app/src/main/res/xml app/android/app/src/debug/res/xml
git commit -m "feat(app): WebView avatar page, native overlay, Android permissions and network policy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
