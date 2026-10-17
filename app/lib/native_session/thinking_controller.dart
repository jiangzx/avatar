import 'thinking_config.dart';

sealed class ThinkCommand {
  const ThinkCommand();
}

final class SetAvatarState extends ThinkCommand {
  const SetAvatarState(this.state);
  final String state;
}

final class PlayFiller extends ThinkCommand {
  const PlayFiller(this.clip);
  final FillerClip clip;
}

final class StopFiller extends ThinkCommand {
  const StopFiller({required this.fade});
  final bool fade;
}

final class Backchannel extends ThinkCommand {
  const Backchannel();
}

final class ThinkDiag extends ThinkCommand {
  const ThinkDiag(this.event, this.fields);
  final String event;
  final Map<String, Object> fields;
}

enum _Phase { idle, listening, waiting, thinking, speaking }

/// Client-only pacing between "user stopped talking" and "first reply audio" (spec §3).
/// Pure state machine: the caller passes the time and applies the returned commands.
class ThinkingController {
  ThinkingController(this.cfg, {required this.vadReleaseMs});

  final ThinkingConfig cfg;
  final int vadReleaseMs;

  _Phase _phase = _Phase.idle;
  int? _speechStartAt;
  int? _lastNodAt;
  int? _silenceAt;
  int? _thinkingAt;
  int? _fillerAt;
  int _fillers = 0;
  bool _transcriptSeen = false;
  bool _replyStarted = false;
  bool _anyResponseStarted = false;
  bool _reconnecting = false;
  bool _fillerPlaying = false;
  bool _fromBargeIn = false;
  bool _skipLogged = false;
  int _tailGuardUntil = 0;
  int _clipIndex = 0;

  int get fillersThisTurn => _fillers;
  bool get fillerPlaying => _fillerPlaying;
  String get phase => _phase.name;

  /// Zero frames go up while a filler plays and during the tail guard after it.
  bool zeroUplink(int now) => _fillerPlaying || now < _tailGuardUntil;

  /// Before the first reply audio, speech heard around a filler only stops the filler.
  bool guardsSpeech(int now) => _phase != _Phase.speaking && zeroUplink(now);

  List<ThinkCommand> onVadSpeaking(int now) {
    final out = <ThinkCommand>[];
    if (_fillerPlaying) {
      _fillerPlaying = false;
      out
        ..add(const StopFiller(fade: false))
        ..add(const ThinkDiag('filler_stopped', {'reason': 'speech'}));
    }
    _tailGuardUntil = 0; // resume real uplink right away
    final bargeIn = _phase == _Phase.speaking;
    if (_phase == _Phase.idle || _phase == _Phase.speaking) _resetTurn();
    if (bargeIn) _fromBargeIn = true; // the next reply should follow the interrupt, not a canned filler
    _phase = _Phase.listening;
    _speechStartAt = now;
    _lastNodAt = null;
    _silenceAt = null;
    _thinkingAt = null;
    out.add(const SetAvatarState('listening'));
    return out;
  }

  List<ThinkCommand> onVadSilent(int now) {
    if (_phase != _Phase.listening) return const [];
    _phase = _Phase.waiting;
    _silenceAt = now - vadReleaseMs; // the detector reports silence only after its release time
    return const [];
  }

  void onUserTranscript() => _transcriptSeen = true;

  void onModelReconnecting() => _reconnecting = true;

  List<ThinkCommand> onResponseStart(int now, {required bool reply}) {
    _anyResponseStarted = true;
    if (reply) _replyStarted = true;
    if (_phase == _Phase.waiting || _phase == _Phase.idle) return _enterThinking(now);
    return const [];
  }

  List<ThinkCommand> onFirstAudio(int now) {
    final out = <ThinkCommand>[];
    if (_fillerPlaying) {
      _fillerPlaying = false;
      out.add(const StopFiller(fade: true));
    }
    _phase = _Phase.speaking;
    _silenceAt = null;
    _thinkingAt = null;
    out.add(const SetAvatarState('speaking'));
    return out;
  }

  List<ThinkCommand> onPlaybackEnded(int now, {required int playedMs}) {
    if (playedMs == 0) return const []; // empty reply (e.g. before a tool call): keep thinking
    _phase = _Phase.idle;
    _resetTurn();
    return const [SetAvatarState('idle')];
  }

