import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'avatar_page.dart';
import 'config.dart';
import 'identity/app_shell.dart';
import 'identity/device_identity.dart';
import 'identity/identity_api.dart';
import 'identity/secure_credential_store.dart';
import 'native_gateway/transports.dart';
import 'spike/native_audio_spike.dart';
import 'spike/secure_storage_spike.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
  runApp(const AvatarApp());
}

class AvatarApp extends StatelessWidget {
  const AvatarApp({super.key});

  @override
  Widget build(BuildContext context) {
    final problem = AppConfig.validate();
    return MaterialApp(
      title: '小柔',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: Colors.teal, brightness: Brightness.dark),
      home: switch (AppConfig.spike) {
        'native_audio' => const NativeAudioSpikePage(),
        'secure_storage' => const SecureStorageSpikePage(),
        _ => problem == null
            ? const _Home()
            : Scaffold(body: Center(child: Text('配置错误：$problem', style: const TextStyle(fontSize: 20)))),
      },
    );
  }
}

/// Owns the single DeviceIdentity for the app's lifetime.
class _Home extends StatefulWidget {
  const _Home();

  @override
  State<_Home> createState() => _HomeState();
}

class _HomeState extends State<_Home> {
  late final _identity = DeviceIdentity(
    store: const SecureCredentialStore(),
    backend: IdentityApi(
      baseUri: Uri.parse(AppConfig.gatewayUrl),
      appSecret: AppConfig.appSecret,
      transport: const IoGatewayTransport(),
    ),
  );

  @override
  Widget build(BuildContext context) => AppShell(
    identity: _identity,
    avatarBuilder: (identity) => AvatarPage(identity: identity, savedStyle: _identity.savedStyle),
  );
}
