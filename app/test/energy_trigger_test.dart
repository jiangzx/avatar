import 'dart:typed_data';

import 'package:avatar_app/spike/energy_trigger.dart';
import 'package:flutter_test/flutter_test.dart';

Int16List frame(int value) => Int16List(320)..fillRange(0, 320, value);

void main() {
  test('fires once per sustained loud segment (same rule as avatar-core)', () {
    final t = EnergyTrigger();
    final fired = [for (var i = 0; i < 20; i++) t.push(frame(2000))];
    expect(fired.where((f) => f).length, 1);
    expect(fired.indexOf(true), 7);
    t.push(frame(0));
    for (var i = 0; i < 8; i++) {
      t.push(frame(2000));
    }
    expect(t.count, 2);
  });

  test('ignores short bursts', () {
    final t = EnergyTrigger();
    for (var k = 0; k < 5; k++) {
      for (var i = 0; i < 5; i++) {
        t.push(frame(2000));
      }
      t.push(frame(0));
    }
    expect(t.count, 0);
  });
}
