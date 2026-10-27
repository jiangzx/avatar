import 'dart:convert';
import 'dart:io';

import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/identity/avatars.dart';
import 'package:avatar_app/identity/characters.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';
import 'support/duix_fakes.dart';

Map<String, Object?> shipped() =>
    jsonDecode(File(CharacterCatalog.assetPath).readAsStringSync()) as Map<String, Object?>;

List<Map<String, Object?>> entries(Map<String, Object?> m) =>
    (m['characters'] as List).cast<Map<String, Object?>>();

void main() {
  test('the shipped catalog lists 小暖, 小凯, 小欣 in the protocol order', () {
    final catalog = loadTestCharacterCatalog();
    expect(characterIds, ['xiaonuan', 'xiaokai', 'xiaoxin']);
    expect(catalog.options.map((o) => o.id), characterIds);
    expect(catalog.options.map((o) => o.title), ['小暖', '小凯', '小欣']);
    expect(catalog.options.map((o) => o.engine), [
      AvatarEngineKind.duix,
      AvatarEngineKind.duix,
      AvatarEngineKind.webview,
    ]);
    expect(catalog.byId('xiaonuan')!.duixModel, 'lily');
    expect(catalog.byId('xiaokai')!.duixModel, 'kai');
    expect(catalog.byId('xiaoxin')!.webviewAvatar, 'default');
    expect(catalog.byId('xiaoxin')!.duixModel, isNull);
    expect(catalog.defaultId, 'xiaonuan');
    expect(catalog.defaultId, defaultCharacterId);
    expect(catalog.byId('lily'), isNull);
    for (final o in catalog.options) {
      expect(o.subtitle, isNotEmpty);
    }
  });

  test('Duix models and 3D avatars exist in their own catalogs', () {
    final duix = loadTestDuixConfig();
    for (final o in loadTestCharacterCatalog().options) {
      if (o.engine == AvatarEngineKind.duix) {
        expect(duix.models.map((m) => m.id), contains(o.duixModel), reason: o.id);
      } else {
        expect(isAvatarId(o.webviewAvatar!), isTrue, reason: o.id);
      }
    }
  });

  test('isCharacterId follows the generated list only', () {
    expect(isCharacterId('xiaokai'), isTrue);
    expect(isCharacterId('lily'), isFalse);
    expect(isCharacterId('default'), isFalse);
  });

  test('rejects a catalog whose ids differ from the generated list', () {
    final missing = shipped();
    entries(missing).removeLast();
    expect(() => CharacterCatalog.parse(jsonEncode(missing)), throwsFormatException);

    final reordered = shipped();
    final list = entries(reordered);
    list.insert(0, list.removeLast());
    expect(() => CharacterCatalog.parse(jsonEncode(reordered)), throwsFormatException);

    final unknown = shipped();
    entries(unknown).first['id'] = 'lily';
    expect(() => CharacterCatalog.parse(jsonEncode(unknown)), throwsFormatException);
  });

  test('rejects an engine without its asset id, or with the other one', () {
    final noModel = shipped();
    entries(noModel).first.remove('duixModel');
    expect(() => CharacterCatalog.parse(jsonEncode(noModel)), throwsFormatException);

    final both = shipped();
    entries(both).last['duixModel'] = 'lily';
    expect(() => CharacterCatalog.parse(jsonEncode(both)), throwsFormatException);

    final badEngine = shipped();
    entries(badEngine).first['engine'] = 'unity';
    expect(() => CharacterCatalog.parse(jsonEncode(badEngine)), throwsFormatException);

    final blankTitle = shipped();
    entries(blankTitle).first['title'] = ' ';
    expect(() => CharacterCatalog.parse(jsonEncode(blankTitle)), throwsFormatException);

    expect(() => CharacterCatalog.parse('not json'), throwsFormatException);
  });
}
