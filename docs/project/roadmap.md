# Roadmap

Last updated: 2026-10-20. 定期静默重建尚未实现，计划在 `docs/superpowers/plans/2026-10-19-slim-rebuild.md`，未批准执行。垫话仍然关闭。#43 的主动链已在 2026-10-20 完成三轮修正，当前为四段式：context/check/leave/checkin 分别约 6/8/10/10 秒；前三段由共享文本模型按阶段生成与上下文相关的主动接话（带前文去重和明确收尾判定），失败时回退配置文案；第四段固定使用配置文案，客气确认用户是否还在听并说明随时可以接着聊（第四轮真机反馈后不再经过接话规划器）。Qwen 与 Seeduplex 共用同一 Director 行为（详见下文）。客户端在每轮回复起播前先缓冲约 1 秒音频（最多等 1.2 秒），压住 Seeduplex 首块音频后的上游顿挫。2026-10-20 手机首句播报完整提示词的问题已定位并修复：Seeduplex 的 `speech_text_buffer.commit` 是直接 TTS，主动响应只能提交 `fallbackText`；提交 `instruction` 的路径已回退，真机首句恢复为短问候，用户已确认首句正常、不再念提示词。Barge-in 现有回归保持通过，读取本节后的打断与沉默坑位再改动。

## 打断与沉默：已踩过的坑

后面改话术、沉默节奏或打断时先读这里。不要为了新文案去改这些机制。

1. 用户正常说话由 Qwen 服务端 VAD 判轮。本地能量 VAD 没响时，不要取消已经开始的回复。这样改过一次，结果整段对话不理人。
2. 垫话保持关闭（`fillersEnabled` 为 false）。「我想想」「稍等」的占位音色不对，而且卡。音色和卡顿没解决之前不要再播。
3. Qwen 的主动指令是 item 模式，整段 instruction 会当成用户消息送进模型。不要在指令里放可以照读的例句。否定句里如果还含着那几个字，模型也会照读。不要把助手自己上一句当成用户说的事。`{utterance}` 只替换用户自己的话。轻声答应（嗯、我知道了这一类）整句才算轻回应，句子里带一个轻词仍是新内容。
4. 「我在」只作为内容步在模型失败时的兜底，不是开场，不是第二句，也不是误打断之后的接话。
5. 打断时必须在上一句还开着的时候把声音送上去，并带上本地 VAD 确认前大约 150ms 的开头，否则短词只剩后半截。攒到 `response.cancel` 之后再送，缓冲区会被清掉：第一下可能碰巧接上，后面几次都听不见，然后一直说没听清。
6. 已经 `response_end` 的回复不要再发 `response.cancel`。打断过程中不要 `session.update` 刷新指令。这两下都会把服务端正在听的声音丢掉。
7. 给模型看的指令和账本里不要写「被用户打断」。模型会把它读出来。截断只留在内部。
8. 本地 VAD 的 speaking 要在等待停播之前发出。停播期间已经静音，就不要再补一条 speaking。没有 speaking 边沿的误切，才把同一句沉默步重新排上。真打断之后不要把被打断的那句补完。
9. 咳嗽、喷嚏、滴一声会触发本地 VAD 并停播，但不是完整的话。大约 2.5 秒后如果没有形成回复，只说「没听清，您再说一遍。」不要说「我在」，不要接被打断的内容。真回复一旦开始，这句必须取消。
10. 跨会话记忆代码已合并，Mock 进程验收见下文；真实二次通话尚未验收。没有记忆快照时，开场是自我介绍并问称呼，不要假装记得上次。
11. 启动网关时用 `app/dev.json` 的 `APP_SECRET` 覆盖进程环境。不要改 `.env`，不要把密钥写进日志或提交。

下面「Next steps」第 1 条里「播放期间完全不上传麦克风」已过时。本地 VAD 认定在插话之后要继续上传。

## 沉默话术（2026-10-18）

已写进 `director.json`，规格见陪伴记忆设计第 2 节。三档等待是 3 秒、12 秒、12 秒。这一版拿去给用户试，正式逐句验收还没做。

1. 「您还方便吗」后面加一句当时的上下文。没聊起来时是称呼；有记忆但这次还没说话时不编具体的事；用户说过话时第二句只点 `{utterance}`。指令里不要再放第二句的例句。
2. 短沉默说「我先安静一会儿，想聊随时喊我。」再安静 3 分钟说「你可以先自己放空一会儿，不用急着回我。」然后停。短离开之后的轻声不立刻再开口，安静满 3 分钟仍说更松的那句。不要把旧的等待句写回指令，否定句里夹着那句也会被照读。

## Phases

