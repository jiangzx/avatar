# Mock 全链路验收报告（2026-10-12）

**结论：Task 18 的设备/浏览器验收没有做。没有任何一项清单结果是通过。** 本报告只含自动化与网关级无头证据；这些证据不能替代清单项，Plan 1 目前既不能宣称"真机可演示"，也不能宣称"模拟器功能链路通过"。

- 设备：Xiaomi 22101317C（Android 13）现已连接。Task 18 产品页 E2E 仍未运行；Task 16 debug/release 探针结果与 Task 17 Spike A 冒烟失败记录见下方。API31_Phone（2 GB 内存）的 WebView renderer 曾被 lowmemorykiller 杀掉（blocker #6）；本机当前磁盘约 488 GB 可用。
- 没有人工驱动的桌面 Chrome，Task 14 的真实浏览器 E2E 仍未做（blockers #2）。
- 范围：Plan 1，MockAdapter；不含真实模型，首响应延迟、抢话率、上下文质量不在本报告结论内。
- 调参：**未调任何常量**（`DEFAULT_MOUTH`、`ACTION_TUNING`、`DEFAULT_DETECTOR`、`MOCK_SPEECH_THRESHOLD`），调参必须依据真机数据。未修改任何代码文件。

## 真机检查点 ① 补充记录（2026-10-12）

Task 16 能力探针在 Xiaomi 22101317C / Android 13 / WebView 104.0.5112.97 的 debug 与 release 包均已运行。`secure_context`、AudioWorklet、wasm、WebGL2（Adreno 619）、getUserMedia（`echoCancellation=true`，16 kHz）与 gateway health 均显示 OK；AudioContext 在无手势时为 `running @ 48000 Hz`。WebView 104 低于计划要求的 Chrome ≥120；提示音是否可听、真实语音拾音电平未确认。release 包通过 `127.0.0.1:8787` 访问 gateway health。

随后点击 Spike A 的 `EC=true`：麦克风占用指示出现，但统计未显示；WebView renderer 收到 SIGABRT，Flutter 主进程随后 native crash。退出记录 PSS 433 MB，设备当时仍有约 4.5 GB 可用内存；底层 renderer abort 原因未知，不能据此认定为 OOM。VAD 初始化完成未确认，因此没有 A/B 数据。本补充不代表 Task 18 清单任何一项通过；见 blockers #3–#6。

## 指标（实测 vs 目标）

| 指标 | 目标【预估】 | 实测 P50 | 实测 P90 | 样本数 | 结论 |
|---|---|---|---|---|---|
| greeting_ms | ≤2000 | 未测 | 未测 | 0 | 未测：Task 18 产品页 E2E 未运行 |
| interrupt_stop_ms | P50 ≤300 / P90 ≤500 | 未测 | 未测 | 0 | 未测：Task 18 产品页 E2E 未运行 |
| 旧语音残留 | 0 / 20 次 | 未测 | 未测 | 0 | 未测：Task 18 产品页 E2E 未运行 |
| action_latency_ms | ≤1000 | 未测 | 未测 | 0 | 未测：Task 18 产品页 E2E 未运行 |
| 冷启动到开口（秒表） | ≤2 秒 | 未测 | 未测 | 0 | 未测：Task 18 产品页 E2E 未运行 |
| 自打断（外放） | ≤1 次/10min | 未测 | 未测 | 0 | 未测：Spike A renderer crash，A/B 尚未运行 |
| Mock 误触发阈值 | — | — | — | — | 未调；`MOCK_SPEECH_THRESHOLD` 仍为 `gateway/.env` 现值 |
| 帧率 idle / speaking | ≥30 fps | 未测 | 未测 | 0 | 未测：产品页未运行 |
| 30 分钟崩溃次数 | 0 | 未测 | 未测 | 0 | 未测：未执行 30 分钟稳定性检查 |

## 清单结果

逐项见 `docs/testing/mock-e2e-checklist.md`（含 Step 0 首跑核对）。汇总：

