import 'dart:convert';

class FillerClip {
  const FillerClip(this.id, this.text);

  final String id;
  final String text;
}

class FillerAudioConfig {
  const FillerAudioConfig({
    required this.chunkMs,
    required this.maxBufferedMs,
    required this.fadeMs,
    required this.gain,
    required this.pumpMs,
  });

  final int chunkMs;
  final int maxBufferedMs;
  final int fadeMs;
  final double gain;
  final int pumpMs;
}

/// App-side thresholds for the thinking state and fillers (assets/config/thinking.json).
class ThinkingConfig {
  const ThinkingConfig({
    required this.fillersEnabled,
    required this.thinkingSilenceMs,
    required this.fillerAfterMs,
    required this.longWaitAfterMs,
    required this.thinkingMaxMs,
    required this.tickMs,
    required this.tailGuardMs,
    required this.fillerEvidence,
    required this.nodFirstAfterMs,
    required this.nodEveryMs,
    required this.audio,
    required this.defaultCharacter,
    required this.characters,
    required this.thinkingClips,
    required this.longWaitClips,
  });

  static const assetPath = 'assets/config/thinking.json';

  /// Spoken fillers stay off until the clips match the reply voice and do not stutter.
  final bool fillersEnabled;
  final int thinkingSilenceMs;
  final int fillerAfterMs;
  final int longWaitAfterMs;
  final int thinkingMaxMs;
  final int tickMs;
  final int tailGuardMs;
  final Set<String> fillerEvidence;
  final int nodFirstAfterMs;
  final int nodEveryMs;
  final FillerAudioConfig audio;
  /// Filler clips live per character: `assets/filler/<characterId>/`.
  final String defaultCharacter;
  final List<String> characters;
  final List<FillerClip> thinkingClips;
  final List<FillerClip> longWaitClips;

  List<FillerClip> get allClips => [...thinkingClips, ...longWaitClips];

  String clipAsset(String characterId, String clipId) => 'assets/filler/$characterId/$clipId.pcm';

  static ThinkingConfig parse(String source) {
    final Object? raw;
    try {
      raw = jsonDecode(source);
    } on FormatException {
      throw const FormatException('thinking_config_not_json');
    }
    if (raw is! Map<String, Object?>) throw const FormatException('thinking_config_not_object');
    return ThinkingConfig.fromMap(raw);
  }

  factory ThinkingConfig.fromMap(Map<String, Object?> m) {
    final nod = _map(m, 'nod');
    final a = _map(m, 'audio');
    final clips = _map(m, 'clips');
    final audio = FillerAudioConfig(
      chunkMs: _int(a, 'chunkMs', 10, 40),
      maxBufferedMs: _int(a, 'maxBufferedMs', 20, 100),
      fadeMs: _int(a, 'fadeMs', 10, 100),
      gain: _num(a, 'gain', 0.1, 2.0),
      pumpMs: _int(a, 'pumpMs', 5, 40),
    );
    if (audio.chunkMs + audio.fadeMs > audio.maxBufferedMs) {
      throw const FormatException('filler_chunk_plus_fade_exceeds_buffer');
    }
    if (audio.pumpMs > audio.chunkMs) throw const FormatException('filler_pump_slower_than_chunk');
    final characters = _strings(m, 'characters', _isId);
    final defaultCharacter = m['defaultCharacter'];
    if (defaultCharacter is! String || !characters.contains(defaultCharacter)) {
      throw const FormatException('default_character_not_listed');
    }
    final cfg = ThinkingConfig(
      fillersEnabled: m['fillersEnabled'] == true,
      thinkingSilenceMs: _int(m, 'thinkingSilenceMs', 100, 1000),
      fillerAfterMs: _int(m, 'fillerAfterMs', 300, 5000),
      longWaitAfterMs: _int(m, 'longWaitAfterMs', 1000, 15000),
      thinkingMaxMs: _int(m, 'thinkingMaxMs', 5000, 60000),
      tickMs: _int(m, 'tickMs', 10, 100),
      tailGuardMs: _int(m, 'tailGuardMs', 0, 1000),
      fillerEvidence: _strings(m, 'fillerEvidence', (s) => s == 'transcript' || s == 'responseStart').toSet(),
      nodFirstAfterMs: _int(nod, 'firstAfterMs', 500, 10000),
      nodEveryMs: _int(nod, 'everyMs', 1000, 20000),
      audio: audio,
      defaultCharacter: defaultCharacter,
      characters: characters,
      thinkingClips: _clips(clips, 'thinking'),
      longWaitClips: _clips(clips, 'longWait'),
    );
    if (cfg.thinkingMaxMs <= cfg.fillerAfterMs + cfg.longWaitAfterMs) {
      throw const FormatException('thinking_max_too_short');
    }
    // Spec gate: thinking must show within 500 ms of local silence.
    if (cfg.thinkingSilenceMs + cfg.tickMs > 500) throw const FormatException('thinking_too_slow');
    final ids = cfg.allClips.map((c) => c.id).toList();
    if (ids.toSet().length != ids.length) throw const FormatException('duplicate_clip_id');
    return cfg;
  }
}

final _idPattern = RegExp(r'^[a-z0-9-]{1,32}$');

bool _isId(String s) => _idPattern.hasMatch(s);

Map<String, Object?> _map(Map<String, Object?> m, String key) {
  final v = m[key];
  if (v is! Map<String, Object?>) throw FormatException('missing_$key');
  return v;
}

int _int(Map<String, Object?> m, String key, int min, int max) {
  final v = m[key];
  if (v is! int || v < min || v > max) throw FormatException('${key}_out_of_range');
  return v;
}

double _num(Map<String, Object?> m, String key, double min, double max) {
  final v = m[key];
  if (v is! num || v < min || v > max) throw FormatException('${key}_out_of_range');
  return v.toDouble();
}

List<String> _strings(Map<String, Object?> m, String key, bool Function(String) valid) {
  final v = m[key];
  if (v is! List || v.isEmpty) throw FormatException('${key}_invalid');
  final out = <String>[];
  for (final e in v) {
    if (e is! String || !valid(e)) throw FormatException('${key}_invalid');
    out.add(e);
  }
  return out;
}

List<FillerClip> _clips(Map<String, Object?> m, String key) {
  final v = m[key];
  if (v is! List || v.isEmpty) throw FormatException('clips_${key}_missing');
  final out = <FillerClip>[];
  for (final c in v) {
    if (c is! Map) throw const FormatException('clip_invalid');
    final id = c['id'];
    final text = c['text'];
    if (id is! String || !_isId(id) || text is! String || text.isEmpty || text.length > 20) {
      throw const FormatException('clip_invalid');
    }
    out.add(FillerClip(id, text));
  }
  return out;
}
