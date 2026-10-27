import 'characters.dart';

/// Whether a character can run on this phone right now (spec「Duix 不可用」).
/// Task 14 computes it in EngineSwitchController.availabilityFor.
sealed class CharacterAvailability {
  const CharacterAvailability();
}

/// Ready, or the bundled model only needs copying once it is picked.
final class Available extends CharacterAvailability {
  const Available();
}

/// The model is being copied; [fraction] is null when progress is unknown.
final class Preparing extends CharacterAvailability {
  const Preparing(this.fraction);

  final double? fraction;
}

/// Greyed out with a plain-language [reason].
final class Unavailable extends CharacterAvailability {
  const Unavailable(this.reason);

  final String reason;
}

/// Copying failed; picking it again retries. [reason] is plain language.
final class PrepareFailed extends CharacterAvailability {
  const PrepareFailed(this.reason);

  final String reason;
}

/// Not offered on this build or phone; the card is not shown.
final class Hidden extends CharacterAvailability {
  const Hidden();
}

/// Still probing the phone; shown as loading, not pickable.
final class Checking extends CharacterAvailability {
  const Checking();
}

bool canPick(CharacterAvailability availability) =>
    availability is Available || availability is Preparing || availability is PrepareFailed;

/// Default hook: every character can run (3D-only tests, Task 13).
CharacterAvailability everyCharacterAvailable(CharacterOption option) => const Available();
