# Task 6: Dart 侧配置、事件与通道桥

**Files:**
- Create: `app/assets/config/duix.json`
- Create: `app/lib/duix/duix_config.dart`
- Create: `app/lib/duix/duix_events.dart`
- Create: `app/lib/duix/duix_bridge.dart`
- Create: `app/test/support/duix_fakes.dart`
- Create: `app/test/duix_config_test.dart`
- Create: `app/test/duix_events_test.dart`
- Create: `app/test/duix_bridge_test.dart`

**Interfaces:**
- Consumes：spec §4.4 的通道契约（Kotlin 侧由 Task 2、3、5 实现）。
- Produces:
  - `DuixAsset {id, dir, url, sha256, bytes}`，带 `toArgs()`；
  - `DuixConfig`（字段见 spec §7），提供 `model`、`assets`（按安装顺序：基础包在前，模型在后）、`totalBytes`，以及 `DuixConfig.parse(String)`、`DuixConfig.assetPath`；
  - `DuixEvent` 及其子类和 `parseDuixEvent(Object?)`；
  - `DuixBridge`、`MethodChannelDuixBridge`、`DuixSupport`、`DuixPrepared`、`DuixStopped`、`DuixBridgeError`；
  - 测试替身 `FakeDuixBridge` 和 `loadTestDuixConfig()`。

`pubspec.yaml` 已经把 `assets/config/` 整个目录列为资源，不需要改。

- [x] **Step 1: 写配置文件**

`app/assets/config/duix.json`：

```json
{
  "enabled": true,
  "debugOnly": false,
  "minTotalMemMb": 7000,
  "maxUncleanExits": 2,
  "base": {
    "id": "gj_dh_res",
    "dir": "gj_dh_res",
    "url": "https://github.com/duixcom/Duix-Mobile/releases/download/v1.0.0/gj_dh_res.zip",
    "sha256": "c3ffeca1cb250f111f70e9e221d9115c9a825a625eff9b93d260ef7da70a5457",
    "bytes": 139403482
  },
  "models": [
    {
      "id": "lily",
      "dir": "Lily",
      "url": "https://github.com/duixcom/Duix-Mobile/releases/download/v2.0.1/Lily.zip",
      "sha256": "9ec390b42b02594470dad69d87841ebbbdfbc0b22803c60092aba8cd9c5a556b",
      "bytes": 35062448
    }
  ],
  "defaultModel": "lily",
  "playback": { "minSegmentMs": 1000, "lipReadyTimeoutMs": 1500, "prepareTimeoutMs": 60000 },
  "vad": { "bargeInThresholdRms": 200, "bargeInGraceMs": 400 },
  "statsIntervalMs": 5000
}
```

- [x] **Step 2: 写测试替身**

`app/test/support/duix_fakes.dart`：

```dart
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_config.dart';
import 'package:avatar_app/duix/duix_events.dart';

/// The real assets/config/duix.json with optional top-level overrides (flutter test runs in app/).
DuixConfig loadTestDuixConfig([Map<String, Object?> overrides = const {}]) {
  final raw = jsonDecode(File('assets/config/duix.json').readAsStringSync()) as Map<String, Object?>;
  return DuixConfig.parse(jsonEncode({...raw, ...overrides}));
}

/// Scripted DuixBridge. `calls` records every control call in order.
class FakeDuixBridge implements DuixBridge {
  FakeDuixBridge({this.support = const DuixSupport(supported: true), Map<String, bool>? installed})
    : installed = {...?installed};

  DuixSupport support;
  final Map<String, bool> installed;
  final calls = <String>[];
  final pushes = <(int, int, int)>[]; // seq, pcm16 bytes, pcm24 bytes
  final installErrors = <String, DuixBridgeError>{};
  DuixBridgeError? prepareError;
  DuixBridgeError? stopError;
  DuixPrepared prepared = const DuixPrepared(width: 540, height: 960, motions: []);
  Completer<void>? installGate;
  DuixStopped stopResult = const DuixStopped(seq: 0, playedMs: 0);
  final _events = StreamController<DuixEvent>.broadcast(sync: true);

  void emit(DuixEvent event) => _events.add(event);

  @override
  Stream<DuixEvent> get events => _events.stream;

  @override
  Future<DuixSupport> probe({required int minTotalMemMb}) async {
    calls.add('probe:$minTotalMemMb');
    return support;
  }

  @override
  Future<Map<String, bool>> installStatus(List<DuixAsset> assets) async {
    calls.add('installStatus');
    return {for (final a in assets) a.id: installed[a.id] ?? false};
  }

  @override
  Future<void> install(DuixAsset asset) async {
    calls.add('install:${asset.id}');
    final gate = installGate;
    if (gate != null) await gate.future;
    final error = installErrors[asset.id];
    if (error != null) throw error;
    installed[asset.id] = true;
  }

  @override
  Future<void> cancelInstall(String id) async => calls.add('cancel:$id');

  @override
  Future<DuixPrepared> prepare(DuixConfig config) async {
    calls.add('prepare:${config.model.dir}');
    final error = prepareError;
    if (error != null) throw error;
    return prepared;
  }

  @override
  Future<void> startResponse(int seq) async => calls.add('start:$seq');

  @override
  Future<void> push(int seq, Uint8List pcm16, Uint8List pcm24) async => pushes.add((seq, pcm16.length, pcm24.length));

  @override
  Future<void> endResponse(int seq) async => calls.add('end:$seq');

  @override
  Future<DuixStopped> stopResponse() async {
    calls.add('stop');
    final error = stopError;
    if (error != null) throw error;
    return stopResult;
  }

  @override
  Future<void> motion(String name) async => calls.add('motion:$name');

  @override
  Future<void> setRendering(bool on) async => calls.add('render:$on');

  @override
  Future<void> release() async => calls.add('release');
}
```

