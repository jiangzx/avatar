import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../avatar_engine/ui/engine_confirm_dialog.dart';
import '../companion_config.dart';
import '../memory/memory_api.dart';
import '../memory/memory_copy.dart';
import 'character_availability.dart';
import 'character_picker_page.dart';
import 'characters.dart';
import 'device_identity.dart';

/// Settings: pick the companion; see and delete what the companions remember.
/// Pops with the newly saved character id, or null. Memory lists live only in this page's state.
class CompanionSettingsPage extends StatefulWidget {
  const CompanionSettingsPage({
    super.key,
    required this.options,
    required this.currentCharacter,
    required this.onSaveCharacter,
    this.availabilityOf = everyCharacterAvailable,
    this.availabilityChanges,
    this.memory,
    this.onMemoryChanged,
    this.diagCode,
    this.companion,
  });

  final List<CharacterOption> options;
  final String currentCharacter;
  final Future<IdentityResult> Function(String id) onSaveCharacter;
  final CharacterAvailability Function(CharacterOption option) availabilityOf;

  /// Rebuilds the cards while a model is being prepared (the EngineSwitchController).
  final Listenable? availabilityChanges;

  /// Null hides the memory blocks (dev builds and tests without a gateway).
  final MemoryApi? memory;

  /// Called after every memory write attempt; the shell restarts the chat.
  final VoidCallback? onMemoryChanged;

  /// Latest `<sessionId>-<diagId>` from the chat page; null hides the copy button.
  final String? diagCode;

  /// Copy for the diag button; null hides it.
  final CompanionConfig? companion;

  @override
  State<CompanionSettingsPage> createState() => _CompanionSettingsPageState();
}

class _CompanionSettingsPageState extends State<CompanionSettingsPage> {
  late String _selected = widget.currentCharacter;
  bool _busy = false;
  String? _error;

  MemoryOverview? _overview;
  bool _loadingMemory = false;
  bool _loadFailed = false;
  bool _writing = false;
  String? _memoryNotice;

