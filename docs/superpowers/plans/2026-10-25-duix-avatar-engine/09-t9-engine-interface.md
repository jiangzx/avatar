# Task 9: AvatarEngine 接口、WebView 引擎搬移、AvatarPage 重构、状态提示条

**风险提示**：这一步改的是现有 3D 主路径，要求「行为零变化」。现有 `app/test/` 必须全部原样通过，不许为了通过而修改现有测试的断言；只能新增测试。

**Files:**
- Create: `app/lib/avatar_engine/avatar_engine.dart`
- Create: `app/lib/avatar_engine/legacy_web_session.dart`
- Create: `app/lib/avatar_engine/webview_engine.dart`
- Create: `app/lib/avatar_engine/presence_chip.dart`
- Modify: `app/lib/avatar_page.dart`（整体替换）
- Modify: `app/lib/overlay.dart`
- Create: `app/test/avatar_engine_test.dart`
- Create: `app/test/presence_chip_test.dart`
- Create: `app/test/avatar_page_engine_test.dart`
- Modify: `app/test/overlay_test.dart`（只追加一个用例）
- Modify: `app/lib/identity/app_shell.dart`、`app/lib/main.dart`（只为适配新的 `AvatarPage` 构造参数，行为不变）

**Interfaces:**
- Consumes: 现有 `NativeAudioIO`、`NativeSpeechDetector`、`NativeUiEvent`、`FillerAudioConfig`、`JsEvent`、`jsCall`、`LocalAssetServer`、`avatarUrlFor`、`PluginNativeAudioIO`、`EnergySpeechDetector`。
- Produces:
  - `enum AvatarEngineKind { webview, duix }`、`parseEngineKind(String?)`；
  - `AvatarEngineFailure(code)`；
  - `AvatarEngineCallbacks`，字段 `onReady`、`onStatus`、`onError`、`onDiag`、`onFailure`、`onSubtitle`、`onState`、`onMetric`；
  - `abstract interface class AvatarEngine`，签名见 spec §5.1；
  - `abstract interface class LegacyWebSession`，包括 `legacyMute(bool)`、`legacyEnd()`、`legacyDebugText(String)`、`legacyRestart()`；
  - `WebViewAvatarEngine({required String avatarId})`；
  - `PresenceHint`、`presenceFor(String state)`、`PresenceChip({required PresenceHint hint})`；
  - `AvatarPage({required AvatarEngine Function() engineFactory, DeviceTokenProvider? identity, Future<String?> Function()? savedStyle, void Function(AvatarEngineFailure)? onEngineFailure, AvatarPagePlatform platform})`；
  - `AvatarOverlay` 新增可选参数 `Widget? presence`。

行为对照（必须保持）：
- 先请求麦克风权限，再启动引擎。被拒时提示「需要麦克风权限才能聊天」。
- WebView 发来 `ready` 后，先发 `config`；只有 `AUDIO_MODE=native` 时才启动原生会话。
- JS 回显的 `subtitle`、`state`、`metric`、`status`、`diag`、`error` 照旧更新页面。
- `AUDIO_MODE=web` 时，静音、挂断、调试文字和重试都发给 WebView。
- 会话事件照旧以 JSON 形式发给 WebView。
- 初始化失败时提示「初始化失败，请重试」，可以重试。

- [x] **Step 1: 写失败的测试**

`app/test/avatar_engine_test.dart`：

```dart
import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('unknown stored engines fall back to the 3D avatar', () {
    expect(parseEngineKind('duix'), AvatarEngineKind.duix);
    expect(parseEngineKind('webview'), AvatarEngineKind.webview);
    expect(parseEngineKind(null), AvatarEngineKind.webview);
    expect(parseEngineKind('DUIX'), AvatarEngineKind.webview);
  });
}
```

`app/test/presence_chip_test.dart`：

```dart
import 'package:avatar_app/avatar_engine/presence_chip.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('only listening and thinking show a hint', () {
    expect(presenceFor('listening'), PresenceHint.listening);
    expect(presenceFor('thinking'), PresenceHint.thinking);
    expect(presenceFor('speaking'), isNull);
    expect(presenceFor('idle'), isNull);
  });

  testWidgets('shows the label for each hint', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: PresenceChip(hint: PresenceHint.listening))));
    expect(find.text('在听您说'), findsOneWidget);
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: PresenceChip(hint: PresenceHint.thinking))));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('我想一想'), findsOneWidget);
  });

  testWidgets('stays still when the system removes animations', (tester) async {
    await tester.pumpWidget(
      const MediaQuery(
        data: MediaQueryData(disableAnimations: true),
        child: MaterialApp(home: Scaffold(body: PresenceChip(hint: PresenceHint.listening))),
      ),
    );
    await tester.pumpAndSettle(); // settles only because nothing repeats
    expect(find.text('在听您说'), findsOneWidget);
  });
}
```

