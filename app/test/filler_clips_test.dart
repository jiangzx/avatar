import 'package:avatar_app/native_audio/filler_clips.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/thinking_fixture.dart';

class _MapBundle extends CachingAssetBundle {
  _MapBundle(this.files);

  final Map<String, Uint8List> files;

  @override
  Future<ByteData> load(String key) async {
    final bytes = files[key];
    if (bytes == null) throw FlutterError('missing asset');
    return ByteData.sublistView(bytes);
  }
}

void main() {
  test('decodes little-endian PCM16', () {
    final bytes = Uint8List.fromList([0x01, 0x00, 0xff, 0xff, 0x00, 0x80]);
    expect(pcm16FromBytes(ByteData.sublistView(bytes)), [1, -1, -32768]);
  });

  test('loads the clips of one style and logs missing ones', () async {
    final cfg = testThinking();
    final lines = <String>[];
    final bundle = _MapBundle({
      'assets/filler/grandchild/think-1.pcm': Uint8List(4800),
      'assets/filler/grandchild/wait-1.pcm': Uint8List(4800),
    });
    final clips = await loadFillerClips(bundle, cfg, 'grandchild', diag: lines.add);
    expect(clips.keys, ['think-1', 'wait-1']);
    expect(clips['think-1']!.length, 2400);
    expect(lines, ['anyidea.diag event=filler_clip_missing id=think-2']);
  });
}
