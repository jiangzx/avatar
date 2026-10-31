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
| 44 | 2026-10-19 | Avatar selection: four new GLB assets | 已提供本地恢复脚本：三个模型来自固定 TalkingHead revision 并通过 SHA-256 校验，`cute-boy.glb` 为固定男性源的本地比例变体；上游示例含非商业或署名限制 | 五个 GLB 的结构、长度声明、校验和、Web 构建复制、TalkingHead 路径白名单和缺失模型回退均已验证；未在目标手机逐一检查构图、材质、表情和动画，也未完成发布许可复核 | POC 可加载五个选择项；不能把当前本地结构验证写成目标手机审美或商业发布通过 | 在目标手机逐一选择五个形象，检查半身构图、材质、面部表情和动作；发布前按各上游许可完成授权复核并替换受限资源 | 未解除 |
| 45 | 2026-10-21 | M1 Task 1：Qwen 日语音频探针 | 本次新合成的 `say -v Kyoko` 日语 WAV（默认/`-r 160`/`-r 280`/`-r 300`，以及 `Grandma`、ffmpeg 重转码、前置静音、重复拼接变体）在 Qwen `semantic_vad` 会话上均无任何 VAD/转写/回复事件（25 s，errors 0）；2026-10-19 生成的 `/tmp/qwen-ja-probe/user-16k.wav`（同 Kyoko、16 kHz mono）连续两次通过（ASR 含平假名+汉字、回复含假名/片假名、audioBytes 288000–710400） | 已确认能力本身可用；未打印任何正文。差异仅在合成样本，原因未定位（TTS 输出、VAD 灵敏度或服务侧均未排除）。未改生产代码 | Qwen 日语能力已验证，但探针“每次新合成样本都复现”未验证；M1 基础不依赖该复现 | 定位新合成样本不触发 VAD 的原因，或生成一个能稳定触发的新样本并复跑 | 未解除（观察项） |
| 46 | 2026-10-21 | M1 Task 1：Seeduplex 日语 ASR 探针 | 日语输入（新样本与 2026-10-19 已知可用样本）均无 ASR completed、无回复、audioBytes 0；仅一次出现 transcription.started + 2 个 partial delta 后中止。无含假名的终稿 | 已用内容无关诊断确认：无 `conversation.item.input_audio_transcription.completed`，无 `response.*`；独立会话中中文/英语 ASR 正常；switch 探针只做了 zh→en | 网关无法判定“用户说了日语”，“明确告知不支持”不可实现；M3 不得实现该功能（已写入 spec 风险表） | 若上游提供日语端到端支持，重新探针并更新决策 | 未解除（M1 按计划继续） |
| 47 | 2026-10-22 | Plan 4 前置：P1 情绪标签验证 | 没有可验证情绪的人声表演 ground truth；`qwen3-tts-flash` 的 instructions 是否真的改变情绪未被独立验证；CosyVoice v2 所有可用中文音色的 `instruction` 返回 `[cosyvoice:] Engine return error code: 428` | P1 15 条合成样本：`emotion` 字段存在，随 `conversation.item.input_audio_transcription.delta` 实时下发，`completed` 自带最终值；取值 neutral/happy/sad/surprised/angry；最终标签命中 happy 2/4、sad 0/5、neutral 2/3；句内会翻转；未打印任何正文。详见 `docs/research/emotion-proactivity-probes-2026-10-22.md` | P1 只能判“不可靠/退回 B”，不能判“字段无效”；Plan 4 情绪信号不能依赖 C | 操作者录 2 条开心、2 条难过、2 条中性的人声表演句（16 kHz 单声道），复跑 `probe-emotion-p1-asr-tags.ts`；或提供可验证情绪的 TTS | 未解除 |
| 48 | 2026-10-22 | Plan 4 前置：P4 Seeduplex 播报中 `session.update` | 播报中发送完整 session payload（带标记指令）：当前回复可继续并正常 done，`session.updated` 耗时 46–61 ms，无 error；但随后下一轮用户音频不再产生回复（3/3 干净样本）。更晚发送时当前回复无 `done` 停滞 | 首个 delta 后立即发送 3 次，均复现“下一轮不响应”；空闲（上一轮 done 后）发送 2/2 下一轮生效；间隔 1 s 连续两次均确认且后一次生效，无乱序/丢弃。Qwen 对照 2/2 播报中更新安全 | Plan 4 不能按“每句终稿后推状态卡”在 Seeduplex 上实现；必须延后到回复结束 | 上游修复，或确认可用的规避方式；安全缝隙推送已验证可用 | 已规避（2026-10-23，T0 统一推送闸门：所有 session 变更只在缝隙推送；单元测试覆盖播报中零 session.update）。真机 Seeduplex 复验 NOT RUN |
| 49 | 2026-10-23 | Plan 4 前置：P2/P3 语音情绪控制 | Qwen 与 Seeduplex 的被动回复和 Seeduplex 直接 TTS，靠 instructions 要求「轻柔、放慢」都盲听不可分辨（见 `docs/research/emotion-proactivity-probes-2026-10-22.md`） | 已做 A/B 合成样本与盲听；判定不做 | 本期语音语气不随情绪变化，只有文本内容与头像表情变化 | 换用支持情绪参数的 TTS（例如级联方案），另立计划 | 未解除（本期不做） |
| 50 | 2026-10-23 | Plan 4 T7 Step 8：真机复试 | 2026-10-24 用户同意转真机验收；launchd 重启 8787（PID 60012，`gateway_listening` adapter=qwen），`adb reverse` 8787 已建；debug APK 经 `adb push` + 设备端 `pm install -r -d` 安装；启动后网关记录 `device_resolved`、`session_created`、greeting `response_start`，麦克风权限已授予。用户确认 item 1–6 全部符合预期；item 4 第一次因新 owner 无称呼失败，补充称呼后重开出现 `care_opening ready`（851ms）→ `closed` 并通过 | 本地 56 文件 839 项测试、typecheck、Mock smoke、合成探针与召回探针均已完成；网关/设备连接已确认；真实听感 1–6 通过 | 真机清单通过；旧 owner 的 328 条历史未接入新 owner（独立于清单） | 收尾：决定是否恢复旧记忆（重绑/迁移，另立计划）与合并/保留分支；之后 M3 | 已通过（1–6 全部符合预期；旧历史未接入） |
| 51 | 2026-10-23 | Plan 4 T7 Step 5：共情评估合并门槛 | 原始文案两次 `+0.48`（`5ccf4f9`/`4843882`，3.78）；T6 问句约束（`952519a`）`+0.06`；文案实验 `baf6319` `+0.50`、`5047028` `+0.40`、`4f9bf1c` `+0.48`、`b31ea80` `+0.45`。Plan 5 原版（`c174d53`）两轮 `firstThree 3.67/3.89`（`+0.37/+0.59`，均值 +0.48），`proactive 3.58/3.75`，`noIntrusion 4.00/4.42`；调参版（`eaf69ca`，去掉低落补句、timeout 1500）两轮 `3.61/3.56`（`+0.31/+0.26`），`proactive 3.58/3.58`，`noIntrusion 4.25/4.00`，两轮 gate 均 false | 12/12 评委成功；原版 `spoken 9/10`，调参版 `spoken 3/4`，`planner_timeout 30/31`、`new_turn 22/23`；crisis 会话没有在危机卡后补句；`noFabrication` 5；plan-a 两版均 pass（0.2328/0.2857） | 原版均值与 Plan 4 的 +0.48 持平，调参版更差；`noIntrusion` 两版均值均低于基线；结构补句未抬起共情 gate；Plan 5 代码已回退（`9b7470b`） | 用户 2026-10-24 接受 +0.48，转真机验收；不再要求 +1；不合并/不推送直至真机结论 | 已接受（2026-10-24；+0.48） |
| 52 | 2026-10-23 | Plan 4 T7 Step 6：plan-a 现有门槛（真实 Qwen） | 旧口径：T6（`952519a`）两次 `0.3538`/`0.3106`；回退后（`4843882`）三次 `0.3333/0.3769/0.3721`，中位数 `0.3721` 未通过；三次开场问句均 `20`，回复侧重算 `0.240/0.271/0.272`（中位数 `0.271`）。2026-10-24 口径修订（问句比排除开场轮，阈值不变）后 live（`7325482`，`dirty:false`）：`22/100=0.22`，`questionRatioScope:"excluding-greeting"`，`avgChars 26.45`，通过，exit 0；历史三次按新口径中位数 `0.271`。结果存 `persona-check-gate-fix.json` 与 `persona-check-revert{,2,3}.json` | 真实 Qwen 跑现有 20 场景；旧口径的失败来自固定开场问称呼与开场句数，回复侧并不超标；新口径 live 与历史重算均通过 | 已规避：门槛口径修订为只统计开场之后的追问，plan-a 不再阻塞；共情 +1 门槛仍单独未过 | 无需继续调 plan-a；保留旧口径数据供审计。后续只处理共情 +1 与真机复试 | 已规避（2026-10-24 口径修订；live 0.22 通过） |
| 53 | 2026-10-24 | 真机验收 item 4：新装新 owner 与关怀跳过的组合 | 新装 App 解析为新 owner `f5ae4a61…`/agent `551364ab…`（grandchild）；旧记忆在 owner `0218df26…`/agent `db871a83…`（old-friend，328 条消息、5 条事实、11 条无 quote 的 followup）。新 owner 已有 27 条消息、`addressing` 与 `health` 各 1 条事实、1 条已关闭并清空 quote 的 followup。补充回答称呼、挂断、等待抽取后重开，日志 `care_opening ready`（851ms）→ `closed`，关怀出现 | 用户反馈 item 1–3 通过；item 4 第一次感到“完全不记得我”，补充称呼后关怀出现并通过。旧 memory 仍完整，但新设备无法跨 owner 读取 | 新装=新 owner，旧称呼/历史不可见；新 owner 有称呼后，带 quote 的 followup 能正常触发关怀；旧 owner 的 11 条 followup 都没有 quote | 新用户关怀路径已验证；item 5–6 也已通过；若需要旧 328 条历史，需另立重绑/迁移计划（不要手改记忆库） | 已规避（新用户关怀路径）；旧记忆跨 owner 未接入（可选迁移） |
| 54 | 2026-10-25 | Task 13 M5 | 来回切换 20 次不再作为验收项 | 用户要求删除 M5。页面交接改为等上一次 release 结束后再 prepare。没有 20 次真机记录 | 假设 A6 没有真机次数证据 | 若要恢复这项，把 M5 加回验收并在真机做 20 次 | 已删除 |
| 55 | 2026-10-25 | Task 13 M6 | 初始化失败退回 3D 未做 | 未删除 Lily 模型文件，未看到退回文案，日志无 `duix_fallback` | 失败回退未在真机验证 | 按计划删掉 Lily 除校验文件外的内容，重开并看到退回 3D | 未执行 |
| 56 | 2026-10-25 | Task 13 M7 | 最终包上的 3D 回归未做 | 用户要求结束手机步骤并登记。更早一次 3D 确认不能代替这项 | 3 轮对话、2 次插话、静音和挂断未在本次关闭 | 在最终包的 3D 模式补做 M7 | 未执行 |
| 57 | 2026-10-25 | Task 13 M8 | PCAPdroid 在 `com.anyidea.avatar_app` 上看到 `content-autofill.googleapis.com`，大约每 30 秒一条，状态为错误，约 300 字节。没有 `guiji`、`duix`、`vshow` | 连接列表从顶到底核对。GitHub 下载域名存在。`127.0.0.1` 未出现（adb reverse 回环不进 VPN）。`debugOnly` 仍为 false，因为这不是 Duix 上报 | 书面零外发未通过 | 确认这条连接的来源并去掉，或修订验收标准后再判 | 未解除 |
| 58 | 2026-10-25 | Task 13 R1、R2、R5 | 回声 RMS、打断主观延迟、30 分钟内存和温度未测 | 用户要求结束手机步骤。R4、R7、R8 已写入验收记录；R3 样本不足不记数值；R6 随 M5 删除 | 这些实测值仍空 | 按计划补测 | 未执行 |
| 59 | 2026-10-27 | Task 17 A3 | 小暖、小欣的 `voices.seeduplex` 为 null，Seeduplex 适配器会回退到默认男声 | 卡片与注册表测试确认 `voiceFor(...,'seeduplex')` 返回 undefined；Qwen 路径已各自有音色（小暖 longanlingxin / Tina，小欣 Tina） | Seeduplex 下两位女性角色的声音与性别不符 | 厂商提供女声 id，写入卡片并在探针中复验 | 未解除 |
| 60 | 2026-10-27 | Task 17 合规（拟人化办法 12、13） | 未提供紧急联系人、一键求助或危机转人工路径 | 危机词表与安全提示已在用；没有对接真人/紧急号码 | 不满足拟人化管理办法第 12、13 条 | 确定紧急联系人与求助流程并实现、验收 | 未解除 |
| 61 | 2026-10-27 | Task 17 合规（拟人化办法 15） | 未提供面向老年人的使用说明与健康使用提示 | 应用内只有 AI 身份常驻提示与休息提醒 | 不满足第 15 条 | 增加老年用户使用说明/健康提示并验收 | 未解除 |
| 62 | 2026-10-27 | Task 17 合规（拟人化办法 16） | 记忆只支持查看/删除，不支持导出或复制 | 设置页四块与 HTTP 接口已验收；无导出接口 | 不满足第 16 条 | 设计并实现记忆导出（文本或文件）并验收 | 未解除 |
| 63 | 2026-10-27 | Task 17 Step 13b | 四个旧探针（affect/care/silence/topic）在当前网络下无法判定：affect 10/10、care 8/8、silence 决策全部撞生产超时（2.5 s / 1.5 s），直接文本调用约 2.0 s | 迁移后脚本均可加载并运行，topic 两个用例各完成 3 段回复；超时是延迟所致，不是签名/迁移错误 | 旧探针结果不能与 Task 6 之前基线比较 | 低延迟网络下重跑并人工复核 | 未解除 |
| 64 | 2026-10-27 | Task 13/16 已知缺口 | 旧的 `AUDIO_MODE=web` 路径（WebView 自己发 `POST /session {}`）总是使用默认角色小暖，也不会弹休息提醒 toast | 新原生路径 P1–P13 已通过；Web 路径未改 | 只有继续使用该路径时才影响多角色与提醒 | 若仍需 web 路径，另开任务接线 | 未解除（仅 web 路径） |
| 65 | 2026-10-27 | Task 15 固有行为 | 记忆接口遇到 401 会重新注册设备，新 owner 看不到旧 owner 的记忆 | 复用 `renew` 的既有行为；P13 清除后不重新注册，符合预期 | 设备令牌失效时用户会觉得记忆丢了 | 设计令牌续期或 owner 迁移方案 | 未解除 |
| 66 | 2026-10-27 | 手机验收 P10 | 改称呼为张大爷后切到小凯，开场字幕含「张」，但播出的第一个字「张」没听到（一次） | 网关该次回复 6 字、生成 470 ms；App `accepted_ms=1840/played_ms=1840`、无丢块；原生播放器播前已排队。同模板复现的 34 字开场前 600 ms RMS 正常（首字在 50–200 ms） | 暂无法复现，可能是一次性起播吃字 | 再现时录屏并保留 `duix_playback_*` 事件，再定位 | 观察 |
| 67 | 2026-10-28 | A2 HarmonyOS Sans 许可 | 计划里的 HarmonyOS Sans SC 自托管需要把官方 TTF 转成 WOFF2；许可是否允许自托管与格式转换不清楚 | 许可原文出自华为官方 HarmonyOS Sans 下载包内的 `LICENSE_Fonts`（© 2021 Huawei Device Co., Ltd.），OpenHarmony `resources` / `global_system_resources` 的 `LICENSE_Fonts` 镜像同文。条款：允许随软件使用、复制、合并、嵌入、打包、分发、销售**未修改**的副本，须显著告知并保留版权与许可；**禁止修改**；禁止单独分发字体文件；许可可撤销，违约即终止。TTF→WOFF2 转换（及子集化）属于修改或至少不明确，且字体嵌入标志为 no subsetting。按 spec「不清楚 → 分支 B」处理。字体包未下载：华为下载页在本机网络策略下无法直接打开，条款经官方华为开发者论坛与 OpenHarmony `LICENSE_Fonts` 镜像交叉核对 | 界面使用系统字体回退栈（`PingFang SC`、`Noto Sans SC`、`Microsoft YaHei`），不随包分发 HarmonyOS Sans，也不从 CDN 加载 | 华为书面确认可转换/子集化且满足署名要求时再切分支 A | 已按 spec 回退，不阻塞 |
| 68 | 2026-10-31 | P5-T3 剩余真机项 | 第 2/3/4 多天回访、第 11 小凯隔离、第 12 App 删除复验未执行 | 第 1/5/6/7/8/9/10 项用户确认通过；第 12 项 App 设置页已实现（事项/反思/情绪摘要展示与删除，`flutter test` 351、analyze、APK 已安装）；第 2/3/4 首日埋点未形成事项线（`followups` 0），第 11 项小凯被配置版本 2 停用 | 多天连续性、角色隔离和 App 删除未取得设备证据 | 下一次真机 session：完成第 2/3/4 第二天回访、后台启用小凯后验第 11 项、有事项线后在设置页删除并复验第 12 项 | 用户跳过（2026-10-31） |
| 69 | 2026-10-31 | P5-T4 盲测 | 需要 3–5 位测试者给基线 vs 新版本 A/B 转写稿打分；隐私规则不允许真实对话或音频 | 未生成 A/B 材料，未找测试者；P5-T2 共情与 plan-a 已通过 | 无真人盲测证据，P5 结论仅基于模型评委 | 用户提供 3–5 位测试者后生成 A/B 转写稿与评分表，收集分数 | 用户跳过（2026-10-31） |
| 70 | 2026-10-31 | P5-T3 不编号项：60 分钟休息提醒 | 需要一次 ≥60 分钟连续通话，本次未做 | 用户确认的其余同日项通过；身份提示与固定话术重复未单列 | 长通话休息提醒未取得设备证据 | 一次 ≥60 分钟真机通话并记录提醒 | 用户跳过（2026-10-31） |
| 71 | 2026-10-31 | P5-T1 Q20 旅程门槛 | 未过 Q20：连续性最高 3.59（原门槛 4.15），共情 4.18–4.35 低于 4.41，第 3 轮另有 1 次编造 | 用户 2026-10-31 决定连续性改为「不倒退」（基线 −0.2）并继续 P5-T2；P5-T2 共情与 plan-a 通过；新口径下仍未全过（共情/编造） | P5 没有 `pass:true`；结论依赖用户决定与 P5-T2 分项评估 | 后续若要严格 Q20，另立计划针对共情/编造调参或改设计；当前口径见 spec | 用户决定接受（2026-10-31） |
| 72 | 2026-10-31 | 实时模型切换 T8：真机 App 冒烟 | 真机切换 3.1 后最初所有问候/回复都返回 `InternalError`，0 字、0 音频 | 定位到 3.1 要求每个 tool 的 `parameters` 带 `required`；适配器 `toQwenTool` 归一化后真机问候/回复正常，用户确认可用；`usage_events` 模型为 `qwen-audio-3.1-realtime-flash`；工具轮/打断/三语未逐项复验 | 细项（工具回执、打断、三语）仍未取得设备证据 | 用户按完整清单复验：触发一次工具、打断一次、zh/ja/en 各一句；切回 3.8 复查 | 部分解除（用户确认基本可用，2026-10-31） |
| 73 | 2026-10-31 | 实时模型切换 T8：3.1 音色试听 | 候选音色只验证了「能出声」，未听音质、性别和多语种自然度；`xunanchuan_v3.1` 仅为男声候选 | 用户在小暖 zh 上听过 3.1 后确认可用；其他角色/语言未逐项试听 | 其他角色/语言的音色映射仍未听；默认已切到 3.1 | 逐角色/语言试听；不通过则替换 `config/realtime.json` 候选后再试 | 部分解除（小暖 zh 用户确认，2026-10-31） |
| 74 | 2026-10-31 | 实时模型切换 T8：3.1 输出上限 | `max_response_output_tokens: 16` 在 `session.updated` 未回显，回复仍为 113 字；当前 `pacing.output.maxTokens` 为 null，默认配置不会发送该字段 | raw WS 实测 `{"echoed":null,"transcriptChars":113,"audioBytes":1194240,"status":"completed"}`；3.1 默认配置暂不受影响 | 若将来配置 maxTokens，3.1 回复长度/成本上限可能失效 | 找到 3.1 支持的限长方式，或实现应用侧/字幕侧截断并复测 | 未解除（2026-10-31） |
| 75 | 2026-10-31 | 实时模型切换：affect 文本模型超时 | 真机 3.1 会话中 09:36:56/09:37:12 两次 `affect_timeout`（2503/2504 ms），09:37:24 一次 `invalid`（2406 ms） | 用同一 affect prompt + `qwen-plus` 复测 6 次 991–1176 ms，无错误；线上无 HTTP 错误，两次是客户端 2.5s 预算处中止；`invalid` 是 JSON 解析失败 | affect 卡片未更新时，低情绪语速可能不变化；回复本身不受影响 | 将 `affect.policy.timeoutMs` 提到 4000ms 并复测；`invalid` 单独观察 | 已解除（2026-10-31，timeout 改为 4000；摘要/affect 为异步，不阻塞回复） |
| 76 | 2026-10-31 | 结束对话 UX：真机重开 | 首轮未执行；用户要求后用现有 8787 网关补跑 | 真机小米 22101317C（Android 13，1080×2400）连续 3 次「结束 → 接着聊天」：4 次 `session_ready`（首启 + 3 次重开），无 fail/error/timeout/closed 诊断，app 进程存活；结束后系统麦克风指示消失、重开后恢复；每次重开有 `duix_playback_start/end` 且 `lips=true`；确认框取消、结束卡片、接着聊天均按预期，「换个伙伴」打开设置页；未做人工听音 | 主观音质/垫话自然度未由人耳确认 | 在真机上连续执行 3 次「结束 → 接着聊天」，确认麦克风、播放、垫话正常；失败则记录并回退到整页重建 | 已解除（2026-10-31，真机 3 次通过；听音待用户主观确认） |
| 77 | 2026-10-31 | 字幕代码：Qwen 3.1 文本工具调用 | 真机字幕出现 `[call] set_memory_consent(...)`；网关 `reply_metrics.tool_calls=0`；真机开场仍听到含 `recall` 的代码，说明只丢文本不够 | 客户端 `visibleAssistantLine` 隐藏这类字幕；网关新增 `textGuard`：`Session.textDelta`/`finalize` 丢弃文本工具调用并记 `assistant_tool_syntax`，不写 ledger/transcript、不执行；检测到即 `interrupt.cancelActive('tool_syntax')`，发送 `response.cancelled` 停止已缓冲音频，并通知 Director 按空回合推进；zh/ja/en `consentToolDescription` 明确只在用户表态后调用。`npm test -w gateway` 1474 项、typecheck、真实记忆库召回探针、`flutter test` 363 项通过。重启 8787 后真机 3 次重开：网关日志 2 次 `assistant_tool_syntax`（seq 1/2，chars=1），对应 `reply_chars=0`；客户端未再出现新的 `assistant_code_hidden`；取消改动已上线，待复验音频 | 取消前可能听到极短代码碎片；开场可能短暂沉默；未由人耳确认 | 用户复验开场/对话不再听到代码音频；若仍听到，检查首块音频与文本的到达顺序 | 部分解除（2026-10-31，文本/字幕/ledger + 音频取消已上线；待用户复验） |
| 78 | 2026-10-31 | 动作续答念出动作名 | 用户请求「点点头」后，`perform_action` 已执行（`tool_calls=1`），续答里出现「点头」 | 根因是 `_shared/*/actions.md` 的示例本身在念动作名（「来，挥挥手」「手を振りますね」）。已改 zh/ja/en 的 actions 示例、`performAction.toolDescription` 和 `toolContinueInstruction`：动作名、表情和动作过程都不许说，只接话题；`npm test -w gateway` 1474 项、typecheck、真实记忆库召回探针通过；网关已重启加载新提示 | 提示词约束不保证模型一定遵守；未用真实语音复验；自动文字输入没有复现「点头」请求 | 用户真机说「点点头」，确认只做动作、不念动作名；仍念则增加动作续答过滤或重生成 | 未解除（2026-10-31，prompt 已改，待真机复验） |
| 79 | 2026-10-31 | 模糊回忆「上次的事」找不到 | 用户问「上次的事你还记得吗」，模型调用 `recall_memory`，工具返回空，AI 说「找不到」；数据存在（最后 12 条已结束会话用户消息有 9 条过旧过滤）。修复后真机能召回，但模型未确认就直接展开旧事（用户听感像编造） | 已改：用 `ctx.triggerText` 判定模糊回忆；新增 `recentUserMessagesBySession`，按会话分组、优先最近含 ≥15 字强陈述的会话；过滤空/问句/轻回应/短动作指令；窗口与阈值进入 `gateway/config/memory.json`；新增内容无关 `recall_path` 日志。按用户选择 A 追加确认优先；真机复验发现只问「是这件吗」不带内容、用户无从确认，先改为逐字引用第一条原话再问，用户又反馈太生硬，最终改为**自然改写 + 确认问句**：`recall.md` 新增 `confirm` 模式（沿用 grounding/长度/1.5s 超时，并要求问句结尾），失败回退逐字模板 `recentConfirmText`（含 `{line}`，zod 校验）。`npm test -w gateway` 127 文件 1479 项、typecheck、真实库副本三路径探针（trigger-present 1074ms；late-final 153ms；bare-query 1ms，均 `quotedLines=2`）通过。真机复验又出现「找不到」，日志 `recall_path path=fts trigger=0`：Qwen 先调工具、转写未下发，已修——缺 `triggerText` 时先等本回合终稿（`recallFinalWaitMs` 默认 1000ms），超时才用模型 query，并给 zh 补精确模糊词；网关重启后待真机复验 | 阈值是启发式；真实短陈述可能被跳过；测试话若较长仍可能入选；自然改写只保证至少一个内容 bigram、不保证逐字忠实；等待会增加最多 1s 的召回延迟 | 用户重启会话后再问「上次的事你还记得吗」，应自然说出具体的事并问「是这件事吗」，确认后接着聊；再问「茶叶」确认无幻觉 | 已修复待真机复验（2026-10-31） |

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
- 2026-10-20 工具轮决策：真实探针确认 Seeduplex 对 `response.create` 返回 `unknown event name`，工具结果后不会自动续答。`recall_memory` 因此返回 grounded `spokenText`（用户原话或空结果），网关用 `speech_text_buffer.commit` 直接播报；其他工具仍用 `toolContinueText`。不要把工具续答改回通用兜底文案。
- 2026-10-20 召回边界：候选必须排除当前这句用户提问（标点不敏感）和以问号结尾的旧提问，否则「上次咱们聊过什么」「我说过喜欢喝茶吗」会被当成历史原话播回，形成“您之前说过：上次咱们聊过什么”这种循环，或把「喝茶」这种提问内容说成用户聊过的事。手机复验发现后已修，单元回归覆盖。
- 2026-10-20 开场与连续性：手机复验发现只有称呼时开场规划器会编「您喜欢听京剧」，而且完整快照不带上次用户陈述，导致「上次聊过什么」找不到。已改为：有称呼时开场一律用 `greetingNameTexts` 安全模板（无称呼才让规划器问称呼）；完整快照注入最近已结束会话里的用户陈述；模糊回忆直接引用最近陈述。不要再把有称呼的开场交给模型自由发挥，也不要把提问/否认/轻回应当陈述。
- 2026-10-21 回忆问句与规划器编造：`上次聊到哪儿了。` 没有问号，旧过滤没拦住，被当成历史原话；用户问“上次聊到哪/聊电影了吗”后，沉默规划器自己编《庐山恋》《城南旧事》《小城之春》并说成用户提过。已修：`recallSkipPatterns` 增加无问号回忆问句模式；沉默规划器照常运行，但提示词禁止补充输入里没有的具体人名/作品名/地名，回忆问句只轻轻接一句或问想聊什么；规划失败才用配置文案。单元回归与真实库验证覆盖。
- 2026-10-21 召回表达：逐字播报用户原话太机械。已加 `roles/_shared/recall.md` 包装提示词，命中后由文本模型生成 1–2 句自然口语；只许使用原话已有事实，新增 `《作品名》` 或丢失原话关键词即拒绝，超时/失败退回逐字原话。真实模型探针与单元回归覆盖。

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

