# Plan 1 · 06 Day 1 音频 A/B spike 与真机 Mock 验收（Task 17–18）

> 先读 [00-overview.md](00-overview.md) 的 Global Constraints。本文件的大部分步骤是**真机手动测试**：严格按步骤记录数据；任何步骤卡住超过 20 分钟按阻塞规则记录后跳过。所有数值都要区分【实测】和【预估】。

---

### Task 17: 音频方案 A/B 对比 spike（spec §2.2、§9 Day 1 ③）

**目标：** 手机外放、无人说话的条件下，比较两条采集链路的"回声自触发"次数：
- **A（WebView）**：`getUserMedia`（`echoCancellation` 分别取 `true` / `'all'`）+ AudioWorklet 播放，与产品代码完全相同的模块。
- **B（Flutter 原生）**：`record`（VOICE_COMMUNICATION + 通话模式 + 扬声器 + echoCancel）采集，`flutter_pcm_sound` 播放。注意：`flutter_pcm_sound` 的 Android 实现使用 `USAGE_MEDIA` 播放（已在 3.3.3 源码中确认），与通话模式下的采集可能不在同一条回声消除路由里——这正是本 spike 要验证的风险。

两边使用同一个判据 `EnergyTrigger`（RMS ≥ 1200 且持续 ≥ 150 ms 记一次），A 额外报告 Silero VAD 的触发次数。

**Files:**
- Create: `avatar-core/spike-aec.html`, `avatar-core/src/spike/aec.ts`, `app/lib/spike/energy_trigger.dart`, `app/lib/spike/native_audio_spike.dart`, `docs/adr/ADR-001-day1-selection.md`
- Modify: `avatar-core/vite.config.ts`, `app/lib/config.dart`, `app/lib/main.dart`
- Test: `app/test/energy_trigger_test.dart`

**Depends on:** Task 9–11（播放、采集、VAD 模块）、Task 16（App 能加载 `PAGE` 指定的页面）、Task 0 Step 5（测试语音）。不依赖 Task 12–14。**分两段执行：** Step 1–4 与 Step 4b 是代码，在模拟器上做启动冒烟后即可提交；Step 5–6 是测量与选型，**只能用真机**——检查点 ① 只跑方案 A `echo=true` 10 分钟快测，检查点 ② 跑完整三组并写定 ADR-001。模拟器的回声路径（Mac 扬声器 → Mac 麦克风）和手机完全不同，数据不得写进 ADR。

**Interfaces:**
- Consumes: `PlaybackController`、`MicCapture`、`LocalVad`、`SpeechDetector`、`EnergyTrigger`、`DEFAULT_DETECTOR`（Task 9–11）；`LocalAssetServer`、`AppConfig.page`（Task 15/16）
- Produces: `AppConfig.spike`（dart-define `SPIKE`）；Dart `EnergyTrigger`；`ADR-001` 结论（选定 A 或 B）

- [x] **Step 1: Dart EnergyTrigger（先写测试）**

`app/test/energy_trigger_test.dart`:

```dart
import 'dart:typed_data';

import 'package:avatar_app/spike/energy_trigger.dart';
import 'package:flutter_test/flutter_test.dart';

Int16List frame(int value) => Int16List(320)..fillRange(0, 320, value);

void main() {
  test('fires once per sustained loud segment (same rule as avatar-core)', () {
    final t = EnergyTrigger();
    final fired = [for (var i = 0; i < 20; i++) t.push(frame(2000))];
    expect(fired.where((f) => f).length, 1);
    expect(fired.indexOf(true), 7);
    t.push(frame(0));
    for (var i = 0; i < 8; i++) {
      t.push(frame(2000));
    }
    expect(t.count, 2);
  });

  test('ignores short bursts', () {
    final t = EnergyTrigger();
    for (var k = 0; k < 5; k++) {
      for (var i = 0; i < 5; i++) {
        t.push(frame(2000));
      }
      t.push(frame(0));
    }
    expect(t.count, 0);
  });
}
```

Run: `cd app && flutter test test/energy_trigger_test.dart`
Expected: FAIL，找不到 `package:avatar_app/spike/energy_trigger.dart`。

`app/lib/spike/energy_trigger.dart`:

