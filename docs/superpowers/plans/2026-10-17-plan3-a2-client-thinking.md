# Plan 3 A2: Client Thinking State, Filler and Backchannel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Between "the elder stops talking" and "the first reply audio", the phone always shows or plays feedback: listening nods, a thinking pose with "…", a same-voice filler clip after 1.2 s, a long-wait filler, and speaking driven by the first real audio frame — all client-side, measured with anonymous logcat diagnostics, then accepted on the Xiaomi against the Plan A gate.

**Architecture:** A pure Dart `ThinkingController` turns VAD edges, server messages and a clock into commands (avatar state, play/stop filler, backchannel nod, diagnostics). `NativeSessionController` feeds it, applies commands on its existing serialized event queue, sends zero frames while a filler plays, and never cancels a reply because of speech heard during a filler. A `FillerPlayer` feeds pre-recorded PCM clips into the shared `FlutterPcmSound` player in small gain-scaled chunks (≤40 ms, ≤100 ms buffered) so it can stop or fade independently of any reply. avatar-core stops switching to speaking on microphone levels, keeps the thinking pose for empty replies, adds a gaze-up/head-tilt thinking pose, a subtle backchannel nod, and a visible sad face.

**Tech Stack:** Flutter 3.47.7 / Dart 3.13.5, `flutter_pcm_sound` 3.3.3, `flutter_test`; avatar-core TypeScript + Vitest; gateway scripts (Node 24 + tsx) for clip recording. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-17-companionship-memory-design.md` — §3 思考态交互, §4 无声附和, 工程约束 #2 and #6, 验收 → 延迟基线 / Plan A 门槛, 未验证假设 4, 4a, 5.

**Prerequisite:** Plan 3 Task 0 complete. **Companion plan:** `docs/superpowers/plans/2026-10-17-plan3-a1-gateway-persona.md`. Dependencies:

| A2 task | Depends on |
|---|---|
| Task 1 (client latency baseline) | nothing in A1; run it after A1 Task 2 and before A1 Task 4 so both baselines describe pre-Plan-A behavior |
| Task 2 (`fillerEvidence` value) | A1 Task 1 §4a result (`docs/research/qwen-plan-a-validation.md`) |
| Task 3 (filler clips) | A1 Task 1 (`gateway/scripts/lib/qwen-raw.ts`), A1 Task 4 (voices in `gateway/roles/elder-companion/role.json`), A2 Task 2 |
| Tasks 4–8 | A2 Task 2; Task 6 also uses the A1 Task 1 result for assumption 5 (zero frames during filler) |
| Task 9 (device acceptance) | all of A1 and A2 in the same Plan A worktree |

## Global Constraints

- Hard rules from `AGENTS.md`: replies to the user in Simplified Chinese; code comments in English, short. Never log conversation content; logcat lines carry event names, ids, counts, durations only. Never commit secrets. Never stage with `git add -A`.
- "Client-side metrics go to anonymous logcat diagnostics, not new protocol messages." No changes to `protocol/` WS messages, binary frames, or Bridge message types; thinking reuses Bridge `state:'thinking'`, backchannel reuses `avatar.action` (`nod`) with a new `source` string value.
- "app 侧的阈值和垫话文案放在 app 的配置文件里": all thresholds, filler texts and clip lists live in `app/assets/config/thinking.json`, validated at load.
- Spec §3 rules, verbatim intent: thinking ends at the **first audio frame**, not `response.start`; speaking is driven by the first audio frame; filler chunks ≤40 ms with gain, ≤100 ms buffered, independent `stopFiller()`, ≤100 ms fade on first real audio, filler residue not counted in `playedMs`/`playback.progress`; zero frames uplink during filler; before first audio, local speech only stops the filler and resumes uplink, never cancels the reply; filler requires a `transcript.user` this turn; tail guard after filler; `playedMs==0` ended does not exit thinking; long wait inferred only from `response.start` without audio or `model_reconnecting`.
- **File ownership (spec):** Plan A owns `app/lib/native_audio/native_audio_io.dart`, the playback queue (`playback_queue.dart`), `speech_detector.dart`, `app/lib/native_session/session_controller.dart`, `app/lib/avatar_page.dart`, the new `FillerPlayer`; `avatar-core/src/nativeAvatar.ts`, `avatar-core/src/avatar/avatarView.ts`. New files created here: `app/lib/diag_log.dart`, `app/lib/native_session/thinking_config.dart`, `app/lib/native_session/thinking_controller.dart`, `app/lib/native_audio/filler_player.dart`, `app/lib/native_audio/filler_clips.dart`, `app/assets/config/thinking.json`, `app/assets/filler/**`, `gateway/scripts/make-filler-clips.ts`, `gateway/scripts/lib/pcm-tools.ts`, tests.
- **Do not touch (Plan B):** `app/lib/native_gateway/gateway_client.dart`, `app/lib/native_gateway/transports.dart`, `app/lib/main.dart`, credential storage, the style picker. The current style comes from Plan B's local storage after A+B merge; until then `thinking.json` `defaultStyle` is used (marked as the merge point in `avatar_page.dart`).
- **Additive edits outside the list (flagged):** `app/lib/native_audio/audio_types.dart` (three new `NativeAudioIO` members), `app/pubspec.yaml` (asset lines appended under `flutter.assets`; Plan B may also edit this file — append only), `app/test/native_session_controller_test.dart` fakes.
- Commands: app tests `cd app && flutter test` (one file: `flutter test test/<file>_test.dart`), `cd app && flutter analyze`; avatar-core `npm test -w avatar-core`, `npm run typecheck -w avatar-core`; gateway `npm test -w gateway`.
- Commit message trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `app/lib/diag_log.dart` | create | `formatDiag`, `logcatDiagSink` (content-free `anyidea.diag` lines) |
| `app/lib/native_session/session_controller.dart` | modify | Perceived-latency diag; thinking wiring, zero uplink, filler-safe speech handling, first-audio speaking |
| `app/lib/native_session/thinking_config.dart` | create | Parse + validate `assets/config/thinking.json` |
| `app/assets/config/thinking.json` | create | Thresholds, filler audio settings, clip list, styles |
| `gateway/scripts/lib/pcm-tools.ts` | create | Trim, normalize, transcript compare for clip recording |
| `gateway/scripts/make-filler-clips.ts` | create | Record same-voice filler clips from Qwen |
| `app/assets/filler/{grandchild,old-friend}/*.pcm` | create | 24 kHz mono s16le filler clips |
| `app/lib/native_audio/filler_player.dart` | create | Chunked, gain-scaled, capped-buffer filler playback with stop/fade |
| `app/lib/native_audio/audio_types.dart` | modify | `fillerActive`, `playFiller`, `stopFiller` on `NativeAudioIO` |
| `app/lib/native_audio/native_audio_io.dart` | modify | Implement filler on the shared `FlutterPcmSound` player |
| `app/lib/native_session/thinking_controller.dart` | create | Listening/thinking/filler/long-wait/timeout state machine |
| `app/lib/native_audio/filler_clips.dart` | create | Load clip PCM for one style |
| `app/lib/avatar_page.dart` | modify | Load config/clips, "…" subtitle while thinking |
| `avatar-core/src/nativeAvatar.ts` | modify | No mic-level speaking; empty reply keeps thinking; backchannel nod |
| `avatar-core/src/avatar/avatarView.ts` | modify | Thinking pose; per-emotion smile so sad is visible |
| `docs/testing/plan-a-latency-baseline.md` | modify | Client baseline section |
| `docs/testing/2026-10-1x-plan-a-device-report.md` | create | Plan A gate results on Xiaomi |

---

### Task 1: Anonymous diagnostics and client perceived-latency baseline

**Files:**
- Create: `app/lib/diag_log.dart`
- Modify: `app/lib/native_session/session_controller.dart`
- Modify: `docs/testing/plan-a-latency-baseline.md` (client section)
- Test: `app/test/diag_log_test.dart`, `app/test/native_session_controller_test.dart`

**Interfaces:**
- Produces (`diag_log.dart`):
  ```dart
  typedef DiagSink = void Function(String line);
  void logcatDiagSink(String line);
  String formatDiag(String event, Map<String, Object> fields); // 'anyidea.diag event=<e> k=v ...'
  ```
- Produces (`NativeSessionController` constructor, optional): `DiagSink diag = logcatDiagSink`, `int Function()? now`. Logs `anyidea.diag event=latency seq=<n> perceived_ms=<ms>` once per `reply` response: from the estimated end of local speech (silent edge − `defaultVadReleaseMs`) to the first accepted audio chunk.

- [x] **Step 1: Write the failing tests**

Create `app/test/diag_log_test.dart`:

```dart
import 'package:avatar_app/diag_log.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('formats anonymous key=value diagnostics', () {
    expect(
      formatDiag('latency', {'seq': 3, 'perceived_ms': 812.4, 'kind': 'reply'}),
      'anyidea.diag event=latency seq=3 perceived_ms=812 kind=reply',
    );
  });

  test('never prints free text', () {
    expect(
      formatDiag('x', {'text': '我今天很好', 'spaced': 'a b'}),
      'anyidea.diag event=x text=invalid spaced=invalid',
    );
  });
}
```

In `app/test/native_session_controller_test.dart`:
- add imports `import 'package:avatar_app/diag_log.dart';`
- add a top-level helper below `main()`:
  ```dart
  Future<void> pumpEvents() async {
    for (var i = 0; i < 6; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }
  ```
- change `SessionFakes.controller()` to:
  ```dart
  NativeSessionController controller({DiagSink? diag, int Function()? now}) =>
      NativeSessionController(
        audio: audio,
        detector: detector,
        client: client,
        emit: events.add,
        diag: diag ?? (_) {},
        now: now,
      );
  ```
- in `FakeDetector`, add a queue used before the default rule:
  ```dart
  final queued = <SpeechEdge>[];

  @override
  SpeechEdge push(Int16List frame, {required int timestampMs}) {
    if (queued.isNotEmpty) return queued.removeAt(0);
    return ++frames == 4 ? SpeechEdge.speaking : SpeechEdge.none;
  }
  ```
  (replace the existing `push`)
- add tests inside `main()`:
  ```dart
  test('logs perceived latency from local speech end to first reply audio', () async {
    var now = 1000;
    final lines = <String>[];
    final f = SessionFakes();
    final c = f.controller(diag: lines.add, now: () => now);
    await c.start();
    f.detector.queued.add(SpeechEdge.speaking);
    f.audio.emitFrame(Int16List(320));
    now = 2000;
    f.detector.queued.add(SpeechEdge.silent);
    f.audio.emitFrame(Int16List(320));
    f.client.emit(const ResponseStart(5, 'reply'));
    await pumpEvents();
    now = 2700;
    f.client.emitAudio(5, Int16List(2400));
    await pumpEvents();
    expect(lines, contains('anyidea.diag event=latency seq=5 perceived_ms=820'));
  });

  test('does not log latency for proactive replies', () async {
    final lines = <String>[];
    final f = SessionFakes();
    final c = f.controller(diag: lines.add);
    await c.start();
    f.detector.queued.addAll([SpeechEdge.speaking, SpeechEdge.silent]);
    f.audio.emitFrame(Int16List(320));
    f.audio.emitFrame(Int16List(320));
    f.client.emit(const ResponseStart(6, 'followup'));
    f.client.emitAudio(6, Int16List(2400));
    await pumpEvents();
    expect(lines.where((l) => l.contains('event=latency')), isEmpty);
  });
  ```

- [x] **Step 2: Run them to verify they fail**

Run: `cd app && flutter test test/diag_log_test.dart test/native_session_controller_test.dart`
Expected: FAIL — `diag_log.dart` not found; `diag`/`now` are not constructor parameters.

- [x] **Step 3: Implement**

Create `app/lib/diag_log.dart`:

```dart
import 'package:flutter/foundation.dart';

/// Receives one anonymous diagnostic line. Fields are counts, durations, ids or enum names only.
typedef DiagSink = void Function(String line);

/// Writes to logcat (tag "flutter"): `adb logcat -s flutter:I | grep anyidea.diag`.
void logcatDiagSink(String line) => debugPrint(line);

final _safeValue = RegExp(r'^[A-Za-z0-9_.:-]{1,64}$');

/// `anyidea.diag event=<event> key=value ...`; any value that is not a short token prints as `invalid`.
String formatDiag(String event, Map<String, Object> fields) {
  final parts = <String>['anyidea.diag', 'event=$event'];
  fields.forEach((key, value) {
    final text = value is double ? value.round().toString() : value.toString();
    parts.add('$key=${_safeValue.hasMatch(text) ? text : 'invalid'}');
  });
  return parts.join(' ');
}
```

In `app/lib/native_session/session_controller.dart`:
- imports: `import '../diag_log.dart';`
- top-level function below the constants:
  ```dart
  int _wallClockMs() => DateTime.now().millisecondsSinceEpoch;
  ```
- constructor:
  ```dart
  NativeSessionController({
    required this.audio,
    required this.detector,
    required this.client,
    required this.emit,
    this.diag = logcatDiagSink,
    int Function()? now,
  }) : _now = now ?? _wallClockMs {
    client.attachEvents(this);
  }
  ```
- fields:
  ```dart
  final DiagSink diag;
  final int Function() _now;
  final _responseKinds = <int, String>{};
  /// Estimated end of the user's last speech segment; consumed by the first reply audio.
  int? _speechEndAt;
  ```
- in `_onFrame`, use `final now = _now();` for `timestampMs:` and both `VadMessage` timestamps; in `case SpeechEdge.speaking:` add `_speechEndAt = null;`; in `case SpeechEdge.silent:` add `_speechEndAt = now - defaultVadReleaseMs;`
- in `_closeOpenSpeech()`, after `_speechOpen = false;` add `_speechEndAt ??= _now();`
- in `case SessionReady():` and `case SessionResumed(...)`: add `_speechEndAt = null;` and `_responseKinds.clear();`
- in `case ResponseStart(...)`: after `_audioReceivedMs[responseSeq] = 0;` add `_responseKinds[responseSeq] = kind;`
- in `onAudio`'s queued task, directly before `await audio.pushResponse(frame.responseSeq, frame.pcm);` add:
  ```dart
      if (firstForSequence) _reportPerceivedLatency(frame.responseSeq);
  ```
- new method:
  ```dart
  void _reportPerceivedLatency(int seq) {
    final endAt = _speechEndAt;
    if (endAt == null || _responseKinds[seq] != 'reply') return;
    _speechEndAt = null;
    diag(formatDiag('latency', {'seq': seq, 'perceived_ms': _now() - endAt}));
  }
  ```

- [x] **Step 4: Run tests and analyze**

Run: `cd app && flutter test && flutter analyze`
Expected: all tests PASS; "No issues found!".

- [ ] **Step 5: Measure the client baseline on the Xiaomi (manual)**  Not run (user instruction: Mock only, no services/device/real model); see docs/blockers.md #18

Run this right after A1 Task 2 and before A1 Task 4 (pre-Plan-A behavior).

```bash
./scripts/build-web.sh
cd app && flutter build apk --debug --dart-define-from-file=dev.json && cd ..
adb push app/build/app/outputs/flutter-apk/app-debug.apk /data/local/tmp/app-debug.apk
adb shell pm install -r -d /data/local/tmp/app-debug.apk
# Ask the user before restarting the gateway they keep on 8787.
adb reverse tcp:8787 tcp:8787
cd gateway && node --env-file-if-exists=.env --import tsx src/index.ts | tee /tmp/gw-baseline-client.log
```

In another terminal: `adb logcat -c && adb logcat -s flutter:I | grep --line-buffered anyidea.diag | tee /tmp/client-baseline.log`

Open the app, speak the same 20 sentences as A1 Task 2 Step 7, one at a time, waiting for each reply. Then:

```bash
grep -o 'perceived_ms=[0-9]*' /tmp/client-baseline.log | cut -d= -f2 | sort -n | awk 'function ceil(x){return (x==int(x))?x:int(x)+1} {a[NR]=$1} END{if(NR==0){print "n=0"; exit} print "n="NR, "p50="a[ceil(NR*0.5)], "p90="a[ceil(NR*0.9)]}'
```

Replace the "Client perceived latency" section of `docs/testing/plan-a-latency-baseline.md` with:

```markdown
## Client perceived latency (A2 Task 1)

Date: 2026-10-1x. Commit: <sha>. Device: Xiaomi 22101317C, debug APK. Definition: local VAD silent edge − 120 ms release → first accepted reply audio chunk.

| n | p50 ms | p90 ms |
|---|---|---|
| | | |

Notes: <missing samples and why>.
```

If the device session is blocked for 20 minutes: add a `docs/blockers.md` row and keep the reason in the section; the "P50 not worse than baseline" gate stays open.

- [x] **Step 6: Commit**

```bash
git add app/lib/diag_log.dart app/lib/native_session/session_controller.dart app/test/diag_log_test.dart app/test/native_session_controller_test.dart docs/testing/plan-a-latency-baseline.md
git commit -m "feat(app): log anonymous perceived-latency diagnostics to logcat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: App-side thinking config

**Files:**
- Create: `app/lib/native_session/thinking_config.dart`
- Create: `app/assets/config/thinking.json`
- Modify: `app/pubspec.yaml` (append `- assets/config/`)
- Create: `app/test/support/thinking_fixture.dart`
- Test: `app/test/thinking_config_test.dart`

**Interfaces:**
- Produces:
  ```dart
  class FillerClip { const FillerClip(this.id, this.text); final String id; final String text; }
  class FillerAudioConfig { final int chunkMs; final int maxBufferedMs; final int fadeMs; final double gain; final int pumpMs; }
  class ThinkingConfig {
    final int thinkingSilenceMs, fillerAfterMs, longWaitAfterMs, thinkingMaxMs, tickMs, tailGuardMs, nodFirstAfterMs, nodEveryMs;
    final Set<String> fillerEvidence; // subset of {'transcript','responseStart'}
    final FillerAudioConfig audio;
    final String defaultStyle; final List<String> styles;
    final List<FillerClip> thinkingClips, longWaitClips;
    List<FillerClip> get allClips;
    String clipAsset(String style, String clipId); // 'assets/filler/<style>/<id>.pcm'
    static const assetPath = 'assets/config/thinking.json';
    static ThinkingConfig parse(String source);              // throws FormatException
    factory ThinkingConfig.fromMap(Map<String, Object?> m);  // throws FormatException
  }
  ```
- Produces (test support): `Map<String, Object?> thinkingMap({List<String> evidence})`, `ThinkingConfig testThinking({List<String> evidence})` in `app/test/support/thinking_fixture.dart`.

- [ ] **Step 1: Write the failing test and fixture**

Create `app/test/support/thinking_fixture.dart`:

```dart
import 'package:avatar_app/native_session/thinking_config.dart';

Map<String, Object?> thinkingMap({List<String> evidence = const ['transcript']}) => {
      'thinkingSilenceMs': 300,
      'fillerAfterMs': 1200,
      'longWaitAfterMs': 4000,
      'thinkingMaxMs': 20000,
      'tickMs': 50,
      'tailGuardMs': 400,
      'fillerEvidence': evidence,
      'nod': {'firstAfterMs': 1500, 'everyMs': 4000},
      'audio': {'chunkMs': 20, 'maxBufferedMs': 100, 'fadeMs': 40, 'gain': 1.0, 'pumpMs': 10},
      'defaultStyle': 'grandchild',
      'styles': ['grandchild', 'old-friend'],
      'clips': {
        'thinking': [
          {'id': 'think-1', 'text': '嗯，我想想。'},
          {'id': 'think-2', 'text': '嗯，让我想一想。'},
        ],
        'longWait': [
          {'id': 'wait-1', 'text': '稍等我一下啊。'},
        ],
      },
    };

ThinkingConfig testThinking({List<String> evidence = const ['transcript']}) =>
    ThinkingConfig.fromMap(thinkingMap(evidence: evidence));
```

Create `app/test/thinking_config_test.dart`:

```dart
import 'dart:convert';
import 'dart:io';

import 'package:avatar_app/native_session/thinking_config.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/thinking_fixture.dart';

Map<String, Object?> shipped() =>
    jsonDecode(File(ThinkingConfig.assetPath).readAsStringSync()) as Map<String, Object?>;

void main() {
  test('parses the shipped config within the spec limits', () {
    final c = ThinkingConfig.parse(File(ThinkingConfig.assetPath).readAsStringSync());
    expect(c.defaultStyle, 'grandchild');
    expect(c.audio.chunkMs, lessThanOrEqualTo(40));
    expect(c.audio.maxBufferedMs, lessThanOrEqualTo(100));
    expect(c.audio.fadeMs, lessThanOrEqualTo(100));
    expect(c.thinkingSilenceMs + c.tickMs, lessThanOrEqualTo(500));
    expect(c.clipAsset('grandchild', 'think-1'), 'assets/filler/grandchild/think-1.pcm');
  });

  test('accepts the test fixture', () {
    expect(testThinking().allClips.map((c) => c.id), ['think-1', 'think-2', 'wait-1']);
  });

  test('rejects chunk plus fade above the buffer cap', () {
    final m = shipped();
    (m['audio'] as Map<String, Object?>)['fadeMs'] = 90;
    expect(() => ThinkingConfig.fromMap(m), throwsFormatException);
  });

  test('rejects a default style that is not listed', () {
    final m = shipped()..['defaultStyle'] = 'pirate';
    expect(() => ThinkingConfig.fromMap(m), throwsFormatException);
  });

  test('rejects invalid clip ids, unknown evidence and a too-short thinking timeout', () {
    final badClip = thinkingMap();
    (badClip['clips'] as Map<String, Object?>)['thinking'] = [
      {'id': '../x', 'text': '嗯'},
    ];
    expect(() => ThinkingConfig.fromMap(badClip), throwsFormatException);
    expect(() => ThinkingConfig.fromMap(thinkingMap(evidence: ['vibes'])), throwsFormatException);
    final shortMax = thinkingMap()..['thinkingMaxMs'] = 5000;
    expect(() => ThinkingConfig.fromMap(shortMax), throwsFormatException);
  });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && flutter test test/thinking_config_test.dart`
Expected: FAIL — `thinking_config.dart` not found.

- [ ] **Step 3: Implement the config and asset**

Create `app/assets/config/thinking.json` (set `fillerEvidence` from `docs/research/qwen-plan-a-validation.md` §4a: `["transcript"]` if a user transcript arrives before `response.created`, else `["transcript","responseStart"]`):

```json
{
  "thinkingSilenceMs": 300,
  "fillerAfterMs": 1200,
  "longWaitAfterMs": 4000,
  "thinkingMaxMs": 20000,
  "tickMs": 50,
  "tailGuardMs": 400,
  "fillerEvidence": ["transcript"],
  "nod": { "firstAfterMs": 1500, "everyMs": 4000 },
  "audio": { "chunkMs": 20, "maxBufferedMs": 100, "fadeMs": 40, "gain": 1.0, "pumpMs": 10 },
  "defaultStyle": "grandchild",
  "styles": ["grandchild", "old-friend"],
  "clips": {
    "thinking": [
      { "id": "think-1", "text": "嗯，我想想。" },
      { "id": "think-2", "text": "嗯，让我想一想。" }
    ],
    "longWait": [{ "id": "wait-1", "text": "稍等我一下啊。" }]
  }
}
```

In `app/pubspec.yaml`, append under `flutter: assets:` (after `- assets/web/spike/`):

```yaml
    - assets/config/
```

Create `app/lib/native_session/thinking_config.dart`:

```dart
import 'dart:convert';

class FillerClip {
  const FillerClip(this.id, this.text);

  final String id;
  final String text;
}

class FillerAudioConfig {
  const FillerAudioConfig({
    required this.chunkMs,
    required this.maxBufferedMs,
    required this.fadeMs,
    required this.gain,
    required this.pumpMs,
  });

  final int chunkMs;
  final int maxBufferedMs;
  final int fadeMs;
  final double gain;
  final int pumpMs;
}

/// App-side thresholds for the thinking state and fillers (assets/config/thinking.json).
class ThinkingConfig {
  const ThinkingConfig({
    required this.thinkingSilenceMs,
    required this.fillerAfterMs,
    required this.longWaitAfterMs,
    required this.thinkingMaxMs,
    required this.tickMs,
    required this.tailGuardMs,
    required this.fillerEvidence,
    required this.nodFirstAfterMs,
    required this.nodEveryMs,
    required this.audio,
    required this.defaultStyle,
    required this.styles,
    required this.thinkingClips,
    required this.longWaitClips,
  });

  static const assetPath = 'assets/config/thinking.json';

  final int thinkingSilenceMs;
  final int fillerAfterMs;
  final int longWaitAfterMs;
  final int thinkingMaxMs;
  final int tickMs;
  final int tailGuardMs;
  final Set<String> fillerEvidence;
  final int nodFirstAfterMs;
  final int nodEveryMs;
  final FillerAudioConfig audio;
  final String defaultStyle;
  final List<String> styles;
  final List<FillerClip> thinkingClips;
  final List<FillerClip> longWaitClips;

  List<FillerClip> get allClips => [...thinkingClips, ...longWaitClips];

  String clipAsset(String style, String clipId) => 'assets/filler/$style/$clipId.pcm';

  static ThinkingConfig parse(String source) {
    final Object? raw;
    try {
      raw = jsonDecode(source);
    } on FormatException {
      throw const FormatException('thinking_config_not_json');
    }
    if (raw is! Map<String, Object?>) throw const FormatException('thinking_config_not_object');
    return ThinkingConfig.fromMap(raw);
  }

  factory ThinkingConfig.fromMap(Map<String, Object?> m) {
    final nod = _map(m, 'nod');
    final a = _map(m, 'audio');
    final clips = _map(m, 'clips');
    final audio = FillerAudioConfig(
      chunkMs: _int(a, 'chunkMs', 10, 40),
      maxBufferedMs: _int(a, 'maxBufferedMs', 20, 100),
      fadeMs: _int(a, 'fadeMs', 10, 100),
      gain: _num(a, 'gain', 0.1, 2.0),
      pumpMs: _int(a, 'pumpMs', 5, 40),
    );
    if (audio.chunkMs + audio.fadeMs > audio.maxBufferedMs) {
      throw const FormatException('filler_chunk_plus_fade_exceeds_buffer');
    }
    if (audio.pumpMs > audio.chunkMs) throw const FormatException('filler_pump_slower_than_chunk');
    final styles = _strings(m, 'styles', _isId);
    final defaultStyle = m['defaultStyle'];
    if (defaultStyle is! String || !styles.contains(defaultStyle)) {
      throw const FormatException('default_style_not_listed');
    }
    final cfg = ThinkingConfig(
      thinkingSilenceMs: _int(m, 'thinkingSilenceMs', 100, 1000),
      fillerAfterMs: _int(m, 'fillerAfterMs', 300, 5000),
      longWaitAfterMs: _int(m, 'longWaitAfterMs', 1000, 15000),
      thinkingMaxMs: _int(m, 'thinkingMaxMs', 5000, 60000),
      tickMs: _int(m, 'tickMs', 10, 100),
      tailGuardMs: _int(m, 'tailGuardMs', 0, 1000),
      fillerEvidence: _strings(m, 'fillerEvidence', (s) => s == 'transcript' || s == 'responseStart').toSet(),
      nodFirstAfterMs: _int(nod, 'firstAfterMs', 500, 10000),
      nodEveryMs: _int(nod, 'everyMs', 1000, 20000),
      audio: audio,
      defaultStyle: defaultStyle,
      styles: styles,
      thinkingClips: _clips(clips, 'thinking'),
      longWaitClips: _clips(clips, 'longWait'),
    );
    if (cfg.thinkingMaxMs <= cfg.fillerAfterMs + cfg.longWaitAfterMs) {
      throw const FormatException('thinking_max_too_short');
    }
    // Spec gate: thinking must show within 500 ms of local silence.
    if (cfg.thinkingSilenceMs + cfg.tickMs > 500) throw const FormatException('thinking_too_slow');
    final ids = cfg.allClips.map((c) => c.id).toList();
    if (ids.toSet().length != ids.length) throw const FormatException('duplicate_clip_id');
    return cfg;
  }
}

final _idPattern = RegExp(r'^[a-z0-9-]{1,32}$');

bool _isId(String s) => _idPattern.hasMatch(s);

Map<String, Object?> _map(Map<String, Object?> m, String key) {
  final v = m[key];
  if (v is! Map<String, Object?>) throw FormatException('missing_$key');
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

List<String> _strings(Map<String, Object?> m, String key, bool Function(String) valid) {
  final v = m[key];
  if (v is! List || v.isEmpty) throw FormatException('${key}_invalid');
  final out = <String>[];
  for (final e in v) {
    if (e is! String || !valid(e)) throw FormatException('${key}_invalid');
    out.add(e);
  }
  return out;
}

List<FillerClip> _clips(Map<String, Object?> m, String key) {
  final v = m[key];
  if (v is! List || v.isEmpty) throw FormatException('clips_${key}_missing');
  final out = <FillerClip>[];
  for (final c in v) {
    if (c is! Map) throw const FormatException('clip_invalid');
    final id = c['id'];
    final text = c['text'];
    if (id is! String || !_isId(id) || text is! String || text.isEmpty || text.length > 20) {
      throw const FormatException('clip_invalid');
    }
    out.add(FillerClip(id, text));
  }
  return out;
}
```

- [ ] **Step 4: Run tests and analyze**

Run: `cd app && flutter test test/thinking_config_test.dart && flutter analyze`
Expected: 5 tests PASS; no issues.

- [ ] **Step 5: Commit**

```bash
git add app/lib/native_session/thinking_config.dart app/assets/config/thinking.json app/pubspec.yaml app/test/support/thinking_fixture.dart app/test/thinking_config_test.dart
git commit -m "feat(app): add validated thinking-state and filler config

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Same-voice filler clips (assumption 4)

**Files:**
- Create: `gateway/scripts/lib/pcm-tools.ts`
- Create: `gateway/scripts/make-filler-clips.ts`
- Create: `app/assets/filler/grandchild/{think-1,think-2,wait-1}.pcm`, `app/assets/filler/old-friend/{think-1,think-2,wait-1}.pcm`
- Modify: `app/pubspec.yaml` (append two asset dirs)
- Modify: `docs/research/qwen-plan-a-validation.md` (add §4)
- Test: `gateway/test/pcmTools.test.ts`, `app/test/filler_assets_test.dart`

**Interfaces:**
- Consumes: `QwenRaw`, `baseSession`, `userText`, `probeEnv`, `writeWav` (A1 Task 1); `app/assets/config/thinking.json` (Task 2); style voices from `gateway/roles/elder-companion/role.json` (A1 Task 4).
- Produces (`pcm-tools.ts`): `rms(pcm, start, end): number`, `trimSilence(pcm, threshold, windowSamples, padSamples): Int16Array`, `normalizePeak(pcm, targetPeak): Int16Array`, `sameText(a, b): boolean`.
- Produces: one 24 kHz mono s16le raw PCM file per clip id per style, 0.3–2.5 s long.

- [ ] **Step 1: Write the failing tests**

Create `gateway/test/pcmTools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizePeak, sameText, trimSilence } from '../scripts/lib/pcm-tools.ts';

describe('pcm tools', () => {
  it('trims leading and trailing silence but keeps a pad', () => {
    const pcm = new Int16Array(4800);
    pcm.fill(5000, 2400, 3360); // 40 ms of sound at 100–140 ms
    const out = trimSilence(pcm, 300, 480, 240);
    expect(out.length).toBe(960 + 2 * 240);
    expect(out[240]).toBe(5000);
  });

  it('returns empty audio when everything is silent', () => {
    expect(trimSilence(new Int16Array(4800), 300, 480, 240).length).toBe(0);
  });

  it('normalizes the peak without clipping', () => {
    const out = normalizePeak(new Int16Array([1000, -2000, 500]), 16000);
    expect(Array.from(out)).toEqual([8000, -16000, 4000]);
  });

  it('compares transcripts ignoring punctuation and spaces', () => {
    expect(sameText('嗯，我想想。', '嗯 我想想')).toBe(true);
    expect(sameText('嗯，我想一想。', '嗯，我想想。')).toBe(false);
  });
});
```

Create `app/test/filler_assets_test.dart`:

```dart
import 'dart:io';

import 'package:avatar_app/native_session/thinking_config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('every configured clip exists for every style as 24 kHz PCM16 of sane length', () {
    final cfg = ThinkingConfig.parse(File(ThinkingConfig.assetPath).readAsStringSync());
    for (final style in cfg.styles) {
      for (final clip in cfg.allClips) {
        final f = File(cfg.clipAsset(style, clip.id));
        expect(f.existsSync(), isTrue, reason: f.path);
        final bytes = f.lengthSync();
        expect(bytes.isEven, isTrue, reason: f.path);
        expect(bytes / 2 / 24, inInclusiveRange(300, 2500), reason: f.path);
      }
    }
  });
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w gateway -- test/pcmTools.test.ts` and `cd app && flutter test test/filler_assets_test.dart`
Expected: FAIL — `pcm-tools.ts` not found; clip files missing.

- [ ] **Step 3: Implement the PCM tools and the recorder**

Create `gateway/scripts/lib/pcm-tools.ts`:

```ts
export function rms(pcm: Int16Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += pcm[i]! * pcm[i]!;
  return end > start ? Math.sqrt(sum / (end - start)) : 0;
}

/** Cuts silence before the first and after the last window whose RMS reaches `threshold`. */
export function trimSilence(pcm: Int16Array, threshold: number, windowSamples: number, padSamples: number): Int16Array {
  let first = -1;
  let last = -1;
  for (let o = 0; o < pcm.length; o += windowSamples) {
    const end = Math.min(pcm.length, o + windowSamples);
    if (rms(pcm, o, end) >= threshold) {
      if (first < 0) first = o;
      last = end;
    }
  }
  if (first < 0) return new Int16Array(0);
  return pcm.slice(Math.max(0, first - padSamples), Math.min(pcm.length, last + padSamples));
}