| Phase | Scope | Status | Plan |
|---|---|---|---|
| Plan 1 | Mock-driven end-to-end on a Xiaomi phone: greeting, multi-turn, barge-in with zero residue, 5 actions, reconnect, Day 1 audio A/B spike | **Complete with blockers.** Code Tasks 0–17 implemented, reviewed and merged on `master`; Task 18 checklist/report written but every device/browser item is "not run". Not demonstrated on a device. | [plan1](../superpowers/plans/2026-10-12-avatar-poc-plan1/00-overview.md) |
| Plan 1.1 | Flutter 原生采集/播放/VAD/网关会话，WebView 头像和界面 | **代码已合并至 `master`；小米启动冒烟和 30 分钟稳定性采样完成，完整真机验收延期，待本地后续任务完成后统一执行。** | [native-audio-path](../superpowers/plans/2026-10-13-native-audio-path-plan.md) |
| Plan 2 | Real adapters (Seeduplex/Qwen), LlmSummarizer, persona/Director tuning, cloud deploy (WSS), release APK, Day 6 device report | **In progress: local gateway-first debugging is now the active path. Seeduplex/Qwen adapters, Qwen-compatible summarizer, local integration, and live Seeduplex/Qwen/text smoke are implemented; debug APK installation and local phone connection are verified; full phone acceptance remains open. Cloud deployment is explicitly deferred until phone debugging is complete.** | [seeduplex-plan2](../superpowers/plans/2026-10-14-seeduplex-plan2.md) |
| Plan 3 | Companionship, memory and agent binding: A persona & pacing, B device identity & binding, C memory MVP, D proactivity & activities, S backchannel/Seeduplex spike | **Spec v4 approved 2026-10-17; plans written for Task 0, A1, A2, B and the A+B merge (`docs/superpowers/plans/2026-10-17-plan3-*.md`). Task 0 complete (gateway contract refactors, commits 349bdb0..1fc7ed1 plus the docs commit): at that time `npm test` passed (protocol 6, gateway 143, avatar-core 91) and `npm run typecheck` was clean; the live Mock smoke on port 8797 passed on 2026-10-18 (#11). Plan A (A1 gateway persona/pacing/metrics + A2 client thinking state) code complete; NOT RUN (user instruction: Mock only): Qwen probes (#12), latency baseline values in `docs/testing/plan-a-latency-baseline.md` (#13), real-Qwen eval for grandchild and old-friend so no question-ratio or reply-length results exist (#15), and Plan A device acceptance (#18, #20-#25; report with NOT RUN rows: `docs/testing/2026-10-17-plan-a-device-report.md`). Open before shipping: hotline number unverified (#16), both styles `"voice": null` (#17), filler clips are macOS `say` placeholders whose voice differs from the reply voice (#19). Plan B (device identity & binding) code complete; device acceptance, Keystore check NOT RUN (#30, #32-#37); live Mock process smoke passed on 2026-10-18 (#31). A and B are merged into master (Plan B first, then Plan A) with style-aware filler clips (the app picks clips by the agent's saved style). A+B device gate NOT RUN (#38 build/install/run, #39 style-switch procedure; the new-voice check cannot pass until #17 and #19 are resolved). Current master suite (run 2026-10-17): `npm test` passed (protocol 6, gateway 271, avatar-core 96), `npm run typecheck` clean, `flutter test` 144 passed, `flutter analyze` no issues. Plan C (memory MVP) code is merged; remaining external gates are listed below. Order: Task 0 → A (A1→A2) ∥ B → A+B merge → C → D; S independent. Plan C is written; plans D/S are not yet written. 2026-10-18: the in-session silence machine in spec §2 is implemented in the gateway Director. A phone session showed a followup cut off by a local cancel with no speaking edge, after which the chain never restarted; interrupted playback now rearms that same step when the user is quiet. A barge-in that goes quiet before the cancel no longer clears the skip-filler mark. User-confirmed device acceptance is not done. The admin page that edits it is a later plan and is not started: [config-admin-later](../superpowers/plans/2026-10-18-config-admin-later.md). Assumption 7 (qwen-plus) verified on 2026-10-18 with the real text client and temporary SQLite; see the live extraction record below. Plan C unit acceptance passed (`npm test -w gateway -- test/memory-acceptance.test.ts`; `npm test -w gateway && npm run typecheck -w gateway`). Real qwen-plus extraction and persisted second-session instruction snapshots passed on synthetic input; phone addressing recall is user-confirmed, while recent-topic continuity failed and remains open (#42). Assumption 8 (on-device tool turn) NOT RUN. A real second phone conversation partially verified by user: addressing recall passed; recent-topic continuity failed and repetitive followups were reported. See the investigation record below.** | [companionship-memory-design](../superpowers/specs/2026-10-17-companionship-memory-design.md) |

Design: [avatar-voice-poc-design](../superpowers/specs/2026-10-12-avatar-voice-poc-design.md).

## What is and is not verified (2026-10-13)

- Verified after the Plan 1.1 merge on `master`: `npm test` → protocol 6, gateway 93, avatar-core 74 passed; `npm run typecheck` clean; `cd app && flutter test` → 36 passed; `flutter analyze` → no issues.
- Gateway-level headless check (Task 18, not a checklist pass): greeting, keyword actions once each, silence follow-ups (~8.4 s / ~25.3 s after `playback.stopped(ended)`), gateway logs contain no conversation text.
- 【模拟器】 only: Task 16 capability probe on Medium_Phone_API_36.1 (WebView 134, 8/8) and API31_Phone (WebView 91, below the ≥120 bar); release APK cleartext to 127.0.0.1 OK; autoplay `running` without gesture (no audible check). Emulator results are NOT phone results.
- NOT verified for the original Plan 1 A path: full desktop Chrome E2E (Task 14 Step 7), Task 18 checklist, WebView mic/VAD capture, AudioWorklet playback, lip-sync, barge-in latency, frame rate, and 30-minute stability. No constants were tuned. ADR-001 (audio path A vs B) is a **DRAFT, undecided**; no A/B measurements exist.
- Plan 1.1 Xiaomi 22101317C: WebView 104 loaded the avatar and Mock greeting, native `AudioRecord` was confirmed at 16 kHz mono with foreground microphone permission, and one `wave` debug action was visually observed. A 30-minute stability sample completed (31 points, renderer alive 31/31; PSS/RSS and 34.0°C recorded). Real speech/VAD, audible confirmation, full action matrix, active-response resume, reliable 10-minute false-trigger count, and 10 true interruptions remain unverified. See [native audio report](../testing/2026-10-13-native-audio-plan1-1-report.md).
- 2026-10-13 hardening pass: native session startup can retry after partial failure; native response setup/audio delivery is serialized; playback feed failures terminate the active response with an error event; HTTP/WS operations have bounded timeouts; gateway adapter startup is bounded by configurable `SESSION_START_TIMEOUT_MS` and does not announce `session.ready` before success; native avatar visibility listeners are released on stop. Regression coverage is included in the gateway, avatar-core, and Flutter suites.
- Hardening validation: `npm test` passed (protocol 6, gateway 95, avatar-core 75); `npm run typecheck`, `cd app && flutter test` (40), `flutter analyze`, `./scripts/build-web.sh`, and `flutter build apk --debug --dart-define-from-file=dev.json` all passed. The generated Web bundle is intentionally ignored under `app/assets/web/`.
- 2026-10-14 local hardening: WebView `GatewayClient` now guards malformed/stale socket messages, makes `close()` idempotent, bounds HTTP and WebSocket setup, and aborts timed-out requests. Focused `avatar-core` GatewayClient tests passed (16).
- 2026-10-14 local hardening continued: `ActionPlayer.stopAll()` now invalidates in-flight wave probes, cancels nod/turn RAF callbacks, and clears smile timers before stopping TalkingHead playback. Regression coverage passed in `avatar-core` actions tests; full `npm test` passed (protocol 6, gateway 95, avatar-core 84) and `npm run typecheck` passed.
- 2026-10-14 device acceptance decision: real voice/VAD interruption, audible playback, active-response resume, network recovery, and stability sampling are explicitly deferred; they remain open in `docs/blockers.md` and will be run together after local follow-up work.
- 2026-10-14 phase transition: by user decision, Phase 1 is marked complete and Plan 2 may begin before the empirical ADR-001 A/B measurement. This is a scheduling decision, not an A/B result; the measurement remains an explicit Plan 2 follow-up.
- Known environment limits: Plan 1's 2 GB AVD renderer kill during Silero VAD load remains unresolved for path A; Plan 1.1 does not load Silero in the product path.

## Plan 1 acceptance (from the plan overview) — status

Greets on open (gateway side ✓ headless; product page ✗); scripted multi-turn with subtitles (✗ device); local-VAD barge-in leaves no stale audio/subtitle (logic covered by unit tests incl. AppController fakes; device ✗); 5 actions tool+keyword deduped (gateway ✓; Xiaomi visual ✓ with Chinese keyword inputs); short reconnect resumes / long reconnect starts new session (unit + client tests ✓; Xiaomi long-disconnect session expiry/new-session ✓; active playback ✗); Ledger/summary/session rebuild covered by automated tests ✓; Task 16 probe ran on-device with version/audio caveats; Spike A smoke failed before counters; audio A/B and ADR-001 decision remain open.

## Cross-phase dependencies

Plan 2 entry conditions:
- **Satisfied / provided by user decision:** Phase 1 is closed for scheduling purposes; the empirical ADR-001 A/B measurement is deferred.
- A model Key must be verified against the official protocol before enabling a real adapter in runtime.
- Plan 1 contracts stay frozen: `protocol`, `RealtimeAdapter`/`MockScript`, HTTP/WS, Bridge. (Post-review fixes only re-send existing messages; no shape changed. New values: Bridge error codes `bad_config`/`bad_message`, status `audio_suspended`.)

## Blockers

See [docs/blockers.md](../blockers.md): #1/#3/#6/#7 are partially relieved by the Plan 1.1 device smoke; #2 desktop Chrome E2E and #4 A/B measurement remain open.

## Next steps

0. Plan 3: Task 0、A1、B 的 8797 Mock 进程冒烟已通过（#11、#14、#31 已解除）；Plan C 的本地记忆门控、持久化快照、Mock 工具续答及 qwen-plus 真实提取（假设 7）已验证，记录见下文。2026-10-18 用户同意后，手机启动前置完成（#41 已解除）：保留原身份库，补齐文本端点并重启 8787，手机已解析原身份并收到开场。用户已确认真实第二次通话能记住称呼，但近期话题接续失败且接话重复。用户已批准 Plan C Task 12 的定向修正（#42）；最近会话摘要、OR 回忆检索和防重复接话指令已实现，单元回归、四场景合成真实模型逐句复核与独立审查已通过，用户随后已确认重启；8787 新版 Qwen 网关与原身份手机会话已启动，用户随后确认不再重复，但沉默主动话语缺少上下文。#43 的本地修复已完成：三段规划按当前阶段推进，规划失败跳过当前段，Seeduplex 使用 instruction；gateway 全量回归 436 项、typecheck 和 diff 检查通过，待手机听感复验。近期话题接续仍未获用户确认；假设 8 仍无真机工具调用证据。后续重启 8787 仍须先征得用户同意。Plan A/B/A+B 的其他设备项仍未完成（#12–#25，排除已解除的 #14；#30、#32–#39）；本次启动不替代它们的完整清单。A+B 新音色门槛依赖 #17 和 #19；Plan D/S 尚无已批准实施计划。
1. Keep the local Qwen gateway running for phone debugging (`ADAPTER=qwen` on port 8787, phone `APP_SECRET` from `app/dev.json`, `adb reverse tcp:8787`). Once local VAD says the user is barging in, mic audio streams while the reply is still open; do not restore the old full-playback drop. See the pitfalls section above. Silence follow-ups stay paused while the user is actually speaking. Local barge-in uses RMS 200 after 400 ms of playback; idle speech stays at RMS 1200. At 20:04 the user confirmed the conversation was fluent. At 20:08 avatar actions worked after gestures were no longer cancelled on `response.end`. Do not restart it as Mock. Do not resume interruption latency percentiles or multi-attempt interruption counts: the user skipped both on 2026-10-16, and that skip is not a pass. The 10-minute silence sample stays skipped as well. The latest interrupt rebuild is installed, but the user has not yet confirmed that a live shout stops playback.
2. Continue the remaining Xiaomi/desktop checks that were not skipped: active-response stale-audio listening, network cases beyond the 2026-10-16 short resume and grace expiry, subtitle finalization once, remaining Task 18 checks, ADR-001, and desktop Chrome E2E. Five actions were already observed with Chinese keywords. Cloud WSS stays deferred.
3. Seeduplex protocol docs and successful key validation are recorded in `docs/research/seeduplex-protocol-validation.md`; `ADAPTER=mock` remains the default, while `ADAPTER=seeduplex` requires an explicit environment key. Complete ADR-001 A/B measurement as a tracked follow-up.
4. Only after phone debugging and its evidence are complete, resume the cloud WSS deployment plan.
5. Section 8.1 renderer: idle 30 fps, speaking/actions 60 fps, shadow map forced off, turn pulls the half-body camera back and restores it. The Day-1 avatar is the gitignored Avaturn T2 GLB. Resting mood is happy with a fixed smile (`mouthSmile` 0.45) and `eyesLookDown` baseline 0. Assistant subtitles drive the mouth one character every 180 ms; microphone levels no longer move the mouth. File check remains 52/52 ARKit morphs, Mixamo bones, 35,469 triangles, textures ≤1024. Phone frame rate is not measured.

## Mock 进程验收（2026-10-18）

- `npm test && npm run typecheck`：protocol 6、gateway 394、avatar-core 96 全部通过，类型检查通过。`npm test -w gateway -- test/memory-acceptance.test.ts`：2 项通过。
- `node --import tsx docs/testing/plan3-mock-smoke.mjs`：顺序启动两个 8797 Mock 进程（identity off / on），显式禁用真实模型客户端。HTTP、身份、权限与日志检查的结果见 blockers #11、#14、#31。
- WebSocket 使用合成输入及模拟播放确认：告知确认前写入为 0；确认后写入；同设备在旧会话仍存在时重新创建会话，触发 `owner_replaced` 并 flush；同一 SQLite 的未提取尾部进入 `snapshotRows` / `renderSnapshot`。动作去重后只发一次，工具调用指标为 1，续答结束。日志未包含检查的合成输入、回复正文或 token。
- 进程均正常退出，临时数据库已删除。8787、手机和真实模型均未操作；未重新采集用户跳过的打断或静默样本。该 Mock 验收当时未覆盖假设 7/8、真实口头回忆或真实首次回复延迟；假设 7 的后续结果见下文，真机二次通话仍 NOT RUN。

## qwen-plus 真实提取验收（2026-10-18）

- Assumption 7 (qwen-plus) verified on 2026-10-18。使用本地已有 Key；文本端点按已核对的同 workspace 北京域名格式派生，仅用于探针，没有写入 `.env` 或读取实际用户记忆。
- 首次手动 curl 返回 HTTP 200，但 JSON 未通过 `parseExtractOps`。真实客户端探针复现 `extract_parse`，2 条消息 extracted=0、facts=0。修复共享提取提示词，补全扁平操作字段及类型，并明确用户希望被叫的称呼归入 addressing。中间一次返回虽可写入，但称呼误归类，探针仍判失败；没有放宽 schema 或验收条件。
- `node --env-file-if-exists=gateway/.env --import tsx docs/testing/plan3-qwen-memory-probe.mjs`：修复后 PASS；1 次真实调用、返回文本 336 字节，2/2 条消息提取、2 条事实，称呼/偏好各命中 1；关闭并重开同一 SQLite 后，快照与下一会话指令包含记忆，另一 owner 无快照。总耗时 2337 ms 是本次提取探针耗时，不是首次音频延迟。
- 本次先运行 `npm test -w gateway -- test/extract.test.ts test/worker.test.ts test/memory-acceptance.test.ts`（18 通过）和 gateway typecheck；修复后 `npm test && npm run typecheck` 再次通过（protocol 6、gateway 394、avatar-core 96）。探针只用合成文本、模拟告知完成，不存音频、不输出正文，临时库已删除。
- 真实手机工具轮、真实第二次通话、听感和首次音频延迟仍 NOT RUN。Xiaomi 在 adb 中可见，但本次没有安装/启动 App、读取对话日志、重启 8787 或修改 `.env`。手机启动配置前置见 `docs/blockers.md` #41。

## 手机记忆验收启动前置（2026-10-18）

- 用户明确同意启动准备及重启 8787。只读核查发现旧进程已有 `MEMORY_DB_PATH=/Users/jed/.avatar/memory.db`，但没有文本端点；旧库已有 1 个 owner、1 个 agent，尚无 `messages` 表。保留原路径和身份，不创建替代 owner、不清除手机数据。
- 使用现有 Key、已验证同 workspace 文本端点和 `app/dev.json` 的 `APP_SECRET`，仅通过进程环境注入；`ADAPTER=qwen`、端口 8787。不修改 `.env`。网关作为独立后台进程运行，PID 和内容脱敏日志路径分别记录在仓库外 `~/.avatar/runtime/gateway-phone.pid` 和 `gateway-phone-log-path`；日志权限 `0600`。
- 重启后 `/healthz` 为 200；`POST /device/register` 无密钥为 401，手机密钥加无效请求体为 400（只验证鉴权与身份路由，不新增设备）。数据库迁移建立 `messages`、`user_facts` 等表，owner/agent 仍各 1，主库权限 `0600`，`PRAGMA foreign_key_check` 无违规。
- 手机已安装 APK 与本地 debug APK 的 SHA-256 一致，包含身份页/API/安全凭据模块，App 源码修改时间均早于 APK；本次无需重装。`adb reverse tcp:8787 tcp:8787` 和 `adb shell am start -n com.anyidea.avatar_app/.MainActivity` 成功，网关观察到原身份 `device_resolved`（old-friend）、`session_created`、greeting start/end。这是连接证据，听感和记忆告知完成仍须用户反馈。
- 本次重跑 `npm test -w gateway -- test/memory-acceptance.test.ts test/worker.test.ts test/extract.test.ts`：18/18 通过。重跑真实合成探针：1 次调用、202 字节、2/2 消息提取、2 条事实、持久化快照与 owner 隔离通过，耗时 1727 ms；临时库已清理。
- 启动时假设 8 真机工具轮、真实第二次通话口头回忆尚未运行；后续用户反馈见下文。只检查事件/计数与用户听感反馈，不输出或记录对话正文。用户跳过的打断及静默采样保持跳过。

## 二次通话反馈与话题接续排查（2026-10-18）

- 用户确认结束并重新打开 App 后，能正确回忆称呼；但询问上次聊到哪里时无法接续，并反复表达不知道。仅将称呼回忆记为用户确认通过，近期话题与防重复未通过；不写入实际对话正文。
- 只读元信息核查：首轮结束触发 `memory_extract(reason=session_end,result=applied,ops=2,messages=13)`；已保存 1 条 episode。用户所报话题在历史消息与 episode 中均存在（仅输出命中计数）。按生产代码重建的快照长 20 字，未包含所报话题。`DeviceRegistry.resolve` 与 `Session.refreshMemorySnapshot` 都只传 facts/notes/未提取 tail，没有传 episodes。
- 合成内存库复现：提取前 topicInSnapshot=true，写入称呼 fact + episode 并推进 extracted 水位后 topicInSnapshot=false，episodeStored=1。连续关键词检索为 0，分开的关键词为 1；当前 `ftsMatch` 用空格隐式 AND，与设计规定的 OR 不一致。泛问上次话题本身没有可检索的主题词，不能靠 FTS 修复替代快照。
- 第二轮脱敏指标：greeting、reply、followup×3，工具调用总数 0、无模型错误码。结合用户反馈及 Director 指令，重复风险来自沉默步骤持续围绕同一用户问题要求接话；这些计数不证明逐句措辞，逐句表现以用户反馈为准。没有自动重试出错的证据。
- `npm test -w gateway -- test/memory-store.test.ts test/snapshot.test.ts test/director.test.ts test/memory-tools.test.ts test/memory-acceptance.test.ts`：73/73 通过；这是现状基线，尚未修复上述缺口。首个临时复现脚本误传 `recordSessionStart` 参数，纠正为现有签名后复现成功；未修改产品代码或持久用户数据。
- 修正范围及验收条件已列入 Plan C Task 12 的待批准提案。#42 未解除。8787 和手机仍保持运行，本次没有重启、部署或修改角色文案。

## Handed to Plan 2 (accepted minors / hardening, from the final review)

Gateway: wire Task 7/8 tunables (confirmWindowMs, dedupeMs, ledger limits, grace/unclaimed/heartbeat/rate limits) into config; WS Origin check, POST /session rate limit/lockout, session cap, session.start timeout after claim, terminate WS on shutdown; revoke older unclaimed connectTokens on rotation; rebuild backoff and buffering mic audio during rebuild; count superseded replies as false interruptions; Director.resume() rate limit; summarize() backoff; escape persona/ledger text in instructions; loadMockScript validation.
Client/app: GatewayClient (idempotent close, stale-socket guard in onmessage, JSON.parse guard, fetch/WS timeouts, 401 handling, close-code aware reconnect), ActionPlayer.stopAll cancelling in-flight turn/nod, AvatarView dispose, fetch-assets pinning/checksum, LocalAssetServer hardening (control chars, nosniff/CSP, loader error counters), WebView origin checks + `frame-src 'none'`, `allowBackup=false`, limit the root Gradle compileSdk hook to the specific plugin, exclude spike/probe pages from release bundles, widget smoke test for `AvatarApp`, build-web.sh arg whitelist and dev.json secret check, release must use `adb reverse`/127.0.0.1 only.

## Repo notes

- Plan 3 worktree prep (run inside each new worktree):

  ```text
  npm ci
  cp ../avatar/gateway/.env gateway/.env        # if present; never commit
  cp ../avatar/app/dev.json app/dev.json        # if present; never commit
  ./scripts/fetch-assets.sh                     # avatar GLB/animations, if the worktree needs the app
  ./scripts/build-web.sh                        # before any flutter build
  (cd app && flutter pub get)
  ```

  Worktrees: plan3-a (A1 → A2 serial), plan3-b. Device gates run one at a time on the Xiaomi; ask the user before restarting the 8787 gateway; smoke runs use 8797.
- Untracked `.codegraph/` is the user's CodeGraph index; not ignored or committed by this work (user's call).
- Progress ledger for this session lives in the git-ignored `.superpowers/sdd/` (per-task briefs, reports, diffs).
- 2026-10-12: host Flutter was upgraded 3.41.2 → 3.47.7 (latest stable, via `flutter upgrade`; Dart 3.13.5, DevTools 2.60.0, revision abaf9c523), Android licenses accepted; `flutter doctor` all green. Re-ran `cd app && flutter pub get && flutter analyze && flutter test` → 19 passed, no issues. Version pins updated in the migration guide and plan overview.

