# P4-T4: 计划 4 验收——回归、手机验收、roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development，收尾前用 verification-before-completion。先读 `00-overview.md`，再读本文件。步骤用 `- [ ]` 勾选。

**Goal:** 跑完全部自动回归，在真机上确认三件事：封禁后的提示与恢复、停用角色的置灰与 24 小时记忆、诊断编号能在后台「排查」页查到同一通会话。结果写进 `docs/testing/2026-10-27-admin-app-acceptance.md` 和 roadmap。手机上的观察以用户确认为准。

**前置：**
- P4-T1、P4-T2、P4-T3 已提交。计划 2、3 已验收（后台能封禁、解封、停用角色、按诊断编号查会话）。
- 执行机器满足总览「环境前置」中 Flutter 和真机两行；`app/dev.json` 存在（只含 `GATEWAY_URL`、`APP_SECRET` 等 `--dart-define`，不要打印内容）。
- 网关以身份模式运行（设置了 `MEMORY_DB_PATH`）并开启后台（`ADMIN_PORT`、`ADMIN_PASSWORD_HASH`）。`ADAPTER=mock` 即可完成本任务；不需要模型 Key。

## Files

- Create: `docs/testing/2026-10-27-admin-app-acceptance.md`
- Modify: `docs/project/roadmap.md`（本阶段条目）、`docs/superpowers/plans/2026-10-27-admin-console/p4-0*.md`（勾选完成的步骤）
- Modify（只在有跳过项时）: `docs/blockers.md`

## Interfaces

- Consumes：P4-T1 `diagId`；P4-T2 封禁提示屏（`banned-notice`、`banned-retry`）、置灰（`CharacterHolds`）；P4-T3 `session_ready` 诊断行、设置页 `copy-diag`；计划 2 的封禁 / 解封 / 排查页；计划 3 的角色停用开关。
- Produces：验收记录与 roadmap 更新，无代码。

- [ ] **Step 1: 自动回归**

Run（仓库根）：

```bash
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
npm test -w admin && npm run typecheck -w admin && npm run build -w admin
cd app && flutter test && flutter analyze
```

Expected: 全部通过；`flutter analyze` 输出 `No issues found!`。把每条命令的通过数（例如 `gateway 7x files, 1xxx tests`、`flutter test` 的 `+NNN: All tests passed!`）抄进验收记录。

- [ ] **Step 2: 内容安全自查**

Run（仓库根）：

```bash
grep -rn "formatDiag(" app/lib | grep -v "_test" 
grep -rn "debugPrint(" app/lib
```

Expected: 新增的诊断行只有 `session_ready`（字段 `sid`、`diag`）和 `character_hold_read_failed` / `character_hold_write_failed`（无字段）；没有任何新增 `debugPrint` 打印文本内容。结论写进记录。

- [ ] **Step 3: 构建并安装**

