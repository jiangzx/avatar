import 'dart:typed_data';

import 'package:flutter/services.dart';

import '../diag_log.dart';
import '../native_session/thinking_config.dart';

Int16List pcm16FromBytes(ByteData data) {
  final out = Int16List(data.lengthInBytes ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = data.getInt16(i * 2, Endian.little);
  }
  return out;
}

/// Loads one character's filler clips; a missing clip is logged and skipped (that filler stays silent).
Future<Map<String, Int16List>> loadFillerClips(
  AssetBundle bundle,
  ThinkingConfig cfg,
  String characterId, {
  DiagSink diag = logcatDiagSink,
}) async {
  final out = <String, Int16List>{};
  for (final clip in cfg.allClips) {
    try {
      out[clip.id] = pcm16FromBytes(await bundle.load(cfg.clipAsset(characterId, clip.id)));
    } catch (_) {
      diag(formatDiag('filler_clip_missing', {'id': clip.id}));
    }
  }
  return out;
}
