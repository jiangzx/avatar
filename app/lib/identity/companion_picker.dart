import 'package:flutter/material.dart';

abstract interface class PickerOption {
  String get id;
  String get title;
  String get subtitle;
}

class SelectionCard extends StatelessWidget {
  const SelectionCard({
    super.key,
    required this.option,
    required this.selected,
    required this.keyPrefix,
    required this.onTap,
    this.disabled = false,
    this.note,
    this.noteColor = Colors.tealAccent,
    this.working = false,
  });

  final PickerOption option;
  final bool selected;
  final String keyPrefix;
  final VoidCallback? onTap;

  /// Greyed out with a lock: this option cannot run on this phone.
  final bool disabled;

  /// One extra line (≥18 sp): the reason, progress, or a retry hint.
  final String? note;
  final Color noteColor;

  /// A small spinner before the note (checking or preparing).
  final bool working;

  @override
  Widget build(BuildContext context) {
    final note = this.note;
    final highlighted = selected && !disabled;
    return Semantics(
      label: note == null ? option.title : '${option.title}，$note',
      selected: highlighted,
      button: true,
      enabled: onTap != null && !disabled,
      child: Material(
        key: Key('$keyPrefix-${option.id}'),
        color: disabled
            ? const Color(0xFF15181F)
            : highlighted
                ? const Color(0xFF1F3B3A)
                : const Color(0xFF1B1F2A),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(
            color: highlighted ? Colors.tealAccent : disabled ? Colors.white12 : Colors.white24,
            width: highlighted ? 3 : 1,
          ),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: disabled ? null : onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 60),
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          option.title,
                          style: TextStyle(
                            color: disabled ? Colors.white38 : Colors.white,
                            fontSize: 24,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          option.subtitle,
                          style: TextStyle(color: disabled ? Colors.white38 : Colors.white70, fontSize: 18),
                        ),
                        if (note != null) ...[
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              if (working) ...[
                                const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
                                const SizedBox(width: 8),
                              ],
                              Flexible(
                                child: Text(
                                  note,
                                  key: Key('$keyPrefix-${option.id}-note'),
                                  // A greyed card keeps its reason readable.
                                  style: TextStyle(color: disabled ? Colors.white70 : noteColor, fontSize: 18),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (disabled)
                    const Icon(Icons.lock, color: Colors.white38, size: 32)
                  else if (highlighted)
                    const Icon(Icons.check_circle, color: Colors.tealAccent, size: 36),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