```dart
import 'dart:math';
import 'dart:typed_data';

// TUNABLE: same defaults as avatar-core/src/audio/energy.ts.
const double energyThresholdRms = 1200;
const int energyMinMs = 150;
const int energyFrameMs = 20;

double rmsInt16(Int16List pcm) {
  if (pcm.isEmpty) return 0;
  var sum = 0.0;
  for (final v in pcm) {
    sum += v * v;
  }
  return sqrt(sum / pcm.length);
}

/// Mirrors avatar-core/src/audio/energy.ts so paths A and B are judged identically.
class EnergyTrigger {
  EnergyTrigger({this.thresholdRms = energyThresholdRms, this.minMs = energyMinMs, this.frameMs = energyFrameMs});

  final double thresholdRms;
  final int minMs;
  final int frameMs;
  int count = 0;
  int _aboveMs = 0;
  bool _armed = true;

  bool push(Int16List frame) {
    if (rmsInt16(frame) >= thresholdRms) {
      _aboveMs += frameMs;
      if (_armed && _aboveMs >= minMs) {
        _armed = false;
        count++;
        return true;
      }
      return false;
    }
    _aboveMs = 0;
    _armed = true;
    return false;
  }
}
```

Run: `cd app && flutter test test/energy_trigger_test.dart`
Expected: 2 个测试 PASS。

- [x] **Step 2: Spike A 页面（WebView 链路）**

`avatar-core/spike-aec.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AEC spike A</title>
    <style>
      body { margin: 0; padding: 16px; background: #10131a; color: #e8ecf3; font: 18px system-ui, sans-serif; }
      button { font-size: 18px; padding: 12px 16px; margin: 4px 4px 12px 0; }
      #out { white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 16px; }
    </style>
  </head>
  <body>
    <h3>音频方案 A：WebView 采集 + AudioWorklet 外放</h3>
    <button id="start-true" type="button">开始（EC=true）</button>
    <button id="start-all" type="button">开始（EC=all）</button>
    <button id="stop" type="button">停止</button>
    <div id="out">手机平放，媒体音量 70%，安静房间，测试期间不要说话。</div>
    <script type="module" src="/src/spike/aec.ts"></script>
  </body>
</html>
```

`avatar-core/src/spike/aec.ts`:

```ts
import { AI_SAMPLE_RATE } from '@anyidea/protocol';
import { MicCapture, type EchoMode } from '../audio/capture.ts';
import { EnergyTrigger } from '../audio/energy.ts';
import { PlaybackController } from '../audio/player.ts';
import { DEFAULT_DETECTOR, LocalVad, SpeechDetector } from '../audio/vad.ts';

export const FEED_CHUNK_MS = 100; // TUNABLE: playback feed interval and chunk length
export const PREBUFFER_CHUNKS = 3; // TUNABLE: ~300 ms head start before real-time feeding
export const RENDER_INTERVAL_MS = 1000; // TUNABLE: stats refresh period

// Posts straight to the Flutter channel so this page does not depend on Task 14's bridge.ts.
const postDiag = (value: string) =>
  (window as unknown as { FlutterBridge?: { postMessage(m: string): void } }).FlutterBridge?.postMessage(
    JSON.stringify({ type: 'diag', key: 'spike_a', value }),
  );
const out = document.getElementById('out')!;
const CHUNK = (AI_SAMPLE_RATE * FEED_CHUNK_MS) / 1000; // 2400 samples
let running: { stop(): Promise<void> } | null = null;

async function loadSpeech(): Promise<Int16Array> {
  const buf = await (await fetch('./spike/speech-24k.pcm')).arrayBuffer();
  return new Int16Array(buf.slice(0, buf.byteLength - (buf.byteLength % 2)));
}

async function run(echo: EchoMode): Promise<void> {
  if (running) await running.stop();
  const speech = await loadSpeech();
  const energy = new EnergyTrigger();
  const normal = new SpeechDetector(DEFAULT_DETECTOR);
  let sileroBargeIn = 0;
  let sileroNormal = 0;
  const player = new PlaybackController({ onFirstAudio() {}, onEnded() {}, onStopped() {}, onProgress() {}, onLevel() {} });
  await player.init();
  await player.resume();
  player.onResponseStart(1);
  let offset = 0;
  const pushNext = () => {
    const chunk = new Int16Array(CHUNK);
    for (let i = 0; i < CHUNK; i++) chunk[i] = speech[(offset + i) % speech.length];
    offset = (offset + CHUNK) % speech.length;
    player.push(1, chunk);
  };
  for (let i = 0; i < PREBUFFER_CHUNKS; i++) pushNext();
  const feeder = setInterval(pushNext, FEED_CHUNK_MS); // then real-time, looping the sample forever

  const capture = new MicCapture();
  const stream = await capture.start({ echo, onFrame: (pcm) => energy.push(pcm) });
  const vad = new LocalVad();
  vad.aiPlaying = true; // the product raises the threshold while the AI speaks
  await vad.start(stream, {
    onStart: () => sileroBargeIn++,
    onEnd: () => {},
    onProbability: (p) => {
      if (normal.push(p, performance.now()) === 'start') sileroNormal++;
    },
  });

  const t0 = performance.now();
  const settings = JSON.stringify(capture.settings());
  const render = () => {
    const min = (performance.now() - t0) / 60000;
    const per10 = (n: number) => (min > 0 ? ((n / min) * 10).toFixed(1) : '0');
    const text =
      `方案 A  echo=${echo}  已运行 ${min.toFixed(1)} 分钟\n` +
      `能量触发 ${energy.count} 次（${per10(energy.count)}/10min）\n` +
      `Silero 打断阈值触发 ${sileroBargeIn} 次（${per10(sileroBargeIn)}/10min）\n` +
      `Silero 普通阈值触发 ${sileroNormal} 次（${per10(sileroNormal)}/10min）\n` +
      `mic=${settings}`;
    out.textContent = text;
    postDiag(text);
  };
  const ticker = setInterval(render, RENDER_INTERVAL_MS);
  running = {
    async stop() {
      clearInterval(feeder);
      clearInterval(ticker);
      render();
      player.interrupt();
      await vad.destroy();
      await capture.stop();
      running = null;
    },
  };
}

document.getElementById('start-true')!.addEventListener('click', () => void run('true'));
document.getElementById('start-all')!.addEventListener('click', () => void run('all'));
document.getElementById('stop')!.addEventListener('click', () => void running?.stop());
```

