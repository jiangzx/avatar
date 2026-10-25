import '../avatar_engine/avatar_engine.dart';
import 'companion_picker.dart';

const characterLily = 'lily';
const characterXiaorou = 'default';

class CharacterOption implements PickerOption {
  const CharacterOption({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.engine,
  });

  @override
  final String id;
  @override
  final String title;
  @override
  final String subtitle;
  final AvatarEngineKind engine;
}

/// Settings order: Lily, then 小柔.
const characterOptions = <CharacterOption>[
  CharacterOption(
    id: characterLily,
    title: 'Lily',
    subtitle: '看着亲切，陪您慢慢聊天',
    engine: AvatarEngineKind.duix,
  ),
  CharacterOption(
    id: characterXiaorou,
    title: '小柔',
    subtitle: '温和自然，陪您轻松聊天',
    engine: AvatarEngineKind.webview,
  ),
];

bool isCharacterId(String id) => characterOptions.any((option) => option.id == id);

/// A missing or retired appearance opens Lily. The kept 3D id stays 小柔.
String activeCharacter(String? saved) => saved == characterXiaorou ? characterXiaorou : characterLily;

AvatarEngineKind engineForCharacter(String id) =>
    characterOptions.firstWhere((option) => option.id == id, orElse: () => characterOptions.first).engine;

/// The corner label follows the engine actually on screen.
String characterNameForEngine(AvatarEngineKind engine) => engine == AvatarEngineKind.duix ? 'Lily' : '小柔';
