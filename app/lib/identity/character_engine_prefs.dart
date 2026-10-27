import '../avatar_engine/avatar_engine.dart';
import 'characters.dart';
import 'device_identity.dart';

/// Temporary bridge for EngineSwitchController (Task 14 deletes it with EnginePrefs).
/// The saved engine is the saved character's engine; nothing is ever rewritten.
class CharacterEnginePrefs implements EnginePrefs {
  CharacterEnginePrefs({required this.identity, required this.catalog});

  final DeviceIdentity identity;
  final CharacterCatalog catalog;

  /// A new install reads as the default character. Storage trouble reads as 3D.
  @override
  Future<AvatarEngineKind> savedEngine() async {
    try {
      final saved = await identity.savedCharacter();
      return (catalog.byId(saved ?? catalog.defaultId) ?? catalog.options.first).engine;
    } on Exception {
      return AvatarEngineKind.webview;
    }
  }

  /// The character is the choice; the engine is never stored separately.
  @override
  Future<bool> saveEngine(AvatarEngineKind engine) async => true;
}
