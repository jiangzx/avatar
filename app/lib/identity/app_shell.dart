import 'dart:async';

import 'package:flutter/material.dart';

import '../avatar_engine/avatar_engine.dart';
import '../avatar_engine/engine_switch_controller.dart';
import '../avatar_engine/ui/engine_copy.dart';
import '../native_gateway/gateway_client.dart';
import 'character_availability.dart';
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

  /// Set for Duix pages: a failure returns to the picker with the reason.
  final void Function(AvatarEngineFailure failure)? onEngineFailure;

  /// POST /session answered 400: the gateway does not know this character.
  final VoidCallback? onUnknownCharacter;
}

/// First launch: character picker + registration. Afterwards: the saved character's chat.
/// Never switches to another character on its own (spec「Duix 不可用」).
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

  /// Null = 3D only (tests and builds without Duix): Duix characters are hidden.
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

  /// Part of the page key; a change starts a fresh page and session.
  int _pageEpoch = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  CharacterAvailability _availabilityOf(CharacterOption option) =>
      widget.engines?.availabilityFor(option) ??
      (option.engine == AvatarEngineKind.webview ? const Available() : const Hidden());

  Future<void> _load() async {
    String? character;
    String? error;
    try {
      character = await widget.identity.savedCharacter();
    } on Exception {
      error = identityErrorText('storage');
    }
    await widget.engines?.load(); // never throws: failures read as hidden or unsupported
    if (!mounted) return;
    final saved = character == null ? null : widget.catalog.byId(character);
    setState(() {
      _character = saved?.id;
      _pickerReason = saved == null ? null : _blockedReason(saved);
      _error = error;
      _loading = false;
    });
  }

  /// Why the saved character cannot open now, or null when it can.
  String? _blockedReason(CharacterOption option) => switch (_availabilityOf(option)) {
    Available() || Checking() || Preparing() => null,
    Unavailable() || PrepareFailed() || Hidden() => savedUnavailableText(option.title),
  };

  /// Copies the Duix model when needed. Null = ready; otherwise a reason code for identityErrorText.
  Future<String?> _prepare(CharacterOption option) async {
    if (option.engine != AvatarEngineKind.duix) return null;
    final engines = widget.engines;
    return engines == null ? 'duix_unsupported' : engines.prepare(option);
  }

  /// Picker confirm: prepare first, then register (first launch) or save, then open the chat.
  Future<void> _pick(String id) async {
    final option = widget.catalog.byId(id);
    if (_busy || option == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final prepareError = await _prepare(option);
    if (!mounted) return;
    if (prepareError != null) {
      setState(() {
        _busy = false;
        _error = identityErrorText(prepareError);
      });
      return;
    }
    final result = _character == null
        ? await widget.identity.chooseFirstCharacter(id)
        : await widget.identity.changeCharacter(id);
    if (result is IdentityOk) await widget.engines?.acknowledgeCrash();
    if (!mounted) return;
    setState(() {
      _busy = false;
      switch (result) {
        case IdentityOk():
          _character = id;
          _pickerReason = null;
          _pageEpoch++;
        case IdentityFailed(:final reason):
          _error = identityErrorText(reason);
      }
    });
  }

  /// Settings save: same preparation as the picker; the settings page pops on success.
  Future<IdentityResult> _saveFromSettings(String id) async {
    final option = widget.catalog.byId(id);
    if (option == null) return const IdentityFailed('invalid_character');
    final prepareError = await _prepare(option);
    if (prepareError != null) return IdentityFailed(prepareError);
    final result = await widget.identity.changeCharacter(id);
    if (result is IdentityOk) await widget.engines?.acknowledgeCrash();
    return result;
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
          availabilityOf: _availabilityOf,
          availabilityChanges: widget.engines,
        ),
      ),
    );
    if (!mounted || saved == null || saved == _character) return;
    setState(() {
      _character = saved;
      _pageEpoch++;
    });
  }

  void _onEngineFailure(CharacterOption option, AvatarEngineFailure failure) {
    widget.engines?.reportDuixFailure(failure);
    if (!mounted) return;
    setState(() => _pickerReason = duixFailedText(option.title));
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
    availabilityOf: _availabilityOf,
    availabilityChanges: widget.engines,
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
    final id = _character;
    final character = id == null ? null : widget.catalog.byId(id);
    if (character == null) return _picker(widget.catalog.defaultId, null);
    final reason = _pickerReason;
    if (reason != null) return _picker(character.id, reason);
    return _home(character);
  }

  Widget _home(CharacterOption character) => Stack(
    children: [
      Positioned.fill(
        child: widget.avatarBuilder(
          AvatarPageRequest(
            key: ValueKey('avatar-${character.id}-$_pageEpoch'),
            identity: widget.identity,
            character: character,
            engine: character.engine,
            onEngineFailure: character.engine == AvatarEngineKind.duix
                ? (failure) => _onEngineFailure(character, failure)
                : null,
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
