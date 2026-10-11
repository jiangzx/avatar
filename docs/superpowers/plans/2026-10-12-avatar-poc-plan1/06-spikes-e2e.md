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
- Modify: `avatar-core/vite.config.ts`, `app/lib/config.dart`, `app/lib/main.dart`, `app/lib/avatar_page.dart`
- Test: `app/test/energy_trigger_test.dart`

**Interfaces:**
- Consumes: `PlaybackController`、`MicCapture`、`LocalVad`、`SpeechDetector`、`EnergyTrigger`、`DEFAULT_DETECTOR`（Task 9–11）；`LocalAssetServer`、`AppConfig`（Task 15）
- Produces: `AppConfig.page`（dart-define `PAGE`，默认 `index.html`）、`AppConfig.spike`（dart-define `SPIKE`）；Dart `EnergyTrigger`；`ADR-001` 结论（选定 A 或 B）

- [ ] **Step 1: Dart EnergyTrigger（先写测试）**

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
  EnergyTrigger({this.thresholdRms = 1200, this.minMs = 150, this.frameMs = 20});

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

- [ ] **Step 2: Spike A 页面（WebView 链路）**

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
import { MicCapture, type EchoMode } from '../audio/capture.ts';
import { EnergyTrigger } from '../audio/energy.ts';
import { PlaybackController } from '../audio/player.ts';
import { DEFAULT_DETECTOR, LocalVad, SpeechDetector } from '../audio/vad.ts';
import { postToFlutter } from '../bridge.ts';

const out = document.getElementById('out')!;
const CHUNK = 2400; // 100 ms @ 24 kHz
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
  for (let i = 0; i < 3; i++) pushNext(); // ~300 ms head start
  const feeder = setInterval(pushNext, 100); // then real-time, looping the sample forever

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
    postToFlutter({ type: 'diag', key: 'spike_a', value: text });
  };
  const ticker = setInterval(render, 1000);
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

- [ ] **Step 3: 让 App 能打开 spike 页面与原生 spike**

`app/lib/config.dart` 在 `AppConfig` 中新增两行（放在 `echo` 下方）：

```dart
  /// Page inside the web bundle to load (spike: 'spike-aec.html').
  static const page = String.fromEnvironment('PAGE', defaultValue: 'index.html');

  /// 'native_audio' opens the path-B spike instead of the WebView.
  static const spike = String.fromEnvironment('SPIKE');
```

`app/lib/avatar_page.dart` 中把

```dart
    await controller.loadRequest(base.resolve('index.html'));
```

改为

```dart
    await controller.loadRequest(base.resolve(AppConfig.page));
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

- [ ] **Step 4: Spike B 页面（Flutter 原生链路）**

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

/// Path B: native capture (VOICE_COMMUNICATION + in-communication mode + speakerphone + AEC)
/// while flutter_pcm_sound loops the same speech sample on the loudspeaker.
class NativeAudioSpikePage extends StatefulWidget {
  const NativeAudioSpikePage({super.key});

  @override
  State<NativeAudioSpikePage> createState() => _NativeAudioSpikePageState();
}

class _NativeAudioSpikePageState extends State<NativeAudioSpikePage> {
  static const _chunkSamples = 12000; // 0.5 s @ 24 kHz
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
    await FlutterPcmSound.setup(sampleRate: 24000, channelCount: 1);
    await FlutterPcmSound.setFeedThreshold(_chunkSamples);
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
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
    setState(() {});
  }

  Future<void> _feed() async {
    final speech = _speech;
    if (speech == null) return;
    final chunk = Int16List(_chunkSamples);
    for (var i = 0; i < _chunkSamples; i++) {
      chunk[i] = speech[(_offset + i) % speech.length];
    }
    _offset = (_offset + _chunkSamples) % speech.length;
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

- [ ] **Step 5: 构建并跑三组测试（每组 10 分钟）**

```bash
cd /Users/JedJiang/SourceCode/anyidea && ./scripts/build-web.sh
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
- 设备：小米 ____（型号），Android __，WebView 版本 ____

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