## 2026-10-19 Seeduplex 日语能力

- 按 grilling 共享理解做音色表核查：端到端路径（Seeduplex 3.0 + 旧 RealtimeAPI 音色清单）仅见 `zh_*` / `en_*`（及中文克隆），无 `ja_*`；方言参数仅中文方言。
- 按 Q9 直接记 FAIL，未用中文音色硬试日语（避免假阳性）。详情：`docs/research/seeduplex-japanese-probe.md`。
- 影响：日语产品不走 `ADAPTER=seeduplex`。解除条件：换适配器/级联方案获批准并探针通过，或厂商日后提供日语端到端音色并复测通过。

## 2026-10-20 主动三段式接话回归（本地修复，待手机复验）

- 复现根因在未提交的 Director 改动：`fire()` 对 `context/check/leave` 三个阶段都调用 `planContext(step)`；规划器在 `speak:false`、超时、无效 JSON、输入不完整或未配置时返回 `null`，`planContext` 随后只推进 `next` 并重新计时，不排队任何语音，所以三段主动追问会全部消失。
- 第二个状态缺口是规划器有内容时始终写入 `pending = 'context'`，即使当前阶段是 `check` 或 `leave`；播放结束后 Director 会把它误判为第一阶段并重新排 `check`，阶段状态无法可靠推进。
- 本地修复：Director 为 `context/check/leave` 传递当前阶段；规划器返回空值或失败时只跳过当前阶段并继续下一段，成功时保留当前 `pending` 阶段；取消、过期结果、安静/打断/暂停/停止门控保持有效。Seeduplex 主动回复提交 `instruction`，由上游按上下文生成，不再直接提交 `fallbackText`。
- 验证：`npm test -w gateway` 通过（39 个测试文件、436 项），`npm run typecheck -w gateway` 通过，`git diff --check` 通过。未重启网关、未安装 APK；当前运行网关版本和手机听感仍未验证。

