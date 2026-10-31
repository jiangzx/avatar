import 'dart:async';

import 'package:flutter/material.dart';

import '../avatar_engine/avatar_engine.dart';
import '../avatar_engine/engine_switch_controller.dart';
import '../avatar_engine/ui/engine_copy.dart';
import '../companion_config.dart';
import '../memory/memory_api.dart';
import '../native_gateway/gateway_client.dart';
import 'character_availability.dart';
import 'character_holds.dart';
import 'character_picker_page.dart';
import 'characters.dart';
import 'companion_settings_page.dart';
import 'credential_store.dart';
import 'device_identity.dart';
import 'session_rejection.dart';

/// What the shell asks the avatar builder for. A new [key] means a fresh page and session.
class AvatarPageRequest {
  const AvatarPageRequest({
    required this.key,
    required this.identity,
    required this.character,
    required this.engine,
    this.onEngineFailure,
    this.onUnknownCharacter,
    this.onSessionRejected,
    this.onDiagCode,
    this.onChangePartner,
  });

  final Key key;
  final DeviceTokenProvider identity;
  final CharacterOption character;
  final AvatarEngineKind engine;

  /// Set for Duix pages: a failure returns to the picker with the reason.
  final void Function(AvatarEngineFailure failure)? onEngineFailure;

  /// POST /session answered 400: the gateway does not know this character.
  final VoidCallback? onUnknownCharacter;

  /// POST /session or the live session was refused (owner_banned / character_disabled).
  final void Function(SessionRejection rejection)? onSessionRejected;

  /// The chat page reports the diag code of each ready session.
  final ValueChanged<String>? onDiagCode;

  /// Opens the settings/character switcher from the chat page's ended card.
  final VoidCallback? onChangePartner;
}

/// First launch: character picker + registration. Afterwards: the saved character's chat.
/// Never switches to another character on its own (spec「Duix 不可用」).
class AppShell extends StatefulWidget {
  const AppShell({
    super.key,
    required this.identity,
    required this.catalog,
    required this.companion,
    required this.avatarBuilder,
    this.holds,
    this.engines,
    this.memory,
  });

  final DeviceIdentity identity;
  final CharacterCatalog catalog;
  final Widget Function(AvatarPageRequest request) avatarBuilder;

  /// Rejection copy and the disabled-character hold (assets/config/companion.json).
  final CompanionConfig companion;

  /// Persistent holds for disabled characters; null keeps them for this run only.
  final CharacterHolds? holds;

  /// Null = 3D only (tests and builds without Duix): Duix characters are hidden.
  final EngineSwitchController? engines;

  /// Settings reads and deletes memory through it; null hides the memory blocks.
  final MemoryApi? memory;

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

  /// A memory write ended the gateway session; keep no chat page under settings until it closes.
  bool _suspended = false;

  /// True between pushing the settings route and its pop starting. The route's Future resolves
  /// at pop start, while the settings page stays mounted for the close animation.
  bool _settingsOpen = false;

  late final CharacterHolds _holds = widget.holds ?? CharacterHolds(MemoryCredentialStore());

  /// The gateway refused this owner; show the notice instead of the chat.
  bool _banned = false;

  /// Latest diag code from the chat page, read when settings opens.
  String? _diagCode;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  CharacterAvailability _availabilityOf(CharacterOption option) {
    if (_holds.isHeld(option.id)) return Unavailable(widget.companion.characterDisabledNote);
    return widget.engines?.availabilityFor(option) ??
        (option.engine == AvatarEngineKind.webview ? const Available() : const Hidden());
  }

  Future<void> _load() async {
    String? character;
    String? error;
    try {
      character = await widget.identity.savedCharacter();
    } on Exception {
      error = identityErrorText('storage');
    }
    await widget.engines?.load(); // never throws: failures read as hidden or unsupported
    await _holds.load(widget.catalog.options.map((option) => option.id)); // never throws
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
  String? _blockedReason(CharacterOption option) {
    if (_holds.isHeld(option.id)) return widget.companion.disabledReasonFor(option.title);
    return switch (_availabilityOf(option)) {
      Available() || Checking() || Preparing() => null,
      Unavailable() || PrepareFailed() || Hidden() => savedUnavailableText(option.title),
    };
  }

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
    _settingsOpen = true;
    final saved = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder: (_) => CompanionSettingsPage(
          options: widget.catalog.options,
          currentCharacter: current,
          onSaveCharacter: _saveFromSettings,
          availabilityOf: _availabilityOf,
          availabilityChanges: widget.engines,
          memory: widget.memory,
          onMemoryChanged: _onMemoryChanged,
          diagCode: _diagCode,
          companion: widget.companion,
        ),
      ),
    );
    // The push Future completes when the pop starts, not when the close animation ends.
    _settingsOpen = false;
    if (!mounted) return;
    setState(() {
      if (saved != null && saved != _character) {
        _character = saved;
        _pageEpoch++;
      }
      _suspended = false; // the new epoch (bumped on the memory change) starts a fresh session
    });
  }

  void _onMemoryChanged() {
    // A write that lands while the settings route closes must not strand the chat: the last
    // epoch (or the current page) stays and the gateway client reconnects by itself.
    if (!mounted || !_settingsOpen || _suspended) return;
    setState(() {
      _suspended = true;
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

  Future<void> _onSessionRejected(CharacterOption option, SessionRejection rejection) async {
    switch (rejection) {
      case SessionRejection.ownerBanned:
        if (mounted) setState(() => _banned = true);
      case SessionRejection.characterDisabled:
        await _holds.hold(option.id, widget.companion.characterDisabledHold);
        if (mounted) setState(() => _pickerReason = widget.companion.disabledReasonFor(option.title));
    }
  }

  void _retryAfterBan() => setState(() {
    _banned = false;
    _pageEpoch++;
  });

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
    if (_banned) return _BannedNotice(text: widget.companion.ownerBannedText, onRetry: _retryAfterBan);
    final reason = _pickerReason;
    if (reason != null) return _picker(character.id, reason);
    return _home(character);
  }

  Widget _home(CharacterOption character) => Stack(
    children: [
      Positioned.fill(
        child: _suspended
            ? const ColoredBox(color: Color(0xFF10131A))
            : widget.avatarBuilder(
                AvatarPageRequest(
                  key: ValueKey('avatar-${character.id}-$_pageEpoch'),
                  identity: widget.identity,
                  character: character,
                  engine: character.engine,
                  onEngineFailure: character.engine == AvatarEngineKind.duix
                      ? (failure) => _onEngineFailure(character, failure)
                      : null,
                  onUnknownCharacter: _onUnknownCharacter,
                  onSessionRejected: (rejection) => unawaited(_onSessionRejected(character, rejection)),
                  onDiagCode: (code) => _diagCode = code,
                  onChangePartner: _openSettings,
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

/// Shown after owner_banned: no chat, no settings, one plain retry.
class _BannedNotice extends StatelessWidget {
  const _BannedNotice({required this.text, required this.onRetry});

  final String text;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: const Color(0xFF10131A),
    body: SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              text,
              key: const Key('banned-notice'),
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white, fontSize: 26, height: 1.5),
            ),
            const SizedBox(height: 40),
            SizedBox(
              height: 64,
              child: FilledButton(
                key: const Key('banned-retry'),
                onPressed: onRetry,
                child: const Text('再试一次', style: TextStyle(fontSize: 22)),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
