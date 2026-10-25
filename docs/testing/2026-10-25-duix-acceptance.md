# Duix 真人形象验收（2026-10-25）

- 提交：实现 `737396c`；AAR sha256：`cd357cd379f0bb69865fb0d04c42f13f85da270c617154e3abf23ebbce011ccb`
- 设备：Xiaomi 22101317C / sunstone / holi / Android 13 / PAGESIZE 4096 / MemTotal 7635452 kB；网关：`127.0.0.1:8787`，`/healthz` 返回 `{"ok":true}`，本次未重启，未重新打印 adapter
- 抓包工具：PCAPdroid 2.0.2。A8 成立：目标 App `com.anyidea.avatar_app` 的连接里能看到 `github.com` 和 `release-assets.githubusercontent.com`

本地没有 `dev-master` 分支。回归对比用 `master`（`b3818ea`，与 `origin/master` 相同，即本分支分出点）。

## 必须通过

| # | 结论 | 证据（日志摘录或用户确认） |
|---|---|---|
| M1 | 通过 | 18:30:19 `duix_prepare result=ok`、`duix_ready`。`duix_stats` 从 18:30:24 到 18:34:50 每 5 秒一条，无断档。进程保持 `6104`，logcat 无 `FATAL`。结束画面 Lily 可见，开关在「真人形象」。观察窗口约 4 分 30 秒，用户结束观察 |
| M2 | 通过 | 用户确认嘴跟着声音动。播放日志多次 `duix_playback_start ... lips=true`。M1 窗口内 seq=5（18:31:37）为 `lips=false` |
| M3 | 通过 | 用户做完插话。18:36:03–18:36:30 连续 8 次 `duix_playback_end ... outcome=interrupted`，其中至少 5 次 `played_ms` 为 1000–1520 |
| M4 | 通过 | 三次短回复都播完：seq=19 / 22 / 24，均为 `outcome=ended`，`played_ms=720`。之后 seq=25 又开始播放 |
| M6 | 未执行 | 未删 Lily 文件，未观察退回 3D |
| M7 | 未执行 | 本次没有在最终包上重做 3D 的 3 轮对话、2 次插话、静音和挂断 |
| M8 | 未通过 | 见下方域名。没有 `guiji` / `duix` / `vshow`。`debugOnly` 仍为 false |

## 记录实测值

| # | 数值 | 备注 |
|---|---|---|
| R1 | NOT RUN | 未读 `activeRmsMax` |
| R2 | NOT RUN | 未记主观停播感受 |
| R3 | NOT RUN | 没有按两种模式各 10 轮采集，不计算差值 |
| R4 | 平均 fps 23.85（59 条，18:30:24–18:35:19）；`slow_frames` 合计 187；`max_frame_ms` 最大 131 | 参考目标 ≥ 24。不卡验收 |
| R5 | NOT RUN | 未做 30 分钟 |
| R7 | 4096 | `adb shell getconf PAGESIZE` |
| R8 | `lips=false` 3 次 | 18:24 seq=5、seq=7；18:31:37 seq=5 |

## 零外发域名

PCAPdroid 只抓 `com.anyidea.avatar_app`，连接列表从顶滚到底。截图在本机 `/tmp/pcapdroid-connections.png`，不入库。

看到的域名：

- `github.com`：DNS 与短 HTTPS
- `release-assets.githubusercontent.com`：模型下载，约 168.4 MB，18:23 结束
- `content-autofill.googleapis.com`：从 18:20:41 起大约每 30 秒一条，归在 `avatar_app`，状态为「错误」，每次约 280–340 字节。真人形象播放期间也有，切回 3D 之后还在

`127.0.0.1` 没有出现。网关走 adb reverse 的回环，PCAPdroid 的 VPN 抓不到；对话日志里有播放，说明网关是通的。

这不是 Duix 的 `vshow.guiji.ai` 上报，所以没有把 `debugOnly` 改成 true，也没有按「上报未能去除」记 blocker。按「除了 GitHub 下载和本机网关不能有别的连接」，M8 未通过。

## 全量回归（2026-10-25）

- `cd app && flutter test`：265 项全部通过
- `cd app && flutter analyze`：No issues found
- `cd app/android && ./gradlew :app:testDebugUnitTest`：BUILD SUCCESSFUL（`:app:testDebugUnitTest` UP-TO-DATE）。JUnit 报告 39 项、0 失败
- `npm test`：protocol 6 项通过；gateway 56 个文件 839 项通过；avatar-core 18 个文件 125 项通过
- `npm run typecheck`：退出码 0
- `git diff --stat master...HEAD -- gateway protocol avatar-core`：无输出
- `git diff --check master...HEAD`：无输出

## 界面

Task 12 截图（只在 `/tmp`，不入库）：开关在小柔下方居中，文案为「3D 形象 / 真人形象」，不压住小柔和状态字。系统字号 1.3 时标签没有被截断，字幕卡片和底部按钮仍在。测完已把 `font_scale` 设回 1.0。

## 未通过、跳过与后续

- M5：已从验收删除，不再作为必须通过项。见 blockers #54
- M6：未执行。见 blockers #55
- M7：未执行。见 blockers #56
- M8：`content-autofill.googleapis.com`。见 blockers #57
- R1、R2、R5：未测。R6 随 M5 删除。见 blockers #58