- 2026-10-14 Plan 2 protocol verification: official Seeduplex docs/demo were cross-checked. The local-key WebSocket probe returned HTTP 403 with `X-Api-Key` and HTTP 401 with Bearer auth before any event or audio was sent; validation and blocker are recorded in `docs/research/seeduplex-protocol-validation.md` and `docs/blockers.md`.

- 2026-10-14 Seeduplex user-Key recheck: using `docs/seeduplex/Seeduplex_APIKey.txt` produced WebSocket HTTP 101, `session.created`, 47,906 output-audio bytes, `response.cancel` -> `response.canceled`, and `session.closed` with zero upstream errors. The intervening timeout was a local probe bug that misclassified binary WebSocket frames carrying UTF-8 JSON; the probe was corrected and the result is recorded in `docs/research/seeduplex-protocol-validation.md`. Function calling remains unverified.

- 2026-10-15 Plan 2 local integration: `gateway/test/seeduplex.integration.test.ts` covers HTTP session creation through client WS startup and Seeduplex greeting audio; Qwen waits for `session.updated`, maps real `response.created`, sends `response.create` after debug text, deduplicates completion events, and has initialization failure coverage. Seeduplex mute/unmute keepalive and mute-state restoration across rebuild are covered. Full `npm test` passed (protocol 6, gateway 118, avatar-core 84); `npm run typecheck` passed.
- 2026-10-15 gateway hardening configuration: confirmation window, ledger limits, session grace/unclaimed timeouts, WS heartbeat, and uplink frame rate are now validated environment settings and are passed through the production startup chain. Focused gateway tests passed (120); remaining hardening items and external acceptance stay open.