## 2026-10-19/20 slim-rebuild 计划执行：子代理额度耗尽

- 计划 `docs/superpowers/plans/2026-10-19-slim-rebuild.md` 按 subagent-driven-development 执行，工作树 `.worktrees/slim-rebuild`（分支 `feat/slim-rebuild`）。
- Task 1（`69e2d7d`）与 Task 2（`1382089`）已完成并通过任务复查。
- Task 3 派发三次（composer-2.5-fast、deepseek-ai/DeepSeek-V4.1-Flash、inherit）均被账号级限流拒绝：`User Provided API Key Rate Limit Exceeded`。另有一次 reviewer 返回 `Weekly usage limit reached. It resets in 2 days.`
- 手动验证：工作树 `git status --porcelain` 为空，HEAD 停在 `1382089`，Task 3 无任何改动落盘；主工作区无相关残留。
- 跳过的影响：Task 3–6（摘要语言、会话接线、客户端感知、路线图）未实现；Task 1–2 的代码已在分支上，未合并。
- 解除条件：额度恢复后继续按计划派发，或经用户同意改为其它执行方式。
- 2026-10-21 更新：额度恢复后计划已继续执行，Task 1–5 均已落地（`69e2d7d`、`1382089`、`ef889a9`、`d0e1994`、`581d7e0` 等），Task 6 的路线图说明见 `docs/project/roadmap.md` 文首；本阻塞已解除。