在 `avatar-core/vite.config.ts` 中把 `input` 改为：

```ts
    rollupOptions: { input: { main: 'index.html', spike: 'spike-aec.html' } },
```

- [x] **Step 3: 让 App 能打开原生 spike**

spike A 页面用 Task 15/16 已有的 `--dart-define=PAGE=spike-aec.html` 打开。`app/lib/config.dart` 在 `AppConfig` 中新增（放在 `page` 下方）：

```dart
  /// 'native_audio' opens the path-B spike instead of the WebView.
  static const spike = String.fromEnvironment('SPIKE');
```

`app/lib/main.dart` 中把 `home:` 改为：

```dart
      home: AppConfig.spike == 'native_audio'
          ? const NativeAudioSpikePage()
          : problem == null
              ? const AvatarPage()
              : Scaffold(body: Center(child: Text('配置错误：$problem', style: const TextStyle(fontSize: 20)))),
```

并在 `main.dart` 顶部加 `import 'spike/native_audio_spike.dart';`。

- [x] **Step 4: Spike B 页面（Flutter 原生链路）**

**未核实假设（AGENTS.md）：** 下面用到的 `flutter_pcm_sound` 3.3.3 API（`FlutterPcmSound.setup(sampleRate:, channelCount:)`、`setFeedThreshold`、`setFeedCallback`、`feed(PcmArrayInt16(bytes: ...))`、`start()`）尚未按包源码核实（2026-10-12 本机 `~/.pub-cache` 中没有该包）。写代码前先 `cd app && flutter pub get`，然后对照 `~/.pub-cache/hosted/pub.dev/flutter_pcm_sound-3.3.3/lib/` 核对方法名、参数名与回调签名；若不一致，按包源码改写本文件，并把差异记入 `docs/blockers.md`（模板见 Task 0）。

**核实结果（2026-10-12，Task 17 实施时）：** 已对照 `flutter_pcm_sound-3.3.3/lib/flutter_pcm_sound.dart` 与 `record_platform_interface-2.1.0`（record 7.1.2 / record_android 2.2.0）源码核对，上述方法名、参数名、回调签名、`AndroidRecordConfig` 字段与枚举值均一致，无需改写。额外发现两点并已在下方代码中处理：① 插件默认日志级别会在每次 `feed` 时打印前 6 个样本字节，因此先调用 `setLogLevel(LogLevel.none)`；② `feed` 发送的是 `bytes.buffer` 整个底层缓冲区而不是视图，所以每次都新建 `Int16List`（不可改成复用大缓冲区的视图）。Android 端播放确认为 `USAGE_MEDIA` / `CONTENT_TYPE_MUSIC`。

`app/lib/spike/native_audio_spike.dart`:

```dart
import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_pcm_sound/flutter_pcm_sound.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:record/record.dart';

import 'energy_trigger.dart';

const int nativeFeedChunkSamples = 12000; // TUNABLE: 0.5 s @ 24 kHz per feed and feed threshold
const Duration nativeRenderInterval = Duration(seconds: 1); // TUNABLE: stats refresh period

/// Path B: native capture (VOICE_COMMUNICATION + in-communication mode + speakerphone + AEC)
/// while flutter_pcm_sound loops the same speech sample on the loudspeaker.
class NativeAudioSpikePage extends StatefulWidget {
  const NativeAudioSpikePage({super.key});

  @override
  State<NativeAudioSpikePage> createState() => _NativeAudioSpikePageState();
}

class _NativeAudioSpikePageState extends State<NativeAudioSpikePage> {
  final _recorder = AudioRecorder();
  final _trigger = EnergyTrigger();
  StreamSubscription<Uint8List>? _sub;
  Timer? _ticker;
  Int16List? _speech;
  int _offset = 0;
  DateTime? _startedAt;
  double _lastRms = 0;
  final _pending = BytesBuilder(copy: false);

  Future<void> _start() async {
    if (!(await Permission.microphone.request()).isGranted) return;
    final bytes = await rootBundle.load('assets/web/spike/speech-24k.pcm');
    final raw = Uint8List.fromList(bytes.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes & ~1));
    _speech = raw.buffer.asInt16List(); // copied, so the view is 2-byte aligned
    // The plugin's default log level prints sample bytes of every feed; keep audio out of logs.
    await FlutterPcmSound.setLogLevel(LogLevel.none);
    await FlutterPcmSound.setup(sampleRate: 24000, channelCount: 1);
    await FlutterPcmSound.setFeedThreshold(nativeFeedChunkSamples);
    FlutterPcmSound.setFeedCallback((_) => _feed());
    await _feed();
    FlutterPcmSound.start();

    final stream = await _recorder.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: 16000,
      numChannels: 1,
      echoCancel: true,
      noiseSuppress: true,
      autoGain: true,
      androidConfig: AndroidRecordConfig(
        audioSource: AndroidAudioSource.voiceCommunication,
        audioManagerMode: AudioManagerMode.modeInCommunication,
        speakerphone: true,
      ),
    ));
    _sub = stream.listen(_onMic);
    _startedAt = DateTime.now();
    _ticker = Timer.periodic(nativeRenderInterval, (_) => setState(() {}));
    setState(() {});
  }

  Future<void> _feed() async {
    final speech = _speech;
    if (speech == null) return;
    // A fresh list per feed: the plugin sends the whole backing buffer, not just the view.
    final chunk = Int16List(nativeFeedChunkSamples);
    for (var i = 0; i < nativeFeedChunkSamples; i++) {
      chunk[i] = speech[(_offset + i) % speech.length];
    }
    _offset = (_offset + nativeFeedChunkSamples) % speech.length;
    await FlutterPcmSound.feed(PcmArrayInt16(bytes: ByteData.sublistView(chunk)));
  }

  /// Re-frames the recorder byte stream into 20 ms (320-sample) frames.
  void _onMic(Uint8List data) {
    _pending.add(data);
    final all = _pending.takeBytes();
    const frameBytes = 640;
    var off = 0;
    final view = ByteData.sublistView(all);
    while (off + frameBytes <= all.length) {
      final frame = Int16List(320);
      for (var i = 0; i < 320; i++) {
        frame[i] = view.getInt16(off + i * 2, Endian.little);
      }
      _lastRms = rmsInt16(frame);
      _trigger.push(frame);
      off += frameBytes;
    }
    if (off < all.length) _pending.add(Uint8List.fromList(all.sublist(off)));
  }

  Future<void> _stop() async {
    _ticker?.cancel();
    await _sub?.cancel();
    await _recorder.stop();
    FlutterPcmSound.setFeedCallback(null);
    await FlutterPcmSound.release();
    if (mounted) setState(() => _startedAt = null);
  }

  @override
  void dispose() {
    _stop();
    _recorder.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final started = _startedAt;
    final minutes = started == null ? 0.0 : DateTime.now().difference(started).inMilliseconds / 60000;
    final per10 = minutes > 0 ? (_trigger.count / minutes * 10).toStringAsFixed(1) : '0';
    return Scaffold(
      appBar: AppBar(title: const Text('音频方案 B：原生采集 + 原生外放')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: DefaultTextStyle(
          style: const TextStyle(fontSize: 18, color: Colors.white),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('手机平放，媒体音量 70%，安静房间，测试期间不要说话。'),
            const SizedBox(height: 12),
            Row(children: [
              FilledButton(onPressed: started == null ? _start : null, child: const Text('开始')),
              const SizedBox(width: 12),
              OutlinedButton(onPressed: started != null ? _stop : null, child: const Text('停止')),
            ]),
            const SizedBox(height: 16),
            Text('已运行 ${minutes.toStringAsFixed(1)} 分钟'),
            Text('能量触发 ${_trigger.count} 次（$per10/10min）'),
            Text('当前 RMS ${_lastRms.round()}'),
          ]),
        ),
      ),
    );
  }
}
```

- [ ] **Step 4b: 模拟器冒烟并提交代码**