- 2026-10-14 summarizer provider: verified the official DashScope OpenAI-compatible text protocol and added explicit `QwenSummarizer` with fixture tests. `MockSummarizer` remains the default; live summarization is pending a workspace-specific endpoint and Key. Evidence: `docs/research/qwen-text-summarizer.md`.

- 2026-10-14 Qwen live smoke: local credentials produced WSS HTTP 101, `session.created`/`session.updated`, real response/audio events with 179,040 output bytes, and text API HTTP 200. Real tool-call event fields were observed; tool-result continuation returned `invalid_request_error` and remains tracked.

- 2026-10-14 Qwen tool continuation: one controlled run successfully returned `conversation.item.created` after a `function_call_output` result; the previously observed 148,320 bytes were from the original response and do not prove a second response. The earlier error was caused by duplicate probe `response.create`; live cancel retry remains open.

- 2026-10-14 Plan 2 adapter core: added explicit `ADAPTER=seeduplex` configuration, environment-only key injection, Seeduplex WebSocket event/audio mapping, cancellation/tool-result translation, and sanitized local fixture tests. Full `npm test` (protocol 6, gateway 98, avatar-core 84) and `npm run typecheck` passed.

- 2026-10-14 protocol contract audit: Seeduplex `speech_text_buffer.commit` is direct TTS, not a generic model response trigger. The existing Director instruction path therefore needs an explicit design decision before real adapter runtime enablement.

- 2026-10-14 proactive speech decision: added explicit Director text fields and Seeduplex direct-TTS mapping so internal prompt instructions are never sent as spoken content.

- 2026-10-14 Qwen fallback: official WebSocket protocol was checked and a frozen-contract adapter with Bearer auth, workspace endpoint, `response.create`, audio/transcript/tool mapping and fixture tests was added. No Qwen Key or workspace endpoint was available for live smoke.

- 2026-10-14 Plan 2 validation after Qwen addition: `npm test` passed (protocol 6, gateway 100, avatar-core 84); `npm run typecheck` passed; `git diff --check` passed.

- 2026-10-14 deployment runbook: documented WSS/TLS/IP-allowlist acceptance and environment-only model/App secrets in `docs/deployment/plan2-wss.md`; cloud target credentials and certificate remain external prerequisites.

- 2026-10-14 cloud deployment attempt: Docker 27.3.1 was already installed; source and a root-only Qwen environment file were staged under `/opt/anyidea`, then Nginx/Certbot installation was started. The supplied SSH port began returning the Nginx default page, so the management channel is blocked. No container start, proxy config, DNS, TLS certificate, or public WSS acceptance is claimed; see `docs/blockers.md`.

- 2026-10-15 cloud access recheck: SSH is restored and `sshd` is confirmed on port `9722`; port `22` is closed. Docker and the staged root-only environment file remain, but the gateway container, Nginx, Certbot, DNS, TLS, and public WSS are still not verified.

- 2026-10-15 domain deployment: `aihero.com.cn` resolves correctly; systemd gateway and Nginx local proxy checks passed. Existing MySQL/Redis ports `3306/6379` were not changed. Let’s Encrypt HTTP-01 timed out because cloud security-group TCP 80/443 are not reachable; Docker image pull is also blocked by Docker Hub, so Compose remains staged while the same source runs under Node 24 systemd.

- 2026-10-14 Plan 2 release build validation: `cd app && flutter build apk --release --dart-define-from-file=dev.json` succeeded; APK size 77,762,308 bytes (hash recorded only as a local prefix), and `flutter analyze` reported no issues. This does not validate cloud WSS or real-device acceptance.

- 2026-10-14 device release smoke: Xiaomi 22101317C was connected and adb reverse succeeded, but release APK installation was rejected by Android (`INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`). No device acceptance result.
- 2026-10-15 local-first debugging: gateway started locally with `ADAPTER=mock`, `GET /healthz` returned 200, authenticated `POST /session` returned session tokens, and `adb reverse tcp:8787 tcp:8787` succeeded. Debug web bundle and APK build succeeded, but APK installation was rejected by Android with `INSTALL_FAILED_USER_RESTRICTED`; phone debugging cannot proceed until device install confirmation is enabled. Cloud deployment is deferred until all phone debugging is complete.
- 2026-10-15 local phone connection: the debug APK was installed with device-side `pm install -r -d` after the client-side install restriction; `MainActivity` is resumed, the local gateway emitted `session_created`, and device logs show native 16 kHz capture plus 24 kHz playback activity through the ADB-reversed gateway. Full voice, interruption, reconnect, and action acceptance remain open. Cloud deployment remains deferred.

- 2026-10-15 local phone acceptance continuation: user confirmed audible playback and mouth movement. `adb reconnect` interrupted the USB channel; after restoring `adb reverse tcp:8787 tcp:8787`, the gateway TCP peer changed and emitted `session_resumed`, while app PID 6963 remained alive. Active-playback stale-audio checks, long disconnection, action matrix and interruption measurements remain open.

- 2026-10-15 real interruption sample: user confirmed 3/3 real interruptions stopped promptly with no audible stale audio; gateway emitted 3 local cancellation events (seq 58–60). This is qualitative evidence only; latency P50/P90, subtitle finalization and the full interruption sample remain unverified. See the native audio report.

