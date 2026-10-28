# 计划 4（App 改动）验收记录（2026-10-27 起）

## 环境

- 代码/APK 提交：`6610123`（P4-T3；本记录随后提交）
- 设备：Xiaomi `22101317C`（arm64，USB）；Android 包 `com.aihero.avatar.bontime`
- Flutter：3.47.8 stable（计划写 3.47.6；用户批准使用 3.47.8）
- 网关：临时 Mock 网关（主机 8797，后台 8788，临时库），通过 `adb reverse tcp:8787 tcp:8797` 供手机连接；线上 8787/真实库未用于本次手机测试。测试结束后临时网关已停止、临时库已删除，adb reverse 已恢复 8787→8787。
- 内容：本记录不含对话内容、音频、ASR、回复、记忆正文、Key 或 `app/dev.json` 值；sid 只写前 8 位。

## 自动回归

| 命令 | 结果 |
|---|---|
| `npm test -w protocol` | 3 文件 / 16 项通过 |
| `npm test -w gateway` / `npm run typecheck -w gateway` | 109 文件 / 1345 项通过；typecheck 通过 |
| `npm test -w admin` / `npm run typecheck -w admin` / `npm run build -w admin` | 24 文件 / 129 项通过；typecheck 与 build 通过 |
| `cd app && flutter test` | 350 项通过 |
| `cd app && flutter analyze` | No issues found! |

## 内容安全自查

- 新增诊断行只有 `session_ready`（`sid`、`diag`）与 `character_hold_read_failed` / `character_hold_write_failed`（无字段）。
- 没有新增 `debugPrint`；既有 `device_reregistered` / `device_renew_failed` / secure-storage spike 行属于旧代码。
- 手机 logcat 只读取 `anyidea.diag` 行；没有读取或记录对话内容。

## 手机验收

| 编号 | 检查 | 结果 | 确认方式 |
|---|---|---|---|
| A1 | logcat 出现 `session_ready`，含 sid 与 diag | 实测：sid 前 8 位 `f6ac6386`，diag `6e69b063b275` | 实测 logcat |
| A2 | 设置页显示并复制诊断编号，出现「已复制诊断编号」 | 通过 | 用户确认 |
| A3 | 后台按编号找到同一通会话（角色小暖、Mock、22:38 开始） | 通过 | 用户确认 |
| B1 | 封禁后通话结束、出现提示屏、无设置按钮、无持续重连刷屏 | 通过 | 用户确认 |
| B2 | 封禁期间点「再试一次」仍是提示屏 | 通过 | 用户确认 |
| B3 | 解封后点「再试一次」回到聊天并能正常说话 | 通过 | 用户确认 |
| C1 | 停用当前角色（小暖）后回到选择页，顶部原因与置灰/锁正确 | 通过 | 用户确认 |
| C2 | 选另一个角色能正常聊天 | 通过 | 用户确认 |
| C3 | 强制停止并重启 App 后仍置灰 | 通过 | 用户确认 |
| C4 | 置灰到期后恢复 | 跳过：默认 24 小时，未等待；本机小暖会保持置灰约 24 小时后自动恢复 | — |

C1 使用手机当时实际在用的**小暖**（计划示例为小欣）；角色停用的复制/置灰行为一致，用户确认。

## 跳过与问题

- C4 未实等到期：不修改默认 24 小时配置；测试机的小暖置灰将在约 24 小时后自动恢复。
- 本次手机测试使用临时 Mock 库。App 在测试中把本机 device token 换成临时库的新 owner；旧线上 owner 的 token 在本机被覆盖，无法恢复。按用户确认切回线上后，App 会注册一个新的线上 owner，旧线上 owner 的记忆不会自动接上（blockers #65 的已知 401 拆分类别）。真实库未被删除或改写；旧 owner 数据仍在库中。
- 临时网关/后台已停止，临时库已删除；线上 8787 网关保持运行（qwen），未改动线上配置。
