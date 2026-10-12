import 'dart:math' as math;
import 'dart:typed_data';

class PcmFrameAccumulator {
  PcmFrameAccumulator(this.frameSamples);

  final int frameSamples;
  Uint8List _pending = Uint8List(0);

  List<Int16List> push(Uint8List bytes) {
    if (bytes.isEmpty) return const [];
    final combined = Uint8List(_pending.length + bytes.length)
      ..setRange(0, _pending.length, _pending)
      ..setRange(_pending.length, _pending.length + bytes.length, bytes);
    final frameBytes = frameSamples * 2;
    final completeBytes = combined.length - (combined.length % frameBytes);
    final frames = <Int16List>[];
    for (var offset = 0; offset < completeBytes; offset += frameBytes) {
      final frame = Int16List(frameSamples);
      final view = ByteData.sublistView(combined, offset, offset + frameBytes);
      for (var i = 0; i < frameSamples; i++) {
        frame[i] = view.getInt16(i * 2, Endian.little);
      }
      frames.add(frame);
    }
    _pending = Uint8List.fromList(combined.sublist(completeBytes));
    return frames;
  }

  Uint8List takeRemainder() {
    final remainder = _pending;
    _pending = Uint8List(0);
    return remainder;
  }
}

double rmsInt16(Int16List pcm) {
  if (pcm.isEmpty) return 0;
  var sum = 0.0;
  for (final sample in pcm) {
    sum += sample * sample;
  }
  return math.sqrt(sum / pcm.length);
}

double zeroCrossingRate(Int16List pcm) {
  if (pcm.length < 2) return 0;
  var crossings = 0;
  for (var i = 1; i < pcm.length; i++) {
    final previous = pcm[i - 1];
    final current = pcm[i];
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings++;
  }
  return crossings / (pcm.length - 1);
}