在模拟器上分别用 `--dart-define=PAGE=spike-aec.html` 和 `--dart-define=SPIKE=native_audio` 启动（命令同 Step 5），确认页面能打开、按钮能点、计数在刷新、没有报错即可；数字不记录。然后提交：

```bash
cd /Users/JedJiang/SourceCode/anyidea
git add avatar-core/spike-aec.html avatar-core/src/spike avatar-core/vite.config.ts app/lib/config.dart app/lib/main.dart app/lib/spike app/test/energy_trigger_test.dart
git commit -m "feat(spike): audio path A/B echo comparison pages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: 真机构建并跑三组测试（每组 10 分钟；检查点 ① 只跑 A `echo=true`，检查点 ② 三组全跑）**

```bash
cd /Users/JedJiang/SourceCode/anyidea && ./scripts/build-web.sh   # 完整模式：构建 avatar-core（含 spike 页）
cd app
# A：WebView 链路
flutter run --dart-define-from-file=dev.json --dart-define=PAGE=spike-aec.html
#   先点"开始（EC=true）"跑 10 分钟 → 停止 → 记录；再点"开始（EC=all）"跑 10 分钟 → 记录
# B：原生链路
flutter run --dart-define-from-file=dev.json --dart-define=SPIKE=native_audio
#   点"开始"跑 10 分钟 → 停止 → 记录
```

统一条件：手机平放在桌面、扬声器朝上；媒体音量 70%（B 进入通话模式后音量键可能改为通话音量，按实际情况记录）；安静房间；测试期间无人说话。

每组结束后再做一次"真打断"抽查：继续播放，测试者在手机前 50 cm 处说 10 句短话（"等一下""你好""停一停"……），记录能量触发和 Silero 触发次数（应接近 10 次）。

- [ ] **Step 6: 写 ADR-001 并选定方案**

`docs/adr/ADR-001-day1-selection.md`（把【实测】栏填上真实数据，未测的写"未测"并说明原因）:

```markdown
# ADR-001：Day 1 选型结论

- 日期：YYYY-MM-DD
- 设备：小米 ____（型号），Android __，WebView 版本 ____（A/B 数据只来自真机；模拟器结果只填在下方"模拟器"列）

## 音频方案 A/B（外放、无人说话、10 分钟）

| 方案 | 设置 | 能量触发次数/10min【实测】 | Silero 打断阈值/10min【实测】 | Silero 普通阈值/10min【实测】 | 真打断 10 句检出数【实测】 | mic settings |
|---|---|---|---|---|---|---|
| A | echo=true |  |  |  |  |  |
| A | echo=all |  |  |  |  |  |
| B | VOICE_COMMUNICATION + 通话模式 + 扬声器 | | n/a | n/a |  | n/a |

判定规则（spec §9 Day 1）：选 10 分钟自打断更少的方案；持平时选 A。目标【预估】：自打断 ≤1 次/10 分钟，真打断检出 ≥9/10。

**结论：** 选定方案 __，理由：__。
若 A、B 都 >1 次/10 分钟：按 spec §2.1 Plan B，在 Plan 2 中评估 `flutter_webrtc` 直连 Qwen WebRTC。

## 其他 Day 1 验证项

| 项 | 模拟器（API 36 / API 31） | 真机【实测】 | 备注 |
|---|---|---|---|
| WebView 版本 / 安全上下文 |  |  | Task 16 Step 8 探针 `webview`、`secure_context` |
| 免手势播放（AudioContext 无手势 running） |  |  | 探针 `autoplay`；完整页面再在 Task 18 Step 0 确认打开即问候 |
| AudioWorklet / wasm / WebGL2 / 麦克风 |  |  | 探针对应各项 |
| release 构建加载 127.0.0.1 页面 |  |  | Task 16 Step 9 |
| WebGL 帧率（idle / speaking） | 不代表手机 |  | Task 18 |
| 主模型选择（Seeduplex vs Qwen） | — | 未测：等待 Key | Plan 2 |
```

如果选定 **B**：按 spec §2.2，在 ADR 中写明需迁移到 Dart 的职责（采集、播放、门控、GatewayClient），并在汇报中提示"Day 2–4 计划需要重排，预计多 1 天"；Plan 1 的 Task 18 仍用方案 A 完成 Mock 验收（默认继续执行 Task 12–14，不自行迁移；是否在 Plan 1 内迁移由用户决定）。

- [ ] **Step 7: 提交 ADR（检查点 ① 写初稿，检查点 ② 定稿）**

```bash
cd /Users/JedJiang/SourceCode/anyidea
git add docs/adr/ADR-001-day1-selection.md
git commit -m "docs(adr): ADR-001 audio path selection from on-device measurements

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Mock 全链路验收与调参（模拟器联调 + 真机验收）

