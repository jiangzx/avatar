# Plan 1.1 原生音频路径验证报告

日期：2026-10-13

本次续验结论：设备启动冒烟和 30 分钟稳定性采样完成；需要人工说话、人工听感和逐项动作/活动回复操作的项目仍未完成，不将其记为通过。

## 范围与设备

- 路径：Plan 1.1 / 方案 B。Flutter 负责采集、VAD、播放和网关会话，WebView 负责头像和界面。
- 设备：Xiaomi 22101317C，Android 13。
- WebView：`com.google.android.webview` 104.0.5112.97。
- 网关：本机 `ADAPTER=mock`，通过 `adb reverse tcp:8787 tcp:8787` 访问。
- 本次命令使用仅存在于当前 shell 的临时测试 secret；没有读取或提交 `.env`、`dev.json` 或其他密钥文件。

## 自动化验证

实际运行并通过：

```text
npm test
npm run typecheck
cd app && flutter test
cd app && flutter analyze
npm test -w avatar-core
npm run typecheck -w avatar-core
./scripts/build-web.sh
cd app && flutter build apk --debug --dart-define=GATEWAY_URL=http://127.0.0.1:8787 --dart-define=APP_SECRET=<临时值> --dart-define=AUDIO_PATH=B --dart-define=AUDIO_MODE=native
cd app && flutter build apk --release --dart-define=GATEWAY_URL=http://127.0.0.1:8787 --dart-define=APP_SECRET=<临时值> --dart-define=AUDIO_PATH=B --dart-define=AUDIO_MODE=native
```

结果：protocol 6 项、gateway 93 项、avatar-core 74 项、Flutter 36 项通过；TypeScript 类型检查和 Flutter analyzer 无问题；debug/release APK 均生成成功。

## 小米设备冒烟

已运行：

```text
ADAPTER=mock APP_SECRET=<临时值> npm run dev -w gateway
adb -s 88a198720422 reverse tcp:8787 tcp:8787
cd app && flutter build apk --debug --dart-define=GATEWAY_URL=http://127.0.0.1:8787 --dart-define=APP_SECRET=<同一临时值> --dart-define=AUDIO_PATH=B --dart-define=AUDIO_MODE=native
adb -s 88a198720422 install -r build/app/outputs/flutter-apk/app-debug.apk
adb -s 88a198720422 shell am force-stop com.anyidea.avatar_app
adb -s 88a198720422 shell monkey -p com.anyidea.avatar_app 1
adb -s 88a198720422 shell appops get com.anyidea.avatar_app RECORD_AUDIO
adb -s 88a198720422 shell dumpsys media.audio_flinger
adb -s 88a198720422 reverse --remove tcp:8787
adb -s 88a198720422 reverse tcp:8787 tcp:8787
```

观察结果：

| 项目 | 状态 | 证据或限制 |
|---|---|---|
| WebView 页面和头像加载 | 已验证 | debug APK 启动后截图显示 TalkingHead 头像；设备前台进程持续存在 |
| Mock 问候字幕 | 已验证 | 页面显示 Mock 问候字幕；未把文本复制到报告 |
| 原生采集初始化 | 已验证初始化，真实检出未验证 | `dumpsys media.audio_flinger` 显示产品进程有 16000 Hz、PCM16、单输入通道；`RECORD_AUDIO` 为 foreground/allow；未做真实说话检出 |
| WebView 麦克风授权 | 已验证未走 WebView 授权回调 | 产品页面未配置 `onPermissionRequest`；权限由 Flutter/record 处理 |
| 原生播放听感 | 未验证 | 自动化截图和系统音频状态无法证明人工听感；不声称可听播放通过 |
| `wave` 动作 | 部分验证 | 调试面板发送固定 ASCII 测试命令后观察到挥手；其余四个动作未逐项留存视觉证据 |
| 短断线/活动回复续接 | 未验证 | 曾在无活动长回复时移除并恢复 reverse；页面和 AudioRecord 存活，但未证明 `session.resumed` 或旧 PCM 丢弃 |
| 真实语音/VAD 打断 | 未测 | 需要人工在设备前说话 |
| 10 分钟静默误触发 | 未判定 | 10 分钟匿名 UI 探针得到 1 次变化，但启动残留/控件索引变化无法归因于 VAD；不记为 0 次通过 |
| 10 句真打断检出 | 未测 | — |
| 30 分钟稳定性、RSS/PSS、温度 | 已采样，音频错误归因不明 | 31 个 60 秒点；应用 PSS 570568→546773 kB，峰值 572259 kB；RSS 569312→543981 kB，峰值 569731 kB；温度 34.0°C；WebView renderer 存活 31/31；产品进程过滤的最终 logcat 音频 `E` 行 0，但 AudioFlinger 系统级输入统计 `err=297`，不能归因到应用 |

