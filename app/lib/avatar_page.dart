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
import 'companion_config.dart';
import 'config.dart';
import 'diag_log.dart';
import 'end_chat_dialog.dart';
import 'identity/session_rejection.dart';
import 'metrics.dart';
import 'native_audio/filler_clips.dart';
import 'native_gateway/gateway_client.dart';
import 'native_gateway/transports.dart';
import 'native_session/events.dart';
import 'native_session/session_controller.dart';
import 'native_session/session_start_guard.dart';
import 'native_session/thinking_config.dart';
import 'overlay.dart';
import 'reminder_toast.dart';

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

/// Qwen 3.1 can print a tool call as plain text. Never show that syntax in the subtitle.
String visibleAssistantLine(String text) {
  final lines = text.split('\n');
  final index = lines.indexWhere(_startsWithToolSyntax);
  return index == -1 ? text : lines.take(index).join('\n').trimRight();
}

const _toolSyntaxPrefixes = ['[', '{', '```', '<tool', 'set_memory_consent('];

bool _startsWithToolSyntax(String line) {
  final leading = line.trimLeft();
  return _toolSyntaxPrefixes.any(leading.startsWith);
}

String _errorLabel(String code) => switch (code) {
  'NotAllowedError' => '麦克风被拒绝，请在设置中允许',
  'NotFoundError' => '没有找到麦克风',
  'gateway_start_failed' => '网关暂时不可用，请稍后重试',
  'audio_start_failed' => '音频初始化失败，请检查麦克风权限',
  _ => '出错了：$code',
};

