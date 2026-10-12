# ADR-001：Day 1 选型结论

> **状态：DRAFT – not decided; awaiting real-device measurements（草稿，未决定，等待真机实测）。**
> 本文件只是占位骨架，便于后续任务引用。截至 2026-10-12 没有小米真机（见 `docs/blockers.md` #1、#3、#4、#5、#6），下表所有【实测】格均为"待真机"。模拟器的回声路径（Mac 扬声器 → Mac 麦克风）与手机完全不同，任何模拟器数字都不得填入 A/B 表。

- 日期：待真机（草稿创建于 2026-10-12）
- 设备：小米 待真机（型号），Android 待真机，WebView 版本 待真机（A/B 数据只来自真机；模拟器结果只填在下方"模拟器"列）

## 音频方案 A/B（外放、无人说话、10 分钟）

| 方案 | 设置 | 能量触发次数/10min【实测】 | Silero 打断阈值/10min【实测】 | Silero 普通阈值/10min【实测】 | 真打断 10 句检出数【实测】 | mic settings |
|---|---|---|---|---|---|---|
| A | echo=true | 待真机 | 待真机 | 待真机 | 待真机 | 待真机 |
| A | echo=all | 待真机 | 待真机 | 待真机 | 待真机 | 待真机 |
| B | VOICE_COMMUNICATION + 通话模式 + 扬声器 | 待真机 | n/a | n/a | 待真机 | n/a |

判定规则（spec §9 Day 1）：选 10 分钟自打断更少的方案；持平时选 A。目标【预估】：自打断 ≤1 次/10 分钟，真打断检出 ≥9/10。

**结论：** 未决定（UNDECIDED）。等待 Task 17 Step 5–6 真机测量后填写。Plan 1 在此之前默认按方案 A 继续 Mock 验收。
若 A、B 都 >1 次/10 分钟：按 spec §2.1 Plan B，在 Plan 2 中评估 `flutter_webrtc` 直连 Qwen WebRTC。

已知风险（来自源码核对，非测量）：`flutter_pcm_sound` 3.3.3 在 Android 上以 `USAGE_MEDIA` / `CONTENT_TYPE_MUSIC` 播放，方案 B 的采集处于通话模式（`MODE_IN_COMMUNICATION` + `VOICE_COMMUNICATION`），两者可能不在同一条回声消除路由里。

## 其他 Day 1 验证项

| 项 | 模拟器（API 36 / API 31） | 真机【实测】 | 备注 |
|---|---|---|---|
| WebView 版本 / 安全上下文 | 【模拟器】API 36：WebView 134；API 31：WebView 91.0.4472.114（低于 Chrome ≥120 标准）；两台安全上下文 OK | 待真机 | Task 16 Step 8 探针 `webview`、`secure_context`；见 blockers #3 |
| 免手势播放（AudioContext 无手势 running） | 【模拟器】两台无手势 `running`；无头模拟器听不到提示音 | 待真机 | 探针 `autoplay`；完整页面再在 Task 18 Step 0 确认打开即问候 |
| AudioWorklet / wasm / WebGL2 / 麦克风 | 【模拟器】探针各项 OK；麦克风只验证到 getUserMedia 成功 | 待真机 | 探针对应各项 |
| release 构建加载 127.0.0.1 页面 | 【模拟器】API 31 release 包可加载 | 待真机 | Task 16 Step 9 |
| WebGL 帧率（idle / speaking） | 不代表手机 | 待真机 | Task 18 |
| 主模型选择（Seeduplex vs Qwen） | — | 未测：等待 Key | Plan 2 |