## Task 7 Step 3 逐项结果

| 检查项 | 结果 | 备注 |
|---|---|---|
| 打开应用、头像、问候、可听播放 | 头像和 Mock 问候已观察；可听播放未由人工确认 | 不把系统播放状态当成人工听感 |
| 真实一句话、16 kHz 单声道、VAD speaking | 采集配置已确认；真实说话和 VAD speaking 未测 | 当前环境没有人工在设备前说话 |
| 长回复期间真实打断、旧 PCM/字幕清理 | 未测 | 调试文本不替代真实打断 |
| wave/nod/smile/turn/heart | 已逐项人工触发并观察到执行一次 | 使用中文关键词：挥挥手、点点头、笑一下、转个身、比个心；英文动作名不触发关键词规则 |
| 活动回复断开/恢复、session resumed、旧 PCM 不播放 | 长断线回收与新会话已验证；活动播放残留未测 | USB 断开超过 60 秒后网关记录 `session_destroyed(reason=grace_expired)`；设备恢复并重新启动应用后记录新的 `session_created` |
| 静默 10 分钟自打断次数 | 用户明确跳过 | 不将跳过记为 0 次或通过 |
| 10 次真实打断检出数 | 未测 | 未进行人工语音操作 |
| 30 分钟 RSS/PSS、温度、音频错误、renderer | 已采样 | 见上表；系统级音频 `err=297` 归因不明 |

## 真机采样摘要

```text
stability_samples=31
app_pss_kb=570568..546773; peak=572259
app_rss_kb=569312..543981; peak=569731
battery_temperature_c=34.0 throughout
webview_renderer_alive=31/31
product_scoped_audio_error_lines=0 (final logcat filter)
audioflinger_input_timestamp_errors=297 (system-level, attribution unknown)
silent_ui_probe_changes=1 (not attributable; not a self-trigger result)
```

## Plan 1 与兼容性边界

Plan 1 的 WebView ≥120 兼容性门槛仍未改变；本报告仅证明 Plan 1.1 方案 B 在本设备上的实测状态。

Plan 1 原有桌面 Chrome 完整 E2E、方案 A/B 10 分钟对比和完整 Task 18 清单未在本次冒烟中补齐。ADR-001 的 A/B 数字仍保持“待真机”，不能据此选择 A 或 B 作为音频 A/B 结论。

## 2026-10-15 本地手机续验

- 环境：Xiaomi 22101317C，debug APK，本地 Mock 网关，ADB reverse 8787。截图可见头像、字幕和调试面板；面板显示 `audioPath=A`，但设备原生采集/播放已观察到。该标签不能替代音频路径实现判定。
- 人工观察：用户明确确认“能听到，口型也在动”。仅证明本次有声播放与口型活动，未测口型同步延迟或打断后闭嘴。
- 短断连：执行 `adb reconnect`，随后 `adb wait-for-device`、`adb reverse tcp:8787 tcp:8787`。网关 TCP 对端从 58854 换为 59677，日志于 2026-10-15 21:06:26（北京时间）记录 `session_resumed`；手机进程 PID 6963 未变化。证明本次自动续接成功，不代表活动播放无残留或长断连验收通过。
- 单独执行 `adb reverse --remove tcp:8787` 未关闭已有 TCP，因此该操作不计入断连证据。
- 未完成：真实语音多轮、定量打断测量、完整动作矩阵、活动响应恢复后的听感、长断连和可靠静默误触发采样。云端部署继续延期。

### 2026-10-15 真实插话抽查（3 次）

- 用户在手机端完成 3 次真实插话，并确认“3 次都迅速停止，无旧声音残留”。这是人工定性结果，不是延迟测量。
- 本地网关观察到 3 条 `response_cancel`，`source=local`，序号 58、59、60；北京时间分别为 21:10:00.010、21:10:02.590、21:10:04.983。日志仅包含事件、时间和序号，无音频或对话内容。
- 本次可记录：3 次真实插话均有本地取消事件，用户未听到旧声音残留。未取得 `interrupt_stop_ms` 的 P50/P90，未验证字幕仅终结一次；不得据此勾选完整打断验收或 10 次抽查。

### 2026-10-15 追加插话抽查（人工累计 10 次）

