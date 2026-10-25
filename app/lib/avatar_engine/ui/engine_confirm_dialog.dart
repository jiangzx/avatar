import 'package:flutter/material.dart';

import '../avatar_engine.dart';
import 'engine_copy.dart';

/// Switching ends the current chat, so it always asks first. True = switch now.
Future<bool> confirmEngineSwitch(BuildContext context, AvatarEngineKind target) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (dialog) => AlertDialog(
      title: Text(confirmTitle(target), style: const TextStyle(fontSize: 24)),
      content: const Text(confirmBody, style: TextStyle(fontSize: 20)),
      actions: [
        SizedBox(
          height: 60,
          child: TextButton(
            key: const Key('engine-confirm-cancel'),
            onPressed: () => Navigator.of(dialog).pop(false),
            child: const Text(confirmCancel, style: TextStyle(fontSize: 20)),
          ),
        ),
        SizedBox(
          height: 60,
          child: FilledButton(
            key: const Key('engine-confirm-ok'),
            onPressed: () => Navigator.of(dialog).pop(true),
            child: const Text(confirmOk, style: TextStyle(fontSize: 20)),
          ),
        ),
      ],
    ),
  );
  return ok ?? false;
}
