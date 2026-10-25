import 'package:avatar_app/identity/avatars.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the 3D catalog keeps only 小柔', () {
    expect(avatarOptions.map((option) => option.id), ['default']);
    expect(avatarOptions.map((option) => option.title), ['小柔']);
    expect(avatarOptions.map((option) => option.assetPath), ['./avatars/avatar.glb']);
  });

  test('unknown and missing ids fall back to the existing avatar', () {
    expect(avatarOptionFor(null).id, defaultAvatarId);
    expect(avatarOptionFor('unknown').id, defaultAvatarId);
    expect(avatarUrlFor('unknown'), './avatars/avatar.glb');
  });
}
