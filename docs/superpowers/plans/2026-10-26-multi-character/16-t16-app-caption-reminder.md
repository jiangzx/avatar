# Task 16: 聊天页常驻 AI 提示与休息提醒 toast

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。先读 spec 对应章节，再读 `00-overview.md`，最后读本文件。步骤用 `- [ ]` 勾选。

**Goal:** 聊天页顶部常驻一行「我是 AI 陪伴，不是真人」（≥18sp、半透明、不挡脸）；收到 `response.start{kind:'reminder'}` 后，用这一轮的 assistant 字幕弹出 toast，最后一次更新后停留 `restToastMs`。文案和时长来自新文件 `app/assets/config/companion.json`。

**Spec 章节：** 产品设计「AI 提示与休息提醒」（第 1 条和「App 收到 `response.start{kind:'reminder'}` 后……」一条）；技术设计 §9「聊天页」「AI 提示文案」、§10 App 配置；附录 B `aiCaption`。

**前置：**
- Task 12 已完成：网关在休息提醒时发 `response.start`，`kind` 为 `'reminder'`，随后照常发这一轮的 `transcript.assistant`。
- Task 13 已完成：`parseServerMessage` 接受 `reminder`（`protocol.dart`），`AvatarPage(displayName:)`，`main.dart` 在 `runApp` 前加载 `CharacterCatalog`。
- Task 15 已完成并提交（`main.dart` 的最新版本含 `MemoryApi`）。
- 基线绿：`cd app && flutter test && flutter analyze`。

## 设计要点

- **怎么拿到「这一轮的字幕」：** 现在的 `UiSubtitle` 不带 `responseSeq`（`events.dart:21-28`），assistant 字幕是 `session_controller.dart:322-326` 按 seq 累加后发出的完整文本。本任务给 `UiSubtitle` 加可选字段 `responseSeq`（assistant 字幕带上，用户字幕和垫话字幕为 null），`toJson()` 不变，WebView 侧协议不受影响。
- **toast 逻辑放在独立的 `ReminderToast`（`ChangeNotifier`）里：** 记住 `reminder` 的 seq，同一 seq 的 assistant 字幕每次更新都刷新文本并重新计时；`restToastMs` 内没有新文本就隐藏。新的非 reminder 回复开始后不再更新，但已显示的 toast 照常到时隐藏。`AvatarPage` 只负责把事件转给它、把文本交给 `AvatarOverlay`。
- **位置：** AI 提示放在顶部名字角标和状态文字下面一行（距安全区顶部 52dp），居中、单行、IgnorePointer；toast 放在底部字幕卡片的上方，和字幕一起占屏幕下部，不挡脸。是否真的不挡脸由 Task 17 真机确认。
- **只在原生音频路径生效：** `AUDIO_MODE=web` 的旧 WebView 会话不经过 `_onNativeEvent`，拿不到 kind，那条路径不弹 toast（AI 提示照常显示）。
- **不记日志：** toast 文本只在内存里存一行，不写日志、不写存储。

## Files

- Create:
  - `app/assets/config/companion.json`
  - `app/lib/companion_config.dart`
  - `app/lib/reminder_toast.dart`
  - `app/test/companion_config_test.dart`
  - `app/test/reminder_toast_test.dart`
- Modify:
  - `app/lib/native_session/events.dart:21-28`（`UiSubtitle`）
  - `app/lib/native_session/session_controller.dart:322-326`（`TranscriptAssistant` 分支）
  - `app/lib/overlay.dart:1-124`（`AvatarOverlay` 整体替换，`_RoundButton` 不动）
  - `app/lib/avatar_page.dart`（Task 13 之后的版本：import、构造参数、`initState`、`_onNativeEvent`、`dispose`、`build`）
  - `app/lib/main.dart`（Task 15 之后的版本：加载 `CompanionConfig` 并传给 `AvatarPage`）
  - Tests：`app/test/overlay_test.dart`（追加）、`app/test/native_session_controller_test.dart`（追加）、`app/test/native_session_events_test.dart`（追加）、`app/test/avatar_page_engine_test.dart`（追加）

