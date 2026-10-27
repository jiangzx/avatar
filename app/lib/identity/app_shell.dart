import 'dart:async';

import 'package:flutter/material.dart';

import '../avatar_engine/avatar_engine.dart';
import '../avatar_engine/engine_switch_controller.dart';
import '../avatar_engine/ui/engine_copy.dart';
import '../duix/duix_installer.dart';
import '../native_gateway/gateway_client.dart';
import 'character_picker_page.dart';
import 'characters.dart';
import 'companion_settings_page.dart';
import 'device_identity.dart';

/// What the shell asks the avatar builder for. A new [key] means a fresh page and session.
class AvatarPageRequest {
  const AvatarPageRequest({
    required this.key,
    required this.identity,
    required this.character,
    required this.engine,
    this.onEngineFailure,
    this.onUnknownCharacter,
  });

  final Key key;
  final DeviceTokenProvider identity;
  final CharacterOption character;
  final AvatarEngineKind engine;

  /// Set for Duix pages.
  final void Function(AvatarEngineFailure failure)? onEngineFailure;

  /// POST /session answered 400: the gateway does not know this character.
  final VoidCallback? onUnknownCharacter;
}

/// First launch: character picker + registration. Afterwards: the chat with a settings button on top.
class AppShell extends StatefulWidget {
  const AppShell({
    super.key,
    required this.identity,
    required this.catalog,
    required this.avatarBuilder,
    this.engines,
  });

  final DeviceIdentity identity;
  final CharacterCatalog catalog;
  final Widget Function(AvatarPageRequest request) avatarBuilder;

  /// Null = 3D only (tests and builds without Duix).
  final EngineSwitchController? engines;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  bool _loading = true;
  String? _character;

