/// GET /memory body (overview contract C1). Lives only in widget state: never cached, stored or logged.
class MemoryItem {
  const MemoryItem({required this.id, required this.text});

  final String id;
  final String text;
}

class MemoryFactItem extends MemoryItem {
  const MemoryFactItem({required super.id, required super.text, required this.category, required this.sensitive});

  /// preference | person | health | other | safety
  final String category;
  final bool sensitive;
}

class MemoryPinnedItem extends MemoryItem {
  const MemoryPinnedItem({required super.id, required super.text, required this.sensitive});

  final bool sensitive;
}

class CharacterMemory {
  const CharacterMemory({required this.character, required this.pinned, required this.facts});

  final String character;

  /// Newest first (gateway order).
  final List<MemoryPinnedItem> pinned;
  final List<MemoryFactItem> facts;
}

class MemoryOverview {
  const MemoryOverview({required this.addressing, required this.profileItems, required this.characters});

  final MemoryItem? addressing;
  final List<MemoryItem> profileItems;
  final List<CharacterMemory> characters;

  CharacterMemory? forCharacter(String id) {
    for (final memory in characters) {
      if (memory.character == id) return memory;
    }
    return null;
  }

  /// Null when [raw] does not match the GET /memory shape; callers treat it as a bad response.
  static MemoryOverview? fromJson(Object? raw) {
    try {
      if (raw is! Map) return null;
      final profile = raw['profile'];
      final characters = raw['characters'];
      if (profile is! Map || characters is! List) return null;
      final addressing = profile['addressing'];
      final items = profile['items'];
      if (items is! List) return null;
      return MemoryOverview(
        addressing: addressing == null ? null : _item(addressing),
        profileItems: [for (final item in items) _item(item)],
        characters: [for (final entry in characters) _character(entry)],
      );
    } on FormatException {
      return null;
    }
  }
}

const _factCategories = {'preference', 'person', 'health', 'other', 'safety'};

MemoryItem _item(Object? raw) {
  if (raw is! Map) throw const FormatException('memory_item');
  final id = raw['id'];
  final text = raw['text'];
  if (id is! String || id.isEmpty || text is! String) throw const FormatException('memory_item');
  return MemoryItem(id: id, text: text);
}

bool _sensitive(Object? raw) {
  final value = (raw as Map)['sensitive'];
  if (value is! bool) throw const FormatException('memory_sensitive');
  return value;
}

MemoryPinnedItem _pinned(Object? raw) {
  final item = _item(raw);
  return MemoryPinnedItem(id: item.id, text: item.text, sensitive: _sensitive(raw));
}

MemoryFactItem _fact(Object? raw) {
  final item = _item(raw);
  final category = (raw as Map)['category'];
  if (category is! String || !_factCategories.contains(category)) throw const FormatException('memory_category');
  return MemoryFactItem(id: item.id, text: item.text, category: category, sensitive: _sensitive(raw));
}

CharacterMemory _character(Object? raw) {
  if (raw is! Map) throw const FormatException('memory_character');
  final character = raw['character'];
  final pinned = raw['pinned'];
  final facts = raw['facts'];
  if (character is! String || pinned is! List || facts is! List) throw const FormatException('memory_character');
  return CharacterMemory(
    character: character,
    pinned: [for (final item in pinned) _pinned(item)],
    facts: [for (final item in facts) _fact(item)],
  );
}