export function normalizePeak(pcm: Int16Array, targetPeak: number): Int16Array {
  let peak = 0;
  for (const s of pcm) peak = Math.max(peak, Math.abs(s));
  if (peak === 0) return pcm.slice();
  const g = targetPeak / peak;
  return Int16Array.from(pcm, (s) => Math.max(-32768, Math.min(32767, Math.round(s * g))));
}

export function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[\s\p{P}]/gu, '');
  return norm(a) === norm(b);
}
```

Create `gateway/scripts/make-filler-clips.ts`:

```ts
// Records filler clips in a style's voice (spec assumption 4, option "realtime model + text").
// Usage (from gateway/): node --env-file-if-exists=.env --import tsx scripts/make-filler-clips.ts \
//   --config ../app/assets/config/thinking.json --style grandchild --out ../app/assets/filler/grandchild [--voice <v>] [--tone 亲切活泼] [--attempts 3]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { baseSession, probeEnv, QwenRaw, userText, writeWav } from './lib/qwen-raw.ts';
import { normalizePeak, sameText, trimSilence } from './lib/pcm-tools.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const configPath = flag('config');
const style = flag('style');
const outDir = flag('out');
if (!configPath || !style || !outDir) throw new Error('--config, --style and --out are required');

const Clip = z.object({ id: z.string().regex(/^[a-z0-9-]{1,32}$/), text: z.string().min(1).max(20) });
const cfg = z.object({ clips: z.object({ thinking: z.array(Clip).min(1), longWait: z.array(Clip).min(1) }) }).parse(JSON.parse(readFileSync(configPath, 'utf8')));
const env = probeEnv();
const voice = flag('voice') ?? env.voice;
const tone = flag('tone') ?? '亲切温和';
const attempts = Number(flag('attempts') ?? 3);
const instructions = `你是录音员。用户让你说哪句话，你就用${tone}的语气把那一句原样说出来，一个字也不加，不要回答别的。`;
mkdirSync(outDir, { recursive: true });

