import 'dart:typed_data';

import 'package:avatar_app/native_audio/pcm.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('reframes arbitrary recorder chunks into 320-sample PCM frames', () {
    final f = PcmFrameAccumulator(320);
    expect(f.push(Uint8List(639)), isEmpty);
    expect(f.push(Uint8List(3)), hasLength(1));
    expect(f.takeRemainder(), hasLength(2));
  });

  test('rms and zero crossing rate are zero for an empty frame', () {
    expect(rmsInt16(Int16List(0)), 0);
    expect(zeroCrossingRate(Int16List(0)), 0);
  });
}