| 项 | 结果【实测】 | 备注 |
|---|---|---|
| release 构建加载 127.0.0.1 页面 |  | Task 16 Step 9 |
| 免手势播放（打开即问候） |  | Task 16 Step 8 |
| WebGL 帧率（idle / speaking） |  | Task 18 |
| 主模型选择（Seeduplex vs Qwen） | 未测：等待 Key | Plan 2 |
```

如果选定 **B**：按 spec §2.2，在 ADR 中写明需迁移到 Dart 的职责（采集、播放、门控、GatewayClient），并在汇报中提示"Day 2–4 计划需要重排，预计多 1 天"；Plan 1 的 Task 18 仍用方案 A 完成 Mock 验收。

- [ ] **Step 7: 提交**

```bash
cd /Users/JedJiang/SourceCode/anyidea
git add avatar-core/spike-aec.html avatar-core/src/spike avatar-core/vite.config.ts app/lib app/test/energy_trigger_test.dart docs/adr
git commit -m "feat(spike): audio path A/B echo comparison and ADR-001

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: 真机 Mock 全链路验收与调参

**目标：** 在小米手机上，用 Mock 把 spec §10 中**不依赖真实模型**的场景全部走一遍，测出指标实测值，调好口型与动作参数，为 Plan 2 留下基线。依赖真实模型的指标（首响应延迟、抢话率、上下文回忆质量）在本任务中只验证"链路正确"，不作为结论。

**Files:**
- Create: `docs/testing/mock-e2e-checklist.md`, `docs/testing/YYYY-MM-DD-mock-e2e-report.md`
- Modify（按调参结果）: `avatar-core/src/audio/mouth.ts`（`DEFAULT_MOUTH`）、`avatar-core/src/avatar/actions.ts`（比心手指角度、点头幅度）、`avatar-core/src/audio/vad.ts`（`DEFAULT_DETECTOR`）

- [ ] **Step 1: 创建验收清单**

`docs/testing/mock-e2e-checklist.md`:

```markdown
# Mock 全链路真机验收清单（Plan 1 / Task 18）

前置：`npm run dev -w gateway`；`adb reverse tcp:8787 tcp:8787`；`./scripts/build-web.sh`；`cd app && flutter run --dart-define-from-file=dev.json`。
调试面板：长按左上角"AI 虚拟人"。每项写：通过/不通过 + 实测数据 + 备注。

| # | 场景（spec §10） | 操作 | 通过标准 | 结果 |
|---|---|---|---|---|
| 1 | 主动迎宾 | 冷启动 App，不触碰屏幕 | 自动开口问候；`greeting_ms` ≤2000【预估目标】 | |
| 2 | 多轮链路 | 连续说 5 句话（Mock 按脚本识别） | 每轮 listening→thinking→speaking→idle；字幕正确；无卡死 | |
| 3 | 打断零残留 | AI 说话时插话，重复 20 次 | 每次声音迅速停止；`interrupt_stop_ms` P50 ≤300、P90 ≤500【预估目标】；旧回复的声音/字幕 0 次再出现 | |
| 4 | 动作 | 调试框依次输入 5 个动作指令各 2 次；再用语音说"挥挥手""比个心" | 动作正确且每次只执行一次；动作期间口型正常；`action_latency_ms` ≤1000 | |
| 5 | 静默追问 | 迎宾结束后保持沉默 40 秒 | 约 8 秒后追问 1 次，约 25 秒后说一句"我在这儿呢"类的话，之后不再主动开口 | |
| 6 | 口型/状态一致 | 观察 3 轮对话 | 嘴只在 AI 出声时动；打断瞬间嘴合上；listening 时有注视和轻点头 | |
| 7 | 静音 | 点麦克风按钮静音后说话 | 不触发任何回复；Director 不追问；再次点击恢复 | |
| 8 | 短断网续接 | 开飞行模式 10 秒再关（`adb reverse` 断开后需重新执行） | 状态显示"网络有点慢"→ 恢复；AI 说一句续接语；没有旧音频 | |
| 9 | 长断网 | 断网 70 秒后恢复 | 建立新会话并重新迎宾 | |
| 10 | 切后台 | 回到桌面 30 秒再返回 | App 不崩溃；回来后能继续对话（记录是否需要重连） | |
| 11 | 来电 | 用另一部手机拨入，挂断后观察 | 不崩溃；记录音频是否恢复 | |
| 12 | 30 分钟稳定性 | 每 1–2 分钟说一句话，持续 30 分钟 | 0 次崩溃；调试面板记录帧率（chrome://inspect 的 Performance 或肉眼）；机身温度主观记录 | |
| 13 | 日志合规 | 检查网关终端输出 | 只有事件名和数值，无任何对话文本 | |
```