## Interfaces

- Consumes：Task 12 的 `response.start{kind:'reminder'}`；Task 13 的 `ResponseStart.kind`（已接受 `reminder`）、`AvatarPage.displayName`；现有 `UiResponseStart`（`events.dart:30-36`）、`NativeSessionController._handleMessage`（`session_controller.dart:227-342`）。
- Produces（与总览 C12 一致）：
  - `app/assets/config/companion.json`：`{ "aiCaption": "我是 AI 陪伴，不是真人", "restToastMs": 6000 }`。
  - `class CompanionConfig { String aiCaption; int restToastMs; Duration get restToast; static const assetPath; static CompanionConfig parse(String) }`、`Future<CompanionConfig> loadCompanionConfig(AssetBundle bundle)`。
  - `UiSubtitle({role, text, isFinal, int? responseSeq})`。
  - `class ReminderToast extends ChangeNotifier { ReminderToast({required Duration showFor}); String? get text; void onEvent(NativeUiEvent event); }`。
  - `AvatarOverlay({..., String? caption, String? toast})`；`AvatarPage({..., CompanionConfig? companion})`；`AvatarApp({catalog, companion})`。

## 调用方适配（保证 `flutter test`、`flutter analyze` 全绿）

| 位置 | 断在哪里 | 处理 |
|---|---|---|
| `lib/main.dart` | `AvatarApp` 新增必填 `companion` | Step 6 |
| `test/overlay_test.dart`、`test/avatar_page_engine_test.dart` | 新参数都可选，旧用例照常编译 | 只追加用例 |
| `test/native_session_*_test.dart`、`test/thinking_controller_test.dart` | `UiSubtitle` 新参数可选、`toJson` 不变 | 不改旧用例 |
| 其他构造 `UiSubtitle` 的地方（`session_controller.dart:321,443`） | 不传 `responseSeq` 仍可编译；用户字幕和垫话字幕本来就该是 null | 不改 |

## Steps

- [x] **Step 1: 写失败的测试，再实现 `companion.json` 和加载器**

新建 `app/test/companion_config_test.dart`：

```dart
import 'dart:convert';
import 'dart:io';

import 'package:avatar_app/companion_config.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> shipped() =>
    jsonDecode(File(CompanionConfig.assetPath).readAsStringSync()) as Map<String, Object?>;

void main() {
  test('parses the shipped config', () {
    final c = CompanionConfig.parse(File(CompanionConfig.assetPath).readAsStringSync());
    expect(c.aiCaption, '我是 AI 陪伴，不是真人');
    expect(c.restToastMs, 6000);
    expect(c.restToast, const Duration(seconds: 6));
  });

  test('rejects a blank or long caption, a bad duration, unknown keys and non-JSON', () {
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'aiCaption': ' '})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'aiCaption': '一' * 31})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'restToastMs': 1000})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'restToastMs': 60000})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'restToastMs': '6000'})), throwsFormatException);
    expect(() => CompanionConfig.parse(jsonEncode({...shipped(), 'extra': 1})), throwsFormatException);
    expect(() => CompanionConfig.parse('not json'), throwsFormatException);
  });
}
```

Run: `cd app && flutter test test/companion_config_test.dart`
Expected: 编译失败（`companion_config.dart` 不存在）。

新建 `app/assets/config/companion.json`（`assets/config/` 已在 pubspec 声明，不用改 pubspec）：

```json
{
  "aiCaption": "我是 AI 陪伴，不是真人",
  "restToastMs": 6000
}
```

新建 `app/lib/companion_config.dart`：