在 `app/test/overlay_test.dart` 的 `main()` 末尾追加：

```dart
  testWidgets('shows an optional presence widget above the subtitles', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AvatarOverlay(
          userLine: '', aiLine: '王叔好', status: '', error: null, muted: false,
          onMute: () {}, onEnd: () {}, onToggleDebug: () {},
          presence: const Text('PRESENCE'),
        ),
      ),
    ));
    final presence = tester.getTopLeft(find.text('PRESENCE'));
    final subtitle = tester.getTopLeft(find.text('王叔好'));
    expect(presence.dy, lessThan(subtitle.dy));
  });
```

`app/test/avatar_page_engine_test.dart`：

```dart
import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/avatar_page.dart';
import 'package:avatar_app/native_audio/audio_types.dart';
import 'package:avatar_app/native_audio/speech_detector.dart';
import 'package:avatar_app/native_session/events.dart';
import 'package:avatar_app/native_session/thinking_config.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeEngine implements AvatarEngine {
  FakeEngine({this.presence = false, this.failWith});

  final bool presence;
  final String? failWith;
  int starts = 0;
  bool disposed = false;
  AvatarEngineCallbacks? callbacks;

  @override
  AvatarEngineKind get kind => AvatarEngineKind.duix;

  @override
  bool get showsPresenceHint => presence;

  @override
  Future<void> start(AvatarEngineCallbacks callbacks) async {
    starts++;
    this.callbacks = callbacks;
    final code = failWith;
    if (code != null) callbacks.onFailure(AvatarEngineFailure(code));
  }

  @override
  Widget buildView() => const Text('ENGINE');

  @override
  NativeAudioIO createAudio(FillerAudioConfig? filler) => throw UnimplementedError();

  @override
  NativeSpeechDetector createDetector() => throw UnimplementedError();

  @override
  void onSessionEvent(NativeUiEvent event) {}

  @override
  Future<void> dispose() async => disposed = true;
}

class FakePlatform extends AvatarPagePlatform {
  FakePlatform({this.micGranted = true});

  final bool micGranted;
  final wakelock = <bool>[];

  @override
  Future<bool> requestMicrophone() async => micGranted;

  @override
  void setWakelock(bool on) => wakelock.add(on);
}

Widget page(FakeEngine engine, FakePlatform platform, {void Function(AvatarEngineFailure)? onFailure}) =>
    MaterialApp(home: AvatarPage(engineFactory: () => engine, platform: platform, onEngineFailure: onFailure));

void main() {
  testWidgets('a denied microphone never starts the engine', (tester) async {
    final engine = FakeEngine();
    await tester.pumpWidget(page(engine, FakePlatform(micGranted: false)));
    await tester.pump();
    expect(engine.starts, 0);
    expect(find.text('需要麦克风权限才能聊天'), findsOneWidget);
  });

  testWidgets('starts the engine, shows its view and keeps the screen on', (tester) async {
    final engine = FakeEngine();
    final platform = FakePlatform();
    await tester.pumpWidget(page(engine, platform));
    await tester.pump();
    expect(engine.starts, 1);
    expect(find.text('ENGINE'), findsOneWidget);
    expect(platform.wakelock, [true]);
  });

  testWidgets('renderer callbacks update the overlay like the old WebView handlers', (tester) async {
    final engine = FakeEngine();
    await tester.pumpWidget(page(engine, FakePlatform()));
    await tester.pump();
    engine.callbacks!.onStatus('reconnecting');
    engine.callbacks!.onSubtitle('assistant', '你好');
    engine.callbacks!.onError('NotFoundError');
    await tester.pump();
    expect(find.text('网络有点慢，稍等我一下'), findsOneWidget);
    expect(find.text('你好'), findsOneWidget);
    expect(find.text('没有找到麦克风'), findsOneWidget);
  });

  testWidgets('a failure without a fallback shows retry, which starts again', (tester) async {
    final engine = FakeEngine(failWith: 'webview_start_failed');
    await tester.pumpWidget(page(engine, FakePlatform()));
    await tester.pump();
    expect(find.text('初始化失败，请重试'), findsOneWidget);
    await tester.tap(find.byKey(const Key('retry')));
    await tester.pump();
    expect(engine.starts, 2);
  });

  testWidgets('a failure with a fallback is handed up without an error', (tester) async {
    final engine = FakeEngine(failWith: 'duix_not_installed');
    final failures = <String>[];
    await tester.pumpWidget(page(engine, FakePlatform(), onFailure: (f) => failures.add(f.code)));
    await tester.pump();
    expect(failures, ['duix_not_installed']);
    expect(find.text('初始化失败，请重试'), findsNothing);
  });

  testWidgets('engines without gaze cues get the presence chip', (tester) async {
    final engine = FakeEngine(presence: true);
    await tester.pumpWidget(page(engine, FakePlatform()));
    await tester.pump();
    engine.callbacks!.onState('listening');
    await tester.pump();
    expect(find.text('在听您说'), findsOneWidget);
    engine.callbacks!.onState('speaking');
    await tester.pump();
    expect(find.text('在听您说'), findsNothing);
  });

  testWidgets('the 3D engine never shows the chip', (tester) async {
    final engine = FakeEngine(presence: false);
    await tester.pumpWidget(page(engine, FakePlatform()));
    await tester.pump();
    engine.callbacks!.onState('listening');
    await tester.pump();
    expect(find.text('在听您说'), findsNothing);
  });

  testWidgets('disposing the page disposes the engine and releases the wakelock', (tester) async {
    final engine = FakeEngine();
    final platform = FakePlatform();
    await tester.pumpWidget(page(engine, platform));
    await tester.pump();
    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    expect(engine.disposed, isTrue);
    expect(platform.wakelock, [true, false]);
  });
}
```