## 2026-10-21 M2 多语言状态

- M2 的 ja/en 内容包、`gateway/config/i18n/*` 与记忆/安全/情绪/沉默本地化已通过单元/合成验证（gateway 45 个测试文件、632 项通过、无 expected fail；typecheck、Flutter 182 项、中文回归 218 项通过；`--temp` 召回探针 78 项断言通过）。Seeduplex 日语仍无能力（#46），真机未验收；真实记忆库只读探针已跑通（预 M2 schema 缺 `meta` 表时走同 SQL 的只读 fallback，不迁移、不写入），三个查询 `hits` 依次为 true/true/false、`evidenceCount` 为 2/2/0、`newTitleFlag` 均为 false。第三个查询此前误命中无关陈述，已用按语言的 `recall.queryFramePatterns` 在 FTS 前剥离第一人称转述框架修复（覆盖问句前缀、英文间接宾语 `that` 与前导空白；`--temp` 覆盖否定句/轻回应不作为证据）；最终复查又修 en 模糊回忆归一化、静默/告知短语大小写与词边界、en 包装词元门槛、zh 填充词/「我记得」前缀、en/ja checkin 长度与 `variationHintLabel` 本地化；详见 `docs/project/roadmap.md` 文首。
- 2026-10-21 M2 closeout：A1–A8 修复已通过 gateway 45/647、typecheck、Flutter 182、根 `npm test` 6/647/114+5、`--temp` 130、Mock smoke；真实库探针扩展为 7 条只读查询（zh 三条 true/true/false；en/ja 诊断行不要求命中，仍未打印正文）。#45/#46 不解除；真实库未迁移、未写入；8787 与真机未操作。

