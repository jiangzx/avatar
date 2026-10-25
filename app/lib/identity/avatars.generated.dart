// Generated from scripts/avatar-catalog.json. Do not edit by hand.
import 'companion_picker.dart';

class AvatarOption implements PickerOption {
  const AvatarOption({required this.id, required this.title, required this.subtitle, required this.assetPath});
  @override final String id;
  @override final String title;
  @override final String subtitle;
  final String assetPath;
}

const defaultAvatarId = 'default';
const avatarOptions = <AvatarOption>[
  AvatarOption(id: 'default', title: '小柔', subtitle: '温和自然，陪您轻松聊天', assetPath: './avatars/avatar.glb'),
];

AvatarOption avatarOptionFor(String? id) {
  for (final option in avatarOptions) {
    if (option.id == id) return option;
  }
  return avatarOptions.first;
}
bool isAvatarId(String id) => avatarOptions.any((option) => option.id == id);
String avatarUrlFor(String? id) => avatarOptionFor(id).assetPath;