  @override
  void initState() {
    super.initState();
    if (widget.memory != null) unawaited(_loadMemory());
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

  Future<void> _loadMemory() async {
    final api = widget.memory;
    if (api == null) return;
    setState(() {
      _loadingMemory = true;
      _loadFailed = false;
    });
    final result = await api.overview();
    if (!mounted) return;
    setState(() {
      _loadingMemory = false;
      switch (result) {
        case MemoryOk(:final value):
          _overview = value;
        case MemoryFailed():
          _loadFailed = true;
      }
    });
  }

  /// One write. The gateway ends the live session before any write is validated, so the shell
  /// restarts the chat after every attempt. Success reloads; failure keeps the lists and says so.
  Future<void> _run(
    Future<MemoryResult<void>> Function(MemoryApi api) write, {
    String Function(String reason)? failureText,
  }) async {
    final api = widget.memory;
    if (api == null || _writing) return;
    setState(() {
      _writing = true;
      _memoryNotice = null;
    });
    final result = await write(api);
    if (!mounted) return;
    widget.onMemoryChanged?.call();
    switch (result) {
      case MemoryOk():
        setState(() => _writing = false);
        await _loadMemory();
      case MemoryFailed(:final reason):
        setState(() {
          _writing = false;
          _memoryNotice = failureText?.call(reason) ?? deleteFailedText;
        });
    }
  }

  /// Every deletion asks first (spec): large dialog, then the write.
  Future<void> _confirmThen(String body, String cancel, String ok, Future<MemoryResult<void>> Function(MemoryApi api) write) async {
    if (_writing) return;
    final confirmed = await confirmLarge(
      context,
      body: body,
      cancel: cancel,
      ok: ok,
      cancelKey: const Key('memory-confirm-cancel'),
      okKey: const Key('memory-confirm-ok'),
    );
    if (!confirmed || !mounted) return;
    await _run(write);
  }

  Future<void> _editAddressing(MemoryItem? current) async {
    if (_writing) return;
    final name = await showDialog<String>(
      context: context,
      builder: (_) => _AddressingDialog(initial: current?.text ?? ''),
    );
    if (name == null || !mounted) return;
    await _run(
      (api) => api.setAddressing(name),
      failureText: (reason) => switch (reason) {
        'declined' => addressingDeclinedText,
        'rejected' => addressingRejectedText,
        _ => saveFailedText,
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final message = _error ?? _memoryNotice;
    return Scaffold(
      backgroundColor: const Color(0xFF10131A),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('聊天伙伴设置', style: TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Expanded(
                child: ListView(
                  children: [
                    _header('选择陪伴角色'),
                    _cards(),
                    ..._memoryBlocks(),
                    ..._diagBlock(),
                  ],
                ),
              ),
              if (message != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8, bottom: 12),
                  child: Text(
                    message,
                    key: Key(_error != null ? 'companion-error' : 'memory-notice'),
                    style: const TextStyle(color: Colors.amberAccent, fontSize: 18),
                  ),
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

  List<Widget> _diagBlock() {
    final code = widget.diagCode;
    final copy = widget.companion;
    if (code == null || copy == null) return const [];
    return [
      const SizedBox(height: 24),
      SizedBox(
        height: 56,
        child: OutlinedButton(
          key: const Key('copy-diag'),
          onPressed: () => unawaited(_copyDiag(code, copy.diagCopiedText)),
          child: Text(copy.diagCopyLabel, style: const TextStyle(fontSize: 20)),
        ),
      ),
      const SizedBox(height: 8),
      // Shown so a family member can read it out over the phone.
      Text(code, key: const Key('diag-code'), style: const TextStyle(color: Colors.white54, fontSize: 14)),
    ];
  }

  Future<void> _copyDiag(String code, String done) async {
    await Clipboard.setData(ClipboardData(text: code));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done, style: const TextStyle(fontSize: 18))));
  }

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

  List<Widget> _memoryBlocks() {
    if (widget.memory == null) return const [];
    final overview = _overview;
    if (overview == null) {
      if (!_loadFailed) {
        return const [Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()))];
      }
      return [
        const SizedBox(height: 16),
        const Text(memoryLoadFailedText, style: TextStyle(color: Colors.amberAccent, fontSize: 18)),
        const SizedBox(height: 8),
        SizedBox(
          height: 60,
          child: OutlinedButton(
            key: const Key('memory-retry'),
            onPressed: _loadingMemory ? null : () => unawaited(_loadMemory()),
            child: const Text(memoryRetry, style: TextStyle(fontSize: 20)),
          ),
        ),
      ];
    }
    return [
      _header(profileSectionTitle),
      _addressingRow(overview.addressing),
      for (final item in overview.profileItems) _itemRow(item),
      if (overview.profileItems.isEmpty) _emptyLine(profileItemsEmpty),
      _actionButton(
        key: const Key('clear-profile'),
        label: clearProfileLabel,
        onPressed: () => unawaited(_confirmThen(clearProfileConfirm, clearCancel, clearOk, (api) => api.clear(MemoryClearScope.profile))),
      ),
      for (final option in widget.options) ..._characterBlock(option, overview.forCharacter(option.id)),
      const SizedBox(height: 24),
      _actionButton(
        key: const Key('clear-all'),
        label: clearAllLabel,
        danger: true,
        onPressed: () => unawaited(_confirmThen(clearAllConfirm, clearCancel, clearOk, (api) => api.clear(MemoryClearScope.all))),
      ),
    ];
  }

  List<Widget> _characterBlock(CharacterOption option, CharacterMemory? memory) {
    final pinned = memory?.pinned ?? const <MemoryPinnedItem>[];
    final facts = memory?.facts ?? const <MemoryFactItem>[];
    final threads = memory?.threads ?? const <MemoryThreadItem>[];
    final reflections = memory?.reflections ?? const <MemoryItem>[];
    final moods = memory?.moods ?? const <MemoryMoodItem>[];
    return [
      _header(characterMemoryTitle(option.title)),
      _subheader(pinnedTitle),
      for (final item in pinned) _itemRow(item),
      if (pinned.isEmpty) _emptyLine(memoryListEmpty),
      _subheader(otherMemoryTitle),
      for (final item in facts) _itemRow(item),
      if (facts.isEmpty) _emptyLine(memoryListEmpty),
      if (threads.isNotEmpty) ...[
        _subheader(threadsTitle),
        for (final item in threads) _itemRow(item, label: threadKindLabel(item.kind)),
      ],
      if (reflections.isNotEmpty) ...[
        _subheader(reflectionsTitle),
        for (final item in reflections) _itemRow(item),
      ],
      if (moods.isNotEmpty) ...[
        _subheader(moodsTitle),
        for (final mood in moods) _moodRow(mood),
      ],
      _actionButton(
        key: Key('clear-character-${option.id}'),
        label: clearCharacterLabel(option.title),
        onPressed: () => unawaited(_confirmThen(
          clearCharacterConfirm(option.title),
          clearCancel,
          clearOk,
          (api) => api.clear(MemoryClearScope.character, character: option.id),
        )),
      ),
    ];
  }

  Widget _addressingRow(MemoryItem? addressing) => Row(
    children: [
      Expanded(
        child: Text(
          '$addressingLabel：${addressing?.text ?? addressingEmpty}',
          style: const TextStyle(color: Colors.white, fontSize: 20),
        ),
      ),
      SizedBox(
        height: 60,
        child: TextButton(
          key: const Key('addressing-edit'),
          style: TextButton.styleFrom(minimumSize: const Size(96, 60)),
          onPressed: _writing ? null : () => unawaited(_editAddressing(addressing)),
          child: const Text(addressingEditLabel, style: TextStyle(fontSize: 20)),
        ),
      ),
    ],
  );

  Widget _itemRow(MemoryItem item, {String? label}) => Padding(
    padding: const EdgeInsets.only(bottom: 4),
    child: Row(
      children: [
        Expanded(child: Text(label == null ? item.text : '$label：${item.text}', style: const TextStyle(color: Colors.white, fontSize: 20))),
        SizedBox(
          height: 60,
          child: TextButton(
            key: Key('delete-${item.id}'),
            style: TextButton.styleFrom(minimumSize: const Size(72, 60)),
            onPressed: _writing
                ? null
                : () => unawaited(_confirmThen(deleteItemConfirm, deleteCancel, deleteOk, (api) => api.deleteItem(item.id))),
            child: const Text(deleteLabel, style: TextStyle(fontSize: 20)),
          ),
        ),
      ],
    ),
  );

  Widget _moodRow(MemoryMoodItem mood) => Padding(
    padding: const EdgeInsets.only(bottom: 4),
    child: Row(
      children: [
        Expanded(
          child: Text(
            '${mood.day} · ${moodEmotionLabel(mood.emotion)} · ${moodPeakLabel(mood.peak)}',
            style: const TextStyle(color: Colors.white, fontSize: 20),
          ),
        ),
        SizedBox(
          height: 60,
          child: TextButton(
            key: Key('delete-${mood.id}'),
            style: TextButton.styleFrom(minimumSize: const Size(72, 60)),
            onPressed: _writing
                ? null
                : () => unawaited(_confirmThen(deleteMoodConfirm, deleteCancel, deleteOk, (api) => api.deleteItem(mood.id))),
            child: const Text(deleteLabel, style: TextStyle(fontSize: 20)),
          ),
        ),
      ],
    ),
  );

  Widget _actionButton({required Key key, required String label, required VoidCallback onPressed, bool danger = false}) =>
      Padding(
        padding: const EdgeInsets.only(top: 12),
        child: SizedBox(
          height: 60,
          child: OutlinedButton(
            key: key,
            style: OutlinedButton.styleFrom(
              foregroundColor: danger ? Colors.redAccent : Colors.white,
              side: BorderSide(color: danger ? Colors.redAccent : Colors.white38),
            ),
            onPressed: _writing ? null : onPressed,
            child: Text(label, style: const TextStyle(fontSize: 20)),
          ),
        ),
      );

  static Widget _header(String text) => Padding(
    padding: const EdgeInsets.only(top: 20, bottom: 12),
    child: Text(text, style: const TextStyle(color: Colors.tealAccent, fontSize: 19, fontWeight: FontWeight.bold)),
  );

  static Widget _subheader(String text) => Padding(
    padding: const EdgeInsets.only(top: 8, bottom: 4),
    child: Text(text, style: const TextStyle(color: Colors.white70, fontSize: 18, fontWeight: FontWeight.bold)),
  );

  static Widget _emptyLine(String text) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Text(text, style: const TextStyle(color: Colors.white54, fontSize: 18)),
  );
}

