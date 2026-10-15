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
| 9 | 2026-10-15 | 本地优先手机调试：debug APK 安装 | 初次 `adb install -r` 被 Android 拒绝（`INSTALL_FAILED_USER_RESTRICTED`） | 改用 `adb push` 后由设备端 `pm install -r -d` 安装成功；应用 `MainActivity` 已 resumed，网关日志出现新的 `session_created`，设备侧观察到 16 kHz `AudioRecord` 与 24 kHz `AudioTrack`。本地连接已建立；真实语音、打断、重连和完整验收仍未宣称通过 | 按 Plan 1/1.1/2 清单完成手机人工验收 | 已解除（本地安装与连接） |
| 10 | 2026-10-15 | Plan 1.1 打断验收 | 修复前 10 次真实打断均反馈播放未停止；2026-10-16 以连续 Mock 节奏复测仍反馈“同一句继续” | `MOCK_PACE_FACTOR=0.5` 的断续原因已确认为配置欠载；改用 2/1 倍速后仍未在受控说“停”期间观察到匹配的 `response_cancel(source=local)`，更像本地 VAD 漏检或时序问题；网关同一序号迟到音频测试仍通过 | 增加匿名 VAD 事件/音量观测，确认设备能检出说话并在活动响应期间发出 local cancel；再补齐计划要求的定量样本 | 未解除 |

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

## 2026-10-14 Plan 2 Seeduplex 协议探针

- 官方资料与官方 Python demo 已核对，脱敏验证记录见 `docs/research/seeduplex-protocol-validation.md`。
- 最小 WebSocket 探针未通过鉴权：`X-Api-Key` 握手 HTTP 403；`Authorization: Bearer` 握手 HTTP 401；均未建立连接、未发送音频、未收到事件。
- 当前本地 Key 不可用于官方端点，需更新/确认 Key 或账号权限后重跑。未伪造输出音频、取消、工具调用或工具结果验证；真实适配器与 Plan 2 实施计划暂缓。

## 2026-10-14 Seeduplex 权限复测

- 用户反馈权限已开通，但本地 Key 复测仍失败：WebSocket `X-Api-Key` 返回 403；HTTPS 预检使用 `X-Api-Key`、Bearer、双头均返回 401。
- 未建立会话、未发送音频或对话事件。需确认本地 Key 已更新且绑定 Seeduplex 实时语音服务/项目后再复测。

## 2026-10-14 Seeduplex Key 根因确认

- 已确认此前失败是因为本地 `docs/seeduplex/developer_keys` 使用了不同的 Key。使用用户提供的 Key 后，WebSocket HTTP 101，收到会话、音频输出和取消确认事件。
- 输出音频与 `response.cancel` 已验证；工具调用/工具结果续答尚未由模型触发，仍需使用可控的真实用户音频或官方工具调用样例完成验证。

## 2026-10-14 Seeduplex 用户 Key 重跑

- 使用 `docs/seeduplex/Seeduplex_APIKey.txt` 中的用户 Key 重跑，WebSocket HTTP 101，收到 `session.created`、输出音频和 `response.canceled`，错误事件数为 0。
- 另一次本地探针超时是探针把 binary frame 中承载的 JSON 误判为非 JSON，已修正探针解析后复测通过；不属于服务端失败。
- Function Calling 仍未被最小输入触发，工具结果续答继续保留为未决项。

## 2026-10-14 Seeduplex response.create 契约缺口

- 官方 Seeduplex 文档只定义 `speech_text_buffer.commit` 为“直接指定文本合成音频”，没有发现通用的 `response.create` 事件。
- 现有冻结的 `RealtimeAdapter.createResponse(instructions?)` 接收 Director 提示词；若把该参数直接作为 `speech_text_buffer.commit.text`，模型会播报内部提示词，不能作为产品行为。
- 当前 SeeduplexAdapter 已验证连接、用户音频触发、音频事件、取消和 fixture 映射，但 Director 迎宾/追问/恢复路径在该缺口解决前不得启用。需要明确：新增上游模型响应触发方式，或把 Director 产出的内容改为可直接播报文本并更新设计/契约。

## 2026-10-14 Seeduplex proactive response decision

