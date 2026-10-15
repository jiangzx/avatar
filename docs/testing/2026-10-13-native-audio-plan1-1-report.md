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
| wave/nod/smile/turn/heart | 仅 wave 有既有视觉观察 | 其余四项未逐项留证 |
| 活动回复断开/恢复、session resumed、旧 PCM 不播放 | 未测 | 断线操作发生在无活动长回复窗口 |
| 静默 10 分钟自打断次数 | 未判定 | 匿名 UI 探针不可归因，不能记为 0 |
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