- [x] **Step 3: 写失败的测试**

`app/test/duix_config_test.dart`：

```dart
import 'dart:convert';
import 'dart:io';

import 'package:avatar_app/duix/duix_config.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> rawConfig() =>
    jsonDecode(File('assets/config/duix.json').readAsStringSync()) as Map<String, Object?>;

void expectInvalid(Map<String, Object?> raw, String code) {
  expect(
    () => DuixConfig.parse(jsonEncode(raw)),
    throwsA(isA<FormatException>().having((e) => e.message, 'message', code)),
  );
}

void main() {
  test('the shipped config parses with the pinned assets', () {
    final cfg = DuixConfig.parse(File('assets/config/duix.json').readAsStringSync());
    expect(cfg.enabled, isTrue);
    expect(cfg.debugOnly, isFalse);
    expect(cfg.model.dir, 'Lily');
    expect(cfg.assets.map((a) => a.id), ['gj_dh_res', 'lily']);
    expect(cfg.totalBytes, 139403482 + 35062448);
    expect(cfg.base.sha256, 'c3ffeca1cb250f111f70e9e221d9115c9a825a625eff9b93d260ef7da70a5457');
    expect(cfg.model.sha256, '9ec390b42b02594470dad69d87841ebbbdfbc0b22803c60092aba8cd9c5a556b');
    expect(cfg.minSegmentMs, 1000);
    expect(cfg.bargeInThresholdRms, 200);
  });

  test('asset args carry exactly what the installer needs', () {
    final cfg = DuixConfig.parse(File('assets/config/duix.json').readAsStringSync());
    expect(cfg.model.toArgs().keys, unorderedEquals(['id', 'dir', 'url', 'sha256', 'bytes']));
  });

  test('rejects non-https urls, bad hashes and unsafe dirs', () {
    final raw = rawConfig();
    final base = Map<String, Object?>.from(raw['base']! as Map);
    expectInvalid({...raw, 'base': {...base, 'url': 'http://x/y.zip'}}, 'asset_url_invalid');
    expectInvalid({...raw, 'base': {...base, 'sha256': 'ABC'}}, 'asset_sha256_invalid');
    expectInvalid({...raw, 'base': {...base, 'dir': 'other'}}, 'base_dir_invalid');
    final model = Map<String, Object?>.from((raw['models']! as List).first as Map);
    expectInvalid({...raw, 'models': [{...model, 'dir': '../Lily'}]}, 'asset_dir_invalid');
    expectInvalid({...raw, 'models': [{...model, 'bytes': 0}]}, 'asset_bytes_invalid');
  });

  test('rejects an unlisted default model and out-of-range numbers', () {
    final raw = rawConfig();
    expectInvalid({...raw, 'defaultModel': 'nobody'}, 'default_model_not_listed');
    expectInvalid({...raw, 'minTotalMemMb': 100}, 'minTotalMemMb_out_of_range');
    expectInvalid({...raw, 'playback': {'minSegmentMs': 700, 'lipReadyTimeoutMs': 1500, 'prepareTimeoutMs': 60000}}, 'minSegmentMs_out_of_range');
    expectInvalid({...raw, 'vad': {'bargeInThresholdRms': 10, 'bargeInGraceMs': 400}}, 'bargeInThresholdRms_out_of_range');
    expectInvalid({...raw, 'statsIntervalMs': 10}, 'statsIntervalMs_out_of_range');
  });

  test('rejects non-json and missing sections', () {
    expect(() => DuixConfig.parse('nope'), throwsFormatException);
    final raw = rawConfig()..remove('playback');
    expectInvalid(raw, 'missing_playback');
  });
}
```