/// Filler clips follow the character; unknown or missing ids use the config default.
String fillerCharacter(ThinkingConfig cfg, String? characterId) =>
    characterId != null && cfg.characters.contains(characterId) ? characterId : cfg.defaultCharacter;

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
    this.onEngineFailure,
    this.onUnknownCharacter,
    this.onSessionRejected,
    this.onDiagCode,
    this.onChangePartner,
    this.gatewayClientFactory,
    this.characterId,
    this.displayName = '',
    this.companion,
    this.handoff,
    this.platform = const AvatarPagePlatform(),
  });

  /// Called once; the page owns and disposes the engine.
  final AvatarEngine Function() engineFactory;

  /// Device bearer source for POST /session; null = dev mode (APP_SECRET only).
  final DeviceTokenProvider? identity;

  /// Set when another engine can take over; otherwise a failure shows the retry error.
  final void Function(AvatarEngineFailure failure)? onEngineFailure;

  /// POST /session answered 400 (unknown character). Null shows the usual error.
  final VoidCallback? onUnknownCharacter;

  /// POST /session or the live session was refused (owner_banned / character_disabled). Null shows the usual error.
  final void Function(SessionRejection rejection)? onSessionRejected;

  /// Receives `<sessionId>-<diagId>` each time a session is ready (settings copies it).
  final ValueChanged<String>? onDiagCode;

  /// Opens the settings/character switcher from the ended card.
  final VoidCallback? onChangePartner;

  /// Test seam: null builds the real gateway client.
  final GatewayClientLike Function()? gatewayClientFactory;

  /// Chosen character: sent on POST /session and picks the filler clips. Null = gateway default (dev).
  final String? characterId;

  /// Corner label: the character title from assets/config/characters.json.
  final String displayName;

  /// AI caption and rest-toast duration (assets/config/companion.json). Null shows neither.
  final CompanionConfig? companion;

  /// When set, this page waits for the previous page to stop its session and release its engine.
  final EngineHandoff? handoff;
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
  /// The chat ended and the page shows the ended card.
  bool _ended = false;
  bool _restarting = false;
  /// The in-flight stop after ending; restart waits for the mic/player release.
  Future<void>? _ending;
  /// The in-flight session start; restart waits so two starts cannot overlap.
  Completer<void>? _startDone;
  /// Responses whose textual tool syntax was already logged once.
  final _hiddenCodeSeqs = <int>{};
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
  bool _released = false;
  ReminderToast? _toast;

  /// The old WebView-owned audio path (AUDIO_MODE=web); null on the native path.
  LegacyWebSession? get _legacy => switch (_engine) {
    final LegacyWebSession legacy when AppConfig.audioMode == 'web' => legacy,
    _ => null,
  };

  @override
  void initState() {
    super.initState();
    final companion = widget.companion;
    if (companion != null) _toast = ReminderToast(showFor: companion.restToast)..addListener(_onToast);
    widget.platform.setWakelock(true);
    unawaited(_init());
  }

  void _onToast() => _update(() {});

  void _update(VoidCallback change) {
    if (mounted) setState(change);
  }

  Future<void> _init() async {
    if (_startingEngine || _sessionGuard.ended) return;
    _startingEngine = true;
    _engineFailed = false;
    try {
      await widget.handoff?.previous;
      if (!mounted || _sessionGuard.ended) return;
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
    final done = Completer<void>();
    _startDone = done;
    _hiddenCodeSeqs.clear();
    try {
      final thinking = await _loadThinking();
      final clips = thinking == null
          ? const <String, Int16List>{}
          : await loadFillerClips(rootBundle, thinking, fillerCharacter(thinking, widget.characterId));
      if (!mounted || !_sessionGuard.isCurrent(token)) return; // ended or restarted while loading
      final session = NativeSessionController(
        audio: _engine.createAudio(thinking?.audio),
        detector: _engine.createDetector(),
        client: widget.gatewayClientFactory?.call() ??
            NativeGatewayClient(
              baseUri: Uri.parse(AppConfig.gatewayUrl),
              appSecret: AppConfig.appSecret,
              transport: const IoGatewayTransport(),
              events: _UnwiredGatewayEvents(),
              audioPath: AppConfig.audioPath,
              language: _deviceLanguage(),
              characterId: widget.characterId,
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
      }
      if (!mounted || !_sessionGuard.isCurrent(token)) {
        if (identical(_session, session)) _session = null;
        await session.stop(); // End/dispose won the race: release the mic and gateway
      }
    } catch (_) {
      // Audio/renderer setup or asset loading failed before the session could report.
      if (mounted && !_sessionGuard.ended) _update(() => _error = '初始化失败，请重试');
    } finally {
      _startingSession = false;
      if (identical(_startDone, done)) _startDone = null;
      if (!done.isCompleted) done.complete();
    }
  }

  void _retry() {
    if (_ended) {
      unawaited(_restart());
      return;
    }
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
      if (_ended) return;
      if (event.key == diagCodeKey) widget.onDiagCode?.call(event.value);
      setState(() => _diag[event.key] = event.value);
      return;
    }
    _toast?.onEvent(event);
    _engine.onSessionEvent(event);
    if (_ended) return; // the engine still gets the final stop state; the ended UI stays quiet
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
      case UiSubtitle(:final role, :final text, :final responseSeq):
        final shown = role == 'assistant' ? visibleAssistantLine(text) : text;
        setState(() => role == 'user' ? _userLine = text : _aiLine = shown);
        if (role == 'assistant' && shown.isEmpty && text.trim().isNotEmpty && responseSeq != null && _hiddenCodeSeqs.add(responseSeq)) {
          logcatDiagSink(formatDiag('assistant_code_hidden', {'chars': text.length}));
        }
      case UiMetric(:final name, :final ms):
        setState(() => _metrics.add(name, ms.toDouble()));
      case UiError(:final code):
        final rejection = sessionRejectionOf(code);
        final onRejected = widget.onSessionRejected;
        if (rejection != null && onRejected != null) {
          onRejected(rejection);
          return;
        }
        final unknown = widget.onUnknownCharacter;
        if (code == 'gateway_http_400' && unknown != null) {
          unknown(); // the only 400 of POST /session is unknown_character
          return;
        }
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

  void _requestEnd() {
    unawaited(_confirmEnd());
  }

  Future<void> _confirmEnd() async {
    if (_ended || _ending != null || _restarting || !mounted) return;
    final end = await confirmEndChat(context);
    if (!mounted || !end) return;
    await _endNow();
  }

  Future<void> _endNow() async {
    if (_ended) return;
    _sessionGuard.end();
    final stop = _stopSession();
    _ending = stop;
    setState(() {
      _ended = true;
      _status = '';
      _error = null;
      _userLine = '';
      _aiLine = '';
    });
    widget.platform.setWakelock(false);
    try {
      await stop;
    } finally {
      if (identical(_ending, stop)) _ending = null;
    }
  }

  Future<void> _stopSession() async {
    final legacy = _legacy;
    if (legacy != null) {
      try {
        legacy.legacyEnd();
      } catch (_) {
        // The ended UI must still be reachable if the legacy bridge misbehaves.
      }
      return;
    }
    final session = _session;
    _session = null;
    try {
      await session?.stop();
    } catch (_) {
      // The UI is already ended; a failed release must not block restart.
    }
  }

  Future<void> _restart() async {
    if (!_ended || _restarting) return;
    _restarting = true;
    try {
      final ending = _ending;
      if (ending != null) await ending;
      final starting = _startDone?.future;
      if (starting != null) await starting;
      if (!mounted) return;
      _sessionGuard.reset();
      final legacy = _legacy;
      if (legacy != null) {
        _showConnecting();
        widget.platform.setWakelock(true);
        legacy.legacyRestart();
        return;
      }
      if (!_engineStarted) {
        setState(() {
          _ended = false;
          _error = null;
          _status = _statusLabels['loading']!;
          _userLine = '';
          _aiLine = '';
        });
        widget.platform.setWakelock(true);
        await _init();
        return;
      }
      _showConnecting();
      widget.platform.setWakelock(true);
      await _startNativeSession();
    } finally {
      _restarting = false;
    }
  }

  void _showConnecting() {
    setState(() {
      _ended = false;
      _error = null;
      _status = _statusLabels['connecting']!;
      _userLine = '';
      _aiLine = '';
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
  void deactivate() {
    // dispose() runs after the next page's initState. Register the release here so the
    // next page waits for this session and renderer to finish.
    _handOff();
    super.deactivate();
  }

  @override
  void dispose() {
    _handOff();
    _toast
      ?..removeListener(_onToast)
      ..dispose();
    _debugText.dispose();
    widget.platform.setWakelock(false);
    super.dispose();
  }

  void _handOff() {
    if (_released) return;
    _released = true;
    _sessionGuard.end();
    final shutdown = _releaseEngine();
    final handoff = widget.handoff;
    if (handoff != null) {
      handoff.replace(shutdown);
    } else {
      unawaited(shutdown);
    }
  }

  /// Stop the session first so the microphone and player are gone, then release the renderer.
  Future<void> _releaseEngine() async {
    final session = _session;
    _session = null;
    try {
      final ending = _ending;
      if (ending != null) await ending;
      await session?.stop();
    } catch (_) {
      // the page is gone; the renderer still has to be released
    }
    await _engine.dispose();
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
            name: widget.displayName,
            onMute: _toggleMute,
            onEnd: _requestEnd,
            onRetry: _retry,
            onRestart: _ended ? () => unawaited(_restart()) : null,
            onChangePartner: widget.onChangePartner,
            ended: _ended,
            onToggleDebug: () => setState(() => _debug = !_debug),
            debugPanel: _debug ? _debugPanel() : null,
            presence: hint == null ? null : PresenceChip(hint: hint),
            caption: widget.companion?.aiCaption,
            toast: _toast?.text,
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
