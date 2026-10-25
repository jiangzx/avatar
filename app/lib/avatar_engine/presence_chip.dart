import 'dart:math' as math;

import 'package:flutter/material.dart';

enum PresenceHint { listening, thinking }

PresenceHint? presenceFor(String state) => switch (state) {
  'listening' => PresenceHint.listening,
  'thinking' => PresenceHint.thinking,
  _ => null,
};

const presenceLabels = {PresenceHint.listening: '在听您说', PresenceHint.thinking: '我想一想'};

/// Status pill above the subtitles for renderers without gaze or head cues (Duix).
class PresenceChip extends StatefulWidget {
  const PresenceChip({super.key, required this.hint});

  final PresenceHint hint;

  @override
  State<PresenceChip> createState() => _PresenceChipState();
}

class _PresenceChipState extends State<PresenceChip> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _pulse.stop();
    } else if (!_pulse.isAnimating) {
      _pulse.repeat();
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final label = presenceLabels[widget.hint]!;
    final still = MediaQuery.disableAnimationsOf(context);
    return Semantics(
      liveRegion: true,
      label: label,
      child: ExcludeSemantics(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(20)),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              AnimatedBuilder(
                animation: _pulse,
                builder: (_, _) => widget.hint == PresenceHint.listening
                    ? _dot(still ? 1.0 : _breath(_pulse.value))
                    : _dots(still ? null : _pulse.value),
              ),
              const SizedBox(width: 10),
              Text(label, style: const TextStyle(color: Colors.white, fontSize: 18)),
            ],
          ),
        ),
      ),
    );
  }

  /// Slow breathing between 45% and 100% opacity.
  static double _breath(double t) => 0.45 + 0.55 * (0.5 - 0.5 * math.cos(2 * math.pi * t));

  static Widget _dot(double opacity) => Opacity(
    opacity: opacity,
    child: Container(
      width: 12,
      height: 12,
      decoration: const BoxDecoration(color: Colors.tealAccent, shape: BoxShape.circle),
    ),
  );

  /// Three dots lighting up in turn; all evenly lit when [t] is null (animations off).
  static Widget _dots(double? t) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      for (var i = 0; i < 3; i++)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: _dot(t == null ? 0.8 : ((t * 3).floor() % 3 == i ? 1.0 : 0.35)),
        ),
    ],
  );
}