`app/test/duix_events_test.dart`：

```dart
import 'package:avatar_app/duix/duix_events.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('parses every native event', () {
    expect(parseDuixEvent({'type': 'playStart', 'seq': 3, 'lips': true}), isA<DuixPlayStart>().having((e) => e.lips, 'lips', true));
    expect(parseDuixEvent({'type': 'playEnd', 'seq': 3, 'playedMs': 1200}), isA<DuixPlayEnd>().having((e) => e.playedMs, 'playedMs', 1200));
    expect(parseDuixEvent({'type': 'playError', 'seq': 3, 'code': 'write_6'}), isA<DuixPlayError>().having((e) => e.code, 'code', 'write_6'));
    expect(
      parseDuixEvent({'type': 'stats', 'fps': 25, 'lipFrames': 10, 'slowFrames': 1, 'maxFrameMs': 52}),
      isA<DuixStats>().having((e) => e.fps, 'fps', 25).having((e) => e.maxFrameMs, 'max', 52),
    );
    expect(parseDuixEvent({'type': 'fault', 'code': 'render'}), isA<DuixFault>());
    expect(
      parseDuixEvent({'type': 'install', 'id': 'lily', 'phase': 'downloading', 'received': 10, 'total': 20}),
      isA<DuixInstallProgress>().having((e) => e.received, 'received', 10),
    );
  });

  test('ignores unknown or malformed events', () {
    expect(parseDuixEvent(null), isNull);
    expect(parseDuixEvent('playEnd'), isNull);
    expect(parseDuixEvent({'type': 'nope'}), isNull);
    expect(parseDuixEvent({'type': 'playEnd', 'seq': '3', 'playedMs': 1}), isNull);
    expect(parseDuixEvent({'type': 'install', 'id': 'lily', 'phase': 'exploding', 'received': 1, 'total': 2}), isNull);
  });
}
```

`app/test/duix_bridge_test.dart`：

```dart
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
```

- [x] **Step 4: 跑测试确认失败**

```bash
cd app && flutter test test/duix_config_test.dart test/duix_events_test.dart test/duix_bridge_test.dart
```

Expected：FAIL，报 `duix_config.dart`、`duix_events.dart`、`duix_bridge.dart` 不存在。

- [x] **Step 5: 写实现**

`app/lib/duix/duix_config.dart`：

