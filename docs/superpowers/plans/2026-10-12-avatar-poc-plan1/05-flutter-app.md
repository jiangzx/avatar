# Plan 1 · 05 Flutter Android 壳（Task 15–16）

> 先读 [00-overview.md](00-overview.md) 的 Global Constraints。Task 0 Step 1–2 必须已完成（adb 可用、小米手机已连接）。真机调试统一用 `adb reverse tcp:8787 tcp:8787`，App 通过 `http://127.0.0.1:8787` 访问电脑上的网关，与 release 版"只对 127.0.0.1 放行明文"的规则一致。

---

### Task 15: Flutter 工程、本地资源服务、Bridge 解析与指标统计

**Files:**
- Create（`flutter create` 生成后修改）: `app/pubspec.yaml`, `app/lib/config.dart`, `app/lib/local_asset_server.dart`, `app/lib/bridge.dart`, `app/lib/metrics.dart`, `app/dev.example.json`
- Modify: `.gitignore`
- Test: `app/test/local_asset_server_test.dart`, `app/test/bridge_test.dart`, `app/test/metrics_test.dart`

**Interfaces:**
- Consumes: Task 14 的 Bridge 契约（`ToFlutter` / `FromFlutter`）
- Produces:
  - `class AppConfig`：`gatewayUrl`、`appSecret`、`audioPath`、`echo`、`static String? validate()`
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
sed -i '' "s/same-as-gateway-APP_SECRET/$(grep APP_SECRET ../gateway/.env | cut -d= -f2)/" dev.json
rm -f test/widget_test.dart   # generated counter-app test, replaced below
```

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
Expected: 全部 PASS（local_asset_server 6 个、bridge 3 个、metrics 2 个）。

- [ ] **Step 6: 静态检查与提交**

Run: `cd app && flutter analyze`
Expected: `No issues found!`

```bash
cd /Users/JedJiang/SourceCode/anyidea
git add .gitignore app
git commit -m "feat(app): Flutter shell scaffold, loopback asset server, bridge parsing, metrics

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: WebView 页面、Android 配置与真机首跑

**Files:**
- Create: `app/lib/overlay.dart`, `app/lib/avatar_page.dart`, `app/android/app/src/main/res/xml/network_security_config.xml`, `app/android/app/src/debug/res/xml/network_security_config.xml`, `scripts/build-web.sh`
- Modify: `app/lib/main.dart`, `app/android/app/src/main/AndroidManifest.xml`
- Test: `app/test/overlay_test.dart`

**Interfaces:**
- Consumes: Task 15 的 `AppConfig`、`LocalAssetServer`、`JsEvent`、`jsCall`、`MetricsStore`；Task 14 的 Bridge 契约
- Produces: 可安装的 debug APK；`AvatarOverlay` 组件（字幕、AI 标识、状态、静音、结束、长按 AI 标识打开调试面板）

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
    await controller.loadRequest(base.resolve('index.html'));
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

- [ ] **Step 7: Web 产物打包脚本**

`scripts/build-web.sh`:

```bash
#!/usr/bin/env bash
# Builds avatar-core and copies it into the Flutter app's assets.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f avatar-core/public/avatars/avatar.glb ] || ./scripts/fetch-assets.sh
[ -f avatar-core/public/spike/speech-24k.pcm ] || ./scripts/make-mock-speech.sh
npm run build -w avatar-core
rm -rf app/assets/web
mkdir -p app/assets
cp -R avatar-core/dist app/assets/web
for d in assets vad avatars animations spike; do
  [ -d "app/assets/web/$d" ] || { echo "missing app/assets/web/$d" >&2; exit 1; }
done
echo "web bundle: $(du -sh app/assets/web | cut -f1)"
```

```bash
cd /Users/JedJiang/SourceCode/anyidea
chmod +x scripts/build-web.sh && ./scripts/build-web.sh
```

Expected: 打印 `web bundle: …M`（约 15–30 MB，主要是 GLB 与 onnxruntime wasm）。

- [ ] **Step 8: 真机首跑**

```bash
cd /Users/JedJiang/SourceCode/anyidea
npm run dev -w gateway &                    # 网关监听 :8787
adb reverse tcp:8787 tcp:8787               # 手机 127.0.0.1:8787 → 电脑网关
cd app && flutter run --dart-define-from-file=dev.json
```

首次安装时小米会弹"USB 安装"确认，点允许；App 首次启动弹麦克风权限，点允许。电脑 Chrome 打开 `chrome://inspect/#devices` 可以看到 WebView 并打开控制台。

逐项核对（结果记入 Task 18 的验收清单，卡住按阻塞规则处理）：

1. 页面加载，虚拟人出现，**不需要任何点击**就开始 Mock 问候（验证"免手势播放"）。
2. 长按左上角"AI 虚拟人"打开调试面板：`audio_context=running`；`mic_settings` 中 `echoCancellation` 为 `true`；`greeting_ms` 有数值。
3. 在调试面板输入"挥挥手"：虚拟人挥手并说"好呀，来，挥挥手！"。
4. 对着手机说话：状态依次变为 listening → thinking → speaking；字幕显示 Mock 脚本里的用户文本。
5. `chrome://inspect` 控制台没有 `ERR_CLEARTEXT_NOT_PERMITTED`、`NotAllowedError`、wasm 加载失败等报错。

- [ ] **Step 9: release 构建加载验证（spec §9 Day 1 ① 要求）**

```bash
cd /Users/JedJiang/SourceCode/anyidea/app
flutter build apk --release --dart-define-from-file=dev.json
adb install -r build/app/outputs/flutter-apk/app-release.apk
adb shell am start -n com.anyidea.avatar_app/.MainActivity
```

Expected: release 包同样能加载页面并开始问候（`adb reverse` 仍需保持）。若页面空白且 `adb logcat | grep -i cleartext` 出现 `CLEARTEXT_NOT_PERMITTED`：说明 WebView 没有按 `domain-config` 放行 127.0.0.1，按 spec 的退路改用 `WebViewAssetLoader`（`https://appassets.androidplatform.net`），把这件事记入 `docs/blockers.md` 并作为 Plan 2 的第一项；Plan 1 其余验收先用 debug 包继续。

- [ ] **Step 10: 提交**

```bash
cd /Users/JedJiang/SourceCode/anyidea
git add scripts/build-web.sh app/lib app/test app/android/app/src/main/AndroidManifest.xml app/android/app/src/main/res/xml app/android/app/src/debug/res/xml
git commit -m "feat(app): WebView avatar page, native overlay, Android permissions and network policy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