```dart
import 'dart:convert';

import 'package:flutter/services.dart';

/// App-side companion copy and timing (assets/config/companion.json, overview contract C12).
class CompanionConfig {
  const CompanionConfig({required this.aiCaption, required this.restToastMs});

  static const assetPath = 'assets/config/companion.json';

  /// Always-on notice on the chat page (spec「AI 提示」).
  final String aiCaption;

  /// How long the rest-reminder toast stays after its last update.
  final int restToastMs;

  Duration get restToast => Duration(milliseconds: restToastMs);

  static CompanionConfig parse(String source) {
    final Object? raw;
    try {
      raw = jsonDecode(source);
    } on FormatException {
      throw const FormatException('companion_config_not_json');
    }
    if (raw is! Map<String, Object?>) throw const FormatException('companion_config_not_object');
    if (raw.keys.any((key) => key != 'aiCaption' && key != 'restToastMs')) {
      throw const FormatException('companion_config_unknown_key');
    }
    final caption = raw['aiCaption'];
    if (caption is! String || caption.trim().isEmpty || caption.length > 30) {
      throw const FormatException('ai_caption_invalid');
    }
    final ms = raw['restToastMs'];
    if (ms is! int || ms < 2000 || ms > 30000) throw const FormatException('rest_toast_ms_out_of_range');
    return CompanionConfig(aiCaption: caption, restToastMs: ms);
  }
}

Future<CompanionConfig> loadCompanionConfig(AssetBundle bundle) async =>
    CompanionConfig.parse(await bundle.loadString(CompanionConfig.assetPath));
```

Run: `cd app && flutter test test/companion_config_test.dart`
Expected: PASS。

- [x] **Step 2: 写失败的测试，再让 assistant 字幕带上 `responseSeq`**

`app/test/native_session_events_test.dart` 的 `main()` 末尾追加：

```dart
  test('the subtitle JSON for the WebView keeps its shape', () {
    const event = UiSubtitle(role: 'assistant', text: '好', isFinal: false, responseSeq: 3);
    expect(event.responseSeq, 3);
    expect(event.toJson(), {'type': 'subtitle', 'role': 'assistant', 'text': '好', 'final': false});
  });
```

`app/test/native_session_controller_test.dart` 的 `main()` 末尾（`SessionFakes` 类之前）追加：

```dart
  test('assistant subtitles carry their response sequence; user lines do not', () async {
    final f = SessionFakes();
    final c = f.controller();
    await c.start();
    f.client.emit(const ResponseStart(9, 'reminder'));
    f.client.emit(const TranscriptAssistant(9, '咱们聊了'));
    f.client.emit(const TranscriptAssistant(9, '一个钟头了'));
    f.client.emit(const TranscriptUser('嗯', true));
    await pumpEvents();
    final subtitles = f.events.whereType<UiSubtitle>().toList();
    final assistant = subtitles.where((s) => s.role == 'assistant').last;
    expect(assistant.text, '咱们聊了一个钟头了');
    expect(assistant.responseSeq, 9);
    expect(subtitles.where((s) => s.role == 'user').single.responseSeq, isNull);
    expect(f.events.whereType<UiResponseStart>().single.kind, 'reminder');
  });
```

Run: `cd app && flutter test test/native_session_events_test.dart test/native_session_controller_test.dart`
Expected: 编译失败（`responseSeq` 参数不存在）。

`app/lib/native_session/events.dart` 第 21–28 行替换为：

```dart
class UiSubtitle extends NativeUiEvent {
  const UiSubtitle({required this.role, required this.text, required this.isFinal, this.responseSeq});
  final String role;
  final String text;
  final bool isFinal;

  /// Assistant subtitles carry their response; null for user lines and filler clips.
  final int? responseSeq;

  /// WebView contract: unchanged, without the sequence.
  @override
  Map<String, Object> toJson() => {'type': 'subtitle', 'role': role, 'text': text, 'final': isFinal};
}
```

`app/lib/native_session/session_controller.dart` 第 326 行改为：

```dart
        emit(UiSubtitle(role: 'assistant', text: next, isFinal: false, responseSeq: responseSeq));
```

Run: `cd app && flutter test test/native_session_events_test.dart test/native_session_controller_test.dart test/thinking_controller_test.dart`
Expected: PASS。

- [x] **Step 3: 写失败的测试，再实现 `ReminderToast`**

