import 'package:flutter/material.dart';

import 'characters.dart';
import 'companion_picker.dart';

class AvatarPickerPage extends StatefulWidget {
  const AvatarPickerPage({
    super.key,
    required this.title,
    required this.confirmLabel,
    required this.initial,
    required this.onConfirm,
    this.onCancel,
    this.busy = false,
    this.error,
  });

  final String title;
  final String confirmLabel;
  final String initial;
  final ValueChanged<String> onConfirm;
  final VoidCallback? onCancel;
  final bool busy;
  final String? error;

  @override
  State<AvatarPickerPage> createState() => _AvatarPickerPageState();
}

class _AvatarPickerPageState extends State<AvatarPickerPage> {
  late String _selected = activeCharacter(widget.initial);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF10131A),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                widget.title,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 26,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                '选好后，下次聊天会使用新的形象',
                style: TextStyle(color: Colors.white70, fontSize: 17),
              ),
              const SizedBox(height: 20),
              Expanded(
                child: ListView(
                  children: [
                    for (final option in characterOptions)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 16),
                        child: SelectionCard(
                          option: option,
                          selected: option.id == _selected,
                          keyPrefix: 'avatar',
                          onTap: widget.busy
                              ? null
                              : () => setState(() => _selected = option.id),
                        ),
                      ),
                    if (widget.error != null)
                      Text(
                        widget.error!,
                        style: const TextStyle(
                          color: Colors.amberAccent,
                          fontSize: 18,
                        ),
                      ),
                  ],
                ),
              ),
              SizedBox(
                height: 64,
                child: FilledButton(
                  key: const Key('avatar-confirm'),
                  onPressed: widget.busy
                      ? null
                      : () => widget.onConfirm(_selected),
                  child: widget.busy
                      ? Semantics(
                          label: '正在保存',
                          child: SizedBox(
                            width: 28,
                            height: 28,
                            child: CircularProgressIndicator(strokeWidth: 3),
                          ),
                        )
                      : Text(
                          widget.confirmLabel,
                          style: const TextStyle(fontSize: 22),
                        ),
                ),
              ),
              if (widget.onCancel != null) ...[
                const SizedBox(height: 12),
                SizedBox(
                  height: 60,
                  child: TextButton(
                    key: const Key('avatar-cancel'),
                    onPressed: widget.busy ? null : widget.onCancel,
                    child: const Text('返回', style: TextStyle(fontSize: 20)),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
