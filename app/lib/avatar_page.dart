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
  'audio_suspended': '点一下屏幕打开声音',
};

/// A connection that is open again clears a transient error.
String? errorAfterStatus(String? error, String status) => status == 'open' ? null : error;

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
    if (!mounted) return;
    // Assign before loading: the page may post 'ready' before loadRequest returns, and _send needs the controller.
    setState(() => _controller = controller);
    await controller.loadRequest(base.resolve(AppConfig.page));
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
        setState(() {
          _status = _statusLabels[status] ?? status;
          _error = errorAfterStatus(_error, status);
        });
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