- 用户完成追加 7 次测试并确认“一切符合预期正常”。结合前 3 次，人工报告累计 10/10 次停止正常、无旧声音残留。该结论仅覆盖本轮定性抽查。
- 该观察窗口新增 9 条 `response_cancel(source=local)`，序号 68、69、70、71、73、74、76、77、80；另有 `model_auto_cancel(seq=64)` 及一次 `model_rebuild(reason=slim)`。没有逐次操作时间标记，不能把这些事件强行一一归因于追加的 7 次操作，也不能据此计算误触发率。
- 核验时应用 PID 6963 存活，ADB reverse 8787 保持，网关 `/healthz` 返回 `{"ok":true}`。
- 已取得人工 10 次定性打断结果；尚未取得延迟 P50/P90、字幕终结次数、可靠静默误触发计数或 Plan 1 要求的 20 次打断结果。其余动作、长断连等验收继续保持未完成。

### 2026-10-15 动作矩阵复测

- 用户在调试面板依次提交中文关键词“挥挥手、点点头、笑一下、转个身、比个心”，五个动作均观察到虚拟人执行一次。
- 英文动作名 `wave`、`nod`、`smile`、`turn`、`heart` 不属于当前关键词规则；本次使用中文表达完成验收。

### 2026-10-15 长断线复测

- Xiaomi 设备 USB 断开超过 60 秒后，网关记录 `session_destroyed`，原因是 `grace_expired`，会话数回到 0。
- 设备重新连接并启动应用后，网关记录新的 `session_created`；这证明长断线不会复用已过期会话。
- 本次没有在活动播放中断线，因此未验证旧 PCM 残留和活动响应恢复听感。

### 2026-10-15 静默误触发采样

- 用户明确决定跳过 10 分钟静默采样；该项目保持未验证，不记为通过。

### 2026-10-15 打断回归与修复

- 用户对修复前 APK 完成 10 次真实打断，反馈 10/10 次说话后播放没有停止；网关窗口同时出现多条 `response_cancel(source=local)`，说明取消信号已发出，但不能证明设备播放队列已清空。
- 修复已加入原生播放 I/O：停止响应时等待正在进行的 PCM `feed` 完成后再释放并重建 `AudioTrack`，避免旧 feed 越过取消边界继续播放。
- 修复后的 debug APK 已构建、安装并通过 Flutter 全量测试与 analyzer；修复后的 3 次设备听感复测仍待用户确认，当前不标记为通过。
- 后续复测反馈仍不稳定：用户观察到长回复喊停后短暂停顿再继续，且短回复难以区分真实打断。当前需要用响应序号日志区分“原响应残留”和“取消后新响应”，因此打断验收仍未通过。

### 2026-10-16 本地 Mock 受控打断复测

- 自动化回归：gateway 129 项、全量 npm test、全量 npm run typecheck、Flutter 40 项、flutter analyze 和 git diff --check 均通过；播放节奏配置已提交为 1b5969c。
- 首次真机复测临时使用 MOCK_PACE_FACTOR=0.5，观察到音频断续。代码检查确认每个 100 ms PCM 块以 200 ms 间隔发送，属于播放队列欠载；这不是旧 PCM 残留证据。
- 随后以 MOCK_PACE_FACTOR=2 和 1 重启干净 Mock 网关并重建会话。2 倍速时用户仍反馈喊停后继续；1 倍速下使用较长中文脚本回复，用户再次反馈“同一句继续”。
- 网关日志显示会话和响应序号正常递增，但受控操作期间没有与用户说“停”对应的活动响应 response_cancel(source=local)；出现的 response_cancel 要么发生在响应已 response_end 之后，要么来源为 model。因此当前证据更支持本地 VAD 漏检/时序问题，尚不能归因于 AudioTrack 仍播放同一序号的迟到 PCM。
- 结论：Mock 连续播放节奏问题已定位并规避；真机语音打断仍未通过。下一步需要增加不含对话内容的 VAD 事件/音量可观测性，再针对小米设备调节能量阈值或确认录音链路是否在外放期间漏检。

### 2026-10-16 匿名 VAD/播放队列观测与受控复测

