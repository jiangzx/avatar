import 'dart:io';

import 'package:avatar_app/companion_config.dart';

/// The shipped assets/config/companion.json (flutter test runs in app/).
CompanionConfig loadTestCompanionConfig() =>
    CompanionConfig.parse(File(CompanionConfig.assetPath).readAsStringSync());
