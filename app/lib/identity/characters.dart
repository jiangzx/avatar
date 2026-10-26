import '../avatar_engine/avatar_engine.dart';
import 'companion_picker.dart';

const characterLily = 'lily';
const characterKai = 'kai';
const characterXiaorou = 'default';

/// Sent on session.start when the chosen character is Kai.
const youngMaleVoiceProfile = 'young-male';

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

/// Settings order: Lily, Kai, then 小柔.
const characterOptions = <CharacterOption>[
  CharacterOption(
    id: characterLily,
    title: 'Lily',
    subtitle: '看着亲切，陪您慢慢聊天',
    engine: AvatarEngineKind.duix,
  ),
  CharacterOption(
    id: characterKai,
    title: 'Kai',
    subtitle: '看着精神，陪您慢慢聊天',
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

bool characterUsesYoungMaleVoice(String? id) => id == characterKai;

/// A missing or retired appearance opens Lily. A known id stays itself.
String activeCharacter(String? saved) => saved != null && isCharacterId(saved) ? saved : characterLily;

String characterTitle(String id) =>
    characterOptions.firstWhere((option) => option.id == id, orElse: () => characterOptions.first).title;

AvatarEngineKind engineForCharacter(String id) =>
    characterOptions.firstWhere((option) => option.id == id, orElse: () => characterOptions.first).engine;

/// The corner label follows the engine actually on screen.
String characterNameForEngine(AvatarEngineKind engine) => engine == AvatarEngineKind.duix ? 'Lily' : '小柔';
