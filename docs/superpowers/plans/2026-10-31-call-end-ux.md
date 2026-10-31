# 结束对话与重开实施计划

日期：2026-10-31
状态：**Task 1–5 实现完成；app 全量测试与 analyze 通过；真机重开待验（blocker #76）**。
设计：`docs/superpowers/specs/2026-10-31-call-end-ux-design.md`

## 目标

结束对话前有安全默认的二次确认；结束后有可重开的大卡片；重开在页内新开会话，不重载头像引擎；结束后不再出现只能退出 App 的死路。

## 非目标

不改 gateway / protocol；不做 60 秒 resume；不做通话摘要/时长；不改记忆抽取、开场和四段式沉默。

## Task 1 - SessionStartGuard 可复位

- 先写失败测试：`test/session_start_guard_test.dart` 覆盖 end → reset → begin，旧 token 失效，新 token 有效。
- 实现：`SessionStartGuard.reset()` 设 `_ended = false` 并递增 `_epoch`。
- 验证：`flutter test test/session_start_guard_test.dart`。

## Task 2 - 结束确认框

- 先写失败测试：`test/end_chat_dialog_test.dart` 覆盖继续、结束、点框外/返回=继续，按钮高度与文字。
- 新增 `lib/end_chat_dialog.dart`：`confirmEndChat(context) -> Future<bool>`，true = 结束；安全项为 FilledButton，破坏项为 `colorScheme.error` 文字；`result ?? false`。
- 验证：`flutter test test/end_chat_dialog_test.dart`。

## Task 3 - 结束态卡片与按钮文字

- 先写失败测试：`test/overlay_test.dart` 覆盖 ended 状态、按钮隐藏、字幕/状态隐藏、两个回调、静音语义标签、圆钮只显示图标。
- 修改 `lib/overlay.dart`：
  - `ended`、`onRestart`、`onChangePartner` 参数；ended 时隐藏底部控制与字幕，显示 `_EndedCard`。
  - `_RoundButton` 只显示图标，语义标签保留；结束键恢复 `Colors.redAccent`。
- 验证：`flutter test test/overlay_test.dart`。

## Task 4 - 页内重开与接线

- 先写失败测试：`test/avatar_page_engine_test.dart` 覆盖「结束取消保持会话 → 确认结束显示卡片 → 换个伙伴回调 → 接着聊天开第二个会话」；必要时加重开失败显示重试。
- 修改 `lib/avatar_page.dart`：
  - 结束改为 `confirmEndChat` → `_endNow`；`_ended`、`_ending`、`_restarting`、`_startDone`。
  - `_startNativeSession` 返回 Future，记录 `_startDone`；构造/加载异常显示「初始化失败，请重试」。
  - `_restart` 等待旧 stop 和旧启动，reset guard，清空字幕，恢复 wakelock，开新会话；失败走现有错误+重试。
  - 结束后事件仍转发引擎，但不再更新 UI；结束态隐藏状态/字幕。
  - 新增 `onChangePartner` 与测试用 `gatewayClientFactory` 注入。
- 修改 `lib/identity/app_shell.dart`、`lib/main.dart`：`AvatarPageRequest.onChangePartner` 接到 `_openSettings`。
- 验证：`flutter test test/avatar_page_engine_test.dart test/app_shell_test.dart`。

## Task 5 - 回归与文档

- `flutter test`（app 全量）、`flutter analyze`。
- 更新 `docs/project/roadmap.md`：状态、实际命令与结果、下一项。
- 真机验证「结束 → 接着聊天」连续 3 次；若无法执行，记录 `docs/blockers.md`，不声称真机通过。

## 验收

- 结束必须二次确认，取消不结束；点框外/返回不结束。
- 确认后显示结束卡片；静音/结束按钮隐藏；字幕和顶部状态清空。
- 「接着聊天」在页内启动新会话，头像引擎不重载；失败显示重试。
- 「换个伙伴」打开现有设置页。
- 全量 app 测试与 analyze 通过；真机结果如实记录。

## 执行结果（2026-10-31）

- Task 1–5 代码完成；新增 `lib/end_chat_dialog.dart`，修改 `overlay.dart`、`avatar_page.dart`、`session_start_guard.dart`、`identity/app_shell.dart`、`main.dart`。
- `cd app && flutter test`：362 项通过。
- `cd app && flutter analyze`：no issues。
- `git diff --check`：clean。
- 真机（现有 8787 网关，小米 22101317C / Android 13）：连续 3 次「结束 → 接着聊天」通过；4 次 `session_ready`（首启 + 3 次重开），无 fail/error/timeout/closed 诊断，app 进程存活；结束后系统麦克风指示消失、重开后恢复；每次重开有 `duix_playback_start/end` 且 `lips=true`。未做人工听音，主观音质/垫话自然度待用户确认。
- 2026-10-31 真机反馈：圆内文字拥挤，已去掉圆钮可见文字、恢复图标（语义标签保留）；空字幕条隐藏。字幕出现 `[call] set_memory_consent(...)` 时由 `visibleAssistantLine` 隐藏，真机记录 `assistant_code_hidden chars=1`。网关侧另见 [tool-syntax guard](../specs/2026-10-31-tool-syntax-guard-design.md)：`textGuard` 已实现并通过 gateway 1473 项回归、typecheck 和真实记忆库召回探针；重启 8787 后真机 3 次重开捕获 2 次 `assistant_tool_syntax`（reply_chars=0），客户端未再出现代码字幕；音频听感待用户。
- 真机恢复：force-stop 触发 Duix crash guard；仅删除本地 `duix_crash_count`、`duix_inflight`、`character_hold_until.xiaoxin` 三个安全存储键，保留 `device_token` / `character_id`，记忆未丢。
