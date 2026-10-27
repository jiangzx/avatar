import 'package:flutter/material.dart';

import '../avatar_engine/ui/engine_copy.dart';
import 'character_availability.dart';
import 'characters.dart';
import 'companion_picker.dart';

/// Plain-language text for identity failure reasons.
String identityErrorText(String reason) => switch (reason) {
  'network' => '网络连接失败，请检查网络后再试',
  'storage' => '手机保存身份信息失败，请重试',
  'http_400' || 'invalid_character' => '这个伙伴暂时不可用，请换一个',
  'http_401' => '应用配置有误，请联系家人',
  'abi_unsupported' || 'low_memory' || 'storage_unavailable' || 'duix_unsupported' => unsupportedText(
    reason == 'duix_unsupported' ? null : reason,
  ),
  'http_429' || 'http_503' => '现在注册的人太多了，请稍后再试',
  _ => '出错了（$reason），请稍后再试',
};

/// POST /session answered 400 for the saved character.
const unknownCharacterText = '这位伙伴暂时联系不上，请重新选一位';

/// The preferred character when it can be picked, else the first visible one that can.
String initialCharacter(
  List<CharacterOption> options,
  String preferred,
  CharacterAvailability Function(CharacterOption option) availabilityOf,
) {
  for (final option in options) {
    if (option.id == preferred && canPick(availabilityOf(option))) return option.id;
  }
  for (final option in options) {
    if (canPick(availabilityOf(option))) return option.id;
  }
  return preferred;
}

/// Large character cards (≥60 dp, ≥18 sp). Hidden characters are left out; locked ones ignore taps.
class CharacterCardList extends StatelessWidget {
  const CharacterCardList({
    super.key,
    required this.options,
    required this.selected,
    required this.onSelect,
    this.availabilityOf = everyCharacterAvailable,
    this.enabled = true,
    this.gap = 16,
  });

  final List<CharacterOption> options;
  final String selected;
  final ValueChanged<String> onSelect;
  final CharacterAvailability Function(CharacterOption option) availabilityOf;
  final bool enabled;
  final double gap;

  @override
  Widget build(BuildContext context) {
    final cards = <Widget>[];
    for (final option in options) {
      final availability = availabilityOf(option);
      if (availability is Hidden) continue;
      cards.add(
        Padding(
          padding: EdgeInsets.only(bottom: gap),
          child: SelectionCard(
            option: option,
            selected: option.id == selected,
            keyPrefix: 'character',
            onTap: enabled && canPick(availability) ? () => onSelect(option.id) : null,
          ),
        ),
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: cards);
  }
}

/// First launch, and whenever the saved character cannot continue: pick one character.
class CharacterPickerPage extends StatefulWidget {
  const CharacterPickerPage({
    super.key,
    required this.title,
    required this.confirmLabel,
    required this.options,
    required this.initial,
    required this.onConfirm,
    this.availabilityOf = everyCharacterAvailable,
    this.availabilityChanges,
    this.onCancel,
    this.busy = false,
    this.error,
  });

  final String title;
  final String confirmLabel;
  final List<CharacterOption> options;

  /// Preferred highlight; replaced by the first pickable character when it cannot be picked.
  final String initial;
  final ValueChanged<String> onConfirm;
  final CharacterAvailability Function(CharacterOption option) availabilityOf;

  /// Rebuilds the cards when availability changes (Task 14 passes the EngineSwitchController).
  final Listenable? availabilityChanges;
  final VoidCallback? onCancel;
  final bool busy;

  /// Error or the reason the picker is shown again.
  final String? error;

  @override
  State<CharacterPickerPage> createState() => _CharacterPickerPageState();
}

class _CharacterPickerPageState extends State<CharacterPickerPage> {
  late String _selected = initialCharacter(widget.options, widget.initial, widget.availabilityOf);

  bool get _selectedPickable {
    for (final option in widget.options) {
      if (option.id == _selected) return canPick(widget.availabilityOf(option));
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final changes = widget.availabilityChanges;
    return Scaffold(
      backgroundColor: const Color(0xFF10131A),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: changes == null ? _body() : ListenableBuilder(listenable: changes, builder: (_, _) => _body()),
        ),
      ),
    );
  }

  Widget _body() {
    final error = widget.error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(widget.title, style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.bold)),
        if (error != null) ...[
          const SizedBox(height: 12),
          Text(error, key: const Key('character-error'), style: const TextStyle(color: Colors.amberAccent, fontSize: 18)),
        ],
        const SizedBox(height: 24),
        Expanded(
          child: SingleChildScrollView(
            child: CharacterCardList(
              options: widget.options,
              selected: _selected,
              availabilityOf: widget.availabilityOf,
              enabled: !widget.busy,
              onSelect: (id) => setState(() => _selected = id),
            ),
          ),
        ),
        SizedBox(
          height: 64,
          child: FilledButton(
            key: const Key('character-confirm'),
            onPressed: widget.busy || !_selectedPickable ? null : () => widget.onConfirm(_selected),
            child: widget.busy
                ? Semantics(
                    label: '正在保存',
                    child: const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3)),
                  )
                : Text(widget.confirmLabel, style: const TextStyle(fontSize: 22)),
          ),
        ),
        if (widget.onCancel != null) ...[
          const SizedBox(height: 12),
          SizedBox(
            height: 60,
            child: TextButton(
              key: const Key('character-cancel'),
              onPressed: widget.busy ? null : widget.onCancel,
              child: const Text('返回', style: TextStyle(fontSize: 20)),
            ),
          ),
        ],
      ],
    );
  }
}