- [x] **Step 2: 跑测试确认失败**

```bash
cd app && flutter test test/avatar_engine_test.dart test/presence_chip_test.dart test/avatar_page_engine_test.dart test/overlay_test.dart
```

Expected：FAIL，报 `avatar_engine.dart`、`presence_chip.dart` 不存在，以及 `AvatarOverlay` 没有 `presence` 参数。

- [x] **Step 3: 写接口与状态提示条**

`app/lib/avatar_engine/avatar_engine.dart`：

```dart
import 'package:flutter/widgets.dart';

import '../native_audio/audio_types.dart';
import '../native_audio/speech_detector.dart';
import '../native_session/events.dart';
import '../native_session/thinking_config.dart';

enum AvatarEngineKind { webview, duix }

/// Stored engine choice; anything unknown is the existing 3D avatar.
AvatarEngineKind parseEngineKind(String? raw) =>
    raw == AvatarEngineKind.duix.name ? AvatarEngineKind.duix : AvatarEngineKind.webview;

/// A content-free reason the renderer cannot (or can no longer) run.
class AvatarEngineFailure {
  const AvatarEngineFailure(this.code);

  final String code;
}

/// What a renderer reports to the page. onSubtitle/onState/onMetric are the WebView's
/// echoes of session events, kept so the 3D page behaves exactly as before.
class AvatarEngineCallbacks {
  const AvatarEngineCallbacks({
    required this.onReady,
    required this.onStatus,
    required this.onError,
    required this.onDiag,
    required this.onFailure,
    required this.onSubtitle,
    required this.onState,
    required this.onMetric,
  });

  /// The renderer is up; the page may start the native session.
  final void Function() onReady;
  final void Function(String status) onStatus;
  final void Function(String code) onError;
  final void Function(String key, String value) onDiag;
  final void Function(AvatarEngineFailure failure) onFailure;
  final void Function(String role, String text) onSubtitle;
  final void Function(String state) onState;
  final void Function(String name, double ms) onMetric;
}

/// One avatar renderer. The page owns it: start once, dispose once.
abstract interface class AvatarEngine {
  AvatarEngineKind get kind;

  /// True when the renderer has no gaze or head cues, so the overlay shows a listening/thinking chip.
  bool get showsPresenceHint;

  /// Starts the renderer. Never throws: problems are reported through [AvatarEngineCallbacks.onFailure].
  Future<void> start(AvatarEngineCallbacks callbacks);

  Widget buildView();
  NativeAudioIO createAudio(FillerAudioConfig? filler);
  NativeSpeechDetector createDetector();

  /// Session events (state, subtitles, actions, emotion, ...) for the renderer.
  void onSessionEvent(NativeUiEvent event);
  Future<void> dispose();
}
```

`app/lib/avatar_engine/legacy_web_session.dart`：

```dart
/// The Plan 1 path where the WebView owns audio (AUDIO_MODE=web). Only the WebView engine has it;
/// it goes away together with that engine.
abstract interface class LegacyWebSession {
  void legacyMute(bool muted);
  void legacyEnd();
  void legacyDebugText(String text);
  void legacyRestart();
}
```

`app/lib/avatar_engine/presence_chip.dart`：

