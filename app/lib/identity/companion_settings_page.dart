import 'package:flutter/material.dart';

import 'character_availability.dart';
import 'character_picker_page.dart';
import 'characters.dart';
import 'device_identity.dart';

/// Settings. Pops with the newly saved character id, or null when nothing changed.
class CompanionSettingsPage extends StatefulWidget {
  const CompanionSettingsPage({
    super.key,
    required this.options,
    required this.currentCharacter,
    required this.onSaveCharacter,
    this.availabilityOf = everyCharacterAvailable,
    this.availabilityChanges,
  });

  final List<CharacterOption> options;
  final String currentCharacter;
  final Future<IdentityResult> Function(String id) onSaveCharacter;
  final CharacterAvailability Function(CharacterOption option) availabilityOf;

  /// Rebuilds the cards while a model is being prepared (the EngineSwitchController).
  final Listenable? availabilityChanges;

  @override
  State<CompanionSettingsPage> createState() => _CompanionSettingsPageState();
}

class _CompanionSettingsPageState extends State<CompanionSettingsPage> {
  late String _selected = widget.currentCharacter;
  bool _busy = false;
  String? _error;

  Widget _cards() {
    Widget list() => CharacterCardList(
      options: widget.options,
      selected: _selected,
      availabilityOf: widget.availabilityOf,
      enabled: !_busy,
      gap: 12,
      onSelect: (id) => setState(() => _selected = id),
    );
    final changes = widget.availabilityChanges;
    return changes == null ? list() : ListenableBuilder(listenable: changes, builder: (_, _) => list());
  }

  Future<void> _save() async {
    if (_busy || _selected == widget.currentCharacter) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final result = await widget.onSaveCharacter(_selected);
    if (!mounted) return;
    switch (result) {
      case IdentityOk():
        Navigator.of(context).pop(_selected);
      case IdentityFailed(:final reason):
        setState(() {
          _busy = false;
          _error = identityErrorText(reason);
        });
    }
  }

  @override
  Widget build(BuildContext context) {
    final error = _error;
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
                    const Text('选择陪伴角色', style: TextStyle(color: Colors.tealAccent, fontSize: 19, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 12),
                    _cards(),
                  ],
                ),
              ),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(error, style: const TextStyle(color: Colors.amberAccent, fontSize: 18)),
                ),
              SizedBox(
                height: 64,
                child: FilledButton(
                  key: const Key('companion-confirm'),
                  onPressed: _busy || _selected == widget.currentCharacter ? null : _save,
                  child: _busy
                      ? const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3))
                      : const Text('换成这位伙伴', style: TextStyle(fontSize: 22)),
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
