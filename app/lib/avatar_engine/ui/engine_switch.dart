import 'package:flutter/material.dart';

import '../avatar_engine.dart';
import '../engine_switch_controller.dart';
import 'engine_copy.dart';

/// Top-centre segmented switch between the 3D avatar and the Duix avatar.
class EngineSwitch extends StatelessWidget {
  const EngineSwitch({
    super.key = const Key('engine-switch'),
    required this.selected,
    required this.duix,
    this.downloadFraction,
    required this.onTap,
  });

  final AvatarEngineKind selected;
  final DuixAvailability duix;
  final double? downloadFraction;

  /// Called for the segment the user tapped; the shell decides what happens.
  final ValueChanged<AvatarEngineKind> onTap;

  @override
  Widget build(BuildContext context) {
    final locked = duix == DuixAvailability.unsupported;
    final fraction = downloadFraction;
    final duixLabel = duix == DuixAvailability.downloading && fraction != null
        ? '${engineLabels[AvatarEngineKind.duix]} ${(fraction * 100).round()}%'
        : engineLabels[AvatarEngineKind.duix]!;
    final duixIcon = switch (duix) {
      DuixAvailability.unsupported => const Icon(Icons.lock, size: 18),
      DuixAvailability.needsDownload => const Icon(Icons.download_rounded, size: 20),
      _ => null,
    };
    return SegmentedButton<AvatarEngineKind>(
      segments: [
        ButtonSegment(value: AvatarEngineKind.webview, label: Text(engineLabels[AvatarEngineKind.webview]!)),
        ButtonSegment(
          value: AvatarEngineKind.duix,
          icon: duixIcon,
          label: Text(duixLabel, style: locked ? const TextStyle(color: Colors.white38) : null),
        ),
      ],
      selected: {selected},
      showSelectedIcon: true,
      onSelectionChanged: (selection) => onTap(selection.first),
      // M3 segmented buttons ignore minimumSize; density is what makes them >= 56 dp for older users.
      style: SegmentedButton.styleFrom(
        visualDensity: const VisualDensity(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 18),
        textStyle: const TextStyle(fontSize: 18),
        backgroundColor: Colors.black54,
        foregroundColor: Colors.white,
        selectedBackgroundColor: Colors.teal,
        selectedForegroundColor: Colors.white,
        side: const BorderSide(color: Colors.white24),
      ),
    );
  }
}