新建 `app/test/reminder_toast_test.dart`（在 `testWidgets` 里跑，`Timer` 走测试的假时钟，用 `tester.pump(duration)` 推进）：

```dart
import 'package:avatar_app/native_session/events.dart';
import 'package:avatar_app/reminder_toast.dart';
import 'package:flutter_test/flutter_test.dart';

const reminderLine = '咱们聊了一个钟头了，要不要起来活动活动、喝口水？我在这儿等您。';

void main() {
  testWidgets('shows the reminder subtitle for restToastMs after its last update, then hides', (tester) async {
    final toast = ReminderToast(showFor: const Duration(milliseconds: 6000));
    var notified = 0;
    toast.addListener(() => notified++);
    toast.onEvent(const UiResponseStart(responseSeq: 7, kind: 'reminder'));
    expect(toast.text, isNull);
    toast.onEvent(const UiSubtitle(role: 'assistant', text: '咱们聊了', isFinal: false, responseSeq: 7));
    expect(toast.text, '咱们聊了');
    await tester.pump(const Duration(milliseconds: 3000));
    toast.onEvent(const UiSubtitle(role: 'assistant', text: reminderLine, isFinal: false, responseSeq: 7));
    expect(toast.text, reminderLine);
    await tester.pump(const Duration(milliseconds: 5999));
    expect(toast.text, reminderLine);
    await tester.pump(const Duration(milliseconds: 2));
    expect(toast.text, isNull);
    expect(notified, 3);
    toast.dispose();
  });

  testWidgets('ignores replies, other sequences, user lines and filler lines', (tester) async {
    final toast = ReminderToast(showFor: const Duration(milliseconds: 6000));
    toast.onEvent(const UiResponseStart(responseSeq: 3, kind: 'reply'));
    toast.onEvent(const UiSubtitle(role: 'assistant', text: '好的', isFinal: false, responseSeq: 3));
    toast.onEvent(const UiResponseStart(responseSeq: 4, kind: 'reminder'));
    toast.onEvent(const UiSubtitle(role: 'assistant', text: '上一句的尾巴', isFinal: false, responseSeq: 3));
    toast.onEvent(const UiSubtitle(role: 'user', text: '嗯', isFinal: true));
    toast.onEvent(const UiSubtitle(role: 'assistant', text: '嗯，我想想。', isFinal: false)); // filler: no seq
    toast.onEvent(const UiSubtitle(role: 'assistant', text: '', isFinal: false, responseSeq: 4));
    expect(toast.text, isNull);
    toast.dispose();
  });

  testWidgets('a reply after the reminder stops updates; the toast still times out', (tester) async {
    final toast = ReminderToast(showFor: const Duration(milliseconds: 6000));
    toast.onEvent(const UiResponseStart(responseSeq: 5, kind: 'reminder'));
    toast.onEvent(const UiSubtitle(role: 'assistant', text: '咱们聊了', isFinal: false, responseSeq: 5));
    toast.onEvent(const UiResponseStart(responseSeq: 6, kind: 'reply'));
    toast.onEvent(const UiSubtitle(role: 'assistant', text: '咱们聊了一个钟头了', isFinal: false, responseSeq: 5));
    expect(toast.text, '咱们聊了');
    await tester.pump(const Duration(milliseconds: 6001));
    expect(toast.text, isNull);
    toast.dispose();
  });

  testWidgets('dispose cancels a pending toast', (tester) async {
    final toast = ReminderToast(showFor: const Duration(milliseconds: 6000));
    toast.onEvent(const UiResponseStart(responseSeq: 8, kind: 'reminder'));
    toast.onEvent(const UiSubtitle(role: 'assistant', text: reminderLine, isFinal: false, responseSeq: 8));
    toast.dispose();
    await tester.pump(const Duration(seconds: 7)); // no callback after dispose, no pending timer
  });
}
```

Run: `cd app && flutter test test/reminder_toast_test.dart`
Expected: 编译失败（`reminder_toast.dart` 不存在）。

