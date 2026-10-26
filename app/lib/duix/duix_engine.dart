import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import '../avatar_engine/avatar_engine.dart';
import '../diag_log.dart';
import '../native_audio/audio_types.dart';
import '../native_audio/speech_detector.dart';
import '../native_session/events.dart';
import '../native_session/thinking_config.dart';
import 'duix_audio_io.dart';
import 'duix_bridge.dart';
import 'duix_config.dart';
import 'duix_crash_guard.dart';
import 'duix_events.dart';

/// The Duix 2D avatar (Lily): a native view driven by reply audio. No gaze, head or emotion cues.
class DuixAvatarEngine with WidgetsBindingObserver implements AvatarEngine {
  DuixAvatarEngine({
    required this.bridge,
    required this.config,
    required this.guard,
    this.modelId,
    this.diag = logcatDiagSink,
  });

  final DuixBridge bridge;
  final DuixConfig config;

  /// Which bundled model to load. Null uses the config default (Lily).
  final String? modelId;
  final DuixCrashGuard guard;
  final DiagSink diag;
  StreamSubscription<DuixEvent>? _events;
  AvatarEngineCallbacks? _callbacks;
  Set<String> _motions = const {};
  bool _observing = false;
  bool _faulted = false;
  bool _disposed = false;

  @override
  AvatarEngineKind get kind => AvatarEngineKind.duix;

  @override
  bool get showsPresenceHint => true;

  @override
  Future<void> start(AvatarEngineCallbacks callbacks) async {
    _callbacks = callbacks;
    WidgetsBinding.instance.addObserver(this);
    _observing = true;
    await guard.markActive();
    _events = bridge.events.listen(_onEvent);
    try {
      final prepared = await bridge.prepare(config, modelId: modelId);
      if (_disposed) return;
      _motions = prepared.motions.toSet();
      diag(formatDiag('duix_ready', {'width': prepared.width, 'height': prepared.height, 'motions': prepared.motions.length}));
      callbacks.onReady();
    } on DuixBridgeError catch (e) {
      if (!_disposed) callbacks.onFailure(AvatarEngineFailure('duix_${e.code}'));
    }
  }

  @override
  Widget buildView() => const ColoredBox(
    color: Color(0xFF10131A),
    child: AndroidView(viewType: 'anyidea/duix_view', creationParamsCodec: StandardMessageCodec()),
  );

  @override
  NativeAudioIO createAudio(FillerAudioConfig? filler) => DuixNativeAudioIO(bridge: bridge, diag: diag);

  @override
  NativeSpeechDetector createDetector() => EnergySpeechDetector(
    bargeInThresholdRms: config.bargeInThresholdRms,
    bargeInGraceMs: config.bargeInGraceMs,
  );

  @override
  void onSessionEvent(NativeUiEvent event) {
    if (event case UiAvatarAction(:final action) when _motions.contains(action)) {
      unawaited(bridge.motion(action).catchError((Object _) {}));
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_disposed) return;
    switch (state) {
      case AppLifecycleState.resumed:
        unawaited(guard.markActive());
        unawaited(bridge.setRendering(true).catchError((Object _) {}));
      case AppLifecycleState.hidden || AppLifecycleState.paused || AppLifecycleState.detached:
        unawaited(guard.markIdle());
        unawaited(bridge.setRendering(false).catchError((Object _) {}));
      case AppLifecycleState.inactive:
        break; // still visible, e.g. under the notification shade
    }
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _callbacks = null;
    if (_observing) WidgetsBinding.instance.removeObserver(this);
    await _events?.cancel();
    _events = null;
    try {
      await bridge.release();
    } on DuixBridgeError catch (e) {
      diag(formatDiag('duix_release_failed', {'code': e.code}));
    }
    await guard.markCleanExit();
  }

  void _onEvent(DuixEvent event) {
    switch (event) {
      case DuixFault(:final code) when !_faulted:
        _faulted = true;
        _callbacks?.onFailure(AvatarEngineFailure('duix_fault_$code'));
      case DuixStats(:final fps, :final lipFrames, :final slowFrames, :final maxFrameMs):
        diag(formatDiag('duix_stats', {
          'fps': fps,
          'lip_frames': lipFrames,
          'slow_frames': slowFrames,
          'max_frame_ms': maxFrameMs,
        }));
      default:
        break;
    }
  }
}