**目标：** 先在模拟器上把功能链路走通，再在小米手机上（真机检查点 ②），用 Mock 把 spec §10 中**不依赖真实模型**的场景全部走一遍，测出指标实测值，调好口型与动作参数，为 Plan 2 留下基线。依赖真实模型的指标（首响应延迟、抢话率、上下文回忆质量）在本任务中只验证"链路正确"，不作为结论。会话记忆（摘要、按播放进度截断、重建与续接后保留 Ledger）在 Plan 1 只由 Task 3/7/8 的自动化测试证明——Mock 的回答是写死的，真机上看不出模型是否"记得"。

指标口径（与 spec §10.2 对照）：`greeting_ms` 从 WebView 内会话开始计时（不含 App 冷启动与 GLB 加载，报告中另记"冷启动到开口"的秒表值）；`interrupt_stop_ms` = 主线程发出停止指令的时刻 + 30 ms 淡出 − VAD 起点，不含系统音频输出延迟，是估算值；`first_response_ms` 在 Mock 下只反映 Mock 的固定延迟，不作结论。

**Depends on:** Task 8、14、16、17 Step 1–4b。清单中标【模拟器】的项写完代码即可做；标【真机】的项在真机检查点 ②（Task 17 Step 5–6 之后）做，调参也只按真机数据调。模拟器结果与真机结果在清单和报告中分开记录。

**Files:**
- Create: `docs/testing/mock-e2e-checklist.md`, `docs/testing/YYYY-MM-DD-mock-e2e-report.md`
- Modify（按调参结果）: `avatar-core/src/audio/mouth.ts`（`DEFAULT_MOUTH`）、`avatar-core/src/avatar/actions.ts`（`ACTION_TUNING`：比心手指角度、点头幅度）、`avatar-core/src/audio/vad.ts`（`DEFAULT_DETECTOR`）、`gateway/.env`（`MOCK_SPEECH_THRESHOLD`，不入库）

- [ ] **Step 0: 完整页面首跑（先模拟器，检查点 ② 再用真机）**

模拟器上先打开主机音频输入（Task 0 Step 2a），Mac 上戴耳机（否则 Mac 扬声器的回声会让打断和 Mock 识别乱触发），或者只用调试框文字代替说话；第 6 项只在真机上做。

```bash
cd /Users/JedJiang/SourceCode/anyidea
./scripts/build-web.sh                      # 完整模式
# Run the gateway in a separate terminal (foreground): `npm run dev -w gateway`; later steps restart it, stop it with Ctrl-C after Task 18.
adb reverse tcp:8787 tcp:8787
cd app && flutter run --dart-define-from-file=dev.json   # PAGE 默认 index.html
```

逐项核对（不通过的项按阻塞规则处理；退路只按真机结果执行）：

1. 页面加载，虚拟人出现，**不需要任何点击**就开始 Mock 问候（Task 16 探针 `autoplay` 失败时，这里按降级方案点一次）。
2. 长按左上角"AI 虚拟人"打开调试面板：`audio_context=running`；`mic_settings` 中 `echoCancellation` 为 `true`；`greeting_ms` 有数值。
3. 在调试面板输入"挥挥手"：虚拟人挥手并说"好呀，来，挥挥手！"。
4. 对着手机说话：状态依次变为 listening → thinking → speaking；字幕显示 Mock 脚本里的下一条用户文本。
5. `chrome://inspect` 控制台没有 `ERR_CLEARTEXT_NOT_PERMITTED`、`NotAllowedError`、worklet/wasm 加载失败等报错。
6. 【仅真机】不说话、只让 AI 外放问候和追问：观察是否出现自己冒出来的用户字幕（Mock 把回声当成说话）。若出现，逐步调高 `gateway/.env` 的 `MOCK_SPEECH_THRESHOLD`（如 1200、1600）并重启网关，记录最终值。

- [ ] **Step 1: 创建验收清单**

`docs/testing/mock-e2e-checklist.md`:

