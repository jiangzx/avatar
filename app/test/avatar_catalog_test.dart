import 'package:avatar_app/identity/avatars.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('ships the existing avatar plus the four requested appearances', () {
    expect(avatarOptions.map((option) => option.id), [
      'default',
      'cute-girl',
      'cute-boy',
      'young-woman',
      'young-man',
    ]);
    expect(avatarOptions.map((option) => option.title), [
      '现有形象',
      '可爱小女孩',
      '可爱小男孩',
      '青年美女',
      '青年俊男',
    ]);
  });

  test('maps every catalog option to a local avatar asset', () {
    expect(avatarOptions.map((option) => option.assetPath), [
      './avatars/avatar.glb',
      './avatars/cute-girl.glb',
      './avatars/cute-boy.glb',
      './avatars/young-woman.glb',
      './avatars/young-man.glb',
    ]);
  });

  test('unknown and missing ids fall back to the existing avatar', () {
    expect(avatarOptionFor(null).id, defaultAvatarId);
    expect(avatarOptionFor('unknown').id, defaultAvatarId);
    expect(avatarUrlFor('unknown'), './avatars/avatar.glb');
  });
}
