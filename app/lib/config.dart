/// Build-time configuration injected with --dart-define-from-file (never committed).
class AppConfig {
  static const gatewayUrl = String.fromEnvironment('GATEWAY_URL');
  static const appSecret = String.fromEnvironment('APP_SECRET');
  static const audioPath = String.fromEnvironment(
    'AUDIO_PATH',
    defaultValue: 'B',
  );
  static const audioMode = String.fromEnvironment(
    'AUDIO_MODE',
    defaultValue: 'native',
  );
  static const echo = String.fromEnvironment('ECHO', defaultValue: 'true');
  static const gatewayRequestTimeout = Duration(
    milliseconds: int.fromEnvironment(
      'GATEWAY_REQUEST_TIMEOUT_MS',
      defaultValue: 10000,
    ),
  );
  static const gatewaySocketTimeout = Duration(
    milliseconds: int.fromEnvironment(
      'GATEWAY_SOCKET_TIMEOUT_MS',
      defaultValue: 10000,
    ),
  );

  /// Page inside the web bundle to load: 'index.html' (product), 'probe.html' (Task 16), 'spike-aec.html' (Task 17).
  static const page = String.fromEnvironment(
    'PAGE',
    defaultValue: 'index.html',
  );

  /// 'native_audio' | 'secure_storage' | 'duix_probe' opens a spike page instead of the app.
  static const spike = String.fromEnvironment('SPIKE');

  /// Returns a user-facing problem description, or null when the config is usable.
  static String? validate() => check(
    gatewayUrl: gatewayUrl,
    appSecret: appSecret,
    audioPath: audioPath,
    audioMode: audioMode,
  );

  static final _placeholder = RegExp(
    r'^(change-me|same-as-)',
    caseSensitive: false,
  );

  /// Pure check behind [validate]; never echoes the secret.
  static String? check({
    required String gatewayUrl,
    required String appSecret,
    required String audioPath,
    String audioMode = 'native',
  }) {
    if (!gatewayUrl.startsWith('http')) return 'GATEWAY_URL 未配置';
    if (appSecret.length < 16) return 'APP_SECRET 未配置';
    if (_placeholder.hasMatch(appSecret)) return 'APP_SECRET 还是模板占位值，请改成网关的真实值';
    if (audioPath != 'A' && audioPath != 'B') return 'AUDIO_PATH 只能是 A 或 B';
    if (audioMode != 'native' && audioMode != 'web') {
      return 'AUDIO_MODE 只能是 native 或 web';
    }
    return null;
  }
}