- 2026-10-15 interruption follow-up: user completed 7 more interruptions and reported normal behavior, bringing the qualitative manual sample to 10/10 with no reported stale audio. The gateway window contains additional local cancellations, but no per-attempt timestamp correlation; latency percentiles, subtitle finalization, false-trigger rate and Plan 1’s 20-attempt requirement remain unverified.
- 2026-10-16 controlled interruption follow-up: gateway 129 tests, full JS tests/typecheck, Flutter 40 tests, analyzer, and diff check passed. A temporary MOCK_PACE_FACTOR=0.5 run reproduced choppy playback because 100 ms chunks were sent every 200 ms; clean runs at factors 2 and 1 removed that configured underrun, but the user still heard the same response continue after saying “停”. During the controlled window no matching active response_cancel(source=local) was observed, so the remaining blocker is local VAD detection/timing on the Xiaomi device, not proven stale PCM. Add anonymous VAD event/level observability before tuning.
- 2026-10-16 anonymous interruption observability: `NativeSessionController` now reports only counters, RMS ranges/counts, response sequence, local-cancel count, and playback queue/feed state; `gateway` logs only `vad_edge` state/count/activeSeq. New tests cover same-sequence audio rejection after cancellation, fresh-sequence acceptance, one-shot end/cancel/error callbacks, and diagnostic redaction. Debug APK rebuilt and installed via device-side `pm install -r -d`; local Mock gateway health and authenticated session creation returned 200; ADB reverse remained active.
- 2026-10-16 controlled Xiaomi sample with the new diagnostics: the panel showed `vadSpeaking=5`, `vadSilent=5`, `rmsMax=9600`, `maxAboveRunMs=300`, and `localCancel=1`. Gateway showed `response.start seq=4`, `vad_edge silent activeSeq=4`, `response_cancel seq=4 source=local`, then `vad_edge speaking activeSeq=0` and `response.start seq=5`. This confirms one real VAD-to-local-cancel-to-new-sequence chain; the user reported that playback still continued or sounded like the same sentence. The new accepted/dropped chunk counters were installed for the next capture, but the following sample did not produce an active-response local cancel, so same-sequence residue is not yet proven. Blocker #10 stays unresolved.
- 2026-10-16 third diagnostic APK capture: the clean local Mock gateway returned health 200 and authenticated session 200; ADB reverse and device-side APK installation succeeded. The observed gateway window contained only idle `vad_edge` events plus `response.start seq=5`/`response_end seq=5`, with no active-response local cancel, so accepted/dropped queue counts remain uncorrelated. The user still reported continued or same-sentence playback. A fresh verification run passed `npm test` (protocol 6, gateway 129, avatar-core 84), `npm run typecheck`, `flutter test` (45), `flutter analyze`, and `git diff --check`; blocker #10 stays unresolved.
- 2026-10-16 cancellation-boundary diagnostics: `NativeSessionController` now captures anonymous playback state both before and after local cancellation (`responseSeq`, queue state, pending/feed, fed/played samples, accepted/dropped counts); a Flutter regression test fails before the change and passes after it. The debug APK was rebuilt and installed with `pm install -r -d`; a persistent local `ADAPTER=mock` gateway returned `/healthz=200` and authenticated `/session=200`. One requested Xiaomi sample produced `vad_edge speaking activeSeq=0` and `vad_edge silent activeSeq=0`, then `response.start seq=25`; the panel showed `vadSpeaking=1`, `vadSilent=1`, `localCancel=0`, `acceptedChunks=842`, `droppedChunks=0`, and only an after-state (`afterResponseSeq=0;afterQueue=idle;afterPending=0;afterFeed=0;afterFedSamples=79200;afterPlayedMs=3300`). No active-response local cancel was captured, so the new before-state fields were not exercised on-device and blocker #10 remains unresolved. An earlier one-shot gateway shell exited and caused a misleading `audio_start_failed`; a persistent gateway session removed that environment failure.
- 2026-10-16 cancellation ordering hardening: cancellation now runs in the same controller event queue as response setup and audio delivery; a gate test reproduces the old overlap and passes with `stopResponse` completing before the next `response.start`. `audio.cancel` is a persistent diagnostic key with controller accepted/dropped counters, and startup errors distinguish gateway failure from audio initialization. The rebuilt APK installed successfully and the device remained resumed with `AudioRecord` active. User feedback was “已停止”, but the matching gateway window had only response seq 5–9 start/end events and no active local cancel, so blocker #10 remains unresolved.
- 2026-10-16 cancel-gap and playback-level diagnostics: `MockAdapter` inserts `MOCK_CANCEL_GAP_MS` (400) of silence and moves the speech cursor after a started response is cancelled, so the next clip does not continue the same waveform. `NativeSessionController` publishes persistent `audio.playback` (`responseSeq`, `activeRmsMax`, `activeAboveRunMs`) for the active reply and leaves that snapshot unchanged after idle levels. The new tests failed before the implementation and passed after it. `npm test -w gateway` passed (130), `npm run typecheck -w gateway` passed, `cd app && flutter test` passed (50), and `flutter analyze` reported no issues. The debug APK was rebuilt and installed with `pm install -r -d`; a persistent `ADAPTER=mock` gateway at `MOCK_PACE_FACTOR=1` logged `gateway_listening`, and the phone session emitted `response_start seq=1 kind=greeting`. At 17:29 Beijing time the user reported a clear stop with audible silence. The matching gateway minute had no new `vad_edge` and no `response_cancel(source=local)`: seq 7 and seq 10 ended normally, seq 8 was `model_auto_cancel`, and seq 9 was `response_cancel source=model`. The debug panel was closed, so `audio.playback` counters were not captured. This is one subjective listen result, not measured interruption acceptance, and blocker #10 stays unresolved.
- 2026-10-16 local non-device follow-up: `QwenAdapter.sendToolResult` now sends `response.create` after `function_call_output`, matching the official client-event sequence. `npm test -w gateway` passed (131) and `npm run typecheck -w gateway` passed. `NativeSessionController` stops the active response when the gateway status becomes reconnecting or closed, and does not emit `playback.stopped` for that stop. The new Flutter test failed before the change and passed after it; `cd app && flutter test` passed (52) and `flutter analyze` reported no issues. A redacted live Qwen probe then observed two `response.created`, two `response.done`, and 65280 audio bytes with no error event. Audible stale-PCM confirmation was not run.
- 2026-10-16 interruption sampling skip and active-reply reconnect: the user skipped interruption latency distribution and multi-attempt counts. Those items are not recorded as passed. During a live Mock reply, dropping the USB channel produced `response_start seq=8` at 10:21:03.309Z, `response_cancel seq=8 source=local` at 10:21:03.422Z, and `session_resumed` at 10:21:07.134Z, with no `response_end` for seq 8. The next audio was seq 9. An earlier drop the same hour reached `grace_expired` at 10:04:40Z and then a new `session_created` at 10:06:02Z. Audible confirmation that no stale PCM remained was not collected. Blocker #10 is marked user-skipped for the quantitative sample only.
- 2026-10-16 local-cancel queue snapshot and speech-segment reset: the debug panel showed one `audio.cancel` for seq 4 (`beforeQueue=playing`, `beforePlayedMs=304`, `beforeFedSamples=9600`, `afterQueue=idle`, same fed/played counts, `cancelledDroppedChunks=4`), matching gateway `response_cancel seq=4 source=local` at 17:27:42 Beijing time. A later reply no longer inherits that open speech segment: response start closes it with one `vad silent` and resets the detector so the next sustained loud input can emit a fresh local cancel. The new Flutter test failed before the change and passed after it; `flutter test` passed (51) and `flutter analyze` was clean. The rebuilt debug APK was installed and the new phone session started a greeting. At 17:47 Beijing time the user again reported a clear stop with silence. The adjacent gateway window contained `response_cancel source=local` for seq 12 at 17:46:47 and seq 13 at 17:46:50. Seq 13 first logged `vad_edge silent activeSeq=13`, then the local cancel and `vad_edge speaking activeSeq=0`. The panel showed `cancelledSeq=13`, `localCancel=2`, `beforeQueue=playing`, `beforePlayedMs=2000`, `beforeFedSamples=48000`, `afterQueue=idle` with those fed/played counts unchanged, and `cancelledDroppedChunks=1`. The following completed reply seq 15 had `activeRmsMax=53` and `activeAboveRunMs=0`. This is one attributable local interruption, not a latency percentile or the planned multi-attempt sample, so blocker #10 stays unresolved.
- 2026-10-16 barge-in regression: the live Qwen log showed `vad_edge speaking` only with `activeSeq=0`, so a shout during playback never cancelled the reply. `EnergySpeechDetector` now uses RMS 200 after 400 ms while `aiPlaying` (idle threshold stays 1200). Qwen uplink stays dropped until `playback.stopped`, not only while the model is still generating. `npm test -w gateway -- test/session.test.ts` passed (20). `cd app && flutter test test/native_speech_detector_test.dart test/native_session_controller_test.dart` passed (19) and `flutter analyze lib/native_audio/speech_detector.dart` reported no issues. The debug APK was installed with `pm install -r -d`. Audible confirmation is not done.

## 话题接续修正实施（2026-10-18）

