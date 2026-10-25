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

/// Where the chosen engine is remembered (DeviceIdentity in the app).
abstract interface class EnginePrefs {
  /// Never throws; storage trouble reads as the 3D avatar.
  Future<AvatarEngineKind> savedEngine();

  /// False when the choice could not be stored.
  Future<bool> saveEngine(AvatarEngineKind engine);
}
