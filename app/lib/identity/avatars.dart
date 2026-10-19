import 'companion_picker.dart';

class AvatarOption implements PickerOption {
  const AvatarOption({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.assetPath,
  });

  @override
  final String id;
  @override
  final String title;
  @override
  final String subtitle;
  final String assetPath;
}

const defaultAvatarId = 'default';

const avatarOptions = <AvatarOption>[
  AvatarOption(
    id: defaultAvatarId,
    title: '现有形象',
    subtitle: '温和自然，陪您轻松聊天',
    assetPath: './avatars/avatar.glb',
  ),
  AvatarOption(
    id: 'cute-girl',
    title: '可爱小女孩',
    subtitle: '活泼亲切，带一点俏皮感',
    assetPath: './avatars/cute-girl.glb',
  ),
  AvatarOption(
    id: 'cute-boy',
    title: '可爱小男孩',
    subtitle: '阳光好奇，喜欢听您分享',
    assetPath: './avatars/cute-boy.glb',
  ),
  AvatarOption(
    id: 'young-woman',
    title: '青年美女',
    subtitle: '明亮从容，温柔有分寸',
    assetPath: './avatars/young-woman.glb',
  ),
  AvatarOption(
    id: 'young-man',
    title: '青年俊男',
    subtitle: '清爽可靠，聊天自然',
    assetPath: './avatars/young-man.glb',
  ),
];

AvatarOption avatarOptionFor(String? id) {
  for (final option in avatarOptions) {
    if (option.id == id) return option;
  }
  return avatarOptions.first;
}

bool isAvatarId(String id) => avatarOptions.any((option) => option.id == id);

String avatarUrlFor(String? id) => avatarOptionFor(id).assetPath;