- 代码改动：Flutter 原生控制器新增匿名诊断事件，包含 speaking/silent 计数、累计与最近 RMS 区间/计数、超过阈值的连续毫秒数、当前 `responseSeq`、local cancel 次数，以及播放队列的状态、pending 数、feed in-flight、已送样本数和已播放毫秒。网关新增 `vad_edge` 日志，只记录 state/count/activeSeq；不记录音频、PCM、ASR 或回复文本。
- 自动化验证：新增并通过同一序号取消后丢弃迟到 PCM、新序号重新入队、播放结束/取消/错误单次事件和匿名诊断字段测试。随后运行 `flutter test`、`flutter analyze`、`npm test`、`npm run typecheck` 与 `git diff --check`，结果见本次会话最终报告。
- 构建/安装：`flutter build apk --debug --dart-define-from-file=dev.json` 成功；通过 `adb push` 与设备端 `pm install -r -d` 安装成功；`adb reverse tcp:8787 tcp:8787` 成功。网关使用本地 `app/dev.json` 中的 APP_SECRET 注入进程环境，`ADAPTER=mock`；`GET /healthz=200`、认证 `POST /session=200`，密钥未输出。
- 首次新观测截图：`rmsMax=6217` 但 `vadSpeaking=0`、`vadSilent=0`、`localCancel=0`；当时网关的 `response_cancel(source=local)` 不能与语音边沿对应，更像提交调试文字时的本地取消，未据此调阈值。
- 第二次受控样本（北京时间 2026-10-16 07:46:57 起）：面板显示 `vadSpeaking=5`、`vadSilent=5`、`rmsMax=9600`、`maxAboveRunMs=300`、`localCancel=1`。网关匿名事件序列为：`response.start seq=4` → `vad_edge silent count=1 activeSeq=4` → `response_cancel seq=4 source=local` → `vad_edge speaking count=1 activeSeq=0` → `response.start seq=5` → `response_end seq=5`。这证明一次真实 VAD 检出、同序号本地取消和新序号启动；`maxAboveRunMs=300` 已超过当前 `startMs=150`，没有调低阈值或缩短 startMs 的证据。
- 听感与验收结论：用户反馈本次说“停”后仍继续或像同一句重复。该反馈与网关的 local cancel 同时存在，但没有同一时刻的 accepted/dropped chunk 快照，不能区分旧序号残留与新序号音频听感相似。随后已把 `acceptedChunks/droppedChunks` 加入播放快照并重装 APK；下一次窗口未出现活动响应期间的 local cancel，因此仍不能证明同序号 PCM 残留。可听停止、旧 PCM 残留、字幕终结和定量样本继续记为“未验证”，blocker #10 保持未解除。

### 2026-10-16 第三版 APK 复测与本轮复验

- 第三版 debug APK 已重新构建、通过 `adb push` 和设备端 `pm install -r -d` 安装；Xiaomi 22101317C 在线，`adb reverse tcp:8787 tcp:8787` 保持成功。使用 `ADAPTER=mock` 的干净本地网关重启后，`GET /healthz` 返回 200，带本地配置 secret 的 `POST /session` 返回 200；secret 和会话令牌未写入日志或报告。
- 第三次受控窗口只观察到空闲期 `vad_edge speaking activeSeq=0`、`vad_edge silent activeSeq=0`，随后 `response.start seq=5` 和 `response_end seq=5`；没有活动 response 期间对应的 `response_cancel(source=local)`，因此 `acceptedChunks/droppedChunks` 仍未取得可归因的取消窗口快照。
- 用户对受控听感的反馈仍为“播放继续或像同一句重复”。现有证据不能区分本地 VAD 漏检、取消后新序号声音相似或同序号迟到 PCM；#10 保持未解除。
- 本轮实际复验：`npm test` 通过（protocol 6、gateway 129、avatar-core 84），`npm run typecheck` 通过，`cd app && flutter test` 通过（45），`cd app && flutter analyze` 无问题，`git diff --check` 通过。

### 2026-10-16 第四次诊断 APK 复测与取消边界补强