新建 `app/lib/reminder_toast.dart`：

```dart
import 'dart:async';

import 'package:flutter/foundation.dart';

import 'native_session/events.dart';

/// Rest-reminder toast (spec「休息提醒」): the subtitle of a `reminder` response, shown for [showFor]
/// after its last update. Holds only the current line in memory; nothing is logged or stored.
class ReminderToast extends ChangeNotifier {
  ReminderToast({required this.showFor});

  final Duration showFor;
  int? _seq;
  String? _text;
  Timer? _timer;
  bool _disposed = false;

  String? get text => _text;

  void onEvent(NativeUiEvent event) {
    switch (event) {
      case UiResponseStart(:final responseSeq, :final kind):
        _seq = kind == 'reminder' ? responseSeq : null;
      case UiSubtitle(role: 'assistant', :final text, :final responseSeq)
          when responseSeq != null && responseSeq == _seq && text.isNotEmpty:
        _show(text);
      default:
        break;
    }
  }

  void _show(String text) {
    _text = text;
    _timer?.cancel();
    _timer = Timer(showFor, _hide);
    notifyListeners();
  }

  void _hide() {
    _timer = null;
    if (_disposed) return;
    _text = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    super.dispose();
  }
}
```

Run: `cd app && flutter test test/reminder_toast_test.dart`
Expected: PASS。

- [x] **Step 4: 写失败的测试，再给 `AvatarOverlay` 加 AI 提示和 toast**

`app/test/overlay_test.dart` 的 `main()` 末尾追加：

```dart
  testWidgets('the AI caption sits at the top, large, semi-transparent and clear of the name and status', (tester) async {
    tester.view.physicalSize = const Size(1080, 2340);
    tester.view.devicePixelRatio = 2.75;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AvatarOverlay(
          userLine: '', aiLine: '', status: '连接中…', error: null, muted: false, name: '小暖',
          caption: '我是 AI 陪伴，不是真人',
          onMute: () {}, onEnd: () {}, onToggleDebug: () {},
        ),
      ),
    ));
    final text = tester.widget<Text>(find.text('我是 AI 陪伴，不是真人'));
    expect(text.style!.fontSize, greaterThanOrEqualTo(18));
    expect(text.style!.color, const Color(0xCCFFFFFF));
    final caption = tester.getRect(find.byKey(const Key('ai-caption')));
    expect(caption.bottom, lessThan(2340 / 2.75 * 0.15));
    expect(caption.overlaps(tester.getRect(find.text('小暖'))), isFalse);
    expect(caption.overlaps(tester.getRect(find.text('连接中…'))), isFalse);
  });

  testWidgets('the rest toast shows above the subtitles in large text', (tester) async {
    const line = '咱们聊了一个钟头了，要不要起来活动活动、喝口水？我在这儿等您。';
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AvatarOverlay(
          userLine: '', aiLine: '王叔好', status: '', error: null, muted: false, name: '小暖',
          toast: line,
          onMute: () {}, onEnd: () {}, onToggleDebug: () {},
        ),
      ),
    ));
    expect(find.byKey(const Key('rest-toast')), findsOneWidget);
    expect(tester.widget<Text>(find.text(line)).style!.fontSize, greaterThanOrEqualTo(18));
    expect(tester.getTopLeft(find.text(line)).dy, lessThan(tester.getTopLeft(find.text('王叔好')).dy));
  });

  testWidgets('no caption and no toast unless given', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: AvatarOverlay(
          userLine: '', aiLine: '', status: '', error: null, muted: false, name: '小暖',
          onMute: () {}, onEnd: () {}, onToggleDebug: () {},
        ),
      ),
    ));
    expect(find.byKey(const Key('ai-caption')), findsNothing);
    expect(find.byKey(const Key('rest-toast')), findsNothing);
  });
```

Run: `cd app && flutter test test/overlay_test.dart`
Expected: 编译失败（`caption`、`toast` 参数不存在）。

