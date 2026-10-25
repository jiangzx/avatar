/// The Plan 1 path where the WebView owns audio (AUDIO_MODE=web). Only the WebView engine has it;
/// it goes away together with that engine.
abstract interface class LegacyWebSession {
  void legacyMute(bool muted);
  void legacyEnd();
  void legacyDebugText(String text);
  void legacyRestart();
}