```markdown
# Mock 全链路验收清单（Plan 1 / Task 18）

前置：`npm run dev -w gateway`；`adb reverse tcp:8787 tcp:8787`；`./scripts/build-web.sh`；`cd app && flutter run --dart-define-from-file=dev.json`。
调试面板：长按左上角"AI 虚拟人"。每项写：通过/不通过 + 实测数据 + 备注，模拟器与真机分两列记录。
"环境"列：【模拟器】= 写代码阶段在模拟器上验证功能即可，检查点 ② 真机抽查；【真机】= 只有真机结果算数；【两者】= 模拟器验功能，数值以真机为准。
Mock 不识别语音内容：每检测到一段说话，就按 `gateway/mock/script.json` 的 `turns` 顺序给出下一条识别结果（说什么都一样）。需要指定内容时用调试框输入文字。

| # | 场景（spec §10） | 环境 | 操作 | 通过标准 | 模拟器结果 | 真机结果 |
|---|---|---|---|---|---|---|
| 1 | 主动迎宾 | 【两者】 | 冷启动 App，不触碰屏幕 | 自动开口问候；`greeting_ms` ≤2000【预估目标】；另用秒表记"点图标到开口"的秒数 | | |
| 2 | 多轮链路 | 【两者】 | 连续说 5 句话（识别结果按脚本顺序） | 每轮 listening→thinking→speaking→idle；字幕与脚本一致；无卡死 | | |
| 3 | 打断零残留 | 【两者】 | AI 说话时插话，重复 20 次 | 每次声音迅速停止；`interrupt_stop_ms` P50 ≤300、P90 ≤500【预估目标】；旧回复的声音/字幕 0 次再出现 | | |
| 4 | 动作 | 【两者】 | 调试框依次输入 5 个动作指令各 2 次；再用语音继续说，直到轮到脚本里含"挥""比心"的两条（`turns` 第 3、4 条，循环使用；想从头开始就重启网关并重开 App） | 动作正确且每次只执行一次（关键词与工具调用去重）；动作期间口型正常；`action_latency_ms` ≤1000 | | |
| 5 | 静默追问 | 【模拟器】 | 迎宾结束后保持沉默 40 秒 | 约 8 秒后追问"刚才聊到这儿…"1 次，再约 25 秒后说"我在这儿呢，想聊随时叫我。"，之后不再主动开口 | | |
| 6 | 口型/状态一致 | 【两者】 | 观察 3 轮对话 | 嘴只在 AI 出声时动；打断瞬间嘴合上；listening 时有注视和轻点头 | | |
| 7 | 静音 | 【模拟器】 | 点麦克风按钮静音后说话 | 不触发任何回复；Director 不追问；再次点击恢复 | | |
| 8 | 短断网续接 | 【两者】 | **注意：`adb reverse` 不经过设备网络，开飞行模式不会断开它，本项不能用 127.0.0.1。** 模拟器：`dev.json` 的 `GATEWAY_URL` 改为 `http://10.0.2.2:8787`（模拟器访问电脑的地址，只有 debug 包允许明文），重新 `flutter run`，对话中执行 `adb shell cmd connectivity airplane-mode enable`，10 秒后 `... disable`（命令不可用时用模拟器下拉快捷设置里的飞行模式）。真机：`dev.json` 的 `GATEWAY_URL` 改为 `http://<电脑局域网 IP>:8787`（只有 debug 包允许明文访问局域网），手机与电脑连同一 Wi-Fi，重新 `flutter run`；对话中开飞行模式 10 秒再关（macOS 防火墙弹窗时允许 node 接入） | 状态显示"网络有点慢"→ 恢复；AI 说"刚才网络断了一下，我们接着聊吧。"；没有旧音频；网关日志出现 `session_resumed`（若先出现 `ws_heartbeat_timeout` 或 `connection_superseded` 也属正常） | | |
| 9 | 长断网 | 【两者】 | 同第 8 项的方式（模拟器用 `10.0.2.2`，真机用局域网 IP），断网 70 秒后恢复 | 建立新会话并重新迎宾，问候有声音、有字幕 | | |
| 10 | 切后台 | 【真机】 | 回到桌面 30 秒再返回 | App 不崩溃；回来后能继续对话（记录是否需要重连） | | |
| 11 | 来电 | 【真机】 | 用另一部手机拨入，挂断后观察 | 不崩溃；记录音频是否恢复 | | |
| 12 | 30 分钟稳定性 | 【真机】 | 每 1–2 分钟说一句话，持续 30 分钟 | 0 次崩溃；调试面板记录帧率（chrome://inspect 的 Performance 或肉眼）；机身温度主观记录 | | |
| 13 | 日志合规 | 【模拟器】 | 检查网关终端输出 | 只有事件名和数值，无任何对话文本 | | |
```

- [ ] **Step 2: 逐项执行并记录**

写代码阶段先在模拟器上执行【模拟器】和【两者】项；真机检查点 ② 执行【真机】和【两者】项。按清单执行；每项结束后在调试面板点"复制 CSV"，粘贴到报告文件的附录。帧率测量：`chrome://inspect` → inspect WebView → Performance 面板录制 10 秒，分别在 idle 和 speaking 状态下读取 FPS。

- [ ] **Step 3: 调参（优先只改 `TUNABLE` 常量/配置；下面标"逻辑改动"的退路会改代码，需跑 `npm run typecheck -w avatar-core && npm test -w avatar-core` 并在报告中注明。改完重新 `./scripts/build-web.sh` 并复测对应项）**

