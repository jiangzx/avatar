/// Build-time configuration injected with --dart-define-from-file (never committed).
class AppConfig {
  static const gatewayUrl = String.fromEnvironment('GATEWAY_URL');
  static const appSecret = String.fromEnvironment('APP_SECRET');
  static const audioPath = String.fromEnvironment('AUDIO_PATH', defaultValue: 'A');
  static const echo = String.fromEnvironment('ECHO', defaultValue: 'true');

  /// Page inside the web bundle to load: 'index.html' (product), 'probe.html' (Task 16), 'spike-aec.html' (Task 17).
  static const page = String.fromEnvironment('PAGE', defaultValue: 'index.html');

  /// 'native_audio' opens the path-B spike instead of the WebView.
  static const spike = String.fromEnvironment('SPIKE');

  /// Returns a user-facing problem description, or null when the config is usable.
  static String? validate() {
    if (!gatewayUrl.startsWith('http')) return 'GATEWAY_URL 未配置';
    if (appSecret.length < 16) return 'APP_SECRET 未配置';
    if (audioPath != 'A' && audioPath != 'B') return 'AUDIO_PATH 只能是 A 或 B';
    return null;
  }
}