- 代码：`NativeSessionController` 在 `local.cancel`/`session.stop` 诊断中同时记录停止前和停止后的匿名播放快照，字段为 `responseSeq`、队列状态、pending/feed、已送样本/已播放毫秒和 accepted/dropped 计数；未增加音频、PCM、ASR 或回复文本。新增 Flutter 测试先验证旧行为缺少 `before*` 字段，再实现并通过。
- 构建/安装：`flutter build apk --debug --dart-define-from-file=dev.json` 成功；`adb push`、设备端 `pm install -r -d`、`adb reverse tcp:8787 tcp:8787` 均成功。设备 `MainActivity` resumed，`RECORD_AUDIO` 为 granted。
- 网关：一次后台 shell 启动因会话退出而停止，设备因此短暂显示 `audio_start_failed`；该错误来自通用启动错误映射，不能作为 AudioTrack 失败证据。改用持续终端会话后，`ADAPTER=mock` 网关保持运行，`GET /healthz=200`、认证 `POST /session=200`，设备 greeting/reply/followup 序号连续结束。
- 受控操作：按请求尝试在回复播放约 1 秒时说“停”。匿名面板显示 `vadSpeaking=1`、`vadSilent=1`、`localCancel=0`、`acceptedChunks=842`、`droppedChunks=0`，最后 after 快照为 `afterResponseSeq=0;afterQueue=idle;afterPending=0;afterFeed=0;afterFedSamples=79200;afterPlayedMs=3300`。网关对应 `vad_edge speaking activeSeq=0`、`vad_edge silent activeSeq=0`，随后才有 `response.start seq=25`；没有活动 response 期间 `response_cancel(source=local)`，因此没有取得 before 快照或可归因的取消窗口。该段此前把操作误写为“用户完成”，现更正为“按请求尝试”。
- 结论：本次证明空闲期 VAD 边沿可到达网关，但仍无法区分 VAD 漏检、取消后新响应听感相似和同序号迟到 PCM。该次操作没有可归因的停止听感结果；可听停止、旧 PCM 残留、字幕单次终结和定量真实打断仍未验证，blocker #10 保持未解除。

### 2026-10-16 取消竞态修复与最新人工反馈

- 代码：取消操作现在与 `response.start`/音频事件共用 `NativeSessionController` 的事件队列；新增门控回归测试证明新序号必须等待旧 `stopResponse` 完成。取消诊断改用持久键 `audio.cancel`，不会被 200 ms 的 `audio.level` 覆盖；同时记录控制器 accepted/dropped 计数、最近序号和取消序号的迟到丢弃计数。启动错误按阶段区分 `audio_start_failed` 与 `gateway_start_failed`，界面分别提示音频初始化或网关不可用。
- 自动验证：`cd app && flutter test` 通过（49），`cd app && flutter analyze` 无问题；针对控制器的失败测试先失败后通过。新的 debug APK 由 `flutter build apk --debug --dart-define-from-file=dev.json` 构建，设备端 `pm install -r -d` 返回 `Success`，`MainActivity` resumed，`AudioRecord` 日志持续存在；持久 `ADAPTER=mock` 网关 `/healthz=200`。
- 最新人工反馈：用户回复“已停止”。同一时间读取到的网关窗口只有 `response.start/end`（seq 5–9），没有 `vad_edge ... activeSeq` 或 `response_cancel(source=local)`；因此只能记录为“用户主观听感为停止”，不能归因于本地取消或证明旧 PCM 已丢弃。`audio.cancel` 的真机字段仍未取得，blocker #10 保持未解除。

### 2026-10-16 取消后静音与播放期音量诊断

- 代码：已开始的 Mock 回复被取消后，下一段音频先输出 `MOCK_CANCEL_GAP_MS=400` 的静音，并把语音读取位置向后跳过这段静音，避免下一段从同一波形无缝续上。控制器新增持久诊断键 `audio.playback`，只在活动回复期间累计 `responseSeq`、`activeRmsMax`、`activeAboveRunMs`；回复结束后空闲音量不再改写该快照。不记录音频、PCM、ASR 或回复文本。
- 自动验证：新的 gateway 测试和 Flutter 测试都先失败后通过。随后 `npm test -w gateway` 通过（130），`npm run typecheck -w gateway` 通过，`cd app && flutter test` 通过（50），`flutter analyze` 无问题。
- 设备准备：debug APK 已重新构建，设备端 `pm install -r -d` 返回 `Success`；`adb reverse tcp:8787 tcp:8787` 成功。持久 `ADAPTER=mock`、`MOCK_PACE_FACTOR=1` 网关记录 `gateway_listening`，手机会话记录 `response_start seq=1 kind=greeting`。`GET /healthz=200`，认证 `POST /session=200`。
- 听感复测尚未进行，不把安装或问候启动记为打断通过。blocker #10 保持未解除。

### 2026-10-16 单次听感结果

- 用户在北京时间 17:29 选择结果 1：声音停住，并且中间有一段明显静音。这是一次主观听感，不是延迟测量。
- 同一分钟的网关窗口没有新的 `vad_edge`。seq 7 正常 `response_end`；seq 8 为 `model_auto_cancel`；seq 9 为 `response_cancel source=model`；seq 10 正常 `response_end`。窗口内没有 `response_cancel(source=local)`。
- 上一条 `vad_edge speaking` 停在 17:27:42，其后直到该窗口没有 `vad_edge silent`。因此这次模型侧取消不能归因于一次新的本地说话边沿。
- 截图时调试面板关闭，`audio.playback` 的 `activeRmsMax/activeAboveRunMs` 未取得。不把本次听感记为定量打断通过，blocker #10 保持未解除。

