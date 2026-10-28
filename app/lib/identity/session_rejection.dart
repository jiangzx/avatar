/// Gateway refusals the shell explains to the user (protocol SESSION_REJECTIONS).
enum SessionRejection { ownerBanned, characterDisabled }

/// Maps a UiError code; anything else is not a rejection.
SessionRejection? sessionRejectionOf(String code) => switch (code) {
  'owner_banned' => SessionRejection.ownerBanned,
  'character_disabled' => SessionRejection.characterDisabled,
  _ => null,
};