/// Edits the addressing: 1–20 characters, large text. Pops with the trimmed name, or null.
class _AddressingDialog extends StatefulWidget {
  const _AddressingDialog({required this.initial});

  final String initial;

  @override
  State<_AddressingDialog> createState() => _AddressingDialogState();
}

class _AddressingDialogState extends State<_AddressingDialog> {
  late final _controller = TextEditingController(text: widget.initial);
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final name = _controller.text.trim();
    if (name.isEmpty) {
      setState(() => _error = addressingEmptyError);
      return;
    }
    Navigator.of(context).pop(name);
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text(addressingDialogTitle, style: TextStyle(fontSize: 24)),
    content: TextField(
      key: const Key('addressing-field'),
      controller: _controller,
      autofocus: true,
      maxLength: addressingMaxLength,
      style: const TextStyle(fontSize: 22),
      decoration: InputDecoration(
        hintText: addressingHint,
        hintStyle: const TextStyle(fontSize: 20),
        errorText: _error,
        errorStyle: const TextStyle(fontSize: 18),
        counterStyle: const TextStyle(fontSize: 18),
      ),
      onSubmitted: (_) => _submit(),
    ),
    actions: [
      SizedBox(
        height: 60,
        child: TextButton(
          key: const Key('addressing-cancel'),
          onPressed: () => Navigator.of(context).pop(),
          child: const Text(dialogCancel, style: TextStyle(fontSize: 20)),
        ),
      ),
      SizedBox(
        height: 60,
        child: FilledButton(
          key: const Key('addressing-save'),
          onPressed: _submit,
          child: const Text(dialogSave, style: TextStyle(fontSize: 20)),
        ),
      ),
    ],
  );
}