- [ ] **Step 2: 逐项执行并记录**

按清单执行；每项结束后在调试面板点"复制 CSV"，粘贴到报告文件的附录。帧率测量：`chrome://inspect` → inspect WebView → Performance 面板录制 10 秒，分别在 idle 和 speaking 状态下读取 FPS。

- [ ] **Step 3: 调参（只改配置常量，改完重新 `./scripts/build-web.sh` 并复测对应项）**

- 口型张合过小/过大：调 `DEFAULT_MOUTH.gain`（建议 4–10）、`noiseFloor`（0.005–0.03）。
- 比心手势不像：在 `chrome://inspect` 控制台里临时修改 `gestureTemplates.heart` 的手指角度并实时调用 `playGesture('heart', 2.5, true)`，得到满意值后写回 `actions.ts`。若到本步结束仍不过关，改为 spec §8.4 的退路"双臂举过头顶的大比心"（用 `playPose` 或新的 gesture 模板），并在报告中注明。
- 点头太僵/太小：调 `nod()` 的 `amplitude` 与 `duration`。如果 `mtAvatar.headRotateX` 不存在导致不点头，记入 `docs/blockers.md`，改用 Mixamo "Head Nod Yes" FBX + `playAnimation`。
- 转身出画面：在 `turn()` 中把整圈改为 ±90° 往返，或在转身期间调用 `setView('full')` 后恢复 `'mid'`。
- 打断太灵敏/不灵敏：调 `DEFAULT_DETECTOR.bargeInThreshold`（0.6–0.9）与 `startMs`（100–250），以 Task 17 的数据为依据。

- [ ] **Step 4: 写验收报告**

`docs/testing/YYYY-MM-DD-mock-e2e-report.md`（日期用执行当天）:

```markdown
# Mock 全链路真机验收报告

- 设备：小米 ____ / Android __ / WebView ____；音频方案：__（见 ADR-001）
- 范围：Plan 1，MockAdapter；**不含真实模型**，首响应延迟、抢话率、上下文质量不在本报告结论内。

## 指标（实测 vs 目标）

| 指标 | 目标【预估】 | 实测 P50 | 实测 P90 | 样本数 | 结论 |
|---|---|---|---|---|---|
| greeting_ms | ≤2000 | | | | |
| interrupt_stop_ms | P50 ≤300 / P90 ≤500 | | | | |
| 旧语音残留 | 0 / 20 次 | | | | |
| action_latency_ms | ≤1000 | | | | |
| 自打断（外放） | ≤1 次/10min | | | | 引用 ADR-001 |
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

Expected: 所有自动化测试 PASS；报告中每个指标都有【实测】值或明确写明"未测 + 原因"。

---

## Plan 1 完成后的交接

1. 汇报：已完成的 Task、ADR-001 结论、报告中的实测指标、`docs/blockers.md` 中所有未解除的阻塞项。
2. 拿到火山引擎 / 阿里云百炼 Key 后编写 **Plan 2**：先核实两家实时协议的真实事件名与音频格式，再实现 `SeeduplexAdapter` / `QwenOmniAdapter`（实现 Task 2 的 `RealtimeAdapter` 接口）、`LlmSummarizer`（实现 Task 3 的 `Summarizer` 接口），然后做双模型对比、Director/人设调参、云端部署（WSS + TLS + App 密钥 + IP 白名单）与 release APK 交付。
