# Plan 1.1 原生音频路径验证报告

日期：2026-10-13

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
adb -s 88a198720422 install -r app-debug.apk
adb -s 88a198720422 install -r app-release.apk
```

观察结果：

| 项目 | 状态 | 证据或限制 |
|---|---|---|
| WebView 页面和头像加载 | 已验证 | debug/release 截图均显示 TalkingHead 头像 |
| Mock 问候字幕 | 已验证 | 页面显示问候字幕；未把文本复制到报告 |
| 原生采集初始化 | 部分验证 | logcat 显示 `AudioRecord` 为 16000 Hz、单声道；未做真实说话检出 |
| WebView 麦克风授权 | 已验证未走 WebView 授权回调 | 产品页面未配置 `onPermissionRequest`；权限由 Flutter/record 处理 |
| 原生播放听感 | 未由自动化环境确认 | 设备上出现问候播放流程，但本报告不声称人工听感通过 |
| `wave` 动作 | 部分验证 | 调试面板发送固定 ASCII 测试命令后观察到挥手；其余四个动作未逐项留存视觉证据 |
| 短断线 | 部分验证 | 停止并重启 Mock 网关后页面、头像和 AudioRecord 仍存活；无活动长回复，未证明 `session.resumed` |
| 真实语音/VAD 打断 | 未测 | 需要人工在设备前说话 |
| 10 分钟静默误触发 | 未测 | — |
| 10 句真打断检出 | 未测 | — |
| 30 分钟稳定性、RSS/PSS、温度 | 未测 | 只记录到一次启动期 `dumpsys meminfo`，不作为稳定性结论 |

## Plan 1 与兼容性边界

Plan 1 的 WebView ≥120 兼容性门槛仍未改变；本报告仅证明 Plan 1.1 方案 B 在本设备上的实测状态。

Plan 1 原有桌面 Chrome 完整 E2E、方案 A/B 10 分钟对比和完整 Task 18 清单未在本次冒烟中补齐。ADR-001 的 A/B 数字仍保持“待真机”，不能据此选择 A 或 B 作为音频 A/B 结论。