let failures = 0;
for (const clip of [...cfg.clips.thinking, ...cfg.clips.longWait]) {
  let best: Int16Array | null = null;
  let matched = false;
  for (let i = 1; i <= attempts && !matched; i++) {
    const c = await QwenRaw.open({ apiKey: env.apiKey, endpoint: env.endpoint, model: env.model, session: baseSession(instructions, voice) });
    const r = await c.collect(() => { c.send(userText(`请原样说：${clip.text}`)); c.send({ type: 'response.create' }); });
    c.close();
    const pcm = normalizePeak(trimSilence(r.audio, 300, 480, 720), Math.round(0.7 * 32767));
    matched = r.error === null && pcm.length > 0 && sameText(r.transcript, clip.text);
    if (pcm.length > 0) best = pcm;
    process.stdout.write(`${JSON.stringify({ style, id: clip.id, attempt: i, status: r.status, matched, ms: Math.round(pcm.length / 24) })}\n`);
  }
  if (!best) { failures++; continue; }
  writeFileSync(`${outDir}/${clip.id}.pcm`, Buffer.from(best.buffer, best.byteOffset, best.byteLength));
  writeWav(`/tmp/filler-${style}-${clip.id}.wav`, best, 24000);
  if (!matched) failures++;
}
process.exit(failures === 0 ? 0 : 2);
```

Run: `npm test -w gateway -- test/pcmTools.test.ts && npm run typecheck -w gateway`
Expected: 4 tests PASS; typecheck clean.

- [ ] **Step 4: Record the clips (manual, needs the key)**

Use each style's voice from `gateway/roles/elder-companion/role.json` (omit `--voice` when it is `null`):

```bash
cd gateway
node --env-file-if-exists=.env --import tsx scripts/make-filler-clips.ts --config ../app/assets/config/thinking.json --style grandchild --out ../app/assets/filler/grandchild --voice <grandchild voice> --tone 年轻亲切
node --env-file-if-exists=.env --import tsx scripts/make-filler-clips.ts --config ../app/assets/config/thinking.json --style old-friend --out ../app/assets/filler/old-friend --voice <old-friend voice> --tone 平稳温和
for f in /tmp/filler-*.wav; do echo "$f"; afplay "$f"; done
```

Expected: exit code 0 for both runs (every clip matched its text). The user listens and confirms per clip: exact words, voice equals the style's reply voice, 0.4–2.0 s, no clipping or cut-off syllables.

Fallback if Qwen cannot produce matching clips after 3 attempts, or the voice is wrong: record a `docs/blockers.md` row ("filler voice differs from reply voice"), then generate placeholder clips with macOS `say` so the feature can still be tested (run from the repo root, once per style directory):

```bash
VOICE_ZH="$(say -v '?' | awk '/zh_CN/ {sub(/[[:space:]]+zh_CN.*/, ""); print; exit}')"
for spec in "think-1:嗯，我想想。" "think-2:嗯，让我想一想。" "wait-1:稍等我一下啊。"; do
  id="${spec%%:*}"; text="${spec#*:}"
  say -v "$VOICE_ZH" -o "/tmp/$id.aiff" "$text"
  afconvert -f WAVE -d LEI16@24000 -c 1 "/tmp/$id.aiff" "/tmp/$id.wav"
  python3 -I -c 'import sys,wave; w=wave.open(sys.argv[1],"rb"); open(sys.argv[2],"wb").write(w.readframes(w.getnframes()))' "/tmp/$id.wav" "app/assets/filler/grandchild/$id.pcm"
