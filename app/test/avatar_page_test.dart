import 'package:avatar_app/avatar_page.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a later open status clears a transient error', () {
    expect(errorAfterStatus('出错了：http_503', 'open'), isNull);
    expect(errorAfterStatus('出错了：http_503', 'reconnecting'), '出错了：http_503');
    expect(errorAfterStatus(null, 'connecting'), isNull);
  });

  test('shows an ellipsis while thinking and clears it when idle', () {
    expect(aiLineAfterState('thinking', '上一句'), '…');
    expect(aiLineAfterState('speaking', '…'), '…');
    expect(aiLineAfterState('idle', '…'), '');
    expect(aiLineAfterState('idle', '好的'), '好的');
  });

  test('hides textual tool calls and code prefixes from assistant subtitles', () {
    expect(visibleAssistantLine('[call]\nset_memory_consent({"granted":"granted","confirmed":true})'), '');
    expect(visibleAssistantLine('  {"query":"上次聊了什么"}'), '');
    expect(visibleAssistantLine('```json\n{"a":1}\n```'), '');
    expect(visibleAssistantLine('您好呀，又见面了。'), '您好呀，又见面了。');
    expect(visibleAssistantLine('我想聊聊[电影]。'), '我想聊聊[电影]。');
    expect(visibleAssistantLine('您好呀。\n[call] set_memory_consent({})'), '您好呀。');
  });
}