## 2026-10-28 P3-T3 Mock smoke 预设断言过期（与本任务无关）

- `node --import tsx docs/testing/plan3-mock-smoke.mjs` 失败于脚本第 80 行 `assert(logs.includes('"event":"orphan_cleanup_batch","deleted":0'))`。实际日志为 `{"event":"orphan_cleanup_batch","job":"orphan_cleanup","deleted":0,...}`：P1 日志迁移给 cleanup 子 logger 加了 `job` 绑定，脚本断言未同步。
- 在 pristine HEAD `54f1198` 的独立 worktree 运行同一脚本，结果相同（`passed:false`，同一断言）。与本任务改动无关。
- 影响：Mock smoke 的 identity 分支在 HTTP 身份检查通过后中断，其后的 WS/记忆检查未运行；本任务用全量测试和其它 Step 12 探针覆盖。解除条件：后续任务更新该断言（不在 P3-T3 范围）。
- 临时修正第一条断言后，脚本第 83 行 `assert.equal(style.status, 200)` 仍失败：`PATCH /agent/style` 返回 404。HEAD 同样失败；该端点已按测试 `gateway/test/identity-http.test.ts:171`（no longer serves PATCH /agent/style）移除，smoke 未同步。故 smoke 的 identity WS 流程整体不可用，直到脚本更新。