  /// Set when the saved character cannot continue; the picker shows this reason.
  String? _pickerReason;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.engines?.addListener(_onEngines);
    unawaited(_load());
  }

  @override
  void dispose() {
    widget.engines?.removeListener(_onEngines);
    super.dispose();
  }

  void _onEngines() {
    final notice = widget.engines?.takeNotice();
    if (notice == null || !mounted) return;
    WidgetsBinding.instance.addPostFrameCallback((_) => _showNotice(notice));
  }

  void _showNotice(EngineNotice notice) {
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    switch (notice) {
      case EngineNotice.fallback:
        messenger.showSnackBar(_snack(fallbackText));
      case EngineNotice.crashDisabled:
        messenger.showSnackBar(_snack(crashDisabledText));
      case EngineNotice.duixReady:
        messenger.showSnackBar(_snack(duixReadyText));
    }
  }

  static SnackBar _snack(String text) => SnackBar(content: Text(text, style: const TextStyle(fontSize: 18)));

  Future<void> _load() async {
    String? character;
    String? error;
    try {
      character = await widget.identity.savedCharacter();
    } on Exception {
      error = identityErrorText('storage');
    }
    await widget.engines?.load(); // never throws: failures read as "Duix hidden or unsupported"
    if (!mounted) return;
    setState(() {
      _character = character;
      _error = error;
      _loading = false;
    });
  }

  /// Picker confirm. First launch registers; later picks only save locally.
  Future<void> _pick(String id) async {
    if (_busy) return;
    final first = _character == null;
    setState(() {
      _busy = true;
      _error = null;
    });
    final result = first ? await widget.identity.chooseFirstCharacter(id) : await widget.identity.changeCharacter(id);
    if (!mounted) return;
    switch (result) {
      case IdentityOk():
        setState(() {
          _busy = false;
          _character = id;
          _pickerReason = null;
        });
        await _followEngine(id);
      case IdentityFailed(:final reason):
        setState(() {
          _busy = false;
          _error = identityErrorText(reason);
        });
    }
  }

  /// Temporary until Task 14: the session engine follows the chosen character.
  Future<void> _followEngine(String id) async {
    final engines = widget.engines;
    final option = widget.catalog.byId(id);
    if (engines == null || option == null || option.engine == engines.sessionEngine) return;
    await engines.choose(option.engine);
    if (mounted && option.engine == AvatarEngineKind.duix && engines.sessionEngine != AvatarEngineKind.duix) {
      final state = engines.installer?.state;
      final code = state is InstallFailed ? state.code : null;
      ScaffoldMessenger.of(context).showSnackBar(_snack(unsupportedText(
        code == 'abi_unsupported' || code == 'low_memory' || code == 'storage_unavailable' ? code : null,
      )));
    }
  }

  Future<IdentityResult> _saveFromSettings(String id) async {
    final option = widget.catalog.byId(id);
    final engines = widget.engines;
    if (option != null &&
        option.engine == AvatarEngineKind.duix &&
        (engines == null || engines.availability == DuixAvailability.unsupported)) {
      return IdentityFailed(engines?.unsupportedReason ?? 'duix_unsupported');
    }
    return widget.identity.changeCharacter(id);
  }

  Future<void> _openSettings() async {
    final current = _character;
    if (current == null) return;
    final saved = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder: (_) => CompanionSettingsPage(
          options: widget.catalog.options,
          currentCharacter: current,
          onSaveCharacter: _saveFromSettings,
        ),
      ),
    );
    if (!mounted || saved == null || saved == _character) return;
    setState(() => _character = saved);
    await _followEngine(saved);
  }

  void _onUnknownCharacter() {
    if (!mounted) return;
    setState(() => _pickerReason = unknownCharacterText);
  }

  Widget _picker(String initial, String? reason) => CharacterPickerPage(
    title: '选一位陪您聊天的伙伴',
    confirmLabel: '就选这个',
    options: widget.catalog.options,
    initial: initial,
    busy: _busy,
    error: _error ?? reason,
    onConfirm: _pick,
  );

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(
        backgroundColor: Color(0xFF10131A),
        body: Center(child: CircularProgressIndicator()),
      );
    }
    final character = _character;
    if (character == null) return _picker(widget.catalog.defaultId, null);
    final reason = _pickerReason;
    if (reason != null) return _picker(character, reason);
    final engines = widget.engines;
    if (engines == null) return _home(AvatarEngineKind.webview, 0, null);
    return ListenableBuilder(
      listenable: engines,
      builder: (context, _) => _home(engines.sessionEngine, engines.pageEpoch, engines),
    );
  }

  Widget _home(AvatarEngineKind engine, int epoch, EngineSwitchController? engines) {
    final saved = widget.catalog.byId(_character!)!;
    // Temporary until Task 14: a Duix character on a 3D session shows the first 3D character.
    final shown = saved.engine == engine
        ? saved
        : widget.catalog.options.firstWhere((o) => o.engine == engine, orElse: () => saved);
    return Stack(
      children: [
        Positioned.fill(
          child: widget.avatarBuilder(
            AvatarPageRequest(
              key: ValueKey('avatar-${engine.name}-${shown.id}-$epoch'),
              identity: widget.identity,
              character: shown,
              engine: engine,
              onEngineFailure: engine == AvatarEngineKind.duix ? engines?.reportDuixFailure : null,
              onUnknownCharacter: _onUnknownCharacter,
            ),
          ),
        ),
        // Bottom-right, clear of the centered mute/end buttons in AvatarOverlay.
        Positioned(
          right: 16,
          bottom: 28,
          child: SafeArea(child: _SettingsButton(onTap: _openSettings)),
        ),
      ],
    );
  }
}

class _SettingsButton extends StatelessWidget {
  const _SettingsButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    label: '换聊天伙伴',
    button: true,
    child: Material(
      color: Colors.white24,
      shape: const CircleBorder(),
      child: InkWell(
        key: const Key('settings'),
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: const SizedBox(
          width: 64,
          height: 64,
          child: Icon(Icons.tune, color: Colors.white, size: 32),
        ),
      ),
    ),
  );
}
