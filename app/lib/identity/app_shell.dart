import 'dart:async';

import 'package:flutter/material.dart';

import '../native_gateway/gateway_client.dart';
import 'device_identity.dart';
import 'style_picker_page.dart';
import 'styles.dart';

/// First launch: style picker + registration. Afterwards: the avatar with a settings button on top.
class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.identity, required this.avatarBuilder});

  final DeviceIdentity identity;
  final Widget Function(DeviceTokenProvider identity) avatarBuilder;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  bool _loading = true;
  String? _style;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    String? style;
    String? error;
    try {
      style = await widget.identity.savedStyle();
    } on Exception {
      error = identityErrorText('storage');
    }
    if (!mounted) return;
    setState(() {
      _style = style;
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
    final saved = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => StyleSettingsPage(identity: widget.identity, current: current)),
    );
    if (!mounted || saved == null) return;
    setState(() => _style = saved);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('已换好，下次聊天时生效', style: TextStyle(fontSize: 18))),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(backgroundColor: Color(0xFF10131A), body: Center(child: CircularProgressIndicator()));
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
    return Stack(
      children: [
        Positioned.fill(child: widget.avatarBuilder(widget.identity)),
        // Bottom-right, clear of the centered mute/end buttons in AvatarOverlay.
        Positioned(right: 16, bottom: 28, child: SafeArea(child: _SettingsButton(onTap: _openSettings))),
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
        child: const SizedBox(width: 64, height: 64, child: Icon(Icons.tune, color: Colors.white, size: 32)),
      ),
    ),
  );
}
