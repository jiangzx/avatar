import 'dart:io';

import 'package:avatar_app/identity/characters.dart';

/// The shipped assets/config/characters.json (flutter test runs in app/).
CharacterCatalog loadTestCharacterCatalog() =>
    CharacterCatalog.parse(File(CharacterCatalog.assetPath).readAsStringSync());
