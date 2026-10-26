import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/identity/characters.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('settings lists Lily, Kai, then 小柔', () {
    expect(characterOptions.map((option) => option.id), [characterLily, characterKai, characterXiaorou]);
    expect(characterOptions.map((option) => option.title), ['Lily', 'Kai', '小柔']);
    expect(characterOptions[0].subtitle, '看着亲切，陪您慢慢聊天');
    expect(characterOptions[1].subtitle, '看着精神，陪您慢慢聊天');
    expect(characterOptions[2].subtitle, '温和自然，陪您轻松聊天');
    expect(characterOptions.map((option) => option.engine), [
      AvatarEngineKind.duix,
      AvatarEngineKind.duix,
      AvatarEngineKind.webview,
    ]);
    expect(characterUsesYoungMaleVoice(characterKai), isTrue);
    expect(characterUsesYoungMaleVoice(characterLily), isFalse);
  });

  test('a new install and retired appearances open Lily; 小柔 stays 小柔', () {
    expect(activeCharacter(null), characterLily);
    expect(activeCharacter('cute-girl'), characterLily);
    expect(activeCharacter('cute-boy'), characterLily);
    expect(activeCharacter('young-woman'), characterLily);
    expect(activeCharacter('young-man'), characterLily);
    expect(activeCharacter('unknown'), characterLily);
    expect(activeCharacter(characterLily), characterLily);
    expect(activeCharacter(characterKai), characterKai);
    expect(activeCharacter(characterXiaorou), characterXiaorou);
    expect(characterTitle(characterKai), 'Kai');
  });

  test('the corner name follows the engine on screen', () {
    expect(characterNameForEngine(AvatarEngineKind.duix), 'Lily');
    expect(characterNameForEngine(AvatarEngineKind.webview), '小柔');
    expect(engineForCharacter(characterLily), AvatarEngineKind.duix);
    expect(engineForCharacter(characterKai), AvatarEngineKind.duix);
    expect(engineForCharacter(characterXiaorou), AvatarEngineKind.webview);
  });
}