done
```

(These phrases must match `thinking.json`; change them together.)

Append to `docs/research/qwen-plan-a-validation.md`:

```markdown
## 4. Filler clip generation

Method used: <realtime model + text prompt (make-filler-clips.ts) | macOS say fallback>.

| style | clip | attempts | matched | ms | listener verdict |
|---|---|---|---|---|---|

Decision: <clips accepted | fallback in use, blocker #n>.
```

- [ ] **Step 5: Register the clip directories**

In `app/pubspec.yaml`, append under `flutter: assets:` (after `- assets/config/`):

```yaml
    - assets/filler/grandchild/
    - assets/filler/old-friend/
```

Run: `cd app && flutter test test/filler_assets_test.dart && flutter analyze`
Expected: PASS; no issues.

- [ ] **Step 6: Commit**

```bash
git add gateway/scripts/lib/pcm-tools.ts gateway/scripts/make-filler-clips.ts gateway/test/pcmTools.test.ts app/assets/filler app/pubspec.yaml app/test/filler_assets_test.dart docs/research/qwen-plan-a-validation.md
git commit -m "feat(app): add same-voice filler clips and their recording script

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Add `docs/blockers.md` if Step 4 used the fallback.)

---

### Task 4: `FillerPlayer` on the shared native player

**Files:**
- Create: `app/lib/native_audio/filler_player.dart`
- Modify: `app/lib/native_audio/audio_types.dart`
- Modify: `app/lib/native_audio/native_audio_io.dart`
- Test: `app/test/filler_player_test.dart`, `app/test/native_playback_queue_test.dart`, `app/test/native_session_controller_test.dart` (fake)

**Interfaces:**
- Consumes: `FillerAudioConfig` (Task 2).
- Produces (`filler_player.dart`):
  ```dart
  abstract interface class PcmSink { bool get busy; Future<void> feed(Int16List pcm); }
  class FillerPlayer {
    FillerPlayer({required PcmSink sink, required FillerAudioConfig cfg, int sampleRate = 24000, int Function()? now});
    bool get active;
    void play(Int16List clip, {void Function()? onDone});
    Future<void> pump();
    void stop();
    Future<void> fadeOut();
    int bufferedSamples();
    void updateRemaining(int remainingFrames);
  }
  ```
- Produces (`NativeAudioIO` additions):
  ```dart
  bool get fillerActive;
  Future<void> playFiller(Int16List clip, {required void Function() onDone});
  Future<void> stopFiller({required bool fade});
  ```
  `PluginNativeAudioIO({AudioRecorder? recorder, FillerAudioConfig? filler})` — without `filler` config, `playFiller` calls `onDone` immediately (no audio). `pushResponse` fades an active filler before feeding the reply; `stopResponse` and `stop` stop it.

- [ ] **Step 1: Write the failing tests**

Create `app/test/filler_player_test.dart`:

```dart
import 'dart:typed_data';

import 'package:avatar_app/native_audio/filler_player.dart';
import 'package:avatar_app/native_session/thinking_config.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeSink implements PcmSink {
  final fed = <Int16List>[];
  @override
  bool busy = false;

  @override
  Future<void> feed(Int16List pcm) async => fed.add(pcm);
}

const audio = FillerAudioConfig(chunkMs: 20, maxBufferedMs: 100, fadeMs: 40, gain: 0.5, pumpMs: 10);

Int16List tone(int ms, [int value = 10000]) => Int16List(24 * ms)..fillRange(0, 24 * ms, value);

void main() {
  test('feeds chunks of at most chunkMs and never buffers more than maxBufferedMs', () async {
    var now = 0;
    final sink = FakeSink();
    var done = 0;
    final p = FillerPlayer(sink: sink, cfg: audio, now: () => now)..play(tone(1000), onDone: () => done++);
    for (; now <= 1200; now += 10) {
      await p.pump();
      expect(p.bufferedSamples(), lessThanOrEqualTo(2400));
    }
    expect(sink.fed.every((c) => c.length <= 480), isTrue);
    expect(sink.fed.fold<int>(0, (n, c) => n + c.length), 24000);
    expect(p.active, isFalse);
    expect(done, 1);
  });

  test('applies the configured gain', () async {
    final sink = FakeSink();
    final p = FillerPlayer(sink: sink, cfg: audio, now: () => 0)..play(tone(100));
    await p.pump();
    expect(sink.fed.first.first, 5000);
  });

  test('stop drops the rest immediately and reports done once', () async {
    final sink = FakeSink();
    var done = 0;
    final p = FillerPlayer(sink: sink, cfg: audio, now: () => 0)..play(tone(1000), onDone: () => done++);
    await p.pump();
    final fedBefore = sink.fed.length;
    p.stop();
    p.stop();
    await p.pump();
    expect(sink.fed.length, fedBefore);
    expect(done, 1);
  });

  test('fadeOut feeds one ramp-down within the buffer cap, then stops', () async {
    final sink = FakeSink();
    final p = FillerPlayer(sink: sink, cfg: audio, now: () => 0)..play(tone(1000));
    await p.pump(); // 60 ms buffered
    await p.fadeOut();
    final ramp = sink.fed.last;
    expect(ramp.length, 960); // 40 ms
    expect(ramp.last, 0);
    expect(ramp.first, greaterThan(ramp[ramp.length ~/ 2]));
    expect(p.bufferedSamples(), lessThanOrEqualTo(2400));
    expect(p.active, isFalse);
  });

  test('does not feed while a reply owns the player', () async {
    final sink = FakeSink()..busy = true;
    final p = FillerPlayer(sink: sink, cfg: audio, now: () => 0)..play(tone(100));
    await p.pump();
    expect(sink.fed, isEmpty);
  });

  test('trusts the native remaining-frames report over the wall clock', () async {
    var now = 0;
    final sink = FakeSink();
    final p = FillerPlayer(sink: sink, cfg: audio, now: () => now)..play(tone(1000));
    await p.pump(); // 1440 samples fed
    now = 20; // wall clock says 480 played
    p.updateRemaining(1440); // the player actually started late
    final fedBefore = sink.fed.length;
    await p.pump();
    expect(sink.fed.length, fedBefore);
  });
}
```

Append to `app/test/native_playback_queue_test.dart`:

```dart
  test('filler residue queued ahead of a reply is not counted as played', () {
    final q = PlaybackQueue(sampleRate: 24000);
    q.start(9);
    q.markFed(9, 2400);
    q.updateRemaining(9, 2400 + 1200); // 50 ms of filler still ahead in the native buffer
    expect(q.playedMs, 0);
    q.updateRemaining(9, 1200);
    expect(q.playedMs, 50);
  });
```

In `app/test/native_session_controller_test.dart`, add to `FakeAudio`:

```dart
  final fillerPlays = <int>[];
  final fillerStops = <bool>[];
  void Function()? _fillerDone;

  @override
  bool fillerActive = false;

  @override
  Future<void> playFiller(Int16List clip, {required void Function() onDone}) async {
    fillerPlays.add(clip.length);
    fillerActive = true;
    _fillerDone = onDone;
  }

  @override
  Future<void> stopFiller({required bool fade}) async {
    fillerStops.add(fade);
    finishFiller();
  }

  void finishFiller() {
    if (!fillerActive) return;
    fillerActive = false;
    final done = _fillerDone;
    _fillerDone = null;
    done?.call();
  }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd app && flutter test test/filler_player_test.dart test/native_playback_queue_test.dart test/native_session_controller_test.dart`
Expected: FAIL — `filler_player.dart` not found; `FakeAudio` overrides members that `NativeAudioIO` does not declare. (The playback-queue test passes already: it documents that the existing `fed − remaining` rule excludes filler residue.)

- [ ] **Step 3: Implement the player and the interface**

Create `app/lib/native_audio/filler_player.dart`:

