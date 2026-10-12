import 'dart:math';
import 'dart:typed_data';

// TUNABLE: same defaults as avatar-core/src/audio/energy.ts.
const double energyThresholdRms = 1200;
const int energyMinMs = 150;
const int energyFrameMs = 20;

double rmsInt16(Int16List pcm) {
  if (pcm.isEmpty) return 0;
  var sum = 0.0;
  for (final v in pcm) {
    sum += v * v;
  }
  return sqrt(sum / pcm.length);
}

/// Mirrors avatar-core/src/audio/energy.ts so paths A and B are judged identically.
class EnergyTrigger {
  EnergyTrigger({this.thresholdRms = energyThresholdRms, this.minMs = energyMinMs, this.frameMs = energyFrameMs});

  final double thresholdRms;
  final int minMs;
  final int frameMs;
  int count = 0;
  int _aboveMs = 0;
  bool _armed = true;

  bool push(Int16List frame) {
    if (rmsInt16(frame) >= thresholdRms) {
      _aboveMs += frameMs;
      if (_armed && _aboveMs >= minMs) {
        _armed = false;
        count++;
        return true;
      }
      return false;
    }
    _aboveMs = 0;
    _armed = true;
    return false;
  }
}
