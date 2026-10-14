# ADR-001：Day 1 选型结论

> **状态：DRAFT – A/B not decided; Plan 2 entry approved by user（A/B 仍未决定；用户已批准先进入 Plan 2）。**
> Plan 1.1 已在小米设备上完成启动冒烟；A/B 数字仍必须来自独立的真机测量，模拟器的回声路径（Mac 扬声器 → Mac 麦克风）与手机完全不同，任何模拟器数字都不得填入 A/B 表。

- 日期：2026-10-13（Plan 1.1 冒烟）
- 设备：小米 22101317C，Android 13，WebView 104.0.5112.97（A/B 数据只来自真机；本次未进行 A/B 数值测量）

本次续验补充：方案 B 在同一设备完成 30 分钟稳定性采样（31 个 60 秒点）；WebView renderer 存活 31/31，电池温度 34.0°C，应用 PSS/RSS 与系统级音频错误摘要见 [Plan 1.1 验证报告](../testing/2026-10-13-native-audio-plan1-1-report.md)。这不是 A/B 测量，不改变下表的“待真机”占位，也不改变本 ADR 的 DRAFT 状态。

## 音频方案 A/B（外放、无人说话、10 分钟）

| 方案 | 设置 | 能量触发次数/10min【实测】 | Silero 打断阈值/10min【实测】 | Silero 普通阈值/10min【实测】 | 真打断 10 句检出数【实测】 | mic settings |
|---|---|---|---|---|---|---|
| A | echo=true | 待真机 | 待真机 | 待真机 | 待真机 | 待真机 |
| A | echo=all | 待真机 | 待真机 | 待真机 | 待真机 | 待真机 |
| B | VOICE_COMMUNICATION + 通话模式 + 扬声器 | 待真机 | n/a | n/a | 待真机 | n/a |

判定规则（spec §9 Day 1）：选 10 分钟自打断更少的方案；持平时选 A。目标【预估】：自打断 ≤1 次/10 分钟，真打断检出 ≥9/10。

**结论：** 用户已批准阶段 1 完成并先进入 Plan 2；Plan 1.1 方案 B 迁移已完成设备启动冒烟。A/B 选型仍未决定，Task 17 Step 5–6 的真机测量作为 Plan 2 跟进项执行。该状态变更是项目排期决定，不代表 A/B 测量已完成。Plan 1 的历史默认方案 A 不变。
若 A、B 都 >1 次/10 分钟：按 spec §2.1 Plan B，在 Plan 2 中评估 `flutter_webrtc` 直连 Qwen WebRTC。

已知风险（来自源码核对，非测量）：`flutter_pcm_sound` 3.3.3 在 Android 上以 `USAGE_MEDIA` / `CONTENT_TYPE_MUSIC` 播放，方案 B 的采集处于通话模式（`MODE_IN_COMMUNICATION` + `VOICE_COMMUNICATION`），两者可能不在同一条回声消除路由里。

## 其他 Day 1 验证项

| 项 | 模拟器（API 36 / API 31） | 真机【实测】 | 备注 |
|---|---|---|---|
| WebView 版本 / 安全上下文 | 【模拟器】API 36：WebView 134；API 31：WebView 91.0.4472.114（低于 Chrome ≥120 标准）；两台安全上下文 OK | 【真机】WebView 104.0.5112.97；Plan 1.1 本地页面可加载 | Task 16 Step 8 探针完整 8 项仍未重跑 |
| 免手势播放（AudioContext 无手势 running） | 【模拟器】两台无手势 `running`；无头模拟器听不到提示音 | n/a（方案 B 不依赖 WebView 音频） | Plan 1 A 路径的 autoplay 结论保持原状 |
| AudioWorklet / wasm / WebGL2 / 麦克风 | 【模拟器】探针各项 OK；麦克风只验证到 getUserMedia 成功 | n/a（方案 B 产品路径不依赖 WebView 麦克风/AudioWorklet） | Plan 1 A 路径的探针仍需单独执行 |
| release 构建加载 127.0.0.1 页面 | 【模拟器】API 31 release 包可加载 | 【真机】release APK 加载本地页面和头像 | 本次为 Plan 1.1 冒烟，不替代 Task 16 8 项探针 |
| WebGL 帧率（idle / speaking） | 不代表手机 | 待真机 | Task 18 |
| 主模型选择（Seeduplex vs Qwen） | — | 未测：等待 Key | Plan 2 |

Spike A 真机冒烟记录：点击 `EC=true` 后出现麦克风占用指示，但统计未显示。WebView renderer 收到 SIGABRT，随后 Flutter 主进程因关联 WebView 未处理 renderer crash 而 native crash；退出记录 PSS 433 MB，设备崩溃后可用内存约 4.5 GB。没有证据表明本次由 lowmemorykiller 引起，renderer 底层 abort 原因未知；VAD 完成初始化、计数刷新及所有 A/B 数值均待复测（见 `docs/blockers.md` #6）。
