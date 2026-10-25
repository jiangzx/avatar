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
  Future<void> ensureBundled();
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
  Future<void> ensureBundled() => _call<void>('ensureBundled');

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
