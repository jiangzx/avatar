import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'avatar_page.dart';
import 'config.dart';
import 'spike/native_audio_spike.dart';

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
      home: AppConfig.spike == 'native_audio'
          ? const NativeAudioSpikePage()
          : problem == null
              ? const AvatarPage()
              : Scaffold(body: Center(child: Text('配置错误：$problem', style: const TextStyle(fontSize: 20)))),
    );
  }
}