把 `app/lib/overlay.dart` 第 1–124 行（`AvatarOverlay` 类，`_RoundButton` 之前）替换为：

```dart
import 'package:flutter/material.dart';

/// Native UI drawn over the avatar. Large text and touch targets (≥18 sp, ≥60 dp).
class AvatarOverlay extends StatelessWidget {
  const AvatarOverlay({
    super.key,
    required this.userLine,
    required this.aiLine,
    required this.status,
    required this.error,
    required this.muted,
    required this.name,
    required this.onMute,
    required this.onEnd,
    required this.onToggleDebug,
    this.onRetry,
    this.debugPanel,
    this.presence,
    this.caption,
    this.toast,
  });

  final String userLine;
  final String aiLine;
  final String status;
  final String? error;
  final bool muted;

  /// The character on screen. Long-press opens the debug panel.
  final String name;
  final VoidCallback onMute;
  final VoidCallback onEnd;
  final VoidCallback onToggleDebug;
  final VoidCallback? onRetry;
  final Widget? debugPanel;

  /// Optional status pill shown just above the subtitle card.
  final Widget? presence;

  /// Always-on AI notice under the top row (spec「AI 提示」); null hides it.
  final String? caption;

  /// Rest-reminder text above the subtitles; null hides it.
  final String? toast;

  @override
  Widget build(BuildContext context) {
    final error = this.error;
    final presence = this.presence;
    final debugPanel = this.debugPanel;
    final caption = this.caption;
    final toast = this.toast;
    return SafeArea(
      child: Stack(
        children: [
          Positioned(
            top: 12,
            left: 12,
            child: GestureDetector(
              onLongPress: onToggleDebug,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(16)),
                child: Text(name, style: const TextStyle(color: Colors.white, fontSize: 16)),
              ),
            ),
          ),
          if (status.isNotEmpty)
            Positioned(
              top: 16,
              right: 12,
              child: Text(status, style: const TextStyle(color: Colors.amberAccent, fontSize: 16)),
            ),
          if (caption != null)
            // Below the name and status row, above the face; never takes taps.
            Positioned(
              top: 52,
              left: 12,
              right: 12,
              child: IgnorePointer(
                child: Center(
                  child: Container(
                    key: const Key('ai-caption'),
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                    decoration: BoxDecoration(color: const Color(0x42000000), borderRadius: BorderRadius.circular(12)),
                    child: Text(
                      caption,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: Color(0xCCFFFFFF), fontSize: 18),
                    ),
                  ),
                ),
              ),
            ),
          Positioned(
            left: 16,
            right: 16,
            bottom: 104,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (toast != null) ...[
                  Container(
                    key: const Key('rest-toast'),
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: const Color(0xE6203A38),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: Colors.tealAccent),
                    ),
                    child: Text(toast, style: const TextStyle(color: Colors.white, fontSize: 20)),
                  ),
                  const SizedBox(height: 8),
                ],
                if (presence != null) ...[
                  Align(alignment: Alignment.centerLeft, child: presence),
                  const SizedBox(height: 8),
                ],
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(12)),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (userLine.isNotEmpty) Text(userLine, style: const TextStyle(color: Colors.white70, fontSize: 18)),
                      if (aiLine.isNotEmpty) Text(aiLine, style: const TextStyle(color: Colors.white, fontSize: 20)),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 24,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                _RoundButton(key: const Key('mute'), icon: muted ? Icons.mic_off : Icons.mic, color: Colors.white24, onTap: onMute),
                const SizedBox(width: 40),
                _RoundButton(key: const Key('end'), icon: Icons.call_end, color: Colors.redAccent, onTap: onEnd),
              ],
            ),
          ),
          if (error != null)
            Center(
              child: Container(
                margin: const EdgeInsets.all(24),
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(color: Colors.black87, borderRadius: BorderRadius.circular(12)),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(error, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 20)),
                    if (onRetry != null) ...[
                      const SizedBox(height: 12),
                      TextButton(key: const Key('retry'), onPressed: onRetry, child: const Text('重试')),
                    ],
                  ],
                ),
              ),
            ),
          if (debugPanel != null) Positioned(top: 128, left: 8, right: 8, child: debugPanel),
        ],
      ),
    );
  }
}
```

