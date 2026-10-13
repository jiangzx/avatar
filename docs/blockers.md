# 阻塞记录

规则：步骤卡住 ≤20 分钟仍未解决 → 手动验证一次 → 记录在下表 → 跳过继续。解除后把“状态”改为“已解除”并写明方式。

| # | 日期 | 任务/步骤 | 现象 | 已做的手动验证与结论 | 跳过的影响 | 解除条件 | 状态 |
|---|---|---|---|---|---|---|---|
| 1 | 2026-10-12 | Task 0 Step 2b | 初次执行时没有小米真机可连接 | 【真机】已连接 Xiaomi 22101317C（sunstone，Android 13，USB）；`adb devices -l` 显示 device，Task 16 debug/release 探针均成功启动 | #1 本身不再阻塞；检查点 ① 的其他子项仍见 #3/#4/#6 | 已接入真机并完成设备连接验证 | 已解除 |
| 2 | 2026-10-12 | Task 14 Step 7 | 自动化浏览器中 `audioWorklet.addModule` 无法返回，也无法代用户授予麦克风权限 | 已验证 TalkingHead 头像、动作、口型和 Mock 网关基础消息；完整 worklet 播放、麦克风/VAD、插话延迟和清单仍未验证 | 桌面 Chrome E2E 未完成 | 在真实桌面 Chrome 中按 Task 14 Step 7 手动跑一遍（戴耳机），结果记入报告 | 未解除 |
| 3 | 2026-10-12 | Task 16 Step 8–9 | 真机 WebView 104 低于 Chrome ≥120 门槛 | Xiaomi debug/release 探针显示 secure context、AudioContext、AudioWorklet、wasm、WebGL2、getUserMedia（16 kHz、`echoCancellation=true`）和 gateway health OK；提示音听感及真实拾音未确认；release 访问 `127.0.0.1:8787` 成功 | Plan 1 A 路径的 WebView 兼容性门槛仍未满足 | 更新 Android System WebView 至 Chrome ≥120 后重跑，并人工确认声音和拾音 | 未解除（版本门槛） |
| 4 | 2026-10-12 | Task 17 Step 5–7 | 真机 Spike A 在统计刷新前触发 WebView renderer SIGABRT，A/B 测量无法开始 | 点击 `EC=true` 后出现麦克风占用指示但无计数；Flutter 随后 native crash；设备约 7.6 GB 内存、崩溃后约 4.5 GB 可用，没有 lowmemorykiller 证据 | A/B 数据、10 句真打断抽查和 ADR-001 结论均未取得 | 先让 Spike A 完成 VAD 初始化并稳定刷新计数，再执行三组 10 分钟测量 | 未解除 |
| 5 | 2026-10-12 | Task 17 Step 4b | 模拟器曾因 VAD 资源路径错误无法加载 | `vadAssetBase(document.baseURI)` 已修复路径；模拟器曾确认 ORT 请求到 `/<token>/vad/`，但真机初始化仍未确认 | Spike A 暂不能用于 A/B 测量 | 在 renderer crash 排查后重跑并确认 VAD 初始化和计数 | 路径缺陷已解除（真机运行待 #6） |
| 6 | 2026-10-12 | Task 17 Step 4b 复测 | 2 GB AVD 曾在 Silero 加载后被 lowmemorykiller 杀 renderer；真机另有独立 SIGABRT | AVD 的 OOM 与真机 renderer abort 是两件事；真机退出记录 PSS 433 MB，底层 abort 原因仍不明 | 产品页和 Spike A 的真实 VAD 运行未验证 | 更新 WebView/复现并定位 renderer SIGABRT；在稳定初始化后关闭此项 | 未解除 |
| 7 | 2026-10-12 | Task 18 Step 0、2、3、4 | 完整 Mock E2E 尚未执行，桌面 Chrome 手动 E2E 仍未做 | 已有自动化回归和网关级无头证据；未新增产品页全链路、性能或人工语音指标 | Plan 1 不能宣称“真机可演示” | 先处理 #3/#6，再按清单记录 CSV，并完成桌面 Chrome E2E | 未解除 |
| 8 | 2026-10-14 | Plan 1.1 真机语音验收 | 用户决定暂缓真实语音/VAD 打断、可听播放、活动响应续接、断线恢复和稳定性验收，待后续本地任务完成后统一执行 | 已保留 2026-10-13 的启动冒烟和 30 分钟采样；本次不把延期项标记为通过 | 暂不取得真实拾音、听感、打断延迟、断线续接和长稳数据 | 本地后续任务完成后，按 Plan 1.1/Task 18 清单回到小米真机统一验收 | 用户延期 |

## 2026-10-13 Plan 1.1 更新

- #1：小米 22101317C 已连接，设备身份和 WebView 104 已核实；完整真机清单仍未完成，标为部分解除。
- #3：Plan 1.1 debug/release 本地页面和头像已加载；Plan 1 的 8 项能力探针仍未重跑，标为部分解除。
- #6：Plan 1.1 启动期间未见真机 WebView renderer 被杀；2 GB 模拟器的 Silero OOM 仍未解除，标为部分解除。
- #7：完成 Plan 1.1 启动冒烟、原生采集初始化、一次挥手视觉检查和 30 分钟稳定性采样；真实语音/VAD、活动响应续接、10 分钟可靠自打断计数和 10 次真打断仍未测，标为部分解除。
- #4：A/B 10 分钟测量和 ADR-001 结论仍未完成。

## 2026-10-13 Plan 1.1 Task 7 Step 3 续验

- 小米设备、ADB reverse、Mock 网关、同一临时 secret 的 debug APK 均可用；应用启动、WebView 104、16 kHz 单声道 `AudioRecord` 初始化和 30 分钟稳定性采样已完成。
- 真实说话、人工听感、长回复真实打断、五个动作逐项视觉确认、活动回复期间 `session.resumed`、10 次真实打断检出仍未完成。当前自动化环境不能代替人在设备前说话，也不能确认扬声器听感。
- 10 分钟静默窗口的匿名 UI 变化探针得到 1 次变化，但启动残留/控件索引变化无法归因于 VAD；因此不记录自打断为 0，也不宣称误触发目标通过。
- 30 分钟采样得到 31 个点：PSS 570568→546773 kB（峰值 572259）、RSS 569312→543981 kB（峰值 569731）、温度 34.0°C、WebView renderer 31/31 存活。最终产品进程 logcat 音频 `E` 行为 0；AudioFlinger 系统级输入 timestamp 统计 `err=297`，无法归因到应用。