- Adopted fixed, configurable proactive utterances for greeting/follow-up/idle/resume. Director keeps prompt instructions for Mock/model context, while Seeduplex maps exact instructions to `greetingText`/`followupText`/`idleNoticeText`/`resumeText` and sends only those texts through direct TTS.
- This avoids speaking internal prompts. It is a POC behavior decision; model-generated proactive responses remain outside the verified Seeduplex protocol.

## 2026-10-14 Qwen fallback adapter

- Official Qwen Realtime WebSocket docs verified: Bearer auth, workspace-specific WSS endpoint, `response.create`, `response.audio.delta`, and `response.audio_transcript.*`. Live WSS smoke succeeds with HTTP 101, session events and output audio; real tool-call fields and tool-result acknowledgement were observed, but a second response after the tool result was not proven. A separate cancel retry hit a transient socket error and remains unverified live.

## 2026-10-14 Qwen text summarizer

- Official DashScope OpenAI-compatible text endpoint and Bearer authentication were verified; `QwenSummarizer` and sanitized HTTP fixtures are implemented with `MockSummarizer` still default.
- Live summarizer smoke now returns HTTP 200 and a response containing `choices[0].message.content`; only status/size/field presence were recorded. Text content was not logged.

## 2026-10-14 Plan 2 external acceptance prerequisites

- Qwen realtime and text credentials are now available and live smoke has been run. Live response cancellation still needs a stable repeat; fixture coverage remains authoritative for the frozen gateway contract.
- Public WSS acceptance requires a target cloud host, DNS name, TLS certificate, and IP allowlist. The runbook is complete, but no deployment target or certificate was supplied, so no public deployment was attempted.
- Xiaomi release acceptance still requires the device-side install confirmation/permission. The earlier release install was rejected with `INSTALL_FAILED_USER_RESTRICTED`; real voice/VAD, audible playback, reconnect, and ADR-001 measurements remain deferred as previously requested.

## 2026-10-14 Cloud deployment access

- The supplied host `14.22.89.31` was reachable over SSH on port `9722` before deployment. Docker 27.3.1 and Docker Compose v2.29.7 were already installed.
- Nginx and Certbot installation was started, but the management channel became unavailable immediately afterward: ports checked through the public address returned the Nginx default page instead of an SSH handshake, including the supplied SSH port. No gateway container, reverse-proxy configuration, or certificate issuance was verified afterward.
- No user-owned domain or DNS record was present in the supplied server information. The attempted temporary `sslip.io` name resolved to `198.18.0.84` from this network rather than `14.22.89.31`, so it is not a valid certificate target here.
- Recovery requires the cloud provider console or a confirmed SSH port/port mapping. Do not claim public WSS, TLS, DNS, or IP allowlist acceptance until the management channel is restored and `GET /health`, HTTPS, and WSS are independently verified.

## 2026-10-15 Cloud access recheck

- SSH access is restored. Remote `ss` and `sshd -T` checks show `sshd` listening on `0.0.0.0:9722` and `[::]:9722`; port `22` refuses connections. Therefore `9722` is the SSH management port, not an application or Nginx port.
- Docker 27.3.1 and Compose v2.29.7 remain installed; `/opt/anyidea/gateway/.env.production` remains root-owned with mode `600`. The gateway container is not running.
- Nginx, Certbot, and the Nginx reverse proxy are not installed/active. Public WSS and TLS remain unverified.

## 2026-10-15 Domain deployment

- `aihero.com.cn` resolves to `14.22.89.31`. Gateway systemd service and Nginx are active; local health and App Secret status checks passed (200/401/200).
- Existing MySQL and Redis public interfaces were preserved: containers remain running and listeners `3306`/`6379` were not changed. The only new firewall rule targets gateway port `8787`, allowing loopback and rejecting direct external access.
- Let’s Encrypt HTTP-01 failed with a CA connection timeout because public TCP 80 is not reachable. Cloud security group access for TCP 80 and 443 is still required before public HTTPS/WSS acceptance.

## 2026-10-14 Plan 2 release APK device install

- Xiaomi 22101317C was visible to `adb`; `adb reverse tcp:8787 tcp:8787` succeeded and the local gateway Mock process started.
- Installing the freshly built release APK failed with `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`. No app launch or real-device Plan 2 acceptance was claimed. Device install permission/confirmation must be enabled before repeating.
