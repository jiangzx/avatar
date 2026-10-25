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