```dart
import 'dart:math' as math;

import 'package:flutter/material.dart';

enum PresenceHint { listening, thinking }

PresenceHint? presenceFor(String state) => switch (state) {
  'listening' => PresenceHint.listening,
  'thinking' => PresenceHint.thinking,
  _ => null,
};

const presenceLabels = {PresenceHint.listening: '在听您说', PresenceHint.thinking: '我想一想'};

/// Status pill above the subtitles for renderers without gaze or head cues (Duix).
class PresenceChip extends StatefulWidget {
  const PresenceChip({super.key, required this.hint});

  final PresenceHint hint;

  @override
  State<PresenceChip> createState() => _PresenceChipState();
}

class _PresenceChipState extends State<PresenceChip> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _pulse.stop();
    } else if (!_pulse.isAnimating) {
      _pulse.repeat();
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final label = presenceLabels[widget.hint]!;
    final still = MediaQuery.disableAnimationsOf(context);
    return Semantics(
      liveRegion: true,
      label: label,
      child: ExcludeSemantics(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(20)),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              AnimatedBuilder(
                animation: _pulse,
                builder: (_, _) => widget.hint == PresenceHint.listening
                    ? _dot(still ? 1.0 : _breath(_pulse.value))
                    : _dots(still ? null : _pulse.value),
              ),
              const SizedBox(width: 10),
              Text(label, style: const TextStyle(color: Colors.white, fontSize: 18)),
            ],
          ),
        ),
      ),
    );
  }

  /// Slow breathing between 45% and 100% opacity.
  static double _breath(double t) => 0.45 + 0.55 * (0.5 - 0.5 * math.cos(2 * math.pi * t));

  static Widget _dot(double opacity) => Opacity(
    opacity: opacity,
    child: Container(
      width: 12,
      height: 12,
      decoration: const BoxDecoration(color: Colors.tealAccent, shape: BoxShape.circle),
    ),
  );

  /// Three dots lighting up in turn; all evenly lit when [t] is null (animations off).
  static Widget _dots(double? t) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      for (var i = 0; i < 3; i++)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: _dot(t == null ? 0.8 : ((t * 3).floor() % 3 == i ? 1.0 : 0.35)),
        ),
    ],
  );
}
```

`app/lib/overlay.dart` 改两处：

1. 构造函数加 `this.presence,`，字段加：
   ```dart
     /// Optional status pill shown just above the subtitle card.
     final Widget? presence;
   ```
2. 把字幕卡片所在的整个 `Positioned(left: 16, right: 16, bottom: 104, ...)` 换成下面这段。卡片本身的内容不变；`Column` 用 `stretch`，这样卡片仍然和原来一样占满宽度：
   ```dart
          Positioned(
            left: 16,
            right: 16,
            bottom: 104,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (presence != null) ...[
                  Align(alignment: Alignment.centerLeft, child: presence!),
                  const SizedBox(height: 8),
                ],
                Container(
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
              ],
            ),
          ),
   ```
3. 调试面板位置从 `Positioned(top: 56, ...)` 改为 `Positioned(top: 128, ...)`，给 Task 12 的顶部切换开关让位。

- [x] **Step 4: 写 WebView 引擎（从 AvatarPage 原样搬出）**

`app/lib/avatar_engine/webview_engine.dart`：