```dart
import 'dart:math' as math;
import 'dart:typed_data';

import '../native_session/thinking_config.dart';

/// Destination of filler PCM. The native player is shared with replies.
abstract interface class PcmSink {
  /// True once a real reply has fed audio; the filler must not feed then.
  bool get busy;
  Future<void> feed(Int16List pcm);
}

int _wallClockMs() => DateTime.now().millisecondsSinceEpoch;

/// Plays one short filler clip in gain-scaled chunks of at most `chunkMs`, keeping at most
/// `maxBufferedMs` queued in the native player so it can stop or fade quickly.
class FillerPlayer {
  FillerPlayer({required this.sink, required this.cfg, this.sampleRate = 24000, int Function()? now})
      : _now = now ?? _wallClockMs;

  final PcmSink sink;
  final FillerAudioConfig cfg;
  final int sampleRate;
  final int Function() _now;

  Int16List _clip = Int16List(0);
  int _offset = 0;
  int _fed = 0;
  int _anchorPlayed = 0;
  int? _anchorAt;
  bool _active = false;
  bool _pumping = false;
  void Function()? _onDone;

  bool get active => _active;
  int get _chunk => sampleRate * cfg.chunkMs ~/ 1000;
  int get _cap => sampleRate * cfg.maxBufferedMs ~/ 1000;
  int get _fade => sampleRate * cfg.fadeMs ~/ 1000;

  /// Steady-state fill level: leaves room for one fade chunk under the cap.
  int get _target => _cap - _fade;

  void play(Int16List clip, {void Function()? onDone}) {
    stop();
    _clip = clip;
    _offset = 0;
    _fed = 0;
    _anchorPlayed = 0;
    _anchorAt = null;
    _onDone = onDone;
    _active = clip.isNotEmpty;
    if (!_active) _finish();
  }

  /// Samples fed but (by estimate) not yet played.
  int bufferedSamples() {
    final at = _anchorAt;
    if (at == null) return 0;
    final played = math.min(_fed, _anchorPlayed + (_now() - at) * sampleRate ~/ 1000);
    return _fed - played;
  }

  /// Native report of queued frames; while the filler is active they are all filler.
  void updateRemaining(int remainingFrames) {
    if (!_active || _anchorAt == null) return;
    _anchorPlayed = (_fed - remainingFrames).clamp(0, _fed);
    _anchorAt = _now();
  }

  /// Feeds up to the steady-state level; finishes once the clip has drained.
  Future<void> pump() async {
    if (!_active || _pumping || sink.busy) return;
    _pumping = true;
    try {
      while (_active && !sink.busy && _offset < _clip.length && bufferedSamples() + _chunk <= _target) {
        final start = _offset;
        final end = math.min(_offset + _chunk, _clip.length);
        _offset = end; // claim first so a concurrent fade never repeats samples
        await _feed(_scaled(start, end, (_) => cfg.gain));
      }
      if (_active && _offset >= _clip.length && bufferedSamples() == 0) _finish();
    } finally {
      _pumping = false;
    }
  }

  /// Stops feeding now; at most `maxBufferedMs` already queued drains by itself.
  void stop() {
    if (!_active) return;
    _clip = Int16List(0);
    _offset = 0;
    _finish();
  }

  /// Feeds one short ramp-down so the filler does not end on a click, then stops.
  Future<void> fadeOut() async {
    if (!_active) return;
    final room = math.max(0, _cap - bufferedSamples());
    final len = math.min(_fade, math.min(room, _clip.length - _offset));
    if (len > 0) {
      final start = _offset;
      _offset += len;
      await _feed(_scaled(start, start + len, (i) => cfg.gain * (1 - (i + 1) / len)));
    }
    stop();
  }

  Future<void> _feed(Int16List pcm) {
    _anchorAt ??= _now();
    _fed += pcm.length;
    return sink.feed(pcm);
  }

  Int16List _scaled(int start, int end, double Function(int i) gainAt) {
    final out = Int16List(end - start);
    for (var i = 0; i < out.length; i++) {
      out[i] = (_clip[start + i] * gainAt(i)).round().clamp(-32768, 32767);
    }
    return out;
  }

  void _finish() {
    _active = false;
    final done = _onDone;
    _onDone = null;
    done?.call();
  }
}
```

In `app/lib/native_audio/audio_types.dart`, add to `NativeAudioIO` (after `setInputEnabled`):

```dart
  /// True while a filler clip is being fed.
  bool get fillerActive;

  /// Plays a short local filler clip ahead of the reply; [onDone] runs once it stops or drains.
  Future<void> playFiller(Int16List clip, {required void Function() onDone});

  /// Stops the filler independently of any reply; [fade] feeds a short ramp-down first.
  Future<void> stopFiller({required bool fade});
```

- [ ] **Step 4: Implement the filler in `PluginNativeAudioIO`**

In `app/lib/native_audio/native_audio_io.dart`:
- imports: `import '../native_session/thinking_config.dart';` and `import 'filler_player.dart';`
- constructor and fields:
  ```dart
  PluginNativeAudioIO({AudioRecorder? recorder, FillerAudioConfig? filler})
    : _recorder = recorder ?? AudioRecorder(),
      _fillerCfg = filler;

  final FillerAudioConfig? _fillerCfg;
  late final FillerPlayer? _filler = _fillerCfg == null
      ? null
      : FillerPlayer(sink: _FillerSink(this), cfg: _fillerCfg, sampleRate: nativePlaybackSampleRate);
  Timer? _fillerTimer;
  ```
- new members:
  ```dart
  @override
  bool get fillerActive => _filler?.active ?? false;

  @override
  Future<void> playFiller(Int16List clip, {required void Function() onDone}) async {
    final filler = _filler;
    final cfg = _fillerCfg;
    if (filler == null || cfg == null) {
      onDone();
      return;
    }
    await _ensurePlayback();
    _fillerTimer?.cancel();
    filler.play(clip, onDone: () {
      _fillerTimer?.cancel();
      _fillerTimer = null;
      onDone();
    });
    if (!filler.active) return;
    _fillerTimer = Timer.periodic(Duration(milliseconds: cfg.pumpMs), (_) => unawaited(filler.pump()));
    await filler.pump();
  }

  @override
  Future<void> stopFiller({required bool fade}) async {
    final filler = _filler;
    if (filler == null || !filler.active) return;
    if (fade) {
      await filler.fadeOut();
    } else {
      filler.stop();
    }
  }

  Future<void> _feedFiller(Int16List pcm) async {
    await FlutterPcmSound.feed(PcmArrayInt16(bytes: ByteData.sublistView(pcm)));
    FlutterPcmSound.start();
  }
  ```
- in `pushResponse`, right after the `_acceptedChunks++;` line add:
  ```dart
    // Safety net: the reply must never queue behind more than a short faded filler tail.
    if (_filler?.active ?? false) await _filler!.fadeOut();
  ```
- in `stopResponse`, right after the `if (_activeSeq == null) { ... }` block add `_filler?.stop();`
- in `stop()`, at the top add:
  ```dart
    _fillerTimer?.cancel();
    _fillerTimer = null;
    _filler?.stop();
  ```
- in `_onFeed`, as the first line add `_filler?.updateRemaining(remainingFrames);`
- at the end of the file add:
  ```dart
  class _FillerSink implements PcmSink {
    _FillerSink(this._io);

    final PluginNativeAudioIO _io;

    /// A reply owns the player once it has fed audio for the active sequence.
    @override
    bool get busy => _io._activeSeq != null && _io._queue.hasFedSamples;

    @override
    Future<void> feed(Int16List pcm) => _io._feedFiller(pcm);
  }
  ```

- [ ] **Step 5: Run tests and analyze**

Run: `cd app && flutter test && flutter analyze`
Expected: all PASS; no issues.

- [ ] **Step 6: Commit**

```bash
git add app/lib/native_audio/filler_player.dart app/lib/native_audio/audio_types.dart app/lib/native_audio/native_audio_io.dart app/test/filler_player_test.dart app/test/native_playback_queue_test.dart app/test/native_session_controller_test.dart
git commit -m "feat(app): play filler clips in small chunks on the shared native player

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `ThinkingController` state machine

**Files:**
- Create: `app/lib/native_session/thinking_controller.dart`
- Test: `app/test/thinking_controller_test.dart`

**Interfaces:**
- Consumes: `ThinkingConfig`, `FillerClip` (Task 2); `testThinking()` (Task 2 fixture).
- Produces:
  ```dart
  sealed class ThinkCommand {}
  final class SetAvatarState extends ThinkCommand { final String state; }      // 'listening'|'thinking'|'speaking'|'idle'
  final class PlayFiller extends ThinkCommand { final FillerClip clip; }
  final class StopFiller extends ThinkCommand { final bool fade; }
  final class Backchannel extends ThinkCommand {}                                // subtle nod
  final class ThinkDiag extends ThinkCommand { final String event; final Map<String, Object> fields; }
  class ThinkingController {
    ThinkingController(ThinkingConfig cfg, {required int vadReleaseMs});
    int get fillersThisTurn; bool get fillerPlaying; String get phase;
    bool zeroUplink(int now); bool guardsSpeech(int now);
    List<ThinkCommand> onVadSpeaking(int now);
    List<ThinkCommand> onVadSilent(int now);
    void onUserTranscript();
    void onModelReconnecting();
    List<ThinkCommand> onResponseStart(int now, {required bool reply});
    List<ThinkCommand> onFirstAudio(int now);
    List<ThinkCommand> onPlaybackEnded(int now, {required int playedMs});
    List<ThinkCommand> onCancelled(int now);
    void onFillerDone(int now);
    List<ThinkCommand> tick(int now);
  }
  ```
  Diagnostics emitted: `thinking after_silence_ms=<n>`, `filler kind=thinking|long_wait after_thinking_ms=<n>`, `filler_skipped reason=no_evidence`, `filler_stopped reason=speech`, `thinking_timeout ms=<n>`.

- [ ] **Step 1: Write the failing tests**

Create `app/test/thinking_controller_test.dart`:

```dart
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

  test('gives up thinking after thinkingMaxMs', () {
    final t = withFiller();
    final c = t.tick(21180);
    expect(c.whereType<StopFiller>(), hasLength(1));
    expect(states(c), ['idle']);
    expect(c.whereType<ThinkDiag>().single.event, 'thinking_timeout');
  });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && flutter test test/thinking_controller_test.dart`
Expected: FAIL — `thinking_controller.dart` not found.

- [ ] **Step 3: Implement**

Create `app/lib/native_session/thinking_controller.dart`:

```dart
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
    if (_phase == _Phase.idle || _phase == _Phase.speaking) _resetTurn();
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
    _phase = _Phase.idle;
    _resetTurn();
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
    if (_silenceAt == null || _fillerPlaying) return const []; // fillers only answer a user turn
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
    _skipLogged = false;
  }
}
```

- [ ] **Step 4: Run tests and analyze**

Run: `cd app && flutter test test/thinking_controller_test.dart && flutter analyze`
Expected: 11 tests PASS; no issues.

- [ ] **Step 5: Commit**

```bash
git add app/lib/native_session/thinking_controller.dart app/test/thinking_controller_test.dart
git commit -m "feat(app): add the client thinking-state controller

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Wire thinking into `NativeSessionController`

**Files:**
- Modify: `app/lib/native_session/session_controller.dart`
- Test: `app/test/native_session_controller_test.dart`

**Interfaces:**
- Consumes: `ThinkingController` + commands (Task 5), `NativeAudioIO.playFiller/stopFiller` (Task 4), `formatDiag` (Task 1), `ThinkingConfig` (Task 2).
- Produces (`NativeSessionController` constructor, optional additions): `ThinkingConfig? thinking`, `Map<String, Int16List> fillerPcm = const {}`, `bool autoTick = true`; public `void tickThinking()` (driven by a periodic timer at `thinking.tickMs`; tests call it directly with `autoTick: false`).
- Behavior: emits `UiState` from thinking commands; `UiState('speaking')` only on the first accepted audio chunk (also when `thinking` is null); `UiSubtitle(role:'assistant', text: <filler text>, isFinal:false)` when a filler starts; `UiAvatarAction(action:'nod', source:'backchannel')` for listening nods; zero frames uplink while `zeroUplink`; speech while `guardsSpeech` sends `vad speaking` but does not stop playback; `playedMs==0` ended emits no `idle`.

- [ ] **Step 1: Write the failing tests**

In `app/test/native_session_controller_test.dart`:
- add imports:
  ```dart
  import 'package:avatar_app/native_session/thinking_config.dart';
  import 'support/thinking_fixture.dart';
  ```
- extend `SessionFakes.controller`:
  ```dart
  NativeSessionController controller({
    DiagSink? diag,
    int Function()? now,
    ThinkingConfig? thinking,
    Map<String, Int16List> fillerPcm = const {},
  }) =>
      NativeSessionController(
        audio: audio,
        detector: detector,
        client: client,
        emit: events.add,
        diag: diag ?? (_) {},
        now: now,
        thinking: thinking,
        fillerPcm: fillerPcm,
        autoTick: false,
      );
  ```
- in `FakeClient`, record uplink frames:
  ```dart
  final audioFrames = <Int16List>[];

  @override
  void sendAudio(Int16List pcm16k) => audioFrames.add(pcm16k);
  ```
  (replace the existing no-op `sendAudio`)