Run: `cd app && flutter test test/overlay_test.dart`
Expected: PASS（含原有 4 个用例）。

- [x] **Step 5: 写失败的测试，再接入 `AvatarPage`**

`app/test/avatar_page_engine_test.dart`：import 区加 `import 'package:avatar_app/companion_config.dart';`，`main()` 末尾追加：

```dart
  testWidgets('the chat page shows the AI caption from the companion config', (tester) async {
    final engine = FakeEngine();
    await tester.pumpWidget(MaterialApp(
      home: AvatarPage(
        engineFactory: () => engine,
        platform: FakePlatform(),
        displayName: '小暖',
        companion: const CompanionConfig(aiCaption: '我是 AI 陪伴，不是真人', restToastMs: 6000),
      ),
    ));
    await tester.pump();
    expect(find.text('我是 AI 陪伴，不是真人'), findsOneWidget);
    expect(find.text('小暖'), findsOneWidget);
    expect(find.byKey(const Key('rest-toast')), findsNothing);
  });

  testWidgets('without a companion config the page shows no caption', (tester) async {
    await tester.pumpWidget(page(FakeEngine(), FakePlatform()));
    await tester.pump();
    expect(find.byKey(const Key('ai-caption')), findsNothing);
  });
```

Run: `cd app && flutter test test/avatar_page_engine_test.dart`
Expected: 编译失败（`AvatarPage` 没有 `companion` 参数）。

改 `app/lib/avatar_page.dart`（Task 13 之后的版本）：
1. import 区加：
   ```dart
   import 'companion_config.dart';
   import 'reminder_toast.dart';
   ```
2. 构造函数参数列表里，`this.displayName = '',` 后加 `this.companion,`；字段区 `displayName` 字段后加：
   ```dart
   /// AI caption and rest-toast duration (assets/config/companion.json). Null shows neither.
   final CompanionConfig? companion;
   ```
3. `_AvatarPageState` 字段区（`bool _released = false;` 后）加：
   ```dart
   ReminderToast? _toast;
   ```
4. `initState` 改为：
   ```dart
   @override
   void initState() {
     super.initState();
     final companion = widget.companion;
     if (companion != null) _toast = ReminderToast(showFor: companion.restToast)..addListener(_onToast);
     widget.platform.setWakelock(true);
     unawaited(_init());
   }

   void _onToast() => _update(() {});
   ```
5. `_onNativeEvent` 里，`if (event is UiDiag) {...}` 这段之后、`_engine.onSessionEvent(event);` 之前加一行：
   ```dart
       _toast?.onEvent(event);
   ```
6. `dispose` 里 `_handOff();` 之后加：
   ```dart
       _toast
         ?..removeListener(_onToast)
         ..dispose();
   ```
7. `build` 里 `AvatarOverlay(` 的参数末尾（`presence: ...,` 之后）加：
   ```dart
               caption: widget.companion?.aiCaption,
               toast: _toast?.text,
   ```

Run: `cd app && flutter test test/avatar_page_engine_test.dart test/avatar_page_test.dart`
Expected: PASS。

- [x] **Step 6: `main.dart` 加载配置**

`app/lib/main.dart`（Task 15 之后的版本）：
1. import 区加 `import 'companion_config.dart';`
2. `main()` 里 `runApp(...)` 改为：
   ```dart
   runApp(AvatarApp(catalog: await _loadCatalog(), companion: await _loadCompanion()));
   ```
   并在 `_loadCatalog` 下面加：
   ```dart
   /// Null when assets/config/companion.json is missing or invalid; the app shows a config error.
   Future<CompanionConfig?> _loadCompanion() async {
     try {
       return await loadCompanionConfig(rootBundle);
     } catch (_) {
       logcatDiagSink(formatDiag('companion_config_invalid', {}));
       return null;
     }
   }
   ```