  List<ThinkCommand> onCancelled(int now) {
    final out = <ThinkCommand>[];
    if (_fillerPlaying) {
      _fillerPlaying = false;
      out.add(const StopFiller(fade: false));
    }
    if (_phase == _Phase.listening) return out; // the user is talking; stay listening
    // They already went quiet. Keep the barge-in mark so the next reply is not a canned filler.
    final bargeIn = _fromBargeIn;
    _phase = _Phase.idle;
    _resetTurn();
    _fromBargeIn = bargeIn;
    out.add(const SetAvatarState('idle'));
    return out;
  }

  /// The audio layer reports the filler stopped or drained; only natural ends start the tail guard.
  void onFillerDone(int now) {
    if (!_fillerPlaying) return;
    _fillerPlaying = false;
    _tailGuardUntil = now + cfg.tailGuardMs;
  }

  List<ThinkCommand> tick(int now) {
    switch (_phase) {
      case _Phase.listening:
        return _nod(now);
      case _Phase.waiting:
        final silenceAt = _silenceAt;
        return silenceAt != null && now - silenceAt >= cfg.thinkingSilenceMs ? _enterThinking(now) : const [];
      case _Phase.thinking:
        return _thinkingTick(now);
      case _Phase.idle:
      case _Phase.speaking:
        return const [];
    }
  }

  List<ThinkCommand> _nod(int now) {
    final start = _speechStartAt;
    if (start == null) return const [];
    final last = _lastNodAt;
    final due = last == null ? start + cfg.nodFirstAfterMs : last + cfg.nodEveryMs;
    if (now < due) return const [];
    _lastNodAt = now;
    return const [Backchannel()];
  }

  List<ThinkCommand> _enterThinking(int now) {
    _phase = _Phase.thinking;
    _thinkingAt = now;
    final silenceAt = _silenceAt;
    return [
      const SetAvatarState('thinking'),
      if (silenceAt != null) ThinkDiag('thinking', {'after_silence_ms': now - silenceAt}),
    ];
  }

  List<ThinkCommand> _thinkingTick(int now) {
    final since = _thinkingAt ?? now;
    if (now - since >= cfg.thinkingMaxMs) {
      final out = <ThinkCommand>[];
      if (_fillerPlaying) {
        _fillerPlaying = false;
        out.add(const StopFiller(fade: false));
      }
      _phase = _Phase.idle;
      _resetTurn();
      out
        ..add(ThinkDiag('thinking_timeout', {'ms': now - since}))
        ..add(const SetAvatarState('idle'));
      return out;
    }
    // Placeholder clips use the wrong voice and stutter, so the shipped config leaves them off.
    // A barge-in already stopped the avatar; a canned line before the next reply sounds stuck.
    if (!cfg.fillersEnabled || _fromBargeIn || (_silenceAt == null && !_replyStarted) || _fillerPlaying) {
      return const [];
    }
    if (_fillers == 0 && now - since >= cfg.fillerAfterMs) {
      if (_hasEvidence()) {
        return _playFiller(now, cfg.thinkingClips[_clipIndex++ % cfg.thinkingClips.length], 'thinking', since);
      }
      if (_skipLogged) return const [];
      _skipLogged = true;
      return const [ThinkDiag('filler_skipped', {'reason': 'no_evidence'})];
    }
    final fillerAt = _fillerAt;
    if (_fillers == 1 &&
        fillerAt != null &&
        now - fillerAt >= cfg.longWaitAfterMs &&
        (_anyResponseStarted || _reconnecting)) {
      return _playFiller(now, cfg.longWaitClips.first, 'long_wait', since);
    }
    return const [];
  }

  bool _hasEvidence() =>
      (cfg.fillerEvidence.contains('transcript') && _transcriptSeen) ||
      (cfg.fillerEvidence.contains('responseStart') && _replyStarted);

  List<ThinkCommand> _playFiller(int now, FillerClip clip, String kind, int since) {
    _fillerPlaying = true;
    _fillerAt ??= now;
    _fillers++;
    return [
      PlayFiller(clip),
      ThinkDiag('filler', {'kind': kind, 'after_thinking_ms': now - since}),
    ];
  }

  void _resetTurn() {
    _speechStartAt = null;
    _lastNodAt = null;
    _silenceAt = null;
    _thinkingAt = null;
    _fillerAt = null;
    _fillers = 0;
    _transcriptSeen = false;
    _replyStarted = false;
    _anyResponseStarted = false;
    _reconnecting = false;
    _fromBargeIn = false;
    _skipLogged = false;
  }
}