- 口型张合过小/过大：调 `DEFAULT_MOUTH.gain`（建议 4–10）、`noiseFloor`（0.005–0.03）。
- 比心手势不像：在 `chrome://inspect` 控制台里临时修改 `gestureTemplates.heart` 的手指角度并实时调用 `playGesture('heart', 2.5, true)`，得到满意值后写回 `actions.ts` 的 `ACTION_TUNING.heartFingers`。若到本步结束仍不过关（逻辑改动），改为 spec §8.4 的退路"双臂举过头顶的大比心"（用 `playPose` 或新的 gesture 模板），并在报告中注明。
- 点头太僵/太小：调 `ACTION_TUNING.nod` 的 `amplitude` 与 `durationMs`。如果 `mtAvatar.headRotateX` 不存在导致不点头，记入 `docs/blockers.md`，（逻辑改动）改用 Mixamo "Head Nod Yes" FBX + `playAnimation`。
- 转身出画面（逻辑改动）：在 `turn()` 中把整圈改为 ±90° 往返，或在转身期间调用 `setView('full')` 后恢复 `'mid'`。
- 打断太灵敏/不灵敏：调 `DEFAULT_DETECTOR.bargeInThreshold`（0.6–0.9）与 `startMs`（100–250），以 Task 17 的数据为依据。
- Mock 被回声误触发（没人说话却出现用户字幕）：调高 `gateway/.env` 的 `MOCK_SPEECH_THRESHOLD`，重启网关后复测第 3、5 项。

- [ ] **Step 4: 写验收报告**

`docs/testing/YYYY-MM-DD-mock-e2e-report.md`（日期用执行当天）:

```markdown
# Mock 全链路真机验收报告

- 设备：小米 ____ / Android __ / WebView ____；音频方案：__（见 ADR-001）；联调模拟器：____
- 下表数值只来自真机；没有真机数据的项写"未测：缺少真机"，不得用模拟器数值代替。
- 范围：Plan 1，MockAdapter；**不含真实模型**，首响应延迟、抢话率、上下文质量不在本报告结论内。

## 指标（实测 vs 目标）

| 指标 | 目标【预估】 | 实测 P50 | 实测 P90 | 样本数 | 结论 |
|---|---|---|---|---|---|
| greeting_ms | ≤2000 | | | | |
| interrupt_stop_ms | P50 ≤300 / P90 ≤500 | | | | |
| 旧语音残留 | 0 / 20 次 | | | | |
| action_latency_ms | ≤1000 | | | | |
| 冷启动到开口（秒表） | ≤2 秒（spec 迎宾延迟口径） | | | | |
| 自打断（外放） | ≤1 次/10min | | | | 引用 ADR-001 |
| Mock 误触发阈值 | — | | | | 最终 `MOCK_SPEECH_THRESHOLD` |
| 帧率 idle / speaking | ≥30 fps | | | | |
| 30 分钟崩溃次数 | 0 | | | | |

## 清单结果
（逐项粘贴 mock-e2e-checklist 的结果列）

## 调参记录
| 参数 | 原值 | 新值 | 原因 |
|---|---|---|---|

## 遗留问题与 Plan 2 输入
- 阻塞项：见 docs/blockers.md 第 __ 条
- 需要真实模型验证：首响应延迟、抢话率、上下文回忆、工具调用对语流的影响
- 其他：

## 附录：metrics CSV
```

- [ ] **Step 5: 全量回归与提交**

```bash
cd /Users/JedJiang/SourceCode/anyidea
npm test && npm run typecheck
(cd app && flutter test && flutter analyze)
git add docs/testing docs/blockers.md avatar-core/src
git commit -m "test: on-device mock end-to-end acceptance, tuning and report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: 所有自动化测试 PASS；报告中每个指标都有真机【实测】值或明确写明"未测 + 原因"。只有【真机】与【两者】项都有真机结果时，Plan 1 才能宣称"真机可演示"；否则只能宣称"模拟器功能链路通过"。

---

## Plan 1 完成后的交接

1. 汇报：已完成的 Task、ADR-001 结论、报告中的实测指标、`docs/blockers.md` 中所有未解除的阻塞项。
2. 拿到火山引擎 / 阿里云百炼 Key 后编写 **Plan 2**：先核实两家实时协议的真实事件名与音频格式，再实现 `SeeduplexAdapter` / `QwenOmniAdapter`（实现 Task 2 的 `RealtimeAdapter` 接口）、`LlmSummarizer`（实现 Task 3 的 `Summarizer` 接口），然后做双模型对比、Director/人设调参、云端部署（WSS + TLS + App 密钥 + IP 白名单）与 release APK 交付。