- add inside `main()`:
  ```dart
  group('thinking state', () {
    late SessionFakes f;
    late NativeSessionController c;
    var now = 0;
    final clips = {'think-1': Int16List(2400), 'think-2': Int16List(2400), 'wait-1': Int16List(2400)};

    List<String> states() => f.events.whereType<UiState>().map((e) => e.state).toList();

    Future<void> speakThenPause() async {
      f.detector.queued.add(SpeechEdge.speaking);
      f.audio.emitFrame(Int16List(320));
      f.client.emit(const TranscriptUser('嗯', false));
      now = 1000;
      f.detector.queued.add(SpeechEdge.silent);
      f.audio.emitFrame(Int16List(320));
      await pumpEvents();
    }

    Future<void> tickAt(int t) async {
      now = t;
      c.tickThinking();
      await pumpEvents();
    }

    setUp(() async {
      now = 0;
      f = SessionFakes();
      c = f.controller(thinking: testThinking(), fillerPcm: clips, now: () => now);
      await c.start();
    });

    test('shows listening, then thinking within 300 ms of silence', () async {
      await speakThenPause();
      expect(states().last, 'listening');
      await tickAt(1180);
      expect(states().last, 'thinking');
    });

    test('plays a filler with its subtitle and sends zero frames while it plays', () async {
      await speakThenPause();
      await tickAt(1180);
      await tickAt(2380);
      expect(f.audio.fillerPlays, [2400]);
      expect(f.events.whereType<UiSubtitle>().last.text, '嗯，我想想。');
      f.audio.emitFrame(Int16List(320)..fillRange(0, 320, 900));
      expect(f.client.audioFrames.last.every((s) => s == 0), isTrue);
    });

    test('local speech during a filler stops the filler and keeps the reply', () async {
      await speakThenPause();
      await tickAt(1180);
      await tickAt(2380);
      f.client.emit(const ResponseStart(5, 'reply'));
      await pumpEvents();
      now = 2500;
      f.detector.queued.add(SpeechEdge.speaking);
      f.audio.emitFrame(Int16List(320));
      await pumpEvents();
      expect(f.audio.fillerStops, [false]);
      expect(f.audio.stopCalls, isEmpty);
      expect(f.client.sent.whereType<PlaybackStopped>(), isEmpty);
      expect(f.client.sent.whereType<VadMessage>().last.state, 'speaking');
    });

    test('switches to speaking on the first audio frame, not on response.start', () async {
      await speakThenPause();
      f.client.emit(const ResponseStart(6, 'reply'));
      await pumpEvents();
      expect(states(), isNot(contains('speaking')));
      f.client.emitAudio(6, Int16List(2400));
      await pumpEvents();
      expect(states().last, 'speaking');
    });

    test('an empty ended reply keeps thinking until the timeout', () async {
      await speakThenPause();
      f.client.emit(const ResponseStart(7, 'reply'));
      await pumpEvents();
      f.audio.onPlaybackEnded?.call(const PlayedAudio(responseSeq: 7, playedMs: 0));
      await pumpEvents();
      expect(states().last, 'thinking');
      await tickAt(21000);
      expect(states().last, 'idle');
    });

    test('nods while the user keeps talking', () async {
      f.detector.queued.add(SpeechEdge.speaking);
      f.audio.emitFrame(Int16List(320));
      await tickAt(1500);
      final nod = f.events.whereType<UiAvatarAction>().single;
      expect([nod.action, nod.source], ['nod', 'backchannel']);
    });
  });

  test('without a thinking config, speaking still follows the first audio frame', () async {
    final f = SessionFakes();
    final c = f.controller();
    await c.start();
    f.client.emit(const ResponseStart(3, 'reply'));
    await pumpEvents();
    expect(f.events.whereType<UiState>().map((e) => e.state), isNot(contains('speaking')));
    f.client.emitAudio(3, Int16List(2400));
    await pumpEvents();
    expect(f.events.whereType<UiState>().last.state, 'speaking');
  });
  ```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd app && flutter test test/native_session_controller_test.dart`
Expected: FAIL — `thinking`, `fillerPcm`, `autoTick`, `tickThinking` do not exist; no `speaking` state is emitted.

- [ ] **Step 3: Implement the wiring**

In `app/lib/native_session/session_controller.dart`:
- imports:
  ```dart
  import 'thinking_config.dart';
  import 'thinking_controller.dart';
  ```
- constructor (replace the Task 1 version):
  ```dart
  NativeSessionController({
    required this.audio,
    required this.detector,
    required this.client,
    required this.emit,
    this.diag = logcatDiagSink,
    int Function()? now,
    ThinkingConfig? thinking,
    Map<String, Int16List> fillerPcm = const {},
    bool autoTick = true,
  })  : _now = now ?? _wallClockMs,
        _thinkingCfg = thinking,
        _thinking = thinking == null ? null : ThinkingController(thinking, vadReleaseMs: defaultVadReleaseMs),
        _fillerPcm = fillerPcm,
        _autoTick = autoTick {
    client.attachEvents(this);
  }
  ```
- fields:
  ```dart
  final ThinkingConfig? _thinkingCfg;
  final ThinkingController? _thinking;
  final Map<String, Int16List> _fillerPcm;
  final bool _autoTick;
  Timer? _tickTimer;
  ```
- in `start()`, after `_started = true;` add `_startTicker();`
- in `stop()`, as the first lines after `_ended = true;` add:
  ```dart
    _tickTimer?.cancel();
    _tickTimer = null;
  ```
- new methods:
  ```dart
  void _startTicker() {
    final cfg = _thinkingCfg;
    if (cfg == null || !_autoTick) return;
    _tickTimer?.cancel();
    _tickTimer = Timer.periodic(Duration(milliseconds: cfg.tickMs), (_) => tickThinking());
  }

  /// Advances thinking timers (called by the periodic ticker; tests call it directly).
  void tickThinking() {
    final thinking = _thinking;
    if (thinking == null || _ended) return;
    _applyLater(thinking.tick(_now()));
  }

  /// State changes happen at call time; their effects run on the serialized event queue.
  void _applyLater(List<ThinkCommand> commands) {
    if (commands.isNotEmpty) _enqueue(() => _apply(commands));
  }

  Future<void> _apply(List<ThinkCommand> commands) async {
    for (final command in commands) {
      switch (command) {
        case SetAvatarState(:final state):
          emit(UiState(state));
        case PlayFiller(:final clip):
          await _playFiller(clip);
        case StopFiller(:final fade):
          await audio.stopFiller(fade: fade);
        case Backchannel():
          emit(const UiAvatarAction(action: 'nod', source: 'backchannel'));
        case ThinkDiag(:final event, :final fields):
          diag(formatDiag(event, fields));
      }
    }
  }

  Future<void> _playFiller(FillerClip clip) async {
    final thinking = _thinking!;
    final pcm = _fillerPcm[clip.id];
    if (pcm == null) {
      diag(formatDiag('filler_missing', {'id': clip.id}));
      thinking.onFillerDone(_now());
      return;
    }
    emit(UiSubtitle(role: 'assistant', text: clip.text, isFinal: false));
    await audio.playFiller(pcm, onDone: () => thinking.onFillerDone(_now()));
  }
  ```
- replace `_onFrame` with:
  ```dart
  void _onFrame(Int16List frame) {
    if (_ended) return;
    final now = _now();
    final edge = detector.push(frame, timestampMs: now);
    final thinking = _thinking;
    if (!_muted) {
      // During a filler and its tail the server must hear silence, not the filler's echo.
      client.sendAudio(thinking != null && thinking.zeroUplink(now) ? Int16List(frame.length) : frame);
    }
    switch (edge) {
      case SpeechEdge.speaking:
        _speechOpen = true;
        _speechEndAt = null;
        _vadSpeakingCount++;
        _emitAudioDiag('vad.speaking');
        final guarded = thinking != null && thinking.guardsSpeech(now);
        if (thinking != null) _applyLater(thinking.onVadSpeaking(now));
        if (guarded) {
          // Filler echo or the user talking over it: stop the filler only, never cancel the reply.
          client.send(VadMessage('speaking', now));
        } else {
          unawaited(_interruptThenReportSpeech());
        }
      case SpeechEdge.silent:
        _speechOpen = false;
        _speechEndAt = now - defaultVadReleaseMs;
        _vadSilentCount++;
        thinking?.onVadSilent(now);
        client.send(VadMessage('silent', now));
        _emitAudioDiag('vad.silent');
      case SpeechEdge.none:
        break;
    }
  }
  ```
- in `_closeOpenSpeech()`, after `_speechEndAt ??= _now();` add `_thinking?.onVadSilent(_now());`
- in `_interruptThenReportSpeech()`, replace `DateTime.now().millisecondsSinceEpoch` with `_now()`.
- in `onAudio`'s queued task, replace the Task 1 line `if (firstForSequence) _reportPerceivedLatency(frame.responseSeq);` with:
  ```dart
      if (firstForSequence) {
        _reportPerceivedLatency(frame.responseSeq);
        final thinking = _thinking;
        if (thinking != null) {
          await _apply(thinking.onFirstAudio(_now())); // fades the filler before the reply is fed
        } else {
          emit(const UiState('speaking'));
        }
      }
  ```
- in `_handleMessage`:
  - `case ResponseStart(...)`: after `detector.aiPlaying = true;` add
    ```dart
        final thinking = _thinking;
        if (thinking != null) await _apply(thinking.onResponseStart(_now(), reply: kind == 'reply'));
    ```
  - `case ResponseCancelled(...)`: after `_emitAudioDiag('response.cancelled');` add
    ```dart
        final thinking = _thinking;
        if (thinking != null) await _apply(thinking.onCancelled(_now()));
    ```
  - `case TranscriptUser(...)`: before `emit(UiSubtitle(...))` add `_thinking?.onUserTranscript();`
  - `case GatewayError(...)`: inside the `if (code == 'model_reconnecting' || retryable)` branch, before `emit(...)`, add `_thinking?.onModelReconnecting();`
- in `_handlePlaybackEnded`, replace `emit(const UiState('idle'));` with:
  ```dart
    final thinking = _thinking;
    if (thinking != null) {
      await _apply(thinking.onPlaybackEnded(_now(), playedMs: played.playedMs));
    } else {
      emit(const UiState('idle'));
    }
  ```
- in `_handlePlaybackError`, after `emit(const UiError('audio_playback_failed'));` add
  ```dart
    final thinking = _thinking;
    if (thinking != null) await _apply(thinking.onCancelled(_now()));
  ```
- in `_interruptActiveNow`, after `emit(const UiState('listening'));` add
  ```dart
      final thinking = _thinking;
      if (thinking != null) await _apply(thinking.onCancelled(_now()));
  ```
- in `_stopForDisconnect`, after `detector.aiPlaying = false;` add
  ```dart
      final thinking = _thinking;
      if (thinking != null) await _apply(thinking.onCancelled(_now()));
  ```

- [ ] **Step 4: Run tests and analyze**

Run: `cd app && flutter test && flutter analyze`
Expected: all PASS (existing controller tests unchanged: they run without a thinking config); no issues.

- [ ] **Step 5: Commit**

```bash
git add app/lib/native_session/session_controller.dart app/test/native_session_controller_test.dart
git commit -m "feat(app): drive thinking, filler and backchannel from the session controller

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: avatar-core — first-audio speaking, empty-reply thinking, poses, backchannel

**Files:**
- Modify: `avatar-core/src/nativeAvatar.ts`
- Modify: `avatar-core/src/avatar/avatarView.ts`
- Test: `avatar-core/test/nativeAvatar.test.ts`, `avatar-core/test/avatarView.test.ts`