- 用户已确认实施 Plan C Task 12 的定向修正，沿用 `executing-plans`。第 1 项已实现：读取同 owner/agent 最近已结束会话的 episode，在初始及遗忘/拒绝刷新时注入快照；预算内先保留称呼和历史话题。旧提取、空会话、当前活跃会话不会替代最近已结束且有摘要的会话。
- TDD：提取后快照、下一会话指令、刷新保留摘要的回归均先失败后通过。`npm test -w gateway -- test/memory-store.test.ts test/snapshot.test.ts test/memory-acceptance.test.ts test/memory-tools.test.ts`：43 通过；`npm run typecheck -w gateway`：通过。基线外新增 3 个测试，并扩展真实消费者断言。
- 第 2 项已实现 OR 回忆检索；遗忘显式保留 AND，新增跨关键词边界召回和遗忘不误删的回归。两种角色先用历史摘要，空记录只说明缺记录；沉默阶段不重新回答旧问题或强制追问。本轮 focused Director/tools/acceptance/pacing 回归 54 通过，gateway typecheck 通过。
- 真实 Qwen 合成评测：`node --env-file-if-exists=gateway/.env --import tsx docs/testing/plan3-topic-continuity-probe.mjs all plan3-topic-continuity-reviewed.json`，4/4 场景的机械检查通过，且开场、回答、context/check/leave、再次明确提问的回复均逐句人工复核通过（每种风格各有历史/空历史一轮，模拟播放，不是真机听感）。最终结果连同人工结论归档为 [topic-continuity-latest](../testing/plan3-topic-continuity-latest.json)。旧指令的合成基线 [topic-continuity-before](../testing/plan3-topic-continuity-before.json) 复现重复未命中说明。迭代中曾发现追问、空记录被说成初次见面、开场编造今天天气，均未算通过，最终指令收紧后复验。
- 独立 reviewer 审查 `4e3ef5e..fa636b1`，发现探针会把换词重复判绿（P2）；`d5a25e6` 将机械检查与人工通过结论分开，并加强重复提问和开场检查，反例验证失败且增量复查确认问题已解决。模型语义仍依赖人工判读；不能将进程 exit 0 等同于行为验收通过。
- 最终代码验证：`npm test`：protocol 6、gateway 399、avatar-core 96 全通过；`npm run typecheck`：通过；`node --check docs/testing/plan3-topic-continuity-probe.mjs`：通过。`node --import tsx docs/testing/plan3-mock-smoke.mjs`：通过，8797 notice/flush/持久尾部/工具续答无回归。未改手机代码，未运行 Flutter 或重装。
- #42 仍开放至手机复验：下一步征得同意后重启 8787，保留现有库与身份，用户结束/重开后确认话题接续和沉默不重复。假设 8 的真机工具轮独立待验。8787 本轮未重启；未改 `.env` 或真实记忆数据，未恢复用户跳过的打断/静默采样。

## 话题接续修正应用到手机网关（2026-10-18）

- 用户确认重启后，以 SIGTERM 收尾旧 Qwen 进程。旧会话触发 `session_destroyed(reason=shutdown)`，记忆提取 `applied`（ops=2、messages=6）。首次脚本等待 15 秒超时未启动新进程；随后确认旧进程退出、8787 无监听，再接续启动，没有强杀或清库。
- 新版网关（代码至 `d5a25e6`）作为独立后台 Qwen 进程运行在 8787。保持 `/Users/jed/.avatar/memory.db`、现有 Key、已验证同 workspace 文本端点及 `app/dev.json` 的手机 APP_SECRET；只注入进程环境，`.env` 哈希未变。PID 与日志路径仍由仓库外 runtime 文件管理。
- 启动前后 owner/agent 身份集合相同，各 1 个 owner/agent/device；消息 19、episode 2、事实 1，启动前后计数相同；数据库权限 0600、外键检查无违规。只核查元信息，不输出正文。
- 运行时检查：`GET /healthz` 200；`POST /device/register` 无密钥 401、手机密钥加无效请求体 400，未新增设备。ADB reverse 检查为 tcp:8787 → tcp:8787。保留数据 force-stop 后重新启动现有 App，观察到原设备身份解析、新会话创建和 greeting start/end；未重装。
- 下一步：用户询问上次聊到哪里，检查能否接续已有话题，再短暂不说话观察 context/check/leave，确认不反复表示不知道或重复原答案。连接和开场事件不替代用户听感结论；#42 保持开放，假设 8 真机工具轮仍独立待验。本轮无产品代码变更，未重跑单元测试；本轮运行的服务、鉴权、数据库元信息和 ADB 检查结果如上。

## 沉默对话流程核查（2026-10-18）

用户确认重复相似话语已消失，但正常聊过几轮后沉默，会听到与上下文无关的主动话语。结论：计时链按当前规格执行；当前规则及上一轮防重复文案未达到自然陪伴的行为要求，不能算完整对话验收通过。#42 保留话题接续待验；新流程问题单列 #43。

### 证据与边界

- 手机播放完成由 `NativeSessionController._handlePlaybackEnded` 发 `playback.stopped(ended)`；Session 只处理当前有效 seq，过期回执不重排计时。模型 `responseDone` 本身不启动沉默步骤。未发现本次泛陪伴由重复播放完成回执造成的证据。
- Director 普通回复播放结束后无条件进入 context，后续 check → leave → rest。只保留最后一条实质用户话，没有判断刚才实际播放的回答是否已充分回应、用户是否自然收尾。生产时间为各句播放结束后 3s / 6s / 6s / 180s，不是从用户停说起累计。
- 上一轮 `fa636b1` 的防重复文案禁止重新回答旧问题，却仍要求产出一句简短陪伴陈述，允许退化成泛泛的陪伴话。上一轮四场景合成评测只覆盖回忆提问与不重复，未覆盖普通多轮的接话相关性；人工判读也接受了泛陪伴，验收范围不足。
- 脱敏手机事件：13:52:00.890Z seq9 播放完成；seq10 / seq11 / seq12 分别在上一句完成后约 3.376s / 6.433s / 6.361s 开始。seq12 被本地打断后约 2.949s 启动 seq13；它播完约 3.486s 又启动 seq14，随后再次出现约 6s 的链。事件没有 cue/stage，不能据此推断每句正文；这些序列与下述确定性复现一致。
- 对应异常话语窗口内无 adapter error 或重建。随后 13:57:54.685Z 才出现 `user_idle_timeout` 与 error rebuild，时间晚于上述话语，不是它们的触发原因。Qwen 当前 item 模式把主动 instruction 作为带标签的 user item 送入模型，不使用 `fallbackText` 作为错误时自动播报；不能把听到的“我在”直接归因为兜底。持续加入主动 user item 的上下文干扰仍是风险，本轮没有做真实模型对照，未作为已证实根因。

### 确定性复现

临时合成探针 `/tmp/avatar-flow-audit.mjs` 用 Node 24 的 `node:test` mock timers 驱动真实 Director 和当前角色配置，不调用模型、不接触身份库，只打印步骤。`node --import tsx /tmp/avatar-flow-audit.mjs` exit 0，8 个基线复现断言成立；这是对当前行为的诊断，**不是修复验收通过**：

| 场景 | 当前实际行为 | 判断 |
|---|---|---|
| 普通两轮后事实问题已回答 | context → check → leave → rest | 没有按是否有话可接作决策 |
| 普通两轮后分享经历已回应 | 同上 | 仅靠文案约束，无实际回答的完成度判断 |
| 普通两轮后明确再见 | 同上 | 缺少自然收尾判断 |
| quiet 短语后重新说实质内容 | 后续一直不启动沉默接话 | bug：`quiet` 没有复位，与规格“直到再次说出有内容的话”不符；正常模型回答不因此被禁止 |
| leave 播放中出现本地 speaking 但没有形成用户话 | context → check → leave → bargeMiss → context | bug：修复听辨的回复未区分阶段，播完把沉默链从头启动 |
| 单独轻声答应 | leave → rest 后停止 | 与当前规格一致 |
| 无 speaking 边沿的误切 | 重排原 check | 与当前防误切约定一致，不应回退 |
| 工具暂停期间 | 不主动说话；release 后才恢复 | 与当前工具门控一致 |

### 待确认的修正方向（尚未实施）

建议允许“这次不说话”：已答完的事实/回忆/操作请求、自然收尾和已充分回应的内容，安静等待；只有确有尚未接住的上下文才补一句相关承接。没有合适内容时不生成泛陪伴，也不靠模型输出空音频来表示跳过。保留现有计时配置作为符合条件时的等待，不再把到时等同于必须发言；未执行第一步时，不继续强制 check/leave/rest。发生新用户活动时，旧步骤及过期决策必须取消。quiet 后新实质发言恢复正常状态；听辨修复不能自动重开整条链。具体决策实现、模型失败策略和可审阅实施步骤须在设计确认后写入计划；此处不是批准或实现记录。

后续验收须覆盖事实问答、经历/情绪、已有充分回应、明确再见、轻声、要求安静后重新开聊、噪声打断、工具轮与过期回执；两种风格都检查多轮相关性和是否应开口，不能只以“不重复”为通过。