## 2026-10-28 P3-T3 真实记忆库探针：实机库仍为 v6

- 实机 `/Users/jed/.avatar/memory.db` 的 `PRAGMA user_version = 6`；`owners` 表没有 v7 的 `banned_at` 列。当前 v7 `SqliteMemoryStore` 在只读构造阶段即失败，探针按设计输出 `NOT RUN db_schema_incompatible`。
- 因此 P3-T10 任务书的前置假设「计划 1 已把真实库升级到 v7」在实机不成立；P3-T10 开始前必须先在用户确认下做 WAL 安全的备份并迁移。不能用裸 `cp` 主库：当前 `memory.db-wal` 约 449 KB，裸拷贝会丢最新消息；应使用 SQLite 的 `.backup`/`VACUUM INTO` 或先 checkpoint 的在线备份。
- 2026-10-28 P3-T3 的安全替代验证（不改线上库）：对实机库做临时 SQLite `.backup`，只把副本迁移到 v7，再用 `plan3-multilingual-recall-probe.mjs --real-db` 只读运行。结果：xiaonuan/xiaokai/xiaoxin 三个角色均为「上次聊到哪儿了」`hits:true`、「上次聊过电影吗」`hits:true`、「我说过喜欢喝茶吗」`hits:false`，`newTitleFlag` 全为 false。临时副本已删除；线上库仍为 v6，`.bak-v6` 未动。
- 2026-10-28 P3-T10 已解除：经用户确认，先停 8787 网关，用 SQLite `.backup` 生成包含 WAL 的 `memory.db.bak-v6-20261028`（校验 v6、owners 1/agents 3/sessions 12/messages 60），再迁移线上库到 v7；重启网关后 8787 正常监听。真实召回探针已在 v7 线上库只读通过（三个角色 true/true/false，`newTitleFlag` 全 false）。旧 `.bak-v6` 保留。