3. `AvatarApp` 改为：
   ```dart
   class AvatarApp extends StatelessWidget {
     const AvatarApp({super.key, required this.catalog, required this.companion});

     final CharacterCatalog? catalog;
     final CompanionConfig? companion;

     @override
     Widget build(BuildContext context) {
       final catalog = this.catalog;
       final companion = this.companion;
       final problem = AppConfig.validate() ??
           (catalog == null ? 'characters.json' : null) ??
           (companion == null ? 'companion.json' : null);
       return MaterialApp(
         title: '智伴',
         debugShowCheckedModeBanner: false,
         theme: ThemeData(
           colorSchemeSeed: Colors.teal,
           brightness: Brightness.dark,
         ),
         home: switch (AppConfig.spike) {
           'native_audio' => const NativeAudioSpikePage(),
           'secure_storage' => const SecureStorageSpikePage(),
           'duix_probe' => const DuixProbeSpikePage(),
           _ =>
             catalog != null && companion != null && problem == null
                 ? _Home(catalog: catalog, companion: companion)
                 : Scaffold(
                     body: Center(
                       child: Text(
                         '配置错误：$problem',
                         style: const TextStyle(fontSize: 20),
                       ),
                     ),
                   ),
         },
       );
     }
   }
   ```
4. `_Home` 改为接收 `companion`：
   ```dart
   class _Home extends StatefulWidget {
     const _Home({required this.catalog, required this.companion});

     final CharacterCatalog catalog;
     final CompanionConfig companion;

     @override
     State<_Home> createState() => _HomeState();
   }
   ```
5. `_HomeState.build` 里的 `AvatarPage(` 加参数 `companion: widget.companion,`

- [x] **Step 7: 全量验证**

```bash
cd app
flutter test
flutter analyze
```

Expected：`flutter test` 全部 PASS；`flutter analyze` 输出 `No issues found!`。

- [x] **Step 8: 提交**

勾选本文件已完成的步骤，然后：

```bash
git add app/assets/config/companion.json app/lib/companion_config.dart app/lib/reminder_toast.dart \
  app/lib/native_session/events.dart app/lib/native_session/session_controller.dart \
  app/lib/overlay.dart app/lib/avatar_page.dart app/lib/main.dart \
  app/test/companion_config_test.dart app/test/reminder_toast_test.dart app/test/overlay_test.dart \
  app/test/native_session_controller_test.dart app/test/native_session_events_test.dart \
  app/test/avatar_page_engine_test.dart \
  docs/superpowers/plans/2026-10-26-multi-character/16-t16-app-caption-reminder.md
git commit -m "feat(app): show the AI caption and the rest reminder toast

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收清单

- [x] `app/assets/config/companion.json` 为 `{ "aiCaption": "我是 AI 陪伴，不是真人", "restToastMs": 6000 }`，加载时校验（空白、超过 30 字、时长不在 2000–30000、未知键都拒绝）；配置无效时 App 显示「配置错误」，不进入聊天。
- [x] 聊天页顶部常驻 AI 提示：18sp、文字半透明（`0xCCFFFFFF`）、深色半透明底（`0x42000000`，白字对比清晰）、单行、不响应点击，不与名字角标和状态文字重叠，位于屏幕上部 15% 以内。
- [x] 收到 `response.start{kind:'reminder'}` 后，toast 显示这一轮的 assistant 字幕（20sp），在字幕卡片上方；最后一次更新后停留 `restToastMs` 再消失；其他 kind、其他 seq、用户字幕、垫话字幕都不触发。
- [x] `UiSubtitle.toJson()` 不变，WebView 侧协议不受影响。
- [x] toast 文本不写日志、不写存储。
- [x] `cd app && flutter test` 全绿；`flutter analyze` 无问题。
- [x] 留给 Task 17 真机确认：AI 提示不挡小暖、小凯（Duix）和小欣（3D）的脸；把网关 `restReminder` 阈值调短后能看到 toast。