**Interfaces:**
- Consumes: Bridge `state` messages from Flutter (Task 6), `avatar.action` with `source: 'backchannel'`.
- Produces (`nativeAvatar.ts`): `export const BACKCHANNEL_SOURCE = 'backchannel';` `audio.level` no longer changes state; `response.end` with `playedMs === 0` keeps the current state; backchannel `nod` → `actions.nod(true)`.
- Produces (`avatarView.ts`):
  ```ts
  export const THINK_EYES_UP: number;     // TUNABLE
  export const THINK_HEAD_TILT: number;   // TUNABLE
  export const NEUTRAL_SMILE: number;     // TUNABLE
  export function poseFor(state: AvatarState): { eyesLookUp: number | null; headRotateZ: number | null };
  export function smileFor(emotion: string): number | null;
  ```
  `enterState` applies `poseFor` through `setBaselineValue('eyesLookUp' | 'headRotateZ', …)` (both keys exist in TalkingHead 1.7.0's `mtAvatar`; visual check in Task 9); `setEmotion` sets the mood and `setFixedValue('mouthSmile', smileFor(emotion))` so the resting smile no longer masks `sad`. `THINK_LOOK_AHEAD_MS` is removed (thinking no longer calls `lookAhead`).

- [ ] **Step 1: Write the failing tests**

Append to `describe('NativeAvatarController', ...)` in `avatar-core/test/nativeAvatar.test.ts`:

```ts
  const lastState = (posts: unknown[]) => posts.filter((p) => (p as { type: string }).type === 'state').at(-1);

  it('stays thinking on microphone levels and speaks only on the state message', async () => {
    const f = nativeAvatarFakes();
    const c = new NativeAvatarController({} as HTMLElement, f.deps);
    await c.start();
    c.handleNativeEvent({ type: 'response.start', responseSeq: 1, kind: 'reply' });
    c.handleNativeEvent({ type: 'audio.level', rms: 9000, zcr: 0.2, dtMs: 20 });
    expect(lastState(f.posts)).toEqual({ type: 'state', state: 'thinking' });
    c.handleNativeEvent({ type: 'state', state: 'speaking' });
    expect(lastState(f.posts)).toEqual({ type: 'state', state: 'speaking' });
  });

  it('keeps the thinking pose after an empty reply ends', async () => {
    const f = nativeAvatarFakes();
    const c = new NativeAvatarController({} as HTMLElement, f.deps);
    await c.start();
    c.handleNativeEvent({ type: 'response.start', responseSeq: 1, kind: 'reply' });
    c.handleNativeEvent({ type: 'response.end', responseSeq: 1, playedMs: 0 });
    expect(lastState(f.posts)).toEqual({ type: 'state', state: 'thinking' });
    c.handleNativeEvent({ type: 'response.start', responseSeq: 2, kind: 'reply' });
    c.handleNativeEvent({ type: 'response.end', responseSeq: 2, playedMs: 900 });
    expect(lastState(f.posts)).toEqual({ type: 'state', state: 'idle' });
  });

  it('plays a subtle nod for backchannel actions and the full action otherwise', async () => {
    const f = nativeAvatarFakes();
    const nods: boolean[] = [];
    const plays: string[] = [];
    f.deps.createActions = () => ({
      play(action: string) { plays.push(action); },
      stopAll() {},
      nod(subtle?: boolean) { nods.push(subtle === true); },
    });
    const c = new NativeAvatarController({} as HTMLElement, f.deps);
    await c.start();
    c.handleNativeEvent({ type: 'avatar.action', action: 'nod', source: 'backchannel' });
    c.handleNativeEvent({ type: 'avatar.action', action: 'nod', source: 'tool' });
    expect(nods).toEqual([true]);
    expect(plays).toEqual(['nod']);
  });
```

Replace `avatar-core/test/avatarView.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_MODEL_FPS, IDLE_MODEL_FPS, NEUTRAL_SMILE, REST_SMILE, THINK_EYES_UP, THINK_HEAD_TILT,
  applyModelFps, modelFpsFor, poseFor, smileFor,
} from '../src/avatar/avatarView.ts';

describe('model frame rate', () => {
  it('stays at 30 fps until the avatar is speaking or acting', () => {
    expect(modelFpsFor('idle', false)).toBe(IDLE_MODEL_FPS);
    expect(modelFpsFor('listening', false)).toBe(IDLE_MODEL_FPS);
    expect(modelFpsFor('thinking', false)).toBe(IDLE_MODEL_FPS);
    expect(modelFpsFor('speaking', false)).toBe(ACTIVE_MODEL_FPS);
    expect(modelFpsFor('idle', true)).toBe(ACTIVE_MODEL_FPS);
  });

  it('writes the interval TalkingHead reads on each animation tick', () => {
    const head = { opt: { modelFPS: 0 }, animFrameDur: 0 };
    applyModelFps(head, ACTIVE_MODEL_FPS);
    expect(head.opt.modelFPS).toBe(60);
    expect(head.animFrameDur).toBeCloseTo(1000 / 60);
  });
});

describe('poses and expressions', () => {
  it('looks up with a slight head tilt only while thinking', () => {
    expect(poseFor('thinking')).toEqual({ eyesLookUp: THINK_EYES_UP, headRotateZ: THINK_HEAD_TILT });
    for (const s of ['idle', 'listening', 'speaking'] as const) expect(poseFor(s)).toEqual({ eyesLookUp: null, headRotateZ: null });
  });

  it('drops the fixed smile for sad so the mood is visible', () => {
    expect(smileFor('happy')).toBe(REST_SMILE);
    expect(smileFor('love')).toBe(REST_SMILE);
    expect(smileFor('neutral')).toBe(NEUTRAL_SMILE);
    expect(smileFor('sad')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w avatar-core -- test/nativeAvatar.test.ts test/avatarView.test.ts`
Expected: FAIL — mic level switches to speaking; empty reply goes idle; backchannel plays the full nod; `poseFor`/`smileFor` not exported.

- [ ] **Step 3: Implement**

`avatar-core/src/nativeAvatar.ts`:
- below the imports add:
  ```ts
  /** Bridge `avatar.action` source used by Flutter for listening nods (local VAD backchannel). */
  export const BACKCHANNEL_SOURCE = 'backchannel';
  ```
- in `handleNativeEvent`:
  ```ts
      case 'response.end':
        // playedMs 0 = empty reply (e.g. before a tool call): keep the thinking pose.
        this.finishResponse(event.responseSeq, false, event.playedMs === 0);
        break;
  ```
  ```ts
      case 'avatar.action':
        if (event.action === 'nod' && event.source === BACKCHANNEL_SOURCE) this.actions?.nod(true);
        else this.actions?.play(event.action);
        break;
  ```
  ```ts
      case 'audio.level':
        break; // speaking follows the first reply audio frame (state message from Flutter), not mic levels
  ```
- `finishResponse` signature and last line:
  ```ts
  private finishResponse(responseSeq: number, cancelled: boolean, keepState = false): void {
    // ...existing body unchanged up to setMouth(null)...
    if (!keepState) this.transition('idle');
  }
  ```

`avatar-core/src/avatar/avatarView.ts`:
- replace `export const THINK_LOOK_AHEAD_MS = 1200;` with:
  ```ts
  // TUNABLE: thinking pose (baseline gaze up, slight head tilt) and the neutral resting smile.
  export const THINK_EYES_UP = 0.25;
  export const THINK_HEAD_TILT = 0.06;
  export const NEUTRAL_SMILE = 0.15;
  ```
- add below `applyModelFps`:
  ```ts
  /** Baseline values held while in a state; null releases them. */
  export function poseFor(state: AvatarState): { eyesLookUp: number | null; headRotateZ: number | null } {
    return state === 'thinking' ? { eyesLookUp: THINK_EYES_UP, headRotateZ: THINK_HEAD_TILT } : { eyesLookUp: null, headRotateZ: null };
  }

  /** Fixed smile per emotion; null lets the mood (e.g. sad) show through. */
  export function smileFor(emotion: string): number | null {
    switch (emotion) {
      case 'happy':
      case 'love':
        return REST_SMILE;
      case 'neutral':
        return NEUTRAL_SMILE;
      default:
        return null;
    }
  }
  ```
- replace `enterState` with:
  ```ts
  enterState(state: AvatarState): void {
    this.state = state;
    this.applyFps();
    const pose = poseFor(state);
    this.head.setBaselineValue('eyesLookUp', pose.eyesLookUp);
    this.head.setBaselineValue('headRotateZ', pose.headRotateZ);
    switch (state) {
      case 'listening':
        this.head.makeEyeContact(LISTEN_EYE_CONTACT_MS);
        break;
      case 'speaking':
        this.head.makeEyeContact(SPEAK_EYE_CONTACT_MS);
        break;
      case 'thinking':
      case 'idle':
        break;
    }
  }
  ```
- replace `setEmotion` with:
  ```ts
  setEmotion(emotion: string): void {
    if (!MOODS.has(emotion)) return;
    this.head.setMood(emotion);
    this.head.setFixedValue('mouthSmile', smileFor(emotion));
  }
  ```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w avatar-core && npm run typecheck -w avatar-core`
Expected: all PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add avatar-core/src/nativeAvatar.ts avatar-core/src/avatar/avatarView.ts avatar-core/test/nativeAvatar.test.ts avatar-core/test/avatarView.test.ts
git commit -m "feat(avatar-core): drive speaking from reply audio and add thinking pose and backchannel nod

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Load config and clips in `AvatarPage`; "…" while thinking

**Files:**
- Create: `app/lib/native_audio/filler_clips.dart`
- Modify: `app/lib/avatar_page.dart`
- Test: `app/test/filler_clips_test.dart`, `app/test/avatar_page_test.dart`

**Interfaces:**
- Consumes: `ThinkingConfig` (Task 2), `PluginNativeAudioIO(filler:)` (Task 4), controller params (Task 6), `formatDiag`/`logcatDiagSink` (Task 1).
- Produces:
  ```dart
  Int16List pcm16FromBytes(ByteData data);
  Future<Map<String, Int16List>> loadFillerClips(AssetBundle bundle, ThinkingConfig cfg, String style, {DiagSink diag});
  String aiLineAfterState(String state, String current); // in avatar_page.dart
  ```
  A missing clip is logged (`filler_clip_missing id=<id>`) and skipped; an invalid config is logged (`thinking_config_invalid`) and the session runs without thinking (degraded, old behavior plus first-audio speaking).

- [ ] **Step 1: Write the failing tests**

Create `app/test/filler_clips_test.dart`:

```dart
import 'dart:typed_data';

import 'package:avatar_app/native_audio/filler_clips.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/thinking_fixture.dart';

class _MapBundle extends CachingAssetBundle {
  _MapBundle(this.files);

  final Map<String, Uint8List> files;

  @override
  Future<ByteData> load(String key) async {
    final bytes = files[key];
    if (bytes == null) throw FlutterError('missing asset');
    return ByteData.sublistView(bytes);
  }
}

void main() {
  test('decodes little-endian PCM16', () {
    final bytes = Uint8List.fromList([0x01, 0x00, 0xff, 0xff, 0x00, 0x80]);
    expect(pcm16FromBytes(ByteData.sublistView(bytes)), [1, -1, -32768]);
  });

  test('loads the clips of one style and logs missing ones', () async {
    final cfg = testThinking();
    final lines = <String>[];
    final bundle = _MapBundle({
      'assets/filler/grandchild/think-1.pcm': Uint8List(4800),
      'assets/filler/grandchild/wait-1.pcm': Uint8List(4800),
    });
    final clips = await loadFillerClips(bundle, cfg, 'grandchild', diag: lines.add);
    expect(clips.keys, ['think-1', 'wait-1']);
    expect(clips['think-1']!.length, 2400);
    expect(lines, ['anyidea.diag event=filler_clip_missing id=think-2']);
  });
}
```

Append to `app/test/avatar_page_test.dart` inside `main()`:

```dart
  test('shows an ellipsis while thinking and clears it when idle', () {
    expect(aiLineAfterState('thinking', '上一句'), '…');
    expect(aiLineAfterState('speaking', '…'), '…');
    expect(aiLineAfterState('idle', '…'), '');
    expect(aiLineAfterState('idle', '好的'), '好的');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd app && flutter test test/filler_clips_test.dart test/avatar_page_test.dart`
Expected: FAIL — `filler_clips.dart` and `aiLineAfterState` not found.

- [ ] **Step 3: Implement**

Create `app/lib/native_audio/filler_clips.dart`:

```dart
import 'dart:typed_data';

import 'package:flutter/services.dart';

import '../diag_log.dart';
import '../native_session/thinking_config.dart';

Int16List pcm16FromBytes(ByteData data) {
  final out = Int16List(data.lengthInBytes ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = data.getInt16(i * 2, Endian.little);
  }
  return out;
}

/// Loads one style's filler clips; a missing clip is logged and skipped (that filler stays silent).
Future<Map<String, Int16List>> loadFillerClips(
  AssetBundle bundle,
  ThinkingConfig cfg,
  String style, {
  DiagSink diag = logcatDiagSink,
}) async {
  final out = <String, Int16List>{};
  for (final clip in cfg.allClips) {
    try {
      out[clip.id] = pcm16FromBytes(await bundle.load(cfg.clipAsset(style, clip.id)));
    } catch (_) {
      diag(formatDiag('filler_clip_missing', {'id': clip.id}));
    }
  }
  return out;
}
```

In `app/lib/avatar_page.dart`:
- imports:
  ```dart
  import 'dart:typed_data';

  import 'diag_log.dart';
  import 'native_audio/filler_clips.dart';
  import 'native_session/thinking_config.dart';
  ```
- top-level function below `errorAfterStatus`:
  ```dart
  /// Subtitle line per avatar state: "…" while thinking; cleared when going idle after thinking.
  String aiLineAfterState(String state, String current) => switch (state) {
        'thinking' => '…',
        'idle' when current == '…' => '',
        _ => current,
      };
  ```
- in `_onJs`, replace `case JsState(:final state): setState(() => _state = state);` with:
  ```dart
      case JsState(:final state):
        setState(() {
          _state = state;
          _aiLine = aiLineAfterState(state, _aiLine);
        });
  ```
- in `_onNativeEvent`, replace `case UiState(:final state): setState(() => _state = state);` with:
  ```dart
      case UiState(:final state):
        setState(() {
          _state = state;
          _aiLine = aiLineAfterState(state, _aiLine);
        });
  ```
- replace `_startNativeSession()` with:
  ```dart
  Future<void> _startNativeSession() async {
    if (_session != null || _startingSession) return;
    _startingSession = true;
    final thinking = await _loadThinking();
    // A+B merge point: use the style stored by Plan B instead of the config default.
    final clips = thinking == null
        ? const <String, Int16List>{}
        : await loadFillerClips(rootBundle, thinking, thinking.defaultStyle);
    final session = NativeSessionController(
      audio: PluginNativeAudioIO(filler: thinking?.audio),
      detector: EnergySpeechDetector(),
      client: NativeGatewayClient(
        baseUri: Uri.parse(AppConfig.gatewayUrl),
        appSecret: AppConfig.appSecret,
        transport: const IoGatewayTransport(),
        events: _UnwiredGatewayEvents(),
        audioPath: AppConfig.audioPath,
      ),
      emit: _onNativeEvent,
      thinking: thinking,
      fillerPcm: clips,
    );
    _session = session;
    try {
      await session.start();
    } catch (_) {
      if (identical(_session, session)) _session = null;
    } finally {
      _startingSession = false;
    }
  }

  Future<ThinkingConfig?> _loadThinking() async {
    try {
      return ThinkingConfig.parse(await rootBundle.loadString(ThinkingConfig.assetPath));
    } catch (_) {
      logcatDiagSink(formatDiag('thinking_config_invalid', {}));
      return null;
    }
  }
  ```

- [ ] **Step 4: Run tests, analyze, build**

Run: `cd app && flutter test && flutter analyze && cd .. && ./scripts/build-web.sh && cd app && flutter build apk --debug --dart-define-from-file=dev.json`
Expected: all tests PASS; no issues; web bundle built; APK built.

- [ ] **Step 5: Commit**

```bash
git add app/lib/native_audio/filler_clips.dart app/lib/avatar_page.dart app/test/filler_clips_test.dart app/test/avatar_page_test.dart
git commit -m "feat(app): load thinking config and filler clips and show an ellipsis while thinking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Plan A acceptance on the Xiaomi

**Files:**
- Create: `docs/testing/2026-10-1x-plan-a-device-report.md`
- Modify: `docs/project/roadmap.md`, `docs/blockers.md` (only for failed/skipped items), both Plan A plan files (tick boxes)

All steps are manual on Xiaomi 22101317C with the Plan A worktree (A1 + A2 merged in it). No item is "passed" unless observed and recorded; skipped items are listed as skipped.

- [ ] **Step 1: Full automated verification**

Run: `npm test && npm run typecheck && cd app && flutter test && flutter analyze`
Expected: protocol, gateway, avatar-core PASS; typecheck clean; Flutter tests PASS; no analyzer issues. Record the exact counts.

- [ ] **Step 2: Build, install, start, capture**

```bash
./scripts/build-web.sh
cd app && flutter build apk --debug --dart-define-from-file=dev.json && cd ..
adb push app/build/app/outputs/flutter-apk/app-debug.apk /data/local/tmp/app-debug.apk
adb shell pm install -r -d /data/local/tmp/app-debug.apk
# Ask the user before restarting the gateway they keep on 8787.
adb reverse tcp:8787 tcp:8787
cd gateway && node --env-file-if-exists=.env --import tsx src/index.ts | tee /tmp/gw-plan-a.log
```

Second terminal: `adb logcat -c && adb logcat -s flutter:I | grep --line-buffered anyidea.diag | tee /tmp/client-plan-a.log`

Confirm `/tmp/gw-plan-a.log` has one `instruction_budget` line and `ADAPTER=qwen` in `gateway_listening`.

- [ ] **Step 3: 20 spoken turns (latency, thinking, filler, no blank)**

Speak the 20 sentences from A1 Task 2 Step 7, then 5 that tend to take longer: 你给我挥挥手 / 给我讲个短故事吧 / 你给我比个心 / 你说说秋天该吃点什么 / 我想听你猜个谜语. For each turn the tester records in a table: did the avatar show either the thinking pose (eyes up, slight tilt, "…" subtitle) or speech within about half a second of stopping? (Y/N); was a filler heard; did it sound like the reply voice; did the filler cut off cleanly when the reply began.

Then compute:

```bash
grep -o 'perceived_ms=[0-9]*' /tmp/client-plan-a.log | cut -d= -f2 | sort -n | awk 'function ceil(x){return (x==int(x))?x:int(x)+1} {a[NR]=$1} END{if(NR==0){print "n=0"; exit} print "n="NR, "p50="a[ceil(NR*0.5)], "p90="a[ceil(NR*0.9)]}'
grep -o 'event=thinking after_silence_ms=[0-9]*' /tmp/client-plan-a.log | cut -d= -f3 | awk '{n++; if($1>500) bad++} END{print "thinking n="n+0, "over500="bad+0}'
grep -c 'event=filler kind=thinking' /tmp/client-plan-a.log
grep -c 'event=filler kind=long_wait' /tmp/client-plan-a.log
grep -c 'event=filler_skipped' /tmp/client-plan-a.log
grep -c 'event=filler_stopped' /tmp/client-plan-a.log
grep -c 'event=thinking_timeout' /tmp/client-plan-a.log
grep -o 'perceived_ms=[0-9]*' /tmp/client-plan-a.log | cut -d= -f2 | awk '$1>=1550{n++} END{print "turns waiting >= 1550 ms:", n+0}'
cd gateway && node --import tsx scripts/log-report.ts metrics < /tmp/gw-plan-a.log
```

Gate checks to record:
- 本地静音后 500 ms 内出现思考态 100%: every turn whose `perceived_ms` > 500 has a `thinking` line with `after_silence_ms` ≤ 500 (`over500=0`).
- 满足垫话条件时必定垫话: `filler kind=thinking` count equals the "turns waiting ≥ 1550 ms" count (300 silence + 1200 filler + 50 tick), and `filler_skipped` = 0. Any skip means the evidence rule missed a turn: record it and, if transcripts arrive late, switch `fillerEvidence` to `["transcript","responseStart"]` per A1 research §4a and repeat this step.
- 没有任何反馈的空白为 0: all per-turn observations are Y and `thinking_timeout` = 0.
- 感知延迟 P50 不比基线差: client p50 ≤ the baseline p50 in `docs/testing/plan-a-latency-baseline.md`.
- Filler self-interruption: `filler_stopped` count equals the turns where the tester actually spoke over a filler (should be 0 in this script).
- Assumption 5 on device: `grep -c '"event":"model_auto_cancel"' /tmp/gw-plan-a.log` and confirm every filler turn still got a reply.

- [ ] **Step 4: Emotion and backchannel**

Say: "我今天特别开心" → happy face; wait 7 s. Say: "我心里有点难过" → the resting smile disappears and a sad face is visible; it returns to the default after about 6 s. While speaking a long sentence (> 2 s), the avatar nods subtly at least once. Record each as observed / not observed.

- [ ] **Step 5: 10-minute silence**

Restart the gateway with a fresh log (`| tee /tmp/gw-silence.log`), open the app, let the greeting finish, put the phone on the table, nobody speaks for 10 minutes (keep the room quiet; note any noise). Then:

```bash
cd gateway && node --import tsx scripts/log-report.ts silence < /tmp/gw-silence.log
```

Gate: `unprompted` = 0 (replies without a local `vad_edge speaking`, excluding greeting and Director) and `maxProactivePerWindow` ≤ 3. Record `replies`, `unprompted`, `proactive`, `maxProactivePerWindow`.

- [ ] **Step 6: Both styles (persona and voice)**

Default run above is grandchild. For old-friend, locally edit (do not commit) `gateway/roles/elder-companion/role.json` `"defaultStyle": "old-friend"` and `app/assets/config/thinking.json` `"defaultStyle": "old-friend"`, rebuild/install the APK (Step 2 commands), restart the gateway, talk for 3 turns. Record: persona wording matches the style (steady, fewer 撒娇 particles), reply voice is the old-friend voice, filler voice matches. Then revert both files:

```bash
git checkout -- gateway/roles/elder-companion/role.json app/assets/config/thinking.json
```

and rebuild/install the default APK. (Style switching through the app belongs to the A+B merge gate.)

- [ ] **Step 7: Write the report, update roadmap and blockers, commit**

Create `docs/testing/2026-10-1x-plan-a-device-report.md`:

```markdown
# Plan A device acceptance — Xiaomi 22101317C — 2026-10-1x

Commit: <sha>. Gateway: ADAPTER=qwen (<model>). APK: debug. Automated: npm test <counts>, flutter test <count>, analyze clean.

| Gate item (spec) | Result | Evidence |
|---|---|---|
| 20 场景问句比例 ≤ 1/3 | <pass/fail> | docs/testing/plan-a-eval/<files> (A1 Task 10) |
| 平均回复字数 ≤ 配置值 | <pass/fail> | same |
| 静默 10 分钟 unprompted = 0 | <n> | log-report silence |
| 每 5 分钟主动说话 ≤ 3 | <max> | log-report silence |
| 静音后 500 ms 内思考态 100% | <over500 / n> | logcat thinking lines |
| 满足条件必定垫话 | <fillers vs waits, skipped> | logcat filler lines |
| 无反馈空白 = 0 | <Y count / turns, timeouts> | per-turn table |
| 感知延迟 P50 不差于基线 | <p50 vs baseline> | logcat latency lines |
| 情绪表情可见 | <happy / sad observed> | Step 4 |
| 两种风格人设和音色可用 | <grandchild / old-friend> | Step 6 |

## Per-turn observations

| # | utterance | feedback ≤0.5 s (Y/N) | filler heard | filler voice matches | clean cut |
|---|---|---|---|---|---|

## Gateway metrics (log-report metrics)

<paste JSON>

## Notes, failures, skipped items

<list>
```

Update `docs/project/roadmap.md` (Plan 3 row: Plan A status, gate results, next: A+B merge gate after Plan B) and add a `docs/blockers.md` row for every failed or skipped gate item.

```bash
git add docs/testing/2026-10-1x-plan-a-device-report.md docs/project/roadmap.md docs/superpowers/plans/2026-10-17-plan3-a1-gateway-persona.md docs/superpowers/plans/2026-10-17-plan3-a2-client-thinking.md
git commit -m "docs: record Plan A device acceptance on Xiaomi

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Add `docs/blockers.md` if Step 3–6 recorded anything.)

## Acceptance (A2 share of the Plan A gate)

- Thinking state within 500 ms of local silence: 100% of qualifying turns (Task 9 Step 3).
- Filler always plays when its conditions hold; filler voice matches the style (Tasks 3, 9).
- Zero blank turns (no sound and no thinking pose) and zero thinking timeouts (Task 9 Step 3).
- Perceived latency P50 not worse than the Task 1 baseline (Task 9 Step 3).
- Emotion expressions visible, subtle backchannel nods while listening (Task 9 Step 4).
- 10-minute silence: zero unprompted replies, ≤ 3 proactive per 5 minutes (Task 9 Step 5, with A1 Task 7).
