import 'dart:convert';

import 'package:flutter/services.dart';

import '../avatar_engine/avatar_engine.dart';
import 'character_ids.generated.dart';
import 'companion_picker.dart';

export 'character_ids.generated.dart';

/// True only for ids in protocol/characters.json (generated list).
bool isCharacterId(String id) => characterIds.contains(id);

/// One companion the user can pick. Display copy and assets come from assets/config/characters.json.
class CharacterOption implements PickerOption {
  const CharacterOption({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.engine,
    this.duixModel,
    this.webviewAvatar,
  });

  @override
  final String id;
  @override
  final String title;
  @override
  final String subtitle;
  final AvatarEngineKind engine;

  /// Model id in assets/config/duix.json; set only for Duix characters.
  final String? duixModel;

  /// Avatar id in the 3D catalog (avatars.generated.dart); set only for WebView characters.
  final String? webviewAvatar;
}

class CharacterCatalog {
  CharacterCatalog(List<CharacterOption> options) : options = List.unmodifiable(options);

  static const assetPath = 'assets/config/characters.json';

  /// Display order; equals the generated characterIds order.
  final List<CharacterOption> options;

  String get defaultId => defaultCharacterId;

  CharacterOption? byId(String id) {
    for (final option in options) {
      if (option.id == id) return option;
    }
    return null;
  }

  /// Throws FormatException unless the ids equal [characterIds] (same order) and every asset id is present.
  static CharacterCatalog parse(String source) {
    final Object? raw;
    try {
      raw = jsonDecode(source);
    } on FormatException {
      throw const FormatException('characters_not_json');
    }
    if (raw is! Map<String, Object?>) throw const FormatException('characters_not_object');
    final list = raw['characters'];
    if (list is! List || list.isEmpty) throw const FormatException('characters_invalid');
    final options = [for (final entry in list) _option(entry)];
    var same = options.length == characterIds.length;
    for (var i = 0; same && i < options.length; i++) {
      same = options[i].id == characterIds[i];
    }
    if (!same) throw const FormatException('character_ids_mismatch');
    return CharacterCatalog(options);
  }

  static CharacterOption _option(Object? entry) {
    if (entry is! Map) throw const FormatException('character_invalid');
    final id = entry['id'];
    final title = entry['title'];
    final subtitle = entry['subtitle'];
    if (id is! String || !isCharacterId(id)) throw const FormatException('character_id_invalid');
    if (title is! String || title.trim().isEmpty || subtitle is! String || subtitle.trim().isEmpty) {
      throw const FormatException('character_copy_invalid');
    }
    final duixModel = entry['duixModel'];
    final webviewAvatar = entry['webviewAvatar'];
    switch (entry['engine']) {
      case 'duix':
        if (!_isAssetId(duixModel) || webviewAvatar != null) throw const FormatException('character_assets_invalid');
        return CharacterOption(id: id, title: title, subtitle: subtitle, engine: AvatarEngineKind.duix, duixModel: duixModel as String);
      case 'webview':
        if (!_isAssetId(webviewAvatar) || duixModel != null) throw const FormatException('character_assets_invalid');
        return CharacterOption(id: id, title: title, subtitle: subtitle, engine: AvatarEngineKind.webview, webviewAvatar: webviewAvatar as String);
      default:
        throw const FormatException('character_engine_invalid');
    }
  }
}

final _assetId = RegExp(r'^[a-z0-9][a-z0-9-]{0,39}$');

bool _isAssetId(Object? value) => value is String && _assetId.hasMatch(value);

Future<CharacterCatalog> loadCharacterCatalog(AssetBundle bundle) async =>
    CharacterCatalog.parse(await bundle.loadString(CharacterCatalog.assetPath));
