import 'dart:async';

import 'package:flutter/material.dart';

import '../avatar_engine/avatar_engine.dart';
import '../avatar_engine/engine_switch_controller.dart';
import '../avatar_engine/ui/duix_download_sheet.dart';
import '../avatar_engine/ui/engine_confirm_dialog.dart';
import '../avatar_engine/ui/engine_copy.dart';
import '../avatar_engine/ui/engine_switch.dart';
import '../native_gateway/gateway_client.dart';
import 'avatar_picker_page.dart';
import 'avatars.dart';
import 'companion_settings_page.dart';
import 'device_identity.dart';
import 'style_picker_page.dart';
import 'styles.dart';

/// What the shell asks the avatar builder for. A new [key] means a fresh page and session.
class AvatarPageRequest {
  const AvatarPageRequest({
    required this.key,
    required this.identity,
    required this.avatarId,
    required this.engine,
    this.onEngineFailure,
  });

  final Key key;
  final DeviceTokenProvider identity;
  final String avatarId;
  final AvatarEngineKind engine;

  /// Set for Duix pages: a failure falls back to the 3D avatar for this session.
  final void Function(AvatarEngineFailure failure)? onEngineFailure;
}

/// First launch: style picker + registration. Afterwards: the avatar with a settings button on top.
class AppShell extends StatefulWidget {
  const AppShell({
    super.key,
    required this.identity,
    required this.avatarBuilder,
    this.engines,
  });

  final DeviceIdentity identity;
  final Widget Function(AvatarPageRequest request) avatarBuilder;

  /// Null = 3D only (tests and builds without the engine switch).
  final EngineSwitchController? engines;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  bool _loading = true;
  String? _style;
  String? _avatar;
  bool _busy = false;
  String? _error;
  bool _sheetOpen = false;

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
        if (_sheetOpen) return; // the sheet already shows the ready state
        messenger.showSnackBar(
          SnackBar(
            content: const Text(duixReadyText, style: TextStyle(fontSize: 18)),
            duration: const Duration(seconds: 8),
            action: SnackBarAction(
              label: duixReadyAction,
              onPressed: () => unawaited(_switchTo(AvatarEngineKind.duix)),
            ),
          ),
        );
    }
  }

  static SnackBar _snack(String text) => SnackBar(content: Text(text, style: const TextStyle(fontSize: 18)));

  Future<void> _onEngineTap(AvatarEngineKind kind) async {
    final engines = widget.engines;
    if (engines == null || kind == engines.sessionEngine) return;
    if (kind == AvatarEngineKind.duix) {
      switch (engines.availability) {
        case DuixAvailability.unsupported:
          ScaffoldMessenger.of(context).showSnackBar(_snack(unsupportedText(engines.unsupportedReason)));
          return;
        case DuixAvailability.needsDownload || DuixAvailability.downloading:
          final installer = engines.installer;
          if (installer == null) return;
          _sheetOpen = true;
          final switchNow = await showDuixDownloadSheet(context, installer);
          _sheetOpen = false;
          if (switchNow && mounted) await engines.choose(AvatarEngineKind.duix);
          return;
        case DuixAvailability.ready:
          break;
        case DuixAvailability.checking || DuixAvailability.hidden:
          return;
      }
    }
    await _switchTo(kind);
  }

  /// Asks first: switching ends the current chat and starts a fresh one.
  Future<void> _switchTo(AvatarEngineKind kind) async {
    final engines = widget.engines;
    if (engines == null || !mounted || kind == engines.sessionEngine) return;
    if (!await confirmEngineSwitch(context, kind)) return;
    await engines.choose(kind);
  }

  Future<void> _load() async {
    String? style;
    String? avatar;
    String? error;
    try {
      style = await widget.identity.savedStyle();
      avatar = await widget.identity.savedAvatar();
    } on Exception {
      error = identityErrorText('storage');
    }
    await widget.engines?.load(); // never throws: failures read as "Duix hidden or unsupported"
    if (!mounted) return;
    setState(() {
      _style = style;
      _avatar = avatar;
      _error = error;
      _loading = false;
    });
  }

  Future<void> _chooseFirstAvatar(String avatar) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final result = await widget.identity.changeAvatar(avatar);
    if (!mounted) return;
    setState(() {
      _busy = false;
      switch (result) {
        case IdentityOk():
          _avatar = avatar;
        case IdentityFailed(:final reason):
          _error = identityErrorText(reason);
      }
    });
  }

  Future<void> _chooseFirst(String style) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final result = await widget.identity.chooseFirstStyle(style);
    if (!mounted) return;
    setState(() {
      _busy = false;
      switch (result) {
        case IdentityOk():
          _style = style;
        case IdentityFailed(:final reason):
          _error = identityErrorText(reason);
      }
    });
  }

  Future<void> _openSettings() async {
    final current = _style;
    if (current == null) return;
    final avatar = _avatar;
    if (avatar == null) return;
    final saved = await Navigator.of(context).push<CompanionSelection>(
      MaterialPageRoute(
        builder: (_) => CompanionSettingsPage(
          currentStyle: current,
          currentAvatar: avatar,
          onSaveStyle: widget.identity.changeStyle,
          onSaveAvatar: widget.identity.changeAvatar,
        ),
      ),
    );
    if (!mounted || saved == null) return;
    setState(() {
      _style = saved.style;
      _avatar = saved.avatar;
    });
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('已换好，下次聊天时生效', style: TextStyle(fontSize: 18)),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(
        backgroundColor: Color(0xFF10131A),
        body: Center(child: CircularProgressIndicator()),
      );
    }
    if (_style == null) {
      return StylePickerPage(
        title: '选一位陪您聊天的伙伴',
        confirmLabel: '就选这个',
        initial: defaultStyleId,
        busy: _busy,
        error: _error,
        onConfirm: _chooseFirst,
      );
    }
    if (_avatar == null) {
      return AvatarPickerPage(
        title: '选一个聊天形象',
        confirmLabel: '开始聊天',
        initial: defaultAvatarId,
        busy: _busy,
        error: _error,
        onConfirm: _chooseFirstAvatar,
      );
    }
    final engines = widget.engines;
    if (engines == null) return _home(AvatarEngineKind.webview, 0, null);
    return ListenableBuilder(
      listenable: engines,
      builder: (context, _) => _home(engines.sessionEngine, engines.pageEpoch, engines),
    );
  }

  static bool _offersSwitch(DuixAvailability availability) =>
      availability != DuixAvailability.hidden && availability != DuixAvailability.checking;

  Widget _home(AvatarEngineKind engine, int epoch, EngineSwitchController? engines) {
    return Stack(
      children: [
        Positioned.fill(
          child: widget.avatarBuilder(
            AvatarPageRequest(
              key: ValueKey('avatar-${engine.name}-$epoch'),
              identity: widget.identity,
              avatarId: _avatar!,
              engine: engine,
              onEngineFailure: engine == AvatarEngineKind.duix ? engines?.reportDuixFailure : null,
            ),
          ),
        ),
        if (engines != null && _offersSwitch(engines.availability))
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.only(top: 60),
                child: Center(
                  child: EngineSwitch(
                    selected: engine,
                    duix: engines.availability,
                    downloadFraction: engines.downloadFraction,
                    onTap: (kind) => unawaited(_onEngineTap(kind)),
                  ),
                ),
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
