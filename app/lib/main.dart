import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'avatar_engine/avatar_engine.dart';
import 'avatar_engine/engine_switch_controller.dart';
import 'avatar_engine/webview_engine.dart';
import 'avatar_page.dart';
import 'config.dart';
import 'diag_log.dart';
import 'duix/duix_bridge.dart';
import 'duix/duix_config.dart';
import 'duix/duix_crash_guard.dart';
import 'duix/duix_engine.dart';
import 'identity/app_shell.dart';
import 'identity/avatars.dart';
import 'identity/character_engine_prefs.dart';
import 'identity/characters.dart';
import 'identity/device_identity.dart';
import 'identity/identity_api.dart';
import 'identity/secure_credential_store.dart';
import 'native_gateway/transports.dart';
import 'spike/duix_probe_spike.dart';
import 'spike/native_audio_spike.dart';
import 'spike/secure_storage_spike.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
  runApp(AvatarApp(catalog: await _loadCatalog()));
}

/// Null when assets/config/characters.json is missing or invalid; the app shows a config error.
Future<CharacterCatalog?> _loadCatalog() async {
  try {
    return await loadCharacterCatalog(rootBundle);
  } catch (_) {
    logcatDiagSink(formatDiag('characters_config_invalid', {}));
    return null;
  }
}

class AvatarApp extends StatelessWidget {
  const AvatarApp({super.key, required this.catalog});

  final CharacterCatalog? catalog;

  @override
  Widget build(BuildContext context) {
    final catalog = this.catalog;
    final problem = AppConfig.validate() ?? (catalog == null ? 'characters.json' : null);
    return MaterialApp(
      title: '智伴',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorSchemeSeed: Colors.teal,
        brightness: Brightness.dark,
      ),
      home: switch (AppConfig.spike) {
        'native_audio' => const NativeAudioSpikePage(),
        'secure_storage' => const SecureStorageSpikePage(),
        'duix_probe' => const DuixProbeSpikePage(),
        _ =>
          catalog != null && problem == null
              ? _Home(catalog: catalog)
              : Scaffold(
                  body: Center(
                    child: Text(
                      '配置错误：$problem',
                      style: const TextStyle(fontSize: 20),
                    ),
                  ),
                ),
      },
    );
  }
}

/// Owns the single DeviceIdentity for the app's lifetime.
class _Home extends StatefulWidget {
  const _Home({required this.catalog});

  final CharacterCatalog catalog;

  @override
  State<_Home> createState() => _HomeState();
}

class _HomeState extends State<_Home> {
  static const _store = SecureCredentialStore();
  late final _identity = DeviceIdentity(
    store: _store,
    backend: IdentityApi(
      baseUri: Uri.parse(AppConfig.gatewayUrl),
      appSecret: AppConfig.appSecret,
      transport: const IoGatewayTransport(),
    ),
  );
  final _bridge = MethodChannelDuixBridge();
  final _handoff = EngineHandoff();
  // Task 14 removes CharacterEnginePrefs together with EnginePrefs.
  late final _engines = EngineSwitchController(
    prefs: CharacterEnginePrefs(identity: _identity, catalog: widget.catalog),
    bridge: _bridge,
    guard: DuixCrashGuard(_store),
    loadConfig: () async => DuixConfig.parse(await rootBundle.loadString(DuixConfig.assetPath)),
    debugBuild: kDebugMode,
  );

  @override
  void dispose() {
    _engines.dispose();
    super.dispose();
  }

  AvatarEngine _engineFor(AvatarPageRequest request) {
    final config = _engines.config;
    if (request.engine == AvatarEngineKind.duix && config != null) {
      return DuixAvatarEngine(
        bridge: _bridge,
        config: config,
        guard: DuixCrashGuard(_store),
        modelId: request.character.duixModel,
      );
    }
    return WebViewAvatarEngine(avatarId: request.character.webviewAvatar ?? defaultAvatarId);
  }

  @override
  Widget build(BuildContext context) => AppShell(
    identity: _identity,
    catalog: widget.catalog,
    engines: _engines,
    avatarBuilder: (request) => AvatarPage(
      key: request.key,
      engineFactory: () => _engineFor(request),
      identity: request.identity,
      characterId: request.character.id,
      displayName: request.character.title,
      onEngineFailure: request.onEngineFailure,
      onUnknownCharacter: request.onUnknownCharacter,
      handoff: _handoff,
    ),
  );
}