```dart
import 'dart:convert';

/// One downloadable Duix package; [dir] is its top-level folder inside the zip.
class DuixAsset {
  const DuixAsset({required this.id, required this.dir, required this.url, required this.sha256, required this.bytes});

  final String id;
  final String dir;
  final String url;
  final String sha256;
  final int bytes;

  Map<String, Object> toArgs() => {'id': id, 'dir': dir, 'url': url, 'sha256': sha256, 'bytes': bytes};
}

/// Duix engine settings (assets/config/duix.json). Ranges match DuixRuntimeConfig.kt.
class DuixConfig {
  const DuixConfig({
    required this.enabled,
    required this.debugOnly,
    required this.minTotalMemMb,
    required this.maxUncleanExits,
    required this.base,
    required this.models,
    required this.defaultModel,
    required this.minSegmentMs,
    required this.lipReadyTimeoutMs,
    required this.prepareTimeoutMs,
    required this.bargeInThresholdRms,
    required this.bargeInGraceMs,
    required this.statsIntervalMs,
  });

  static const assetPath = 'assets/config/duix.json';

  /// The SDK hard-codes this base resource folder.
  static const baseDir = 'gj_dh_res';

  final bool enabled;

  /// Hides Duix in release builds, e.g. while telemetry removal is unverified.
  final bool debugOnly;
  final int minTotalMemMb;
  final int maxUncleanExits;
  final DuixAsset base;
  final List<DuixAsset> models;
  final String defaultModel;
  final int minSegmentMs;
  final int lipReadyTimeoutMs;
  final int prepareTimeoutMs;
  final double bargeInThresholdRms;
  final int bargeInGraceMs;
  final int statsIntervalMs;

  DuixAsset get model => models.firstWhere((m) => m.id == defaultModel);

  /// Install order: shared base resources first, then the model.
  List<DuixAsset> get assets => [base, model];

  int get totalBytes => assets.fold(0, (sum, a) => sum + a.bytes);

  static DuixConfig parse(String source) {
    final Object? raw;
    try {
      raw = jsonDecode(source);
    } on FormatException {
      throw const FormatException('duix_config_not_json');
    }
    if (raw is! Map<String, Object?>) throw const FormatException('duix_config_not_object');
    final playback = _map(raw, 'playback');
    final vad = _map(raw, 'vad');
    final base = _asset(raw['base']);
    if (base.dir != baseDir) throw const FormatException('base_dir_invalid');
    final modelsRaw = raw['models'];
    if (modelsRaw is! List || modelsRaw.isEmpty) throw const FormatException('models_invalid');
    final models = [for (final m in modelsRaw) _asset(m)];
    final ids = {base.id, ...models.map((m) => m.id)};
    if (ids.length != models.length + 1) throw const FormatException('duplicate_asset_id');
    if (models.any((m) => m.dir == baseDir)) throw const FormatException('asset_dir_invalid');
    final defaultModel = raw['defaultModel'];
    if (defaultModel is! String || !models.any((m) => m.id == defaultModel)) {
      throw const FormatException('default_model_not_listed');
    }
    return DuixConfig(
      enabled: _bool(raw, 'enabled'),
      debugOnly: _bool(raw, 'debugOnly'),
      minTotalMemMb: _int(raw, 'minTotalMemMb', 2000, 32000),
      maxUncleanExits: _int(raw, 'maxUncleanExits', 1, 10),
      base: base,
      models: models,
      defaultModel: defaultModel,
      minSegmentMs: _int(playback, 'minSegmentMs', 800, 3000),
      lipReadyTimeoutMs: _int(playback, 'lipReadyTimeoutMs', 500, 5000),
      prepareTimeoutMs: _int(playback, 'prepareTimeoutMs', 5000, 180000),
      bargeInThresholdRms: _num(vad, 'bargeInThresholdRms', 50, 2000),
      bargeInGraceMs: _int(vad, 'bargeInGraceMs', 0, 2000),
      statsIntervalMs: _int(raw, 'statsIntervalMs', 1000, 60000),
    );
  }
}

final _token = RegExp(r'^[A-Za-z0-9_-]{1,64}$');
final _sha256 = RegExp(r'^[0-9a-f]{64}$');
const _maxAssetBytes = 2 * 1024 * 1024 * 1024;

DuixAsset _asset(Object? raw) {
  if (raw is! Map) throw const FormatException('asset_invalid');
  final id = raw['id'];
  final dir = raw['dir'];
  final url = raw['url'];
  final sha = raw['sha256'];
  final bytes = raw['bytes'];
  if (id is! String || !_token.hasMatch(id)) throw const FormatException('asset_id_invalid');
  if (dir is! String || !_token.hasMatch(dir)) throw const FormatException('asset_dir_invalid');
  if (url is! String || !url.startsWith('https://') || Uri.tryParse(url) == null) {
    throw const FormatException('asset_url_invalid');
  }
  if (sha is! String || !_sha256.hasMatch(sha)) throw const FormatException('asset_sha256_invalid');
  if (bytes is! int || bytes <= 0 || bytes > _maxAssetBytes) throw const FormatException('asset_bytes_invalid');
  return DuixAsset(id: id, dir: dir, url: url, sha256: sha, bytes: bytes);
}

Map<String, Object?> _map(Map<String, Object?> m, String key) {
  final v = m[key];
  if (v is! Map<String, Object?>) throw FormatException('missing_$key');
  return v;
}

bool _bool(Map<String, Object?> m, String key) {
  final v = m[key];
  if (v is! bool) throw FormatException('${key}_invalid');
  return v;
}

int _int(Map<String, Object?> m, String key, int min, int max) {
  final v = m[key];
  if (v is! int || v < min || v > max) throw FormatException('${key}_out_of_range');
  return v;
}

double _num(Map<String, Object?> m, String key, double min, double max) {
  final v = m[key];
  if (v is! num || v < min || v > max) throw FormatException('${key}_out_of_range');
  return v.toDouble();
}
```

`app/lib/duix/duix_events.dart`：

