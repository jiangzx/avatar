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
| 10 | 2026-10-15 | Plan 1.1 打断验收 | 修复前 10 次真实打断均反馈播放未停止；2026-10-16 一次样本检出 VAD 并取消活动响应但用户仍反馈继续或像同句重复，后续样本未捕获活动取消 | 新诊断显示第二次样本 `vadSpeaking=5`、`vadSilent=5`、`rmsMax=9600`、`maxAboveRunMs=300`、`localCancel=1`，网关确认 `seq=4` 被 `source=local` 取消后启动 `seq=5`；取消顺序门控测试已证明新序号等待旧停止完成。Mock 在已开始的回复被取消后会插入 400 ms 静音并跳过原波形，避免下一段听起来像同一句无缝继续；播放期间的 `audio.playback` 会保留 `activeRmsMax/activeAboveRunMs`。复位后的包在 17:46:47 和 17:46:50 各有一次 `source=local`（seq 12、seq 13）。seq 13 先 `vad silent activeSeq=13`，再本地取消；面板显示 playing→idle，playedMs 停在 2000，fedSamples 保持 48000，同序号丢弃 1 块。17:47 听感为停住且有明显静音。seq 15 正常结束时 `activeRmsMax=53`。2026-10-16 用户明确跳过打断延迟分布和多次计数，这两项不记为通过，也不再采样。字幕只终结一次仍未单独测量 | 延迟分布与多次计数不再作为解除条件。字幕只终结一次仍未测量 | 定量样本用户跳过 |
| 11 | 2026-10-17 | Plan 3 Task 0 Step 2（Mock 进程冒烟） | 曾按用户要求延期 | 2026-10-18 真实进程验证：无 bearer 的 `/session` 200，伪造 bearer 401，错误 App Secret 401；命令见路线图本次验收记录 | 此项不再阻塞；不代表手机验收 | 8797 Mock 冒烟已完成并正常停止 | 已解除 |
| 12 | 2026-10-17 | Plan A A1 Task 1 Step 6–7 | 用户指示本次仅用 Mock、不调用真实模型、不启动服务：Qwen 实时探针（instructions / cap / audio / voices）、探针音频合成和音色试听均未执行 | 未做手动验证；探针工具与辅助函数已写好并有单元测试（`gateway/test/qwenProbe.test.ts`），脚本未运行、未建立任何网络连接 | 假设 1/2/3/4a/5 均未验证，采用计划回退：假设 1 → `RESPONSE_INSTRUCTIONS='item'`；假设 2 → 两种风格 `"voice": null`；假设 3 → `output.maxTokens: null`，用量字段可为 null；假设 4a → `fillerEvidence=["transcript","responseStart"]`；假设 5 → 保留填充期零帧，待真机验证。结果文档 `docs/research/qwen-plan-a-validation.md` 全部标记 NOT RUN | 提供 `gateway/.env` 中的 `DASHSCOPE_API_KEY`/`QWEN_ENDPOINT`，按 Task 1 Step 6 运行探针并回填该文档，再按结果调整对应回退 | 未解除 |
| 13 | 2026-10-17 | Plan A A1 Task 2 Step 7（网关延迟基线） | 用户指示本次仅用 Mock、不启动网关、不调用真实模型、不连小米真机：Xiaomi + Qwen 20 句网关基线未测量 | 未做手动验证；指标采集（`ReplyMetricsTracker`、`log-report.ts`）已实现并有单元测试，`docs/testing/plan-a-latency-baseline.md` 仅含空表并标注 NOT RUN | 无 Plan A 之前的延迟基线，Plan A「P50 不劣于基线」门槛保持未关闭 | 在 A1 Task 4 之前的 plan3-a 提交上（该提交 SHA 由 Task 4 回填到基线文档），按 Step 7 在小米真机 + Qwen 上说 20 句并运行 `scripts/log-report.ts metrics`，填表 | 未解除 |
| 14 | 2026-10-17 | Plan A A1 Task 10 Step 2（Mock 进程冒烟） | 曾按用户要求延期 | 2026-10-18 真实进程验证：`/session` 200、`instruction_budget` 恰好 1 条，检查的合成输入及回复正文未出现在日志；命令见路线图本次验收记录 | 此项不再阻塞；真实模型人设及延迟门槛仍开放 | 8797 Mock 冒烟已完成并正常停止 | 已解除 |
| 15 | 2026-10-17 | Plan A A1 Task 10 Step 3（真实 Qwen 评测） | 用户指示本次仅用 Mock、不调用真实模型、无 key：grandchild / old-friend 两种风格的评测均未运行 | 未做手动验证；评测框架（`gateway/src/eval/*`、`scripts/eval.ts`、20 条场景）已实现并有单元测试；未生成任何评测报告，未取得提问比例与平均回复字数 | Plan A 门槛第 1–2 项（提问占比 ≤ 1/3、平均回复 ≤ 45 字）及 scam-call / chest-tight / are-you-real / lonely-evening 人工检查均未关闭；风格文案未经真实模型调优 | 提供 `gateway/.env` 的 key 后按 Step 3 运行两条 eval 命令（每种风格约 10 分钟），失败则按计划最多调 3 轮并记录 | 用户延期 |
| 16 | 2026-10-17 | Plan A A1 Task 3（安全文案，遗留项） | `gateway/roles/_shared/safety.md` 只有「心理援助热线」措辞，没有电话号码（规格第 325 行附近亦无已核实号码） | 未核实任何号码，未编造；按执行约定只写措辞 | 危机场景下回复无法给出具体热线号码 | 核实并确认一个有效热线号码后写入 `safety.md`（并由人工审核），上线前必须完成 | 未解除 |
| 17 | 2026-10-17 | Plan A A1 Task 3（音色，遗留项；依赖 #12） | `gateway/roles/elder-companion/role.json` 两种风格均为 `"voice": null`，Qwen 音色探针未运行（见 #12） | 未做手动验证；按回退使用适配器默认音色 | 规格要求的「每种风格独立音色」未满足，两种风格听起来同一声音 | 运行 #12 的 voices 探针，选定音色后回填两种风格的 `voice` | 未解除 |
| 18 | 2026-10-17 | Plan A A2 Task 1 Step 5（客户端感知延迟基线） | 用户指示本次仅用 Mock、无服务/真机/真实模型：小米真机上的 20 句基线测量未运行 | 未做手动验证；`anyidea.diag event=latency` 日志已实现并有单元测试；未取得任何 perceived_ms 数据，`docs/testing/plan-a-latency-baseline.md` 客户端表格留空 | Plan A 门槛「P50 不差于基线」的客户端部分未关闭 | 基线须在提交 `33dfbf4`（A1 Task 4 之前）上测量：接入小米真机，按计划 Step 5 说同样的 20 句并统计 p50/p90 填表 | 用户延期 |
| 19 | 2026-10-17 | Plan A A2 Task 3 Step 4（填充语片段录制） | 填充音色与回复音色不同：Qwen 片段录制未运行（用户指示本次仅用 Mock、无 key、无真实模型），两种风格目录均使用 macOS `say -v Tingting` 占位片段 | 未做手动验证；`make-filler-clips.ts` 与 PCM 工具已实现并有单元测试，但未对 Qwen 执行；占位片段时长 1.2–1.8 秒，已通过资源存在性/时长测试，未经人工试听 | 在片段重新录制前，用户听到的填充语音色与回复音色不同，两种风格的填充语听起来相同 | 提供 key 并确定音色后（依赖 #12、#17）按 Step 4 对两种风格运行 `make-filler-clips.ts`，试听确认后替换占位片段，并更新研究文档 §4 | 未解除 |
| 20 | 2026-10-17 | Plan A A2 Task 8 Step 4（完整 Web 构建与 debug APK 构建） | 用户指示本次不运行完整 `build-web.sh`（会拉取资源）、不构建 APK（无真机、`app/dev.json` 不存在）：仅运行了 `--probe-only`、`flutter test`、`flutter analyze` | 未做手动验证；配置/片段加载由 `filler_clips_test.dart` 与 `avatar_page_test.dart` 单元测试覆盖，`avatar_page.dart` 已通过 analyze，但未在真实 APK/WebView 中运行 | Web 包与 APK 能否成功构建、`AvatarPage` 实际加载资源与「…」显示均未在设备上确认 | 准备好 `app/dev.json` 与设备后，运行完整 `./scripts/build-web.sh` 与 `cd app && flutter build apk --debug --dart-define-from-file=dev.json`，并在 Task 9 真机验证中确认 | 用户延期 |
| 21 | 2026-10-17 | Plan A A2 Task 9 Step 2（构建、安装、启动网关、抓取日志） | 用户指示本次仅用 Mock、无服务/真机/真实模型：未连接小米真机、未启动网关（ADAPTER=qwen）、未抓取 logcat/网关日志 | 未做手动验证；仅完成 Task 9 Step 1 自动化验证 | Step 2 前置未满足，Step 3–6 的全部设备证据均无法产生；`instruction_budget` 与 `ADAPTER=qwen` 日志未确认 | 依赖 #20 的完整构建；接入真机与 key 后按计划 Step 2 构建、安装、启动网关并抓取日志 | 用户延期 |
| 22 | 2026-10-17 | Plan A A2 Task 9 Step 3（20 句口述回合） | 用户指示本次仅用 Mock、无服务/真机/真实模型：20+5 句口述回合未运行 | 未做手动验证；报告中逐回合表格与指标均标 NOT RUN，未编造数值 | Plan A 门槛未关闭：静音后 500 ms 内思考态 100%、满足条件必定垫话、无反馈空白为 0、感知延迟 P50 不差于基线（依赖 #18）、`model_auto_cancel` 假设 5 的设备验证 | 完成 #21 后按 Step 3 说 20+5 句，运行计划中的 grep/log-report 命令并填写报告；遗留项见设备报告 | 用户延期 |
| 23 | 2026-10-17 | Plan A A2 Task 9 Step 4（情绪表情与点头） | 用户指示本次仅用 Mock、无服务/真机/真实模型：未在设备上观察 happy/sad 表情与听话点头 | 未做手动验证；情绪/点头/思考姿势（eyesLookUp、headRotateZ）仅有单元测试 | Plan A 门槛「情绪表情可见、听话时有轻微点头」未关闭 | 完成 #21 后按 Step 4 说「我今天特别开心」「我心里有点难过」并说长句，记录是否观察到 | 用户延期 |
| 24 | 2026-10-17 | Plan A A2 Task 9 Step 5（10 分钟静默） | 用户指示本次仅用 Mock、无服务/真机/真实模型：10 分钟静默测试未运行 | 未做手动验证；`log-report silence` 无输入日志，replies/unprompted/proactive 均无数据 | Plan A 门槛「静默 10 分钟 unprompted = 0」「每 5 分钟主动说话 ≤ 3」未关闭 | 完成 #21 后按 Step 5 重启网关、静置 10 分钟并运行 `log-report.ts silence` | 用户延期 |
| 25 | 2026-10-17 | Plan A A2 Task 9 Step 6（两种风格人设与音色） | 用户指示本次仅用 Mock、无服务/真机/真实模型：两种风格的真机对话未运行 | 未做手动验证；无风格人设与音色的听感记录（风格音色仍为 null，见 #17；填充语音色不同于回复音色，见 #19） | Plan A 门槛「两种风格人设和音色可用」未关闭 | 完成 #21、#17、#19 后按 Step 6 切换 old-friend 各说 3 句，记录后还原改动 | 用户延期 |
| 30 | 2026-10-17 | Plan 3 B Task 1 Step 5–6（Keystore 存储真机验证，spec 假设 9） | 用户指示本次仅 Mock、不连真机、不构建 APK，`flutter build apk` 与小米真机检查未执行 | 状态：NOT RUN (no device; user instruction Mock only)。未做手动验证；`flutter pub get`（镜像）、`flutter analyze`（无问题）、`flutter test`（53 通过）已通过，但这些不证明 Keystore 行为。NOT RUN ≠ FAIL：Task 1b 未执行，继续使用 `flutter_secure_storage` 11.2.0 | 未取得写入/回读、force-stop 后持久化、原地重装后持久化、非明文存储的证据；真机凭据存储是否可用未知 | Plan B 门禁前，在小米真机按 Task 1 Step 6 重跑（`--dart-define=SPIKE=secure_storage`）；若 FAIL 则执行 Task 1b | 未解除 |
| 31 | 2026-10-17 | Plan 3 B Task 7 Step 7（身份注册 Mock 进程冒烟） | 曾按用户要求延期 | 2026-10-18 真实进程验证：token 长 43；bearer 会话 200、伪造 bearer 401、无 bearer 200；改风格 200；dev 删除端点 404；SQLite 权限 600；token 未出现在日志；1 owner，style 为 grandchild；启动与退出正常。Plan C 后首次 bearer 会话有 2 次 `device_resolved`（先定位 owner，再在 flush 后读快照）；命令见路线图本次验收记录 | 此项不再阻塞；Keystore 和手机验收仍开放 | 临时库已删除，8797 网关已正常停止，8787 未触碰 | 已解除 |
| 32 | 2026-10-17 | Plan 3 B Task 11 Step 3 前置（debug APK 构建与安装） | 用户指示本次仅 Mock，不连真机、不启动服务、不构建 APK | 状态：NOT RUN (user instruction: Mock only, no device/services)。未做手动验证，不记为通过；`flutter build apk --debug --dart-define-from-file=dev.json` 与 `adb install` 未执行（`app/dev.json` 不存在）；Task 10 Step 10 的 build 部分同属此项 | 没有可安装到小米真机的含身份流程的 APK，下列 #33–#37 无法执行 | 获得真机与批准后，按 Plan B Task 11 Step 3 构建并安装；需先确认是否重启用户的 8787 网关 | 用户延期 |
| 33 | 2026-10-17 | Plan 3 B Task 11 Step 3 检查 1（首次启动选择风格） | 用户指示本次仅 Mock，不连真机、不启动服务、不构建 APK | 状态：NOT RUN (user instruction: Mock only, no device/services)。未做手动验证，不记为通过；两卡片选择页、选 老朋友型 后头像打开并问候；网关日志 `device_registered`（`style:old-friend`）与 `device_resolved` 均未观察 | Plan B 门禁“首次注册并绑定 agent”缺真机证据 | 真机按 Step 3 检查 1 执行并记录日志 | 用户延期 |
| 34 | 2026-10-17 | Plan 3 B Task 11 Step 3 检查 2（force-stop 后身份持久化） | 用户指示本次仅 Mock，不连真机、不启动服务、不构建 APK | 状态：NOT RUN (user instruction: Mock only, no device/services)。未做手动验证，不记为通过；force-stop 重启后不再出现选择页、`device_resolved` 的 `agent` 短哈希相同、库中仍只有一个 owner 均未观察（依赖 #30） | Keystore 持久化与 owner 复用缺真机证据 | 真机按 Step 3 检查 2 执行，并用 Task 7 Step 7 的 `node -e` 查询库 | 用户延期 |
| 35 | 2026-10-17 | Plan 3 B Task 11 Step 3 检查 3（60 秒内重连替换旧会话） | 用户指示本次仅 Mock，不连真机、不启动服务、不构建 APK | 状态：NOT RUN (user instruction: Mock only, no device/services)。未做手动验证，不记为通过；`session_destroyed` 的 `reason:owner_replaced` 未在真机日志中观察（单元测试已覆盖 manager 行为） | 一个 owner 同时只有一个活动会话的真机证据缺失 | 真机按 Step 3 检查 3 执行 | 用户延期 |
| 36 | 2026-10-17 | Plan 3 B Task 11 Step 3 检查 4（设置页改风格） | 用户指示本次仅 Mock，不连真机、不启动服务、不构建 APK | 状态：NOT RUN (user instruction: Mock only, no device/services)。未做手动验证，不记为通过；设置页选 孙辈型 并保存、提示“已换好，下次聊天时生效”、`agent_style_changed`（`style:grandchild`）及下一会话 `device_resolved` 均未观察；声音与人设变化属于 A+B 合并门禁，不在此项 | 改风格全链路缺真机证据 | 真机按 Step 3 检查 4 执行 | 用户延期 |
| 37 | 2026-10-17 | Plan 3 B Task 11 Step 3 检查 5–6（日志无 token；Keystore Step 6） | 用户指示本次仅 Mock，不连真机、不启动服务、不构建 APK | 状态：NOT RUN (user instruction: Mock only, no device/services)。未做手动验证，不记为通过；`grep -E '[A-Za-z0-9_-]{43}' <log> | wc -l` 应为 `0` 未跑（无真机日志）；Task 1 Step 6 的 Keystore 检查仍按 #30 未运行 | 日志不泄露 token 的真机证据缺失；Plan B 门禁整体 NOT RUN | 真机完成 #33–#36 后在其网关日志上执行 grep，并按 #30 重跑 Keystore 检查 | 用户延期 |
| 38 | 2026-10-17 | Plan 3 A+B 合并 Task 3 Step 2（构建、安装、运行：build-web、debug APK、adb 安装、合并后网关 ADAPTER=qwen） | 用户指示本次仅 Mock，不连真机、不启动服务、不构建 APK、不调用真实模型 | 状态：NOT RUN (user instruction: Mock only, no device/services)。未做手动验证，不记为通过；未启动网关（8787 上用户的 Qwen 网关未触碰），未构建或安装任何东西 | 合并后的 APK 与网关未在真机上跑过 | 用户确认可重启 8787 网关后，按合并计划 Task 3 Step 2 执行 | 用户延期 |
| 39 | 2026-10-17 | Plan 3 A+B 合并 Task 3 Step 3（门禁流程：首次选孙辈型聊一轮；设置改老朋友型；会话结束后再聊一轮；网关日志检查） | 用户指示本次仅 Mock；依赖 #38 | 状态：NOT RUN (user instruction: Mock only, no device/services)。未做手动验证，不记为通过；换风格后音色与人设同时变化、填充语片段使用新音色、两次 `session_created` 映射同一 agent 短哈希、日志无对话内容，均未观察。即使真机运行，「新音色」检查也无法通过：填充语片段是 macOS `say` 占位（#19），两种风格 `voice` 均为 null（#17），须先解除二者 | A+B 合并门禁整体 NOT RUN；风格切换全链路的真机证据缺失 | 先解除 #17、#19，完成 #38，再按合并计划 Task 3 Step 3 逐项记录通过/失败 | 用户延期 |
| 40 | 2026-10-18 | Plan C Task 9：真实提取 JSON 契约 | qwen-plus HTTP 200，但提示词未说明扁平字段结构；实际 worker 报 extract_parse，消息未标记提取。补字段后又发现称呼未归入 addressing | 真实探针先失败再通过；补全共享 prompt 的现有字段/类型，明确 addressing 归类后，2/2 消息提取、2 条事实，并通过重开 SQLite 的快照及 owner 隔离检查。命令及计数见 roadmap 真实提取验收 | 本地真实提取链路已可验；手机口头回忆仍待测 | 修复及 live probe 已完成 | 已解除 |
| 41 | 2026-10-18 | Plan C 手机验收启动配置 | 旧进程已有仓库外身份库，未配置 QWEN_SUMMARIZER_ENDPOINT，尚无记忆表 | 用户明确同意后保留原库和手机身份，通过进程环境补齐已验证文本端点、现有 Key、手机 APP_SECRET，重启 8787；health 200、鉴权 401/400、迁移及 0600 权限检查通过，ADB reverse 与 App 启动成功，原身份解析及开场 start/end 已观察。详见 roadmap 手机启动记录 | 启动前置已完成；真机工具轮和二次口头回忆仍待用户交互 | 用户在手机完成测试轮次，再核查内容脱敏事件与计数 | 已解除（启动前置；非真机验收通过） |
| 42 | 2026-10-18 | Plan C 真实二次通话：近期话题与重复接话 | 用户确认称呼回忆成功，但上次话题接续失败，沉默时反复表达不知道 | 用户批准后已补最近已结束会话摘要、OR 回忆检索（遗忘保留 AND）与防重复指令。TDD 回归、全量 6/399/96、类型检查、8797 Mock 冒烟通过；最终真实 Qwen 合成 4 场景机械检查和逐句人工复核通过。独立审查发现的探针 P2 已修正复查；证据及限制见 roadmap 话题接续修正实施记录 | 代码和合成模型门槛通过；用户同意后已应用到 8787，health/auth/DB 元信息与手机新会话开场事件通过；用户确认重复消失；近期话题接续与假设 8 仍待验；沉默无关发言另见 #43 | 近期话题接续与真机工具轮另验；先处理 #43 的流程决策 | 未解除（重复消失已确认；话题接续待验） |
| 43 | 2026-10-18 | 会话内沉默流程与上下文相关性 | 用户确认重复消失，但沉默时出现无关泛陪伴 | 核查播放回执、Director、Qwen item 指令、脱敏时序及旧评测；101 项相关测试通过；8 个合成基线复现确认无语义判断、quiet 不恢复、噪声后沉默链重开，详见 roadmap 沉默对话流程核查 | 当前固定阶梯和防重复文案不满足自然对话；既有测试未覆盖是否应开口 | 先确认允许跳过沉默发言及后续阶梯的行为；随后更新规格/计划，TDD 修状态边界并补两种风格正常多轮评测，再回手机验收 | 未解除（诊断完成，行为修正待确认；未改代码或重启） |
| 44 | 2026-10-19 | Avatar selection: four new GLB assets | 目录和选择链路已实现，但当前 checkout 只有外部提供的默认 `avatar.glb`；四个新模型没有可核验的文件、授权和视觉验收证据 | WebView 白名单、缺失模型回退和匿名诊断已通过单元测试；未伪造或下载未经确认的模型资源 | 四个新增形象暂时显示现有模型，无法完成逐模型审美、材质、表情和手机构图验收 | 提供四个已获授权的 GLB，放入 `avatar-core/public/avatars/` 后运行完整 Web 构建并在目标手机逐一验收 | 未解除 |

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
