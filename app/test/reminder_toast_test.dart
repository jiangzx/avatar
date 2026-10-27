import 'package:avatar_app/native_session/events.dart';
import 'package:avatar_app/reminder_toast.dart';
import 'package:flutter_test/flutter_test.dart';

const reminderLine = '咱们聊了一个钟头了，要不要起来活动活动、喝口水？我在这儿等您。';

void main() {
  testWidgets('shows the reminder subtitle for restToastMs after its last update, then hides', (tester) async {
    final toast = ReminderToast(showFor: const Duration(milliseconds: 6000));
    var notified = 0;
    toast.addListener(() => notified++);
    toast.onEvent(const UiResponseStart(responseSeq: 7, kind: 'reminder'));
    expect(toast.text, isNull);
    toast.onEvent(const UiSubtitle(role: 'assistant', text: '咱们聊了', isFinal: false, responseSeq: 7));
    expect(toast.text, '咱们聊了');
    await tester.pump(const Duration(milliseconds: 3000));
    toast.onEvent(const UiSubtitle(role: 'assistant', text: reminderLine, isFinal: false, responseSeq: 7));
    expect(toast.text, reminderLine);
    await tester.pump(const Duration(milliseconds: 5999));
    expect(toast.text, reminderLine);
    await tester.pump(const Duration(milliseconds: 2));
    expect(toast.text, isNull);
    expect(notified, 3);
    toast.dispose();
  });

  testWidgets('ignores replies, other sequences, user lines and filler lines', (tester) async {
    final toast = ReminderToast(showFor: const Duration(milliseconds: 6000));
    toast.onEvent(const UiResponseStart(responseSeq: 3, kind: 'reply'));
    toast.onEvent(const UiSubtitle(role: 'assistant', text: '好的', isFinal: false, responseSeq: 3));
    toast.onEvent(const UiResponseStart(responseSeq: 4, kind: 'reminder'));
    toast.onEvent(const UiSubtitle(role: 'assistant', text: '上一句的尾巴', isFinal: false, responseSeq: 3));
    toast.onEvent(const UiSubtitle(role: 'user', text: '嗯', isFinal: true));
    toast.onEvent(const UiSubtitle(role: 'assistant', text: '嗯，我想想。', isFinal: false)); // filler: no seq
    toast.onEvent(const UiSubtitle(role: 'assistant', text: '', isFinal: false, responseSeq: 4));
    expect(toast.text, isNull);
    toast.dispose();
  });

  testWidgets('a reply after the reminder stops updates; the toast still times out', (tester) async {
    final toast = ReminderToast(showFor: const Duration(milliseconds: 6000));
    toast.onEvent(const UiResponseStart(responseSeq: 5, kind: 'reminder'));
    toast.onEvent(const UiSubtitle(role: 'assistant', text: '咱们聊了', isFinal: false, responseSeq: 5));
    toast.onEvent(const UiResponseStart(responseSeq: 6, kind: 'reply'));
    toast.onEvent(const UiSubtitle(role: 'assistant', text: '咱们聊了一个钟头了', isFinal: false, responseSeq: 5));
    expect(toast.text, '咱们聊了');
    await tester.pump(const Duration(milliseconds: 6001));
    expect(toast.text, isNull);
    toast.dispose();
  });

  testWidgets('dispose cancels a pending toast', (tester) async {
    final toast = ReminderToast(showFor: const Duration(milliseconds: 6000));
    toast.onEvent(const UiResponseStart(responseSeq: 8, kind: 'reminder'));
    toast.onEvent(const UiSubtitle(role: 'assistant', text: reminderLine, isFinal: false, responseSeq: 8));
    toast.dispose();
    await tester.pump(const Duration(seconds: 7)); // no callback after dispose, no pending timer
  });
}
