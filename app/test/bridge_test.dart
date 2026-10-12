import 'package:avatar_app/bridge.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('parses every JS event type', () {
    expect(JsEvent.parse('{"type":"ready"}'), isA<JsReady>());
    final sub = JsEvent.parse('{"type":"subtitle","role":"assistant","text":"你好","final":false}') as JsSubtitle;
    expect((sub.role, sub.text, sub.isFinal), ('assistant', '你好', false));
    expect((JsEvent.parse('{"type":"state","state":"speaking"}') as JsState).state, 'speaking');
    final m = JsEvent.parse('{"type":"metric","name":"greeting_ms","ms":812}') as JsMetric;
    expect((m.name, m.ms), ('greeting_ms', 812.0));
    expect((JsEvent.parse('{"type":"status","status":"open"}') as JsStatus).status, 'open');
    final d = JsEvent.parse('{"type":"diag","key":"mic_settings","value":"{}"}') as JsDiag;
    expect((d.key, d.value), ('mic_settings', '{}'));
    expect((JsEvent.parse('{"type":"error","code":"NotAllowedError"}') as JsError).code, 'NotAllowedError');
  });

  test('rejects malformed or unknown messages', () {
    expect(JsEvent.parse('not json'), isNull);
    expect(JsEvent.parse('[]'), isNull);
    expect(JsEvent.parse('{"type":"subtitle","role":"x","text":1}'), isNull);
    expect(JsEvent.parse('{"type":"metric","name":"a","ms":"fast"}'), isNull);
    expect(JsEvent.parse('{"type":"other"}'), isNull);
  });

  test('builds a safe JS call', () {
    final js = jsCall({'type': 'debugText', 'text': '"); alert(1); ("'});
    expect(js, r'window.avatarBridge && window.avatarBridge.receive({"type":"debugText","text":"\"); alert(1); (\""});');
  });
}
