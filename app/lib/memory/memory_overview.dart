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

class MemoryThreadItem extends MemoryItem {
  const MemoryThreadItem({required super.id, required super.text, required this.kind, required this.sensitive});

  /// event | concern | plan
  final String kind;
  final bool sensitive;
}

class MemoryMoodItem {
  const MemoryMoodItem({required this.id, required this.day, required this.emotion, required this.peak});

  final String id;

  /// YYYY-MM-DD, Asia/Shanghai.
  final String day;

  /// neutral | happy | sad | love
  final String emotion;

  /// 1..3
  final int peak;
}

class CharacterMemory {
  const CharacterMemory({
    required this.character,
    required this.pinned,
    required this.facts,
    this.threads = const [],
    this.reflections = const [],
    this.moods = const [],
  });

  final String character;

  /// Newest first (gateway order).
  final List<MemoryPinnedItem> pinned;
  final List<MemoryFactItem> facts;
  final List<MemoryThreadItem> threads;
  final List<MemoryItem> reflections;
  final List<MemoryMoodItem> moods;
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
const _threadKinds = {'event', 'concern', 'plan'};
const _moodEmotions = {'neutral', 'happy', 'sad', 'love'};

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

MemoryThreadItem _thread(Object? raw) {
  final item = _item(raw);
  final kind = (raw as Map)['kind'];
  if (kind is! String || !_threadKinds.contains(kind)) throw const FormatException('memory_thread_kind');
  return MemoryThreadItem(id: item.id, text: item.text, kind: kind, sensitive: _sensitive(raw));
}

MemoryMoodItem _mood(Object? raw) {
  if (raw is! Map) throw const FormatException('memory_mood');
  final id = raw['id'];
  final day = raw['day'];
  final emotion = raw['emotion'];
  final peak = raw['peak'];
  if (id is! String || id.isEmpty || day is! String || !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(day)
      || emotion is! String || !_moodEmotions.contains(emotion) || peak is! int || peak < 1 || peak > 3) {
    throw const FormatException('memory_mood');
  }
  return MemoryMoodItem(id: id, day: day, emotion: emotion, peak: peak);
}

CharacterMemory _character(Object? raw) {
  if (raw is! Map) throw const FormatException('memory_character');
  final character = raw['character'];
  final pinned = raw['pinned'];
  final facts = raw['facts'];
  final threads = raw['threads'];
  final reflections = raw['reflections'];
  final moods = raw['moods'];
  if (character is! String || pinned is! List || facts is! List) throw const FormatException('memory_character');
  if (threads != null && threads is! List) throw const FormatException('memory_threads');
  if (reflections != null && reflections is! List) throw const FormatException('memory_reflections');
  if (moods != null && moods is! List) throw const FormatException('memory_moods');
  return CharacterMemory(
    character: character,
    pinned: [for (final item in pinned) _pinned(item)],
    facts: [for (final item in facts) _fact(item)],
    threads: threads == null ? const [] : [for (final item in threads) _thread(item)],
    reflections: reflections == null ? const [] : [for (final item in reflections) _item(item)],
    moods: moods == null ? const [] : [for (final item in moods) _mood(item)],
  );
}