本轮实际运行：`npm test -w gateway -- test/director.test.ts test/session.test.ts test/qwen.test.ts`，3 文件、101 测试通过；上述 8 场景基线探针成立。只更新诊断记录，没有产品代码变更、没有新增真实模型请求、没有更改 `.env` 或读取真实记忆正文，没有重启 8787 或操作手机。按 AGENTS §7，先报告原设计缺口并确认修正行为，再开始受影响的实施。

## 三步主动链回归修正（2026-10-18）

- 根因：`Director.onAiTurnEnded` 在有内容会话完成 `context` 后直接进入 `waitQuietly`，因此 `check → leave` 永远不会排队；`planContext` 返回空值或失败时也直接静默，真实模型返回 `speak:false` 时整条主动链被截断。
- 修正：context 播放结束恢复原有 `check → leave → rest` 转移；可选 planner 未配置、拒绝或失败时回退到 context 话术并继续三步链。取消、打断、用户新发言和 quiet 状态仍会清理计时器，不改变工具轮门控。
- TDD 回归：新增“approved context continuation 继续到 check/leave”测试，并覆盖 planner 缺失、返回空值、拒绝异常的三步回退；更新 session 事件链断言。
- 验证：`npm test -w gateway` → 39 files / 435 tests passed；`npm test` → protocol 6、gateway 435、avatar-core 96 passed；`npm run typecheck` 及 `git diff --check` 通过。手机听感和 8787 重启尚未执行。

## 沉默流程修正执行（2026-10-18）

- 用户已确认 #43 的初版修正规则，按既有 Task 12 补入 S1–S3，沿用 `executing-plans` 在当前功能分支顺序执行；后续回归修正见本节末尾。
- 初版任务覆盖 S1 Director 发言前判断、取消和状态恢复，S2 文本客户端结构化判断及生产接线，S3 两种风格多轮评测和独立审查。该初版曾把判断失败统一处理为静默，后来证实会截断用户要求的主动三步链。
- 初版实现已完成；本轮已补回归修正并通过 gateway/全 JS 验证。#42 的话题接续、真机听感及假设 8 仍待验。8787 当前进程不随代码编辑重启。原有暂存文档与 `.gitignore` 改动保留。

- 初版 S1 已实现并验证：新增 15 项回归先失败（缺少判断门控、取消、quiet 复位与听辨修复阶段），修复后 `npm test -w gateway -- test/director.test.ts test/director-silence.test.ts` 48/48 通过。初版实质对话最多一句批准承接的规则已被本轮三步主动链回归修正覆盖，开场未聊起来的阶梯保持不变。

- S2 已完成生产接线：复用 `TextModelClient`，结构化结果在 zod 边界验证；未配置、失败、超时或过期时 planner 返回空值，Director 现在回退到 context 话术并继续三步主动链，诊断不含正文。Session 只在有效播放完成时传入实际回答；决策只用该次用户话和回答，不把主动系统提示当成用户话。模型重建会暂停并取消判断，恢复后不自动重启语音链。
- S2 验证：新增 Session 播完/重复回执断言先失败，重建取消断言先失败；配置校验去掉新 schema 时拒绝断言失败，恢复后通过。`npm test -w gateway -- test/director.test.ts test/director-silence.test.ts test/silence.test.ts test/session.test.ts test/config.test.ts test/fileCatalog.test.ts`：145 通过；`npm run typecheck -w gateway`：通过。
- S3 的初版合成评测和独立审查已完成：真实 Qwen 文本判断覆盖两种风格、16 个语义场景，机械检查 16/16；该报告验证了判断器语义，却没有覆盖三步主动链回归。报告见 `docs/testing/plan3-silence-flow-latest.json`，旧失败基线保留在 `plan3-silence-flow-before.json`；两份报告均区分人工判读与机械检查。
- 独立审查发现并修复一个 P2：记忆告知完成回执不能提前清掉 `pending`，否则告知文案会覆盖上一轮实际回答；断线恢复提示也标记为独立 cue，播完后不再拿旧话题重新判断。初版交错回归后，`npm test`：protocol 6、gateway 434、avatar-core 96 全通过；本轮三步主动链回归后 gateway 为 435。`npm run typecheck`、Mock 8797 冒烟、两个探针 `node --check` 均通过。8787 未重启，手机听感和 #42 话题接续仍待用户复验。

## Avatar selection implementation (2026-10-19)

- Added independent local avatar selection for the existing model plus `cute-girl`, `cute-boy`, `young-woman`, and `young-man`. First launch is style then avatar; settings manages both; changes apply on the next session.
- Flutter focused verification: `flutter test test/app_shell_test.dart test/avatar_page_config_test.dart test/companion_picker_test.dart test/style_picker_test.dart` passed (20 tests). `flutter analyze` completed with only the existing missing generated Web asset warnings and pre-existing lint/info items.
- Avatar-core verification: `npm test -w avatar-core` passed (16 files, 102 tests); `npm run typecheck -w avatar-core` passed. Bridge validation accepts exactly the five catalog paths, defaults omitted paths, rejects URLs/traversal, and retries the existing model when a selected model is unavailable.
- `scripts/fetch-assets.sh` now restores the five local model paths from a pinned TalkingHead revision, verifies the three upstream SHA-256 values, and derives `cute-boy.glb` from the pinned male source while preserving its rig and blendshapes. The GLBs remain ignored because the upstream examples are non-commercial or attribution-bound.
- Full validation after provisioning: `./scripts/build-web.sh` passed and copied all five models into the Web bundle; `npm test` passed (protocol 6, gateway 435, avatar-core 102); `npm run typecheck` passed; `cd app && flutter test` passed (161); `flutter analyze` reported no issues; `git diff --check` passed.
- Blocker #44 is narrowed to target-phone visual acceptance and release-license review. Local GLB structure, checksums, build inclusion, catalog paths, and runtime fallback are verified; framing, materials, facial blendshapes, and animation quality on the target phone remain unverified.

## Seeduplex local gateway switch (2026-10-19)

- `gateway/.env` now selects `ADAPTER=seeduplex` with the locally supplied API key and the existing Seeduplex endpoint/model/voice settings; the key remains in the ignored file and was not logged or committed.
- Restarted the phone gateway on port 8787 after the previous Qwen process closed. Health returned 200, the startup event reported `adapter=seeduplex`, and the existing Android app reconnected through the preserved ADB reverse mapping.
- The new gateway log recorded one session, 16 completed response pairs, 5 response cancellations, and 3 silence decisions with no error events. This verifies local session connectivity; full target-phone voice acceptance remains open.

## 沉默固定文案修正（2026-10-19，2026-10-20 更正）

- **2026-10-20 更正：** Seeduplex 的 `speech_text_buffer.commit` 是直接文本合成，提交 Director 的 `instruction` 会把完整提示词原样播给用户。手机首句播报“当前没有…请礼貌…开场只用一句陈述…”即该回归，不是固定文案问题。主动响应路径只能提交可直接播报的 `fallbackText`。
- 已修复 `gateway/src/adapters/seeduplex.ts`：`createResponse` 只提交 `fallbackText`；`gateway/test/seeduplex.test.ts` 断言 commit 文本既不是 instruction 也不是 cue。`npm test -w gateway` 436 项通过，`npm run typecheck -w gateway` 通过。
- 2026-10-20 真机复验：重启 8787（`ADAPTER=seeduplex`）并重开 App 后，新会话 greeting 播放约 5.3 秒（修复前同一路径约 20.2 秒），随后两段沉默 followup 分别约 5.8 / 9.7 秒，均为短句时长；本轮无 `adapter_error`。再次重开 App 的 greeting 播放约 3.8 秒，用户确认首句正常、不再念提示词。内容正确性由适配器回归测试和用户听感共同确认。
- 2026-10-20 后续：阶段推进逻辑已由下一节“三步主动链统一”修正取代；check/leave 不再经过判断器，Seeduplex 不会因 `speak:false` 逐段静默。
- 当前没有新的部署动作；网关和 APK 均按用户要求暂停，手机复验等待用户安排。

## 三步主动链统一（2026-10-20）