```bash
cd app
flutter build apk --debug --dart-define-from-file=dev.json
adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

Expected: `Success`。不需要卸载重装（本计划没有改本地存储格式）。

- [ ] **Step 4: 打开 logcat**

另开终端：

```bash
adb logcat -c && adb logcat -s flutter:I | grep anyidea.diag
```

- [ ] **Step 5: 手机验收 A——诊断编号**

1. 打开 App，进入任一角色聊天，等到状态变成可以说话。
2. logcat 应出现一行 `anyidea.diag event=session_ready sid=<uuid> diag=<12 位十六进制>`。
3. 打开设置页，滚到底部，看到「复制诊断编号」按钮和下面一行灰色编号，编号等于 `<sid>-<diag>`。
4. 点按钮，看到「已复制诊断编号」。把剪贴板内容粘到电脑上（例如粘到微信发给自己）。
5. 浏览器打开后台「排查」页，粘贴编号查找，能看到这通会话的时间线（开始通话、回复、结束原因等），角色和时间与手机一致。

记录：sid 前 8 位、diag、后台是否找到（是 / 否）。

- [ ] **Step 6: 手机验收 B——封禁**

1. 手机保持在聊天中。后台用户详情页找到 Step 5 的 diag 对应的用户，点「封禁」并确认。
2. 手机上通话应在几秒内结束，出现一屏「服务暂时不可用，请联系家人」和「再试一次」，没有设置按钮。logcat 不应出现持续刷屏的重连。
3. 点「再试一次」：仍是同一屏提示（网关返回 403）。
4. 后台点「解封」。手机点「再试一次」：回到聊天，能正常说话。

记录每一步是否符合（用户确认）。

- [ ] **Step 7: 手机验收 C——停用角色**

1. 后台「角色」页停用手机当前在用的角色（例如小欣），发布。
2. 手机上结束当前通话（进行中的会话不受影响，这是预期），再重新进入聊天。
3. 应回到角色选择页，顶部写「小欣暂时休息中，请先选一位别的伙伴」，小欣卡片置灰、带锁、写「暂时休息中」，不能选。设置页里小欣同样置灰。
4. 选另一个角色，能正常聊天。
5. 强制停止 App 再打开（`adb shell am force-stop <applicationId>` 或在多任务里划掉），设置页里小欣仍置灰。
6. 后台重新启用小欣。手机上小欣在置灰时长内仍是灰的（预期：本机记 24 小时）。如需当场确认恢复，可临时把 `characterDisabledHoldMs` 改成 `60000` 重新构建验证，**验证完改回 `86400000` 并确认 `git diff app/assets/config/companion.json` 为空**。

记录每一步是否符合（用户确认）。

- [ ] **Step 8: 写验收记录**

新建 `docs/testing/2026-10-27-admin-app-acceptance.md`，结构：

```markdown
# 计划 4（App 改动）验收记录（2026-10-27 起）

## 自动回归
| 命令 | 结果 |
|---|---|
| npm test -w protocol | … |
| npm test -w gateway / typecheck | … |
| npm test -w admin / typecheck / build | … |
| flutter test / flutter analyze | … |

## 内容安全自查
…（Step 2 结论）

## 手机验收（设备型号、APK 提交号）
| 编号 | 检查 | 结果 | 确认方式 |
|---|---|---|---|
| A1 | logcat 出现 session_ready，含 sid 与 diag | | 实测 |
| A2 | 设置页显示并复制诊断编号 | | 用户确认 |
| A3 | 后台排查页按编号找到同一通会话 | | 用户确认 |
| B1 | 封禁后通话结束、出现提示屏、无重连刷屏 | | 用户确认 |
| B2 | 封禁期间「再试一次」仍是提示屏 | | 用户确认 |
| B3 | 解封后「再试一次」恢复聊天 | | 用户确认 |
| C1 | 停用后回到选择页，原因与置灰正确 | | 用户确认 |
| C2 | 换角色可聊天 | | 用户确认 |
| C3 | 重启 App 后仍置灰 | | 用户确认 |
| C4 | 置灰到期后恢复（如做了临时短时长验证，注明并确认已改回） | | 用户确认 |

## 跳过与问题
…（没有就写「无」）
```

记录里不出现任何对话内容、Key、`app/dev.json` 的值；sid 只写前 8 位。

- [ ] **Step 9: 更新 roadmap 与计划勾选**

- `docs/project/roadmap.md` 本阶段条目写：计划 4 完成情况、Step 1 的真实命令与结果、手机验收结论（用户确认的写明）、未通过或跳过的项及 blockers 编号、下一步。
- 勾选 `p4-01` 到 `p4-04` 中实际完成的步骤。
- 有跳过项时按 AGENTS.md 第 7 条写进 `docs/blockers.md`。

- [ ] **Step 10: Commit**

```bash
git add docs/testing/2026-10-27-admin-app-acceptance.md docs/project/roadmap.md docs/superpowers/plans/2026-10-27-admin-console/p4-01-protocol-diag.md docs/superpowers/plans/2026-10-27-admin-console/p4-02-app-rejections.md docs/superpowers/plans/2026-10-27-admin-console/p4-03-app-diagnostics.md docs/superpowers/plans/2026-10-27-admin-console/p4-04-acceptance.md
git commit -m "docs: record the plan 4 app acceptance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（改了 `docs/blockers.md` 时把它也加进 `git add`。）
