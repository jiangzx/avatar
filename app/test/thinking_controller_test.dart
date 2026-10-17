import 'package:avatar_app/native_session/thinking_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/thinking_fixture.dart';

ThinkingController make({List<String> evidence = const ['transcript']}) =>
    ThinkingController(testThinking(evidence: evidence), vadReleaseMs: 120);

List<String> states(List<ThinkCommand> c) => c.whereType<SetAvatarState>().map((s) => s.state).toList();

/// Speech 0–1000 ms (estimated end 880), transcript seen, thinking at 1180, first filler at 2380.
ThinkingController withFiller() {
  final t = make();
  t.onVadSpeaking(0);
  t.onUserTranscript();
  t.onVadSilent(1000);
  t.tick(1180);
  t.tick(2380);
  return t;
}

void main() {
  test('listens and nods at a low rate while the user speaks', () {
    final t = make();
    expect(states(t.onVadSpeaking(0)), ['listening']);
    expect(t.tick(1499), isEmpty);
    expect(t.tick(1500).whereType<Backchannel>(), hasLength(1));
    expect(t.tick(3000), isEmpty);
    expect(t.tick(5500).whereType<Backchannel>(), hasLength(1));
  });

  test('enters thinking 300 ms after speech ends, before any reply', () {
    final t = make();
    t.onVadSpeaking(0);
    t.onVadSilent(1000);
    expect(t.tick(1179), isEmpty);
    final c = t.tick(1180);
    expect(states(c), ['thinking']);
    expect(c.whereType<ThinkDiag>().single.fields['after_silence_ms'], 300);
  });

  test('plays one filler after fillerAfterMs once a user transcript was seen', () {
    final t = make();
    t.onVadSpeaking(0);
    t.onUserTranscript();
    t.onVadSilent(1000);
    t.tick(1180);
    expect(t.tick(2379).whereType<PlayFiller>(), isEmpty);
    expect(t.tick(2380).whereType<PlayFiller>().single.clip.id, 'think-1');
    expect(t.zeroUplink(2380), isTrue);
    expect(t.tick(3000).whereType<PlayFiller>(), isEmpty);
  });

  test('skips the filler without evidence, and accepts response.start when configured', () {
    final strict = make();
    strict.onVadSpeaking(0);
    strict.onVadSilent(1000);
    strict.tick(1180);
    strict.onResponseStart(1500, reply: true);
    final skipped = strict.tick(2380);
    expect(skipped.whereType<PlayFiller>(), isEmpty);
    expect(skipped.whereType<ThinkDiag>().single.event, 'filler_skipped');
    expect(strict.tick(2500), isEmpty);
    final loose = make(evidence: ['transcript', 'responseStart']);
    loose.onVadSpeaking(0);
    loose.onVadSilent(1000);
    loose.tick(1180);
    loose.onResponseStart(1500, reply: true);
    expect(loose.tick(2380).whereType<PlayFiller>(), hasLength(1));
  });

  test('plays the long-wait filler only after response.start or model_reconnecting, and never a third', () {
    final t = withFiller();
    t.onFillerDone(3400);
    expect(t.tick(6380).whereType<PlayFiller>(), isEmpty);
    t.onModelReconnecting();
    expect(t.tick(6400).whereType<PlayFiller>().single.clip.id, 'wait-1');
    t.onFillerDone(7400);
    expect(t.tick(12000).whereType<PlayFiller>(), isEmpty);
  });

  test('first audio fades the filler and switches to speaking', () {
    final t = withFiller();
    final c = t.onFirstAudio(2600);
    expect(c.whereType<StopFiller>().single.fade, isTrue);
    expect(states(c), ['speaking']);
    expect(t.fillerPlaying, isFalse);
  });

  test('an empty ended reply keeps thinking; a played one returns to idle', () {
    final t = make();
    t.onVadSpeaking(0);
    t.onVadSilent(1000);
    t.tick(1180);
    t.onResponseStart(1300, reply: true);
    expect(t.onPlaybackEnded(1400, playedMs: 0), isEmpty);
    expect(t.phase, 'thinking');
    t.onFirstAudio(2000);
    expect(states(t.onPlaybackEnded(4000, playedMs: 1800)), ['idle']);
  });

  test('local speech during a filler only stops the filler and reopens the uplink', () {
    final t = withFiller();
    expect(t.guardsSpeech(2500), isTrue);
    final c = t.onVadSpeaking(2500);
    expect(c.whereType<StopFiller>().single.fade, isFalse);
    expect(states(c), ['listening']);
    t.onFillerDone(2510); // the audio layer confirms the stop
    expect(t.zeroUplink(2510), isFalse);
  });

  test('a filler that drains naturally keeps zero uplink for the tail guard', () {
    final t = withFiller();
    t.onFillerDone(3400);
    expect(t.zeroUplink(3799), isTrue);
    expect(t.guardsSpeech(3799), isTrue);
    expect(t.zeroUplink(3800), isFalse);
  });

  test('a proactive response shows thinking but never a filler', () {
    final t = make();
    expect(states(t.onResponseStart(0, reply: false)), ['thinking']);
    expect(t.tick(5000).whereType<PlayFiller>(), isEmpty);
  });

  test('a reply response.start counts as a user turn even if local VAD never fired', () {
    final t = make();
    t.onUserTranscript();
    expect(states(t.onResponseStart(1000, reply: true)), ['thinking']);
    expect(t.tick(2199).whereType<PlayFiller>(), isEmpty);
    expect(t.tick(2200).whereType<PlayFiller>(), hasLength(1));
  });

  test('a non-reply response.start gets no filler even with a transcript and no VAD', () {
    final t = make();
    t.onUserTranscript();
    t.onResponseStart(1000, reply: false);
    expect(t.tick(2500).whereType<PlayFiller>(), isEmpty);
  });

  test('cancel during a filler stops it, resets the turn and allows no further filler', () {
    final t = withFiller();
    final c = t.onCancelled(2500);
    expect(c.whereType<StopFiller>().single.fade, isFalse);
    expect(states(c), ['idle']);
    expect(t.phase, 'idle');
    expect(t.fillerPlaying, isFalse);
    expect(t.fillersThisTurn, 0);
    expect(t.tick(9000), isEmpty);
  });

  test('gives up thinking after thinkingMaxMs', () {
    final t = withFiller();
    final c = t.tick(21180);
    expect(c.whereType<StopFiller>(), hasLength(1));
    expect(states(c), ['idle']);
    expect(c.whereType<ThinkDiag>().single.event, 'thinking_timeout');
  });
}