```dart
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../bridge.dart';
import '../config.dart';
import '../identity/avatars.dart';
import '../local_asset_server.dart';
import '../native_audio/audio_types.dart';
import '../native_audio/native_audio_io.dart';
import '../native_audio/speech_detector.dart';
import '../native_session/events.dart';
import '../native_session/thinking_config.dart';
import 'avatar_engine.dart';
import 'legacy_web_session.dart';

Map<String, Object?> buildAvatarConfig({
  required String avatarId,
  required String gatewayUrl,
  required String appSecret,
  required String audioPath,
  required String echo,
  String? audioMode,
}) => {
  'type': 'config',
  'gatewayUrl': gatewayUrl,
  'appSecret': appSecret,
  'audioPath': audioPath,
  'echo': echo,
  'avatarUrl': avatarUrlFor(avatarId),
  ...?audioMode == null ? null : {'audioMode': audioMode},
};

/// The existing three.js avatar in a WebView, served from the bundled web assets on 127.0.0.1.
class WebViewAvatarEngine implements AvatarEngine, LegacyWebSession {
  WebViewAvatarEngine({required this.avatarId});

  final String avatarId;
  final _server = LocalAssetServer(loadAsset: rootBundle.load);
  final _controller = ValueNotifier<WebViewController?>(null);
  AvatarEngineCallbacks? _callbacks;
  bool _disposed = false;

  @override
  AvatarEngineKind get kind => AvatarEngineKind.webview;

  @override
  bool get showsPresenceHint => false;

  @override
  Future<void> start(AvatarEngineCallbacks callbacks) async {
    _callbacks = callbacks;
    try {
      await _server.start();
      final base = _server.baseUri;
      final controller = WebViewController();
      await controller.setJavaScriptMode(JavaScriptMode.unrestricted);
      await controller.setBackgroundColor(const Color(0xFF10131A));
      await controller.addJavaScriptChannel('FlutterBridge', onMessageReceived: (m) => _onJs(m.message));
      await controller.setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (req) =>
              req.url.startsWith(base.toString()) ? NavigationDecision.navigate : NavigationDecision.prevent,
        ),
      );
      final platform = controller.platform;
      if (platform is AndroidWebViewController) {
        await platform.setAllowFileAccess(false);
        await AndroidWebViewController.enableDebugging(kDebugMode);
      }
      if (_disposed) return;
      // Assign before loading: the page may post 'ready' before loadRequest returns, and _send needs the controller.
      _controller.value = controller;
      await controller.loadRequest(base.resolve(AppConfig.page));
    } catch (_) {
      if (!_disposed) callbacks.onFailure(const AvatarEngineFailure('webview_start_failed'));
    }
  }

  @override
  Widget buildView() => ValueListenableBuilder<WebViewController?>(
    valueListenable: _controller,
    builder: (_, controller, _) =>
        controller == null ? const SizedBox.shrink() : WebViewWidget(controller: controller),
  );

  @override
  NativeAudioIO createAudio(FillerAudioConfig? filler) => PluginNativeAudioIO(filler: filler);

  @override
  NativeSpeechDetector createDetector() => EnergySpeechDetector();

  @override
  void onSessionEvent(NativeUiEvent event) => unawaited(_send(event.toJson()));

  @override
  void legacyMute(bool muted) => unawaited(_send({'type': 'mute', 'muted': muted}));

  @override
  void legacyEnd() => unawaited(_send({'type': 'end'}));

  @override
  void legacyDebugText(String text) => unawaited(_send({'type': 'debugText', 'text': text}));

  @override
  void legacyRestart() => _sendConfig();

  @override
  Future<void> dispose() async {
    _disposed = true;
    _callbacks = null;
    unawaited(_server.stop());
    _controller.dispose();
  }

  void _onJs(String raw) {
    final event = JsEvent.parse(raw);
    final cb = _callbacks;
    if (event == null || cb == null || _disposed) return;
    switch (event) {
      case JsReady():
        _sendConfig();
        cb.onReady();
      case JsSubtitle(:final role, :final text):
        cb.onSubtitle(role, text);
      case JsState(:final state):
        cb.onState(state);
      case JsMetric(:final name, :final ms):
        cb.onMetric(name, ms);
      case JsStatus(:final status):
        cb.onStatus(status);
      case JsDiag(:final key, :final value):
        cb.onDiag(key, value);
      case JsError(:final code):
        cb.onError(code);
    }
  }

  void _sendConfig() {
    unawaited(
      _send(
        buildAvatarConfig(
          avatarId: avatarId,
          gatewayUrl: AppConfig.gatewayUrl,
          appSecret: AppConfig.appSecret,
          audioPath: AppConfig.audioPath,
          echo: AppConfig.echo,
          audioMode: AppConfig.audioMode == 'native' ? 'native' : null,
        ),
      ),
    );
  }

  Future<void> _send(Map<String, Object?> message) async {
    final controller = _controller.value;
    if (controller == null || _disposed) return;
    await controller.runJavaScript(jsCall(message));
  }
}
```

- [x] **Step 5: 替换 AvatarPage**

把 `app/lib/avatar_page.dart` 整体替换为下面的代码。和原文件相比只有这些变化：
- WebView 相关代码搬到了引擎里；
- 引擎通过 `engineFactory` 注入；
- 平台调用通过 `AvatarPagePlatform` 注入；
- 新增状态提示条；
- 调试面板第一行多显示 `engine=`。