- 用户听感：Seeduplex 模式下正常聊过几轮后沉默，没有 Qwen 那样的三段主动接话，而是一直等待；要求对标 Qwen，两种适配器共用同一套逻辑。
- 根因：共享 Director 在 `hadContent` 时把 context/check/leave 三段都交给文本判断器；Seeduplex 直出 TTS 不回报回答文本，判断器更容易返回 `speak:false`，`skipPlannedStep` 于是逐段静默，手机听感就是一直等待。这不是 Seeduplex 适配器差异，而是 Director 把“判断器拒绝”当成了“整条链不发言”。
- 修正（统一在 `Director`，不区分适配器）：只有 context 段经过判断器；判断器拒绝、异常或超时都改说配置的温和承接 `contextText`（默认 `followupText`），并继续三步链。check/leave 不再询问判断器，固定使用配置文案；Qwen 仍按 instruction 生成，Seeduplex 按 fallbackText 直接播报。rest 仍只触发一次提取并按配置播一句后停止。
- 配置：`gateway/roles/elder-companion/director.json` 新增 `contextText: "您接着说，我在这儿听着呢。"`；zod schema 与 `DirectorConfig` 同步，启动时校验。
- TDD：新增/更新 `director-silence.test.ts`，覆盖判断器拒绝、异常和批准三种路径都走完 context → check → leave → rest；`director.test.ts`、`session.test.ts` 更新为 check 不再调用判断器。`npm test -w gateway` → 102 files / 436 tests passed；`npm run typecheck -w gateway` 通过。
- 规格：`docs/superpowers/specs/2026-10-17-companionship-memory-design.md` §2 已改为 2026-10-20 约定，取代 2026-10-18 #43 的“最多一句、其余安静等待”。
- 待办：重启 8787 后真机复验“聊几轮 → 沉默”，应听到 3 秒后的温和承接、约 12 秒后的「您还方便吗」、再约 12 秒后的短离开；用户听感确认前不算完成。8787 未重启。
- 2026-10-20 后续：用户已确认三段都听到，但反馈衔接不自然、缺少主动性、像固定语句；本节的“仅 context 判断 + check/leave 固定文案”由下一节取代。

## 三步主动链接话自然化（2026-10-20 第二轮）

- 用户听感：三段都能听到，但上下文衔接不自然，接话没有主动性，更像固定语句；要求给三段式增加互动性与主动性，同时保持 Qwen / Seeduplex 行为统一。
- 修正（仍在共享 `Director`，不区分适配器）：context、check、leave 三段都调用 `planSilenceLine`。规划输入扩展为 `SilenceContext { stage, userText, assistantText, previousTexts }`；规划结果扩展为 `SilencePlan { text, close? }`。`previousTexts` 记录本轮链已播出的接话（最多保留 3 句），新的实质用户发言后清空，规划提示词据此避免重复角度和问题。
- 三段定位：context 抓住用户最后一句里具体的人、事或感受，回应并可用一个具体小问题把话递给对方；check 换一个相关角度继续聊，最多一个轻松问题；leave 温暖地给空间，不再提问。规划器不再要求 `assistantText` 非空（Seeduplex 直出 TTS 常无回答文本），空回答时仍可用用户话规划。
- 结束条件：只有用户最后一句明确结束对话（睡觉、出门、再见、别聊了）时才返回 `close`，此时不播任何文案并停止本轮链；其余情况都主动接话。规划返回 `null`、无文本、异常、超时或输入超预算时，仍回退到该阶段配置文案（`contextText` / `checkContextText` / `leaveText`），三段不会整体静默。
- 配置：`gateway/roles/elder-companion/director.json` 的 `silenceDecision.instruction` 改为分阶段、主动接话提示词；`speakInstruction` 允许已规划句子里的小问题（不再要求“不加问句”）。Qwen 按 instruction 生成，Seeduplex 按 `fallbackText` 直接播报，两种适配器走同一套阶段与回退逻辑。
- TDD：`silence.test.ts` 覆盖新 `SilencePlan`、stage/previousTexts、`close`、空 `assistantText`、预算与取消；`director-silence.test.ts` 覆盖三段都规划、前文累积、`close` 停止、规划异常回退、迟到结果丢弃；`director.test.ts`、`session.test.ts` 同步新输入形状。`npm test -w gateway` → 39 files / 440 tests passed；根 `npm test` → protocol 6、gateway 440、avatar-core 103 passed；`npm run typecheck -w gateway` 与 `git diff --check` 通过。
- 待办：重启 8787 需再次征得用户同意；真机复验重点听三段是否顺着刚才的话题、是否避免重复、leave 是否自然收束。用户听感确认前不算完成。
- 2026-10-20 后续：用户确认三段听感与预期完全一致，但要求改为四段式（6/8/10/10 秒），本节的“三段”方案由下一节取代。

## 四段主动链真机反馈与根因修正（2026-10-20 第四轮）

- 用户反馈：第四段没有听到“是否还在听、随时可以聊”之类的话；另外回复有时先出一个字“好”，停一下才继续说。要求仔细排查并找到根因。
- 根因一（第四段内容）：checkin 也走了通用接话规划器。该提示词的第一条规则要求“从 userText 里抓住具体细节继续回应”，优先级压过埋在第三条里的 checkin 要求。用真实 qwen-plus 对合成场景连跑 3 次，checkin 输出全部是继续话题（例如“腿酸是活动开了…”），没有一次包含“还在听/随时可聊”。这是提示词设计冲突，不是适配器缺陷。
- 修正一（共享 Director，适配器无关）：`fire()` 只对 context/check/leave 调用 `planSilenceLine`；checkin 直接走配置文案 `checkinInstruction`（Qwen 渲染）与 `checkinText`（Seeduplex 直说）。规划提示词中删除 checkin 阶段，避免规则冲突。`SilenceContext.stage` 收窄为实际会规划的三个阶段。
- 根因二（“好”后停顿）：用合成中文语音直连真实 Seeduplex 探测（不涉及真实对话内容），两轮里第一段音频之后到第二段音频的间隔分别为 231 ms 和 472 ms，后续间隔明显更小；而客户端 `FlutterPcmSound` 在收到第一块音频时立刻 `play()`，没有起播缓冲，插件内部只有最小缓冲。上游一起播顿挫就直接成为可听见的“一个字后停一下”。属于“上游流式起播间隔 + 客户端无起播缓冲”的组合根因，不是适配器丢包，也不是网关转发延迟。
- 修正二（客户端，Qwen/Seeduplex 共用）：`PlaybackQueue` 增加 `startCushionSamples`，`PluginNativeAudioIO` 在每轮回复起播前先攒约 1000 ms 音频（`nativePlaybackStartCushionMs`）再喂给播放器；缓冲足够立即起播，短回复在 `response.end` 时立即释放，若上游起播明显慢于实时则由 1200 ms 定时器兜底（`nativePlaybackStartWaitMaxMs`），不会无限等待。起播缓冲只影响首个声音，不改变后续播放。探针 6 轮中首段大停顿均出现在前 3 块音频内（最大 472 ms），1000 ms 缓冲可覆盖。
- TDD/验证：`native_playback_queue_test.dart` 新增 4 个缓冲用例，`flutter test` → 165 passed；`director-silence.test.ts` 改为“前三段规划、checkin 固定文案”，`npm test -w gateway` → 39 files / 440 tests passed；`npm run typecheck -w gateway` 通过。
- 待办：客户端起播缓冲需重新构建 APK 才能上机；重启 8787 与安装新 APK 都需用户同意，真机确认前不算完成。

## 四段主动链（2026-10-20 第三轮）

- 用户要求：三段式沉默追问改为四段式，前三段间隔分别约 6、8、10 秒，再加一段约 10 秒；第四段要客气、亲切地询问用户是否还在听，并友好表示随时都可以接着聊；改动要同时应用到 Qwen 适配器，以后同类改动都要适配两种适配器。
- 修正（仍在共享 `Director`，不区分适配器）：新增 `checkin` 阶段，顺序为 context → check → leave → checkin → rest。四段都由 `planSilenceLine` 生成；前三段的定位沿用第二轮，checkin 的语气要求是客气、亲切、轻声确认“是否还在听”，并说明随时可聊，不催促、不追问、不起新话题。
- 时序：`contextAfterMs` 3000 → 6000，`checkAfterMs` 12000 → 8000，`leaveAfterMs` 12000 → 10000，新增 `checkinAfterMs: 10000`；`restAfterMs` 仍为 180000，在 checkin 播完后开始计时。开场后尚无实质用户话的路径仍保留三步，不进入 checkin。
- 配置：`gateway/roles/elder-companion/director.json` 新增 `checkinInstruction` 与 `checkinText`（“您还在听吗？不着急，您随时想聊都可以，我一直都在。”）；`DirectorSchema`、`DirectorConfig` 同步，启动时校验。规划提示词加入各阶段的新间隔和 checkin 的语气规则。
- 适配器：Qwen 与 Seeduplex 都从同一个 Director 接收同一份 `ProactiveRequest`。Qwen 的 `proactiveEvents` 使用 `instruction`（其中已由 `speakInstruction` 带上规划好的第四段句子），Seeduplex 直接播 `fallbackText`；两边的阶段、生成与回退逻辑完全一致，没有适配器专属分支。
- TDD：`director-silence.test.ts` 覆盖四段时序、四段都规划、`previousTexts` 累积、close、异常回退、取消；`config.test.ts` 校验新时序与 checkin 文案；`director.test.ts`、`session.test.ts` 同步默认时长与四段推进。`npm test -w gateway` → 39 files / 440 tests passed；根 `npm test` → protocol 6、gateway 440、avatar-core 103 passed；`npm run typecheck -w gateway` 与 `git diff --check` 通过。
- 待办：重启 8787 需再次征得用户同意；真机复验四段间隔和第四段的客气亲切感，用户听感确认前不算完成。