### 2026-10-16 本地取消队列快照与说话段复位

- 调试面板中的 `audio.cancel`：`cancelledSeq=4`，`localCancel=1`，`cancelledDroppedChunks=4`。停止前 `beforeQueue=playing`、`beforePending=0`、`beforeFeed=0`、`beforeFedSamples=9600`、`beforePlayedMs=304`、`beforeAcceptedChunks=119`、`beforeDroppedChunks=0`。停止后 `afterQueue=idle`、`afterPending=0`、`afterFeed=0`、`afterFedSamples=9600`、`afterPlayedMs=304`、`afterAcceptedChunks=119`、`afterDroppedChunks=0`。已送样本和已播放毫秒没有增加，取消序号之后有 4 块被丢弃。
- 网关对应北京时间 17:27:42 的 `response_cancel seq=4 source=local`。这是一次队列边界证据，不是延迟百分位或多次样本。
- 代码：新回复开始时，如果上一段说话还开着，先复位检测器并发送一次 `vad silent`，让下一次持续大声能够再次产生 `speaking` 和本地取消。新测试在修改前失败、修改后通过。`cd app && flutter test` 通过（51），`flutter analyze` 无问题。
- 新 debug APK 已 `pm install -r -d` 成功并重新启动；网关仍是 `ADAPTER=mock`，新手机会话已 `response_start seq=1 kind=greeting`。这段复位逻辑的真机听感尚未复测，blocker #10 保持未解除。

### 2026-10-16 复位后的本地取消听感

- 用户在北京时间 17:47 再次选择结果 1：声音停住，并且中间有一段明显静音。
- 紧邻窗口内有两次 `response_cancel(source=local)`：seq 12 于 17:46:47，seq 13 于 17:46:50。seq 13 开始后先出现 `vad_edge silent activeSeq=13`，随后才是本地取消和 `vad_edge speaking activeSeq=0`。这与“新回复先关闭上一段说话，再接受一次新的本地打断”一致。
- 面板 `audio.cancel`：`cancelledSeq=13`，`localCancel=2`，`cancelledDroppedChunks=1`。停止前 `beforeQueue=playing`、`beforeFedSamples=48000`、`beforePlayedMs=2000`、`beforePending=0`、`beforeFeed=0`。停止后 `afterQueue=idle`，已送样本和已播放毫秒仍是 48000 与 2000。同序号有 1 块在取消后被丢弃。
- 随后正常结束的 seq 15 上，`audio.playback` 为 `responseSeq=15;activeRmsMax=53;activeAboveRunMs=0`。该回复播放期间麦克风能量远低于阈值，不能当成一次漏检。
- 本次证明一次可归因的本地取消、队列停止和主观静音同时出现。尚未取得打断延迟 P50/P90、字幕只终结一次，也未完成计划要求的多次定量样本。

### 2026-10-16 定量打断样本跳过

- 用户明确决定不再做打断延迟分布和多次计数。这两项记为用户跳过，不记为通过，也不再采样。
- 字幕只终结一次没有被这次决定单独豁免，仍未测量，不记为通过。
- blocker #10 状态改为「定量样本用户跳过」。

### 2026-10-16 活动回复期间的短断连

- 调试文字触发 `response_start seq=8 kind=reply`（10:21:03.309Z）。回复开始后 113 ms，USB 通道被断开，网关记录 `response_cancel seq=8 source=local`（10:21:03.422Z）。seq 8 没有 `response_end`。
- 约 3.7 s 后记录 `session_resumed`（10:21:07.134Z），下一段音频是新的 seq 9。这落在 60 s 宽限内。
- 同一小时更早的一次断开没有在宽限内恢复：10:04:40Z `session_destroyed reason=grace_expired`，10:06:02Z 新建会话。这是长断连后的新会话，不是续接。
- 取消发生在服务端断开传输之后。客户端现在在网关状态变为 reconnecting 或 closed 时就停止当前播放，不等 `session.resumed`。该行为有单元测试。含这次改动的 debug APK 已用 `pm install -r -d` 装上并重新启动，但没有采集扬声器听感，因此不把「旧 PCM 完全听不见」记为通过。
