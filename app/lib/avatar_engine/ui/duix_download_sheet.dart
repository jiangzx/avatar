import 'dart:async';

import 'package:flutter/material.dart';

import '../../duix/duix_installer.dart';
import 'engine_copy.dart';

/// Bottom sheet for the first Duix download. True = the user chose to switch now.
/// The sheet can be dismissed; the download keeps going and 3D keeps chatting.
Future<bool> showDuixDownloadSheet(BuildContext context, DuixInstaller installer) async {
  final result = await showModalBottomSheet<bool>(
    context: context,
    showDragHandle: true,
    backgroundColor: const Color(0xFF1B2029),
    builder: (_) => DuixDownloadSheet(installer: installer),
  );
  return result ?? false;
}

class DuixDownloadSheet extends StatelessWidget {
  const DuixDownloadSheet({super.key, required this.installer});

  final DuixInstaller installer;

  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
      child: ListenableBuilder(
        listenable: installer,
        builder: (context, _) => Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: _content(context, installer.state),
        ),
      ),
    ),
  );

  List<Widget> _content(BuildContext context, DuixInstallState state) {
    final total = installer.config.totalBytes;
    void close(bool switchNow) => Navigator.of(context).pop(switchNow);
    return switch (state) {
      InstallIdle() => [
        _title(downloadTitle),
        _body(downloadBody(total)),
        _primary('duix-download-start', downloadStart, () => unawaited(installer.start())),
        _secondary('duix-download-later', downloadLater, () => close(false)),
      ],
      InstallDownloading(:final received, :final fraction) => [
        _title(downloadTitle),
        LinearProgressIndicator(value: fraction, minHeight: 8),
        const SizedBox(height: 12),
        _body(downloadProgress(received, total)),
        _secondary('duix-download-cancel', downloadCancel, () => unawaited(installer.cancel())),
      ],
      InstallPreparing() => [
        _title(downloadTitle),
        const LinearProgressIndicator(minHeight: 8),
        const SizedBox(height: 12),
        _body(downloadPreparing),
      ],
      InstallFailed(:final code) => [
        _title(downloadTitle),
        _body(downloadFailed(code)),
        _primary('duix-download-retry', downloadRetry, () => unawaited(installer.start())),
        _secondary('duix-download-later', downloadLater, () => close(false)),
      ],
      InstallReady() => [
        _title(duixReadyText),
        _primary('duix-switch-now', readySwitchNow, () => close(true)),
        _secondary('duix-switch-later', readyLater, () => close(false)),
      ],
    };
  }

  static Widget _title(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Text(text, style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.bold)),
  );

  static Widget _body(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 20),
    child: Text(text, style: const TextStyle(color: Colors.white70, fontSize: 20)),
  );

  static Widget _primary(String key, String label, VoidCallback onTap) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: SizedBox(
      height: 60,
      child: FilledButton(key: Key(key), onPressed: onTap, child: Text(label, style: const TextStyle(fontSize: 20))),
    ),
  );

  static Widget _secondary(String key, String label, VoidCallback onTap) => SizedBox(
    height: 60,
    child: TextButton(key: Key(key), onPressed: onTap, child: Text(label, style: const TextStyle(fontSize: 20))),
  );
}
