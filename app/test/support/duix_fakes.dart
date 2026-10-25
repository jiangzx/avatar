import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_config.dart';
import 'package:avatar_app/duix/duix_events.dart';
import 'package:avatar_app/native_audio/audio_types.dart';
import 'package:avatar_app/native_audio/mic_capture.dart';

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
  DuixBridgeError? bundleError;
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
  Future<void> ensureBundled() async {
    calls.add('ensureBundled');
    final error = bundleError;
    if (error != null) throw error;
    installed['gj_dh_res'] = true;
    installed['lily'] = true;
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

class FakeMic implements MicInput {
  int starts = 0;
  int stops = 0;
  bool enabled = true;
  AudioFrameCallback? onFrame;

  @override
  Future<void> start({required AudioFrameCallback onFrame, required AudioLevelCallback onLevel}) async {
    starts++;
    this.onFrame = onFrame;
  }

  @override
  Future<void> stop() async => stops++;

  @override
  set inputEnabled(bool value) => enabled = value;
}
