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