## 2026-10-28 P4-T4 真机验收的本地身份副作用

- 手机验收使用临时 Mock 库；App 在临时库注册了新 owner，并把本机 `device_token` 覆盖为临时库 token。旧线上 owner 的 token 在本机已丢失，无法恢复。
- 按用户确认切回线上 8787 后，App 会注册一个新的线上 owner；旧线上 owner 及其记忆仍保留在真实库，但不会自动接到新 owner（blockers #65 的 401 拆分类别）。用户已接受；不删除真实库数据。
- C4（置灰 24 小时到期恢复）未等待：测试机小暖保持置灰约 24 小时后自动恢复；临时网关/后台/临时库已清理，线上 8787 未被改动。

## 2026-10-29 P3-T7 真机沉默日志未做

- Step 6（真机沉默，核对 3 秒兜底是否在用户开口前说出，以及 `response.created` 是否把窗口内的另一条 followup 算成引擎那句）跳过：用户确认了停网关、备份和重启，当时不在手机旁。
- 网关已重新监听，`healthz` 200。备份后缀 `.bak-v7-20261029`，源库和备份当时都已是 `user_version` 8。没有改代码。
- 旅程评测未过 P3 不退步门槛（编造 2、共情低于基线）。记录在 `docs/testing/2026-10-29-p3-silence-engine-acceptance.md`。当时 P4-T1 未开始。2026-10-30 用户要求继续后，P4 代码已提交；P4 旅程门槛见当日验收记录。