```dart
import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import 'avatar_engine/avatar_engine.dart';
import 'avatar_engine/legacy_web_session.dart';
import 'avatar_engine/presence_chip.dart';
import 'config.dart';
import 'diag_log.dart';
import 'metrics.dart';
import 'native_audio/filler_clips.dart';
import 'native_gateway/gateway_client.dart';
import 'native_gateway/transports.dart';
import 'native_session/events.dart';
import 'native_session/session_controller.dart';
import 'native_session/session_start_guard.dart';
import 'native_session/thinking_config.dart';
import 'overlay.dart';

export 'avatar_engine/webview_engine.dart' show buildAvatarConfig;

const _statusLabels = {
  'loading': '加载中…',
  'connecting': '连接中…',
  'open': '',
  'reconnecting': '网络有点慢，稍等我一下',
  'model_reconnecting': '网络有点慢，稍等我一下',
  'closed': '对话已结束',
  'audio_suspended': '点一下屏幕打开声音',
};

/// A connection that is open again clears a transient error.
String? errorAfterStatus(String? error, String status) =>
    status == 'open' ? null : error;

/// Subtitle line per avatar state: "…" while thinking; cleared when going idle after thinking.
String aiLineAfterState(String state, String current) => switch (state) {
  'thinking' => '…',
  'idle' when current == '…' => '',
  _ => current,
};

String _errorLabel(String code) => switch (code) {
  'NotAllowedError' => '麦克风被拒绝，请在设置中允许',
  'NotFoundError' => '没有找到麦克风',
  'gateway_start_failed' => '网关暂时不可用，请稍后重试',
  'audio_start_failed' => '音频初始化失败，请检查麦克风权限',
  _ => '出错了：$code',
};

/// Filler clips follow the agent's saved style; unknown or missing styles use the config default.
String fillerStyle(ThinkingConfig cfg, String? saved) =>
    saved != null && cfg.styles.contains(saved) ? saved : cfg.defaultStyle;

/// Platform hooks the page needs; widget tests replace them.
class AvatarPagePlatform {
  const AvatarPagePlatform();

  Future<bool> requestMicrophone() async => (await Permission.microphone.request()).isGranted;

  void setWakelock(bool on) => unawaited(WakelockPlus.toggle(enable: on));
}

class AvatarPage extends StatefulWidget {
  const AvatarPage({
    super.key,
    required this.engineFactory,
    this.identity,
    this.savedStyle,
    this.onEngineFailure,
    this.platform = const AvatarPagePlatform(),
  });

  /// Called once; the page owns and disposes the engine.
  final AvatarEngine Function() engineFactory;

  /// Device bearer source for POST /session; null = dev mode (APP_SECRET only).
  final DeviceTokenProvider? identity;
  final Future<String?> Function()? savedStyle;

  /// Set when another engine can take over; otherwise a failure shows the retry error.
  final void Function(AvatarEngineFailure failure)? onEngineFailure;
  final AvatarPagePlatform platform;

  @override
  State<AvatarPage> createState() => _AvatarPageState();
}

class _AvatarPageState extends State<AvatarPage> {
  late final AvatarEngine _engine = widget.engineFactory();
  final _metrics = MetricsStore();
  final _diag = <String, String>{};
  final _debugText = TextEditingController();
  NativeSessionController? _session;
  bool _engineStarted = false;
  bool _engineFailed = false;
  bool _startingEngine = false;
  bool _startingSession = false;
  String _userLine = '';
  String _aiLine = '';
  String _status = '准备中…';
  String _state = 'idle';
  String? _error;
  bool _muted = false;
  bool _debug = false;
  /// End/dispose invalidates an in-flight session start; it must not leave a live mic.
  final _sessionGuard = SessionStartGuard();

  /// The old WebView-owned audio path (AUDIO_MODE=web); null on the native path.
  LegacyWebSession? get _legacy => switch (_engine) {
    final LegacyWebSession legacy when AppConfig.audioMode == 'web' => legacy,
    _ => null,
  };

  @override
  void initState() {
    super.initState();
    widget.platform.setWakelock(true);
    unawaited(_init());
  }

  void _update(VoidCallback change) {
    if (mounted) setState(change);
  }

  Future<void> _init() async {
    if (_startingEngine || _sessionGuard.ended) return;
    _startingEngine = true;
    _engineFailed = false;
    try {
      if (!await widget.platform.requestMicrophone()) {
        _update(() => _error = '需要麦克风权限才能聊天');
        return;
      }
      if (!mounted || _sessionGuard.ended) return;
      await _engine.start(
        AvatarEngineCallbacks(
          onReady: _onEngineReady,
          onStatus: _onStatus,
          onError: (code) => _update(() => _error = _errorLabel(code)),
          onDiag: (key, value) => _update(() => _diag[key] = value),
          onFailure: _onEngineFailure,
          onSubtitle: (role, text) => _update(() => role == 'user' ? _userLine = text : _aiLine = text),
          onState: _onRendererState,
          onMetric: (name, ms) => _update(() => _metrics.add(name, ms)),
        ),
      );
      _engineStarted = !_engineFailed;
    } catch (_) {
      if (mounted && !_sessionGuard.ended) setState(() => _error = '初始化失败，请重试');
    } finally {
      _startingEngine = false;
    }
  }

  void _onEngineReady() {
    if (!mounted || _legacy != null) return; // AUDIO_MODE=web: the WebView runs its own session
    unawaited(_startNativeSession());
  }

  void _onStatus(String status) => _update(() {
    _status = _statusLabels[status] ?? status;
    _error = errorAfterStatus(_error, status);
  });

  void _onRendererState(String state) => _update(() {
    _state = state;
    _aiLine = aiLineAfterState(state, _aiLine);
  });

  void _onEngineFailure(AvatarEngineFailure failure) {
    _engineFailed = true;
    logcatDiagSink(formatDiag('avatar_engine_failed', {'engine': _engine.kind.name, 'code': failure.code}));
    if (_sessionGuard.ended) return;
    final fallback = widget.onEngineFailure;
    if (fallback != null) {
      fallback(failure);
      return;
    }
    _update(() => _error = '初始化失败，请重试');
  }

  String _deviceLanguage() {
    final code = PlatformDispatcher.instance.locale.languageCode;
    return switch (code) {
      'zh' => 'zh',
      'ja' => 'ja',
      'en' => 'en',
      _ => 'zh',
    };
  }

  Future<void> _startNativeSession() async {
    if (_session != null || _startingSession || _sessionGuard.ended) return;
    final token = _sessionGuard.begin();
    if (token < 0) return;
    _startingSession = true;
    final thinking = await _loadThinking();
    String? saved;
    try {
      saved = await widget.savedStyle?.call();
    } on Exception catch (e) {
      logcatDiagSink(
        formatDiag('saved_style_read_failed', {
          'type': e.runtimeType.toString(),
        }),
      );
      saved = null; // storage failure: fall back to the config default
    }
    final clips = thinking == null
        ? const <String, Int16List>{}
        : await loadFillerClips(
            rootBundle,
            thinking,
            fillerStyle(thinking, saved),
          );
    if (!mounted || !_sessionGuard.isCurrent(token)) {
      _startingSession = false;
      return; // ended or restarted while loading
    }
    final session = NativeSessionController(
      audio: _engine.createAudio(thinking?.audio),
      detector: _engine.createDetector(),
      client: NativeGatewayClient(
        baseUri: Uri.parse(AppConfig.gatewayUrl),
        appSecret: AppConfig.appSecret,
        transport: const IoGatewayTransport(),
        events: _UnwiredGatewayEvents(),
        audioPath: AppConfig.audioPath,
        language: _deviceLanguage(),
        identity: widget.identity,
      ),
      emit: _onNativeEvent,
      thinking: thinking,
      fillerPcm: clips,
    );
    _session = session;
    try {
      await session.start();
    } catch (_) {
      if (identical(_session, session)) _session = null;
    } finally {
      _startingSession = false;
    }
    if (!mounted || !_sessionGuard.isCurrent(token)) {
      if (identical(_session, session)) _session = null;
      await session.stop(); // End/dispose won the race: release the mic and gateway
    }
  }

  void _retry() {
    if (_startingSession || _sessionGuard.ended) return;
    setState(() => _error = null);
    if (!_engineStarted) {
      unawaited(_init());
      return;
    }
    final legacy = _legacy;
    if (legacy != null) {
      legacy.legacyRestart();
      return;
    }
    final existing = _session;
    _session = null;
    if (existing != null) unawaited(existing.stop());
    unawaited(_startNativeSession());
  }

  Future<ThinkingConfig?> _loadThinking() async {
    try {
      return ThinkingConfig.parse(
        await rootBundle.loadString(ThinkingConfig.assetPath),
      );
    } catch (_) {
      logcatDiagSink(formatDiag('thinking_config_invalid', {}));
      return null;
    }
  }

  void _onNativeEvent(NativeUiEvent event) {
    if (!mounted) return;
    if (event is UiDiag) {
      setState(() => _diag[event.key] = event.value);
      return;
    }
    _engine.onSessionEvent(event);
    switch (event) {
      case UiStatus(:final status):
        setState(() {
          _status = _statusLabels[status] ?? status;
          _error = errorAfterStatus(_error, status);
        });
      case UiState(:final state):
        setState(() {
          _state = state;
          _aiLine = aiLineAfterState(state, _aiLine);
        });
      case UiSubtitle(:final role, :final text):
        setState(() => role == 'user' ? _userLine = text : _aiLine = text);
      case UiMetric(:final name, :final ms):
        setState(() => _metrics.add(name, ms.toDouble()));
      case UiError(:final code):
        setState(() => _error = _errorLabel(code));
      case UiResponseStart() ||
          UiResponseEnd() ||
          UiResponseCancelled() ||
          UiAvatarAction() ||
          UiAvatarEmotion() ||
          UiAudioLevel() ||
          UiDiag():
        break;
    }
  }

  void _toggleMute() {
    setState(() => _muted = !_muted);
    final legacy = _legacy;
    if (legacy == null) {
      _session?.setMuted(_muted);
    } else {
      legacy.legacyMute(_muted);
    }
  }

  void _end() {
    _sessionGuard.end();
    final legacy = _legacy;
    if (legacy == null) {
      unawaited(_session?.stop() ?? Future<void>.value());
    } else {
      legacy.legacyEnd();
    }
    setState(() {
      _status = _statusLabels['closed']!;
      _error = null; // the session is over; a retry button must not stay active
    });
  }

  Widget _debugPanel() {
    final summary = _metrics.summary().entries.map(
      (e) =>
          '${e.key}: n=${e.value.count} p50=${e.value.p50.round()} p90=${e.value.p90.round()}',
    );
    return Container(
      padding: const EdgeInsets.all(8),
      color: Colors.black87,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'engine=${_engine.kind.name}  state=$_state  audioPath=${AppConfig.audioPath}  echo=${AppConfig.echo}',
            style: const TextStyle(color: Colors.white70),
          ),
          ...summary.map(
            (s) => Text(s, style: const TextStyle(color: Colors.white)),
          ),
          ..._diag.entries.map(
            (e) => Text(
              '${e.key}=${e.value}',
              style: const TextStyle(color: Colors.white54, fontSize: 12),
            ),
          ),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _debugText,
                  style: const TextStyle(color: Colors.white),
                  decoration: const InputDecoration(
                    hintText: '输入文字代替语音',
                    hintStyle: TextStyle(color: Colors.white38),
                  ),
                  onSubmitted: (v) {
                    if (v.trim().isEmpty) return;
                    final legacy = _legacy;
                    if (legacy == null) {
                      _session?.debugText(v.trim());
                    } else {
                      legacy.legacyDebugText(v.trim());
                    }
                    _debugText.clear();
                  },
                ),
              ),
              TextButton(
                onPressed: () =>
                    Clipboard.setData(ClipboardData(text: _metrics.toCsv())),
                child: const Text('复制 CSV'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _sessionGuard.end();
    unawaited(_session?.stop() ?? Future<void>.value());
    unawaited(_engine.dispose());
    _debugText.dispose();
    widget.platform.setWakelock(false);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final hint = _engine.showsPresenceHint ? presenceFor(_state) : null;
    return Scaffold(
      backgroundColor: const Color(0xFF10131A),
      body: Stack(
        children: [
          Positioned.fill(child: _engine.buildView()),
          AvatarOverlay(
            userLine: _userLine,
            aiLine: _aiLine,
            status: _status,
            error: _error,
            muted: _muted,
            onMute: _toggleMute,
            onEnd: _end,
            onRetry: _retry,
            onToggleDebug: () => setState(() => _debug = !_debug),
            debugPanel: _debug ? _debugPanel() : null,
            presence: hint == null ? null : PresenceChip(hint: hint),
          ),
        ],
      ),
    );
  }
}

class _UnwiredGatewayEvents implements GatewayClientEvents {
  @override
  void onAudio(_) {}

  @override
  void onMessage(_) {}

  @override
  void onStatus(_) {}
}
```

