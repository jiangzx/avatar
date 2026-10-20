import 'package:avatar_app/native_audio/native_audio_io.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:record/record.dart';

void main() {
  test('keeps the recorder alive across audio focus loss', () {
    expect(
      nativeRecordConfig().audioInterruption,
      AudioInterruptionMode.pauseResume,
    );
  });
}
