import 'package:flutter/material.dart';

import '../avatar_engine.dart';
import 'engine_copy.dart';

/// Large two-button confirm (title 24 sp, body and buttons 20 sp, 60 dp buttons). True = [ok].
Future<bool> confirmLarge(
  BuildContext context, {
  String? title,
  required String body,
  required String cancel,
  required String ok,
  Key cancelKey = const Key('confirm-cancel'),
  Key okKey = const Key('confirm-ok'),
}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (dialog) => AlertDialog(
      title: title == null ? null : Text(title, style: const TextStyle(fontSize: 24)),
      content: Text(body, style: const TextStyle(fontSize: 20)),
      actions: [
        SizedBox(
          height: 60,
          child: TextButton(
            key: cancelKey,
            onPressed: () => Navigator.of(dialog).pop(false),
            child: Text(cancel, style: const TextStyle(fontSize: 20)),
          ),
        ),
        SizedBox(
          height: 60,
          child: FilledButton(
            key: okKey,
            onPressed: () => Navigator.of(dialog).pop(true),
            child: Text(ok, style: const TextStyle(fontSize: 20)),
          ),
        ),
      ],
    ),
  );
  return result ?? false;
}

/// Switching ends the current chat, so it always asks first. True = switch now.
Future<bool> confirmEngineSwitch(BuildContext context, AvatarEngineKind target) => confirmLarge(
  context,
  title: confirmTitle(target),
  body: confirmBody,
  cancel: confirmCancel,
  ok: confirmOk,
  cancelKey: const Key('engine-confirm-cancel'),
  okKey: const Key('engine-confirm-ok'),
);