| # | 场景 | 模拟器 | 真机 |
|---|---|---|---|
| 1–4, 6–9 | 迎宾/多轮/打断/动作/口型/静音/断网/长断网 | 未测：2 GB 模拟器 renderer 被杀 | 未测：Task 18 产品页 E2E 未运行；仅 Task 16 能力探针已运行 |
| 5 | 静默追问 | 部分，仅网关级（见下），非通过 | 不适用 |
| 10–12 | 切后台/来电/30 分钟 | 不适用 | 未测：Task 18 清单未运行 |
| 13 | 日志合规 | 部分，仅网关级（见下），非通过 | 不适用 |
| Step 0.1–0.6 | 完整页面首跑 | 未测：无可用设备 | 未测：Task 18 产品页未运行；Spike A renderer crash 尚待排查 |

## 自动化证据（不能替代清单项）

2026-10-12 实际运行：

| 命令 | 结果 |
|---|---|
| `npm test`（根） | protocol 1 文件 6 测试通过；gateway 8 文件 91 测试通过；avatar-core 10 文件 57 测试通过 |
| `npm run typecheck`（根） | 退出码 0 |
| `cd app && flutter test` | 15 测试全部通过 |
| `cd app && flutter analyze` | No issues found |

## 网关级无头证据（gateway-level headless evidence，不是 App/WebView 验证）

方法：后台启动 `ADAPTER=mock` 网关（端口 8787，运行后按 PID 结束并确认端口已释放），用不入库的临时 node 脚本（Node 内置 fetch/WebSocket）走 `POST /session` + WS 协议；App 密钥取自 `gateway/.env`，未输出、未写入仓库。脚本只记录消息类型、序号、长度，不记录文本内容。

| 观察 | 结果 | 支持清单项 |
|---|---|---|
| `session.start` 后问候 | 约 0.3 s 内 `response.start kind=greeting`，约 2.7 s 后 `response.end`，收到 127200 个 24 kHz 采样（约 5.3 s 音频） | 第 1 项（仅网关侧，无 WebView，无 `greeting_ms`） |
| `debug.userText` "给我比心" | `response.cancelled`→`transcript.user`→`avatar.action heart (source=keyword)` 恰好 1 次→新 reply | 第 4 项（仅网关侧，未经动画） |
| `debug.userText` "挥挥手" | 同上，`avatar.action wave (keyword)` 恰好 1 次 | 第 4 项（仅网关侧） |
| 静默追问（客户端在 `response.end` 后发 `playback.stopped reason=ended`，与真实客户端一致） | 问候结束后约 8.4 s 追问（followup#1），其后约 25.3 s 说收尾语（followup#2），至观察结束（约 50 s）再无主动开口 | 第 5 项（仅网关；部分） |
| 网关 stdout 对话文本 | 两次运行的网关日志只有 `gateway_listening`、`session_created`、`response_cancel`、`session_destroyed` 等事件名与数值；对"你好/刚才/比心/挥/饺子"检索 0 命中 | 第 13 项（仅网关；部分） |

注意与不确定点：
- 第一次无头运行中客户端没有发 `playback.stopped(ended)`，**沉默追问在 45 s 内没有出现**。原因是网关的静默计时器在 `playback.stopped(ended)` 到达时才启动（`session.ts` → `director.onAiTurnEnded()`），不是网关缺陷，但意味着真实客户端必须可靠上报播放结束；该上报在 App 中的行为仍需真机/浏览器验证。第二次运行补发后出现上述结果。
- 动作触发来源在该路径下为 `keyword`；`tool` 路径与"工具调用去重"未在此观察。
- 单次运行，无重复样本；时间值为本机网关与本机客户端的挂钟时间，不是端到端体验指标。

## 调参记录
| 参数 | 原值 | 新值 | 原因 |
|---|---|---|---|
| （无） | — | — | 无真机数据，不调参 |

## 遗留问题与 Plan 2 输入
- 阻塞项：见 docs/blockers.md #1–#7（#7 为本任务；所有剩余清单项与复现命令列在其中）。
- 需要真机/真实浏览器验证：Step 0 全部、清单 1–4、6–12、第 5/13 项的 App 侧部分、确认 WebView >=120 与麦克风实际拾音、Task 14 Step 7 桌面 Chrome E2E。Task 16 探针能力结果不等同于这些产品体验项。
- 需要真实模型验证：首响应延迟、抢话率、上下文回忆、工具调用对语流的影响。
- 其他：本地 VAD 在 2 GB 模拟器上发生过 lowmemorykiller renderer kill；真机 Spike A 出现另一条尚未查明原因的 renderer SIGABRT（#6）。

## 附录：metrics CSV
无（没有任何 App/WebView 会话产生指标）。