```dart
/// Events from the Kotlin Duix host (EventChannel anyidea/duix/events).
sealed class DuixEvent {
  const DuixEvent();
}

/// Audio of [seq] became audible; [lips] is false when it started before lip features were ready.
final class DuixPlayStart extends DuixEvent {
  const DuixPlayStart(this.seq, {required this.lips});
  final int seq;
  final bool lips;
}

/// Real audio of [seq] played out.
final class DuixPlayEnd extends DuixEvent {
  const DuixPlayEnd(this.seq, this.playedMs);
  final int seq;
  final int playedMs;
}

final class DuixPlayError extends DuixEvent {
  const DuixPlayError(this.seq, this.code);
  final int seq;
  final String code;
}

final class DuixStats extends DuixEvent {
  const DuixStats({required this.fps, required this.lipFrames, required this.slowFrames, required this.maxFrameMs});
  final int fps;
  final int lipFrames;
  final int slowFrames;
  final int maxFrameMs;
}

/// The render loop died; the engine is unusable.
final class DuixFault extends DuixEvent {
  const DuixFault(this.code);
  final String code;
}

final class DuixInstallProgress extends DuixEvent {
  const DuixInstallProgress({required this.id, required this.phase, required this.received, required this.total});
  final String id;

  /// One of `downloading`, `verifying`, `unzipping`, `done`.
  final String phase;
  final int received;
  final int total;
}

const _installPhases = {'downloading', 'verifying', 'unzipping', 'done'};

DuixEvent? parseDuixEvent(Object? raw) {
  if (raw is! Map) return null;
  return switch (raw) {
    {'type': 'playStart', 'seq': final int seq, 'lips': final bool lips} => DuixPlayStart(seq, lips: lips),
    {'type': 'playEnd', 'seq': final int seq, 'playedMs': final int playedMs} => DuixPlayEnd(seq, playedMs),
    {'type': 'playError', 'seq': final int seq, 'code': final String code} => DuixPlayError(seq, code),
    {
      'type': 'stats',
      'fps': final int fps,
      'lipFrames': final int lipFrames,
      'slowFrames': final int slowFrames,
      'maxFrameMs': final int maxFrameMs,
    } =>
      DuixStats(fps: fps, lipFrames: lipFrames, slowFrames: slowFrames, maxFrameMs: maxFrameMs),
    {'type': 'fault', 'code': final String code} => DuixFault(code),
    {
      'type': 'install',
      'id': final String id,
      'phase': final String phase,
      'received': final int received,
      'total': final int total,
    }
        when _installPhases.contains(phase) =>
      DuixInstallProgress(id: id, phase: phase, received: received, total: total),
    _ => null,
  };
}
```

`app/lib/duix/duix_bridge.dart`：

