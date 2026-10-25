import 'dart:async';

import 'package:flutter/material.dart';

import '../avatar_engine/avatar_engine.dart';
import '../avatar_engine/engine_switch_controller.dart';
import '../avatar_engine/ui/engine_copy.dart';
import '../duix/duix_installer.dart';
import '../native_gateway/gateway_client.dart';
import 'characters.dart';
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
    final saved = await Navigator.of(context).push<CompanionSelection>(
      MaterialPageRoute(
        builder: (_) => CompanionSettingsPage(
          currentStyle: current,
          currentAvatar: activeCharacter(_avatar),
          onSaveStyle: widget.identity.changeStyle,
          onSaveAvatar: (next) async {
            final engines = widget.engines;
            if (next == characterLily && (engines == null || engines.availability == DuixAvailability.unsupported)) {
              return IdentityFailed(engines?.unsupportedReason ?? 'duix_unsupported');
            }
            return widget.identity.changeAvatar(next);
          },
        ),
      ),
    );
    if (!mounted || saved == null) return;
    final styleChanged = saved.style != _style;
    final avatarChanged = saved.avatar != activeCharacter(_avatar);
    if (!styleChanged && !avatarChanged) return;
    setState(() {
      _style = saved.style;
      _avatar = saved.avatar;
    });
    final engines = widget.engines;
    final target = engineForCharacter(saved.avatar);
    if (engines != null && target != engines.sessionEngine) {
      await engines.choose(target);
      if (mounted && target == AvatarEngineKind.duix && engines.sessionEngine != AvatarEngineKind.duix) {
        final state = engines.installer?.state;
        final code = state is InstallFailed ? state.code : null;
        ScaffoldMessenger.of(context).showSnackBar(_snack(unsupportedText(
          code == 'abi_unsupported' || code == 'low_memory' || code == 'storage_unavailable' ? code : null,
        )));
      }
    }
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
    final engines = widget.engines;
    if (engines == null) return _home(AvatarEngineKind.webview, 0, null);
    return ListenableBuilder(
      listenable: engines,
      builder: (context, _) => _home(engines.sessionEngine, engines.pageEpoch, engines),
    );
  }

  Widget _home(AvatarEngineKind engine, int epoch, EngineSwitchController? engines) {
    final shown = engine == AvatarEngineKind.duix ? characterLily : characterXiaorou;
    return Stack(
      children: [
        Positioned.fill(
          child: widget.avatarBuilder(
            AvatarPageRequest(
              key: ValueKey('avatar-${engine.name}-$shown-${_style ?? ''}-$epoch'),
              identity: widget.identity,
              avatarId: shown,
              engine: engine,
              onEngineFailure: engine == AvatarEngineKind.duix ? engines?.reportDuixFailure : null,
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