如果 `flutter analyze` 报 `package:flutter/foundation.dart` 是多余的 import（`PlatformDispatcher` 已经通过 `material.dart` 可用），就删掉这一行。

- [x] **Step 6: 适配调用方（行为不变）**

`app/lib/main.dart` 的 `_HomeState.build` 改为：

```dart
  @override
  Widget build(BuildContext context) => AppShell(
    identity: _identity,
    avatarBuilder: (identity, avatarId) => AvatarPage(
      engineFactory: () => WebViewAvatarEngine(avatarId: avatarId),
      identity: identity,
      savedStyle: _identity.savedStyle,
    ),
  );
```

并加 `import 'avatar_engine/webview_engine.dart';`。`app/lib/identity/app_shell.dart` 这一步不用改（`avatarBuilder` 的签名没变；Task 12 才改它）。

- [x] **Step 7: 跑测试确认通过，3D 行为零变化**

```bash
cd app && flutter test && flutter analyze
```

Expected：新增的测试全部通过；所有现有测试原样通过，其中 `avatar_page_test`、`avatar_page_config_test`、`avatar_page_style_test`、`overlay_test`、`app_shell_test` 的旧用例一个都不改；没有新的分析问题。

再做一次真机回归，确认 3D 照常可用：

```bash
flutter build apk --debug --dart-define-from-file=dev.json && adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

请用户确认 3D 模式的以下行为和之前一样：打开后有开场白、能对话、能插话、静音和挂断有效、长按「小柔」能打开调试面板（现在位置更低）。

- [x] **Step 8: 提交**

```bash
git add app/lib/avatar_engine/avatar_engine.dart app/lib/avatar_engine/legacy_web_session.dart \
  app/lib/avatar_engine/webview_engine.dart app/lib/avatar_engine/presence_chip.dart \
  app/lib/avatar_page.dart app/lib/overlay.dart app/lib/main.dart \
  app/test/avatar_engine_test.dart app/test/presence_chip_test.dart \
  app/test/avatar_page_engine_test.dart app/test/overlay_test.dart
git commit -m "refactor(app): put the 3D avatar behind an AvatarEngine interface

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
