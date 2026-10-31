import 'package:flutter/material.dart';

/// Copy for the end-chat confirmation (large type for the elder UI).
const endChatTitle = '要结束这次聊天吗？';
const endChatBody = '结束以后，想聊随时可以接着聊。';
const endChatContinue = '继续聊天';
const endChatEnd = '结束聊天';

/// True = end the chat. Barrier tap and system back return false (keep chatting).
Future<bool> confirmEndChat(BuildContext context) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (dialog) => AlertDialog(
      title: Text(endChatTitle, style: const TextStyle(fontSize: 24)),
      content: Text(endChatBody, style: const TextStyle(fontSize: 20)),
      actions: [
        SizedBox(
          height: 60,
          child: TextButton(
            key: const Key('end-confirm-end'),
            onPressed: () => Navigator.of(dialog).pop(true),
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(dialog).colorScheme.error,
            ),
            child: const Text(endChatEnd, style: TextStyle(fontSize: 20)),
          ),
        ),
        SizedBox(
          height: 60,
          child: FilledButton(
            key: const Key('end-confirm-continue'),
            onPressed: () => Navigator.of(dialog).pop(false),
            child: const Text(endChatContinue, style: TextStyle(fontSize: 20)),
          ),
        ),
      ],
    ),
  );
  // Null means barrier tap or system back: the safe outcome is to keep chatting.
  return result ?? false;
}