```dart
import 'package:flutter/services.dart';

import 'duix_config.dart';
import 'duix_events.dart';

class DuixSupport {
  const DuixSupport({required this.supported, this.reason});

  final bool supported;

  /// `abi_unsupported`, `low_memory`, `library_missing`, `storage_unavailable`, or another error code.
  final String? reason;
}

class DuixPrepared {
  const DuixPrepared({required this.width, required this.height, required this.motions});

  final int width;
  final int height;

  /// Named motion regions of the model; empty for Lily.
  final List<String> motions;
}

/// What the native player had active when stopped; seq 0 means nothing was playing any more.
class DuixStopped {
  const DuixStopped({required this.seq, required this.playedMs});

  final int seq;
  final int playedMs;
}

/// A content-free error code from the native side (spec §4.4).
class DuixBridgeError implements Exception {
  const DuixBridgeError(this.code);

  final String code;

  @override
  String toString() => 'DuixBridgeError($code)';
}

/// Dart side of the Kotlin DuixHost. One instance per app.
abstract interface class DuixBridge {
  Stream<DuixEvent> get events;
  Future<DuixSupport> probe({required int minTotalMemMb});
  Future<Map<String, bool>> installStatus(List<DuixAsset> assets);
  Future<void> install(DuixAsset asset);
  Future<void> cancelInstall(String id);
  Future<DuixPrepared> prepare(DuixConfig config);
  Future<void> startResponse(int seq);
  Future<void> push(int seq, Uint8List pcm16, Uint8List pcm24);
  Future<void> endResponse(int seq);

  /// Silences now and reports which reply was active and how much real audio of it was heard.
  Future<DuixStopped> stopResponse();
  Future<void> motion(String name);
  Future<void> setRendering(bool on);
  Future<void> release();
}

class MethodChannelDuixBridge implements DuixBridge {
  MethodChannelDuixBridge({MethodChannel? methods, EventChannel? events})
    : _methods = methods ?? const MethodChannel('anyidea/duix'),
      _eventChannel = events ?? const EventChannel('anyidea/duix/events');

  final MethodChannel _methods;
  final EventChannel _eventChannel;
  Stream<DuixEvent>? _events;

  @override
  Stream<DuixEvent> get events => _events ??= _eventChannel
      .receiveBroadcastStream()
      .handleError((Object _) {}, test: (e) => e is PlatformException)
      .map(parseDuixEvent)
      .where((e) => e != null)
      .cast<DuixEvent>();

  Future<T?> _call<T>(String method, [Object? args]) async {
    try {
      return await _methods.invokeMethod<T>(method, args);
    } on PlatformException catch (e) {
      throw DuixBridgeError(e.code);
    } on MissingPluginException {
      throw const DuixBridgeError('library_missing');
    }
  }

  @override
  Future<DuixSupport> probe({required int minTotalMemMb}) async {
    try {
      final r = await _call<Map<Object?, Object?>>('probe', {'minTotalMemMb': minTotalMemMb});
      final reason = r?['reason'];
      return DuixSupport(supported: r?['supported'] == true, reason: reason is String ? reason : null);
    } on DuixBridgeError catch (e) {
      return DuixSupport(supported: false, reason: e.code);
    }
  }

  @override
  Future<Map<String, bool>> installStatus(List<DuixAsset> assets) async {
    final r = await _call<Map<Object?, Object?>>('installStatus', {
      'assets': [
        for (final a in assets) {'id': a.id, 'dir': a.dir, 'sha256': a.sha256},
      ],
    });
    return {for (final a in assets) a.id: r?[a.id] == true};
  }

  @override
  Future<void> install(DuixAsset asset) => _call<void>('install', asset.toArgs());

  @override
  Future<void> cancelInstall(String id) => _call<void>('cancelInstall', {'id': id});

  @override
  Future<DuixPrepared> prepare(DuixConfig config) async {
    final r = await _call<Map<Object?, Object?>>('prepare', {
      'modelDir': config.model.dir,
      'minSegmentMs': config.minSegmentMs,
      'lipReadyTimeoutMs': config.lipReadyTimeoutMs,
      'statsIntervalMs': config.statsIntervalMs,
      'prepareTimeoutMs': config.prepareTimeoutMs,
    });
    final width = r?['width'];
    final height = r?['height'];
    final motions = r?['motions'];
    if (width is! int || height is! int) throw const DuixBridgeError('bad_reply');
    return DuixPrepared(
      width: width,
      height: height,
      motions: [if (motions is List) for (final m in motions) if (m is String) m],
    );
  }

  @override
  Future<void> startResponse(int seq) => _call<void>('startResponse', {'seq': seq});

  @override
  Future<void> push(int seq, Uint8List pcm16, Uint8List pcm24) =>
      _call<void>('push', {'seq': seq, 'pcm16': pcm16, 'pcm24': pcm24});

  @override
  Future<void> endResponse(int seq) => _call<void>('endResponse', {'seq': seq});

  @override
  Future<DuixStopped> stopResponse() async {
    final r = await _call<Map<Object?, Object?>>('stopResponse');
    final seq = r?['seq'];
    final ms = r?['playedMs'];
    return DuixStopped(seq: seq is int ? seq : 0, playedMs: ms is int ? ms : 0);
  }

  @override
  Future<void> motion(String name) => _call<void>('motion', {'name': name});

  @override
  Future<void> setRendering(bool on) => _call<void>('setRendering', {'on': on});

  @override
  Future<void> release() => _call<void>('release');
}
```

- [x] **Step 6: 跑测试确认通过**

```bash
cd app && flutter test test/duix_config_test.dart test/duix_events_test.dart test/duix_bridge_test.dart && flutter analyze
```

Expected：三个文件全部通过；`flutter analyze` 没有新问题。

如果 `MockStreamHandler.inline` 在当前 Flutter 里叫别的名字，就以 `flutter_test` 的实际 API（`package:flutter_test/src/mock_event_channel.dart`）为准改测试，事件断言不变。

- [x] **Step 7: 提交**

```bash
git add app/assets/config/duix.json app/lib/duix/duix_config.dart app/lib/duix/duix_events.dart \
  app/lib/duix/duix_bridge.dart app/test/support/duix_fakes.dart app/test/duix_config_test.dart \
  app/test/duix_events_test.dart app/test/duix_bridge_test.dart
git commit -m "feat(duix): add the Duix config, events and channel bridge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
