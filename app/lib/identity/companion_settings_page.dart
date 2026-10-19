import 'package:flutter/material.dart';

import 'avatars.dart';
import 'companion_picker.dart';
import 'device_identity.dart';
import 'style_picker_page.dart';
import 'styles.dart';

class CompanionSelection {
  const CompanionSelection({required this.style, required this.avatar});

  final String style;
  final String avatar;
}

class CompanionSettingsPage extends StatefulWidget {
  const CompanionSettingsPage({
    super.key,
    required this.currentStyle,
    required this.currentAvatar,
    required this.onSaveStyle,
    required this.onSaveAvatar,
  });

  final String currentStyle;
  final String currentAvatar;
  final Future<IdentityResult> Function(String style) onSaveStyle;
  final Future<IdentityResult> Function(String avatar) onSaveAvatar;

  @override
  State<CompanionSettingsPage> createState() => _CompanionSettingsPageState();
}

class _CompanionSettingsPageState extends State<CompanionSettingsPage> {
  late String _style = widget.currentStyle;
  late String _avatar = avatarOptionFor(widget.currentAvatar).id;
  bool _busy = false;
  String? _error;

  Future<void> _save() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    if (_style != widget.currentStyle) {
      final result = await widget.onSaveStyle(_style);
      if (result case IdentityFailed(:final reason)) {
        if (mounted) setState(() { _busy = false; _error = identityErrorText(reason); });
        return;
      }
    }
    if (_avatar != widget.currentAvatar) {
      final result = await widget.onSaveAvatar(_avatar);
      if (result case IdentityFailed(:final reason)) {
        if (mounted) setState(() { _busy = false; _error = identityErrorText(reason); });
        return;
      }
    }
    if (mounted) Navigator.of(context).pop(CompanionSelection(style: _style, avatar: _avatar));
  }

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
              const Text('聊天伙伴设置', style: TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.bold)),
              const SizedBox(height: 20),
              Expanded(
                child: ListView(
                  children: [
                    const Text('聊天风格', style: TextStyle(color: Colors.tealAccent, fontSize: 19, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 12),
                    for (final option in styleOptions)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: SelectionCard(
                          option: option,
                          selected: option.id == _style,
                          keyPrefix: 'style',
                          onTap: _busy ? null : () => setState(() => _style = option.id),
                        ),
                      ),
                    const SizedBox(height: 12),
                    const Text('形象', style: TextStyle(color: Colors.tealAccent, fontSize: 19, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 12),
                    for (final option in avatarOptions)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: SelectionCard(
                          option: option,
                          selected: option.id == _avatar,
                          keyPrefix: 'avatar',
                          onTap: _busy ? null : () => setState(() => _avatar = option.id),
                        ),
                      ),
                    if (_error != null) Text(_error!, style: const TextStyle(color: Colors.amberAccent, fontSize: 18)),
                  ],
                ),
              ),
              SizedBox(
                height: 64,
                child: FilledButton(
                  key: const Key('companion-confirm'),
                  onPressed: _busy ? null : _save,
                  child: _busy
                      ? const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3))
                      : const Text('保存', style: TextStyle(fontSize: 22)),
                ),
              ),
              const SizedBox(height: 12),
              SizedBox(
                height: 60,
                child: TextButton(
                  key: const Key('companion-cancel'),
                  onPressed: _busy ? null : () => Navigator.of(context).pop(),
                  child: const Text('返回', style: TextStyle(fontSize: 20)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
