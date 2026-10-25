import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_events.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/duix_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const methods = MethodChannel('anyidea/duix');
  const events = EventChannel('anyidea/duix/events');
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late List<MethodCall> calls;

  void reply(Object? Function(MethodCall call) handler) {
    calls = [];
    messenger.setMockMethodCallHandler(methods, (call) async {
      calls.add(call);
      return handler(call);
    });
  }

  tearDown(() {
    messenger.setMockMethodCallHandler(methods, null);
    messenger.setMockStreamHandler(events, null);
  });

  test('probe maps results and errors', () async {
    final bridge = MethodChannelDuixBridge();
    reply((_) => {'supported': true, 'reason': null});
    expect((await bridge.probe(minTotalMemMb: 7000)).supported, isTrue);
    expect(calls.single.arguments, {'minTotalMemMb': 7000});
    reply((_) => throw PlatformException(code: 'library_missing'));
    final missing = await bridge.probe(minTotalMemMb: 7000);
    expect((missing.supported, missing.reason), (false, 'library_missing'));
  });

  test('a missing plugin reads as library_missing', () async {
    messenger.setMockMethodCallHandler(methods, null);
    final support = await MethodChannelDuixBridge().probe(minTotalMemMb: 7000);
    expect(support.reason, 'library_missing');
  });

  test('install calls carry the asset and map error codes', () async {
    final cfg = loadTestDuixConfig();
    final bridge = MethodChannelDuixBridge();
    reply((call) => call.method == 'installStatus' ? {'gj_dh_res': true, 'lily': false} : null);
    expect(await bridge.installStatus(cfg.assets), {'gj_dh_res': true, 'lily': false});
    expect(calls.single.arguments, {
      'assets': [
        {'id': 'gj_dh_res', 'dir': 'gj_dh_res', 'sha256': cfg.base.sha256},
        {'id': 'lily', 'dir': 'Lily', 'sha256': cfg.model.sha256},
      ],
    });
    await bridge.install(cfg.model);
    expect(calls.last.arguments, cfg.model.toArgs());
    reply((_) => throw PlatformException(code: 'sha_mismatch'));
    await expectLater(bridge.install(cfg.model), throwsA(isA<DuixBridgeError>().having((e) => e.code, 'code', 'sha_mismatch')));
  });

  test('prepare sends runtime settings and parses the reply', () async {
    final cfg = loadTestDuixConfig();
    final bridge = MethodChannelDuixBridge();
    reply((_) => {'width': 540, 'height': 960, 'motions': ['wave', 7]});
    final prepared = await bridge.prepare(cfg);
    expect((prepared.width, prepared.height), (540, 960));
    expect(prepared.motions, ['wave']);
    expect(calls.single.arguments, {
      'modelDir': 'Lily',
      'minSegmentMs': 1000,
      'lipReadyTimeoutMs': 1500,
      'statsIntervalMs': 5000,
      'prepareTimeoutMs': 60000,
    });
    reply((_) => {'width': 'x'});
    await expectLater(bridge.prepare(cfg), throwsA(isA<DuixBridgeError>().having((e) => e.code, 'code', 'bad_reply')));
  });

  test('audio calls carry both PCM copies; stop returns seq and playedMs', () async {
    final bridge = MethodChannelDuixBridge();
    reply((call) => call.method == 'stopResponse' ? {'seq': 4, 'playedMs': 830} : null);
    await bridge.startResponse(4);
    await bridge.push(4, Uint8List(2), Uint8List(3));
    await bridge.endResponse(4);
    final stopped = await bridge.stopResponse();
    expect((stopped.seq, stopped.playedMs), (4, 830));
    expect(calls.map((c) => c.method), ['startResponse', 'push', 'endResponse', 'stopResponse']);
    expect(calls[1].arguments, {'seq': 4, 'pcm16': Uint8List(2), 'pcm24': Uint8List(3)});
  });

  test('events are parsed and malformed ones dropped', () async {
    messenger.setMockStreamHandler(
      events,
      MockStreamHandler.inline(onListen: (_, sink) {
        sink.success({'type': 'nope'});
        sink.success({'type': 'playEnd', 'seq': 2, 'playedMs': 10});
        sink.endOfStream();
      }),
    );
    final got = await MethodChannelDuixBridge().events.toList();
    expect(got.single, isA<DuixPlayEnd>());
  });
}