## 2026-10-30 P4-T7 真机开场未做

- Step 6（八项真机开场：称呼、只提一件事、健康类兜底、打断重说、不知称呼、ja/en 配置指令、告别不挽留、要求少说后降档）跳过：用户在对话里，不在手机旁。没有重启 8787。
- 旅程评测未过 P4 门槛（共情 4.24，基线 4.41）。编造 0、挽留 0、不打扰 4.82。没有改代码。记录在 `docs/testing/2026-10-30-p4-opening-acceptance.md`。P5-T1 未开始。

## 2026-10-30 Web 真人说话头 spike：用户前置未就位

- 计划 `docs/superpowers/plans/2026-10-30-web-photoreal-demo/` 的 T1b 需要 `build/photoreal/wav2lip_gan.pth`（Wav2Lip GAN 官方 checkpoint，仅研究用）。worktree `.worktrees/photoreal-spike` 下缺失，因此 ONNX、frames/faces、`manifest.json`、`speech-24k.pcm`、mel filterbank/fixture 和资产 lock 都未生成。
- 目标机只装了 Safari；ORT WebGPU 只支持桌面 Chrome/Edge。T1a 只用 `curl` 验证了页面 HTML 与模块转换，WebGPU、S1–S5 和 T7 基准都未验证。
- 解除条件：用户手动下载 checkpoint 到 `build/photoreal/wav2lip_gan.pth`，并安装 Chrome/Edge；之后继续 T1b，再跑 T3/T5/T7。

## 2026-10-30 Web 真人说话头 T8 盲测待用户

- T7 的 S1–S5 全过（报告 `docs/testing/2026-10-30-web-photoreal-spike.md`），按计划进入 T8。
- 阻塞：T8 需要用户用 Android 真机录一段 Duix Lily 回复、Web 端录屏，并由 3–5 名评审做盲测；这些项目前无法由代理完成。实现与 S1–S5 结果已合并到 `master`（原分支 `photoreal-spike`）。
- 解除条件：用户提供两段录屏与盲测评分；之后把结果写进 T8 报告、研究文档结论与 roadmap。

## 2026-10-31 主动话题问句：召回探针在 HEAD 已失败（与本次无关）

- `node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --temp` 在当前 HEAD（`d6d688a`，用户 2026-10-31 的 vague-recall 提交）失败于 `zh_vague_recent_only`。同一脚本在 HEAD~1（`a431aa3`）的独立 worktree 通过 `{"mode":"temp","checks":133,"ok":true}`；HEAD 不包含本次未提交改动，结果相同。说明失败由 `d6d688a` 的 vague-recall 改动引入，不是本次主动话题问句实现。
- 本次实现后的 gateway 全量 128 文件/1510 项、`npm run typecheck -w gateway`、protocol 3/16 + typecheck、admin 24/132 + typecheck + build 均通过；`git diff --check` clean。
- `MEMORY_DB_PATH` 未设置，未跑 `--real-db`；真实库迁移 v9 和真机 7 项未做。
- 解除条件：先修复/回滚 `d6d688a` 的 vague recall，使 `--temp` 探针恢复；再在有真实库的机器上备份、迁移 v9、跑 `--real-db`，并在用户在场时做真机验收。

## 2026-10-31 主动话题真机：换个话题待下一轮会话

- 真机记忆问句已通过；“不感兴趣”卡片路径已通过：check `selfShare` 选 `card:walk`，`proactive_topic_declined source=card`，DB `proactive_topic_avoid` 写入 `card:walk`；`owner.notified_at` 已置。
- App 三角色随后都显示离线（`CharacterHolds` + Duix crash guard + 网关 `character_disabled`）。已用 debug 构建 `--dart-define=CLEAR_HOLDS=true` 只清 `character_hold_until.*`/`duix_crash_count`/`duix_inflight`，保留 `device_token`/`character_id`/真实记忆；覆盖安装后小暖已重新进入通话。未直接编辑加密的 FlutterSecureStorage 文件。
- 真机“换个话题”待下一轮会话；单元测试已覆盖。记忆负偏好（`stmt:` key）本轮未真机触发（check 选中的是 `card:walk`），由单元测试覆盖。
- 临时关闭 `routine`/`continueThread` 的测试配置已用 `git checkout` 恢复并重启网关；真实库 v9；备份 `~/.avatar/memory.db.bak-v8-20261031-topicq`；`proactive_topic_avoid` 有 1 行 `card:walk`。
