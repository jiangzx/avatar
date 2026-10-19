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
  });

  final PickerOption option;
  final bool selected;
  final String keyPrefix;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: option.title,
      selected: selected,
      button: true,
      child: Material(
        key: Key('$keyPrefix-${option.id}'),
        color: selected ? const Color(0xFF1F3B3A) : const Color(0xFF1B1F2A),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: selected ? Colors.tealAccent : Colors.white24, width: selected ? 3 : 1),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(option.title, style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.bold)),
                      const SizedBox(height: 8),
                      Text(option.subtitle, style: const TextStyle(color: Colors.white70, fontSize: 18)),
                    ],
                  ),
                ),
                if (selected) const Icon(Icons.check_circle, color: Colors.tealAccent, size: 36),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
