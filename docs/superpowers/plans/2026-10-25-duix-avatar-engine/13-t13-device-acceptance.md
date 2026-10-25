# Task 13: 真机验收、零外发确认与文档收尾

**Files:**
- Create: `docs/testing/2026-10-25-duix-acceptance.md`
- Modify: `docs/project/roadmap.md`
- Modify: `docs/blockers.md`（只在有失败项或跳过项时）
- Modify: `app/assets/config/duix.json`（只在 Step 3 证实外发无法去掉时，把 `debugOnly` 改为 `true`）

**Interfaces:**
- Consumes: Task 1–12 的全部产物。
- Produces: 验收记录（「必须通过」逐项结论 + 「记录实测值」），以及 roadmap 状态。

规则（spec §10、D8）：
- 「必须通过」任何一项失败，都不算完成。记 blocker 并报告，不许把失败写成通过。
- 「记录实测值」只记录，不卡验收；但每一项都要写真实数值，或者写 `NOT RUN：<原因>`。
- 主观项写明「用户确认」。

先准备环境：
- 按 roadmap「Repo notes」启动本地网关（ADAPTER=qwen，端口 8787，`APP_SECRET` 取自 `app/dev.json`），然后 `adb reverse tcp:8787 tcp:8787`。
- 构建并安装：
  ```bash
  ./scripts/duix/build-sdk.sh            # skip if libs/duix-sdk-release.aar is current
  cd app && flutter build apk --debug --dart-define-from-file=dev.json
  adb install -r build/app/outputs/flutter-apk/app-debug.apk
  ```

- [x] **Step 1: 静态零外发检查（APK 层面）**

```bash
cd app && rm -rf /tmp/duix-apk && mkdir /tmp/duix-apk && unzip -q build/app/outputs/flutter-apk/app-debug.apk -d /tmp/duix-apk
grep -rlaE 'guiji\.ai|guiji\.cn|sysEventReport' /tmp/duix-apk/classes*.dex /tmp/duix-apk/lib || echo "no telemetry strings"
rm -rf /tmp/duix-apk
```

Expected：输出 `no telemetry strings`。

- [x] **Step 2: 确认抓包工具可用（假设 A8）**

1. 在手机上安装 PCAPdroid（Google Play 或 F-Droid），授予 VPN 权限。
2. Target app 选 `com.anyidea.avatar_app`，开始抓包。
3. 在 App 里打开「真人形象」，点「开始下载」，等进度出来后点「取消下载」。
4. 在 PCAPdroid 的连接列表里确认能看到 `github.com` 或 `objects.githubusercontent.com` 的 HTTPS 连接。

能看到就说明工具能按 App 抓到 HTTPS 的目标域名，A8 成立。看不到就改用 `adb shell dumpsys connectivity` 和路由器日志的组合方案，并在记录里写明；两种都不行，就记 blocker（隐私项 NOT RUN）。

- [x] **Step 3: 真机零外发（必须通过）**

保持 PCAPdroid 只抓本 App，然后：
1. 完成真人形象下载（第一次大约 174 MB）。
2. 在主页切换到真人形象，确认后等 Lily 出现。
3. 进行 3 轮对话。
4. 切回 3D，再切回真人形象一次。

在连接列表里确认：除了 GitHub 下载和 `127.0.0.1`（走 adb reverse 的网关），没有任何连接，尤其是没有 `guiji`、`duix`、`vshow` 相关的域名。截一张连接列表的图，只放在本机 `/tmp`，不入库；在记录里写出看到的域名清单。

如果出现上报连接：
- 把 `app/assets/config/duix.json` 的 `debugOnly` 改为 `true`；
- 在 `docs/blockers.md` 新增一条「Duix 上报未能去除」，写上看到的域名和时间点；
- 这一项判为失败，继续做其余各项，最终报告里写明。

- [x] **Step 4: 必须通过的功能项**

每一项都请用户在手机上操作并确认，同时抓日志：`adb logcat -c` 之后，再执行 `adb logcat -s flutter:I anyidea.diag:I | grep anyidea.diag`。

| # | 项 | 操作 | 通过标准 |
|---|---|---|---|
| M1 | 不崩溃、不黑屏 | 切到真人形象，聊 5 分钟 | Lily 一直可见；logcat 没有 `FATAL` |
| M2 | 有声音、嘴会动 | 听开场白和 3 轮回复 | 每轮都有声音；嘴随声音动（用户确认）；日志里有 `duix_playback_start ... lips=true` |
| M3 | 真实插话能停播 | 在回复播放 1 秒以上时大声插话，试 5 次 | 5 次都停播（用户确认）；每次日志都有 `duix_playback_end ... outcome=interrupted` |
| M4 | 短句能播完 | 长按「小柔」打开调试面板，输入「请只回答一个字：好」，试 3 次 | 每次都听到回复，日志都有 `duix_playback_end ... outcome=ended`，之后能继续对话 |
| M6 | 初始化失败自动退回 3D | 见下方命令 | 出现「真人形象没能打开，先用 3D 形象陪您聊」，3D 正常对话；日志有 `duix_fallback` |
| M7 | 3D 行为不变 | 在 3D 模式下聊 3 轮，插话 2 次，静音和挂断各 1 次 | 用户确认和改动前一致 |
| M8 | 零外发 | Step 3 | 通过 |

M6 的模拟方法：保留目录和校验文件，删掉 Lily 的其余文件，让 `prepare` 失败。

```bash
D=/sdcard/Android/data/com.anyidea.avatar_app/files/duix/model/Lily
adb shell "cd $D && ls -A | grep -v '^.anyidea-sha256$' | while read f; do rm -rf \"\$f\"; done"
# Relaunch the app (saved engine = Duix) and observe the fallback; then restore:
adb shell rm -f $D/.anyidea-sha256        # the app now sees Lily as not installed
# Re-download in the app, or: ./scripts/duix/push-models.sh com.anyidea.avatar_app
```

- [x] **Step 5: 记录实测值（不卡验收）**

| # | 指标 | 方法 | 目标（参考） |
|---|---|---|---|
| R1 | 回声 RMS | 真人形象模式下，不说话听完 10 轮回复。每轮播完后打开调试面板，读 `audio.playback` 的 `activeRmsMax`，取 10 个值的最大值作为 p95 的估计 | ≤ 100 |
| R2 | 打断延迟 | M3 的 5 次插话中，用户感受从开口到停播的时间（主观，记「立刻 / 约半秒 / 超过 1 秒」） | ≤ 400 ms |
| R3 | 首句延迟 | 两种模式各聊 10 轮。每轮取日志里 `latency perceived_ms`，加上听到声音前的等待：3D 用 `playback_start hold_ms`，真人形象用 `duix_playback_start hold_ms`。算两种模式各自的 p50，再求差 | 真人形象比 3D 多出的部分 ≤ +300 ms |
| R4 | 帧率 | 对话 5 分钟，取日志里 `duix_stats fps` 的平均值，同时记 `slow_frames` 和 `max_frame_ms` | ≥ 24 |
| R5 | 30 分钟稳定性 | 真人形象模式连续对话或静候 30 分钟，每 5 分钟跑一次 `adb shell dumpsys meminfo com.anyidea.avatar_app \| grep -E 'TOTAL( PSS)?:'` 和 `adb shell dumpsys battery \| grep temperature` | PSS ≤ 1.5 GB；温度 ≤ 43 °C（battery 报的单位是 0.1 °C） |
| R7 | 页大小 | `adb shell getconf PAGESIZE` | 记录（4096 或 16384） |
| R8 | 口型等待超时 | 统计日志里 `lips=false` 出现的次数 | 记录 |

- [x] **Step 6: 写验收记录**

`docs/testing/2026-10-25-duix-acceptance.md` 的结构如下（尖括号部分换成真实结果）：

```markdown
# Duix 真人形象验收（<日期>）

- 提交：<git rev-parse --short HEAD>；AAR sha256：<app/android/app/libs/duix-sdk-release.aar.sha256>
- 设备：<型号 / SoC / Android / PAGESIZE / MemTotal>；网关：<adapter / 端口>
- 抓包工具：<PCAPdroid 版本，A8 结论>

## 必须通过

| # | 结论 | 证据（日志摘录或用户确认） |
|---|---|---|
| M1 | <通过/失败> | <…> |
| M2 | … | … |
| M3 | … | … |
| M4 | … | … |
| M6 | … | … |
| M7 | … | … |
| M8 | … | 看到的域名：<…> |

## 记录实测值

| # | 数值 | 备注 |
|---|---|---|
| R1 | <…> | |
| R2 | <…> | 主观 |
| R3 | 3D p50=<…>，真人形象 p50=<…>，差=<…> | |
| R4 | <…> | |
| R5 | <每 5 分钟的 PSS / 温度> | |
| R7 | <…> | |
| R8 | <…> | |

## 未通过、跳过与后续
<逐条列出，并链接 blockers.md 对应条目；没有就写「无」>
```

- [x] **Step 7: 全量回归**

```bash
cd app && flutter test && flutter analyze
cd android && ./gradlew :app:testDebugUnitTest && cd ../..
npm test && npm run typecheck
git diff --stat dev-master...HEAD -- gateway protocol avatar-core
git diff --check dev-master...HEAD
```

Expected：
- Flutter 和 Kotlin 测试全部通过；
- `npm test`、`npm run typecheck` 和改动前一致（本计划没有碰网关）；
- `git diff --stat ... -- gateway protocol avatar-core` 没有输出；
- `git diff --check` 没有输出。

把各命令的真实输出摘要（测试数量、通过数量）写进验收记录。

- [x] **Step 8: 更新 roadmap 和 blockers**

在 `docs/project/roadmap.md` 的最上方加一段 `## Duix 真人形象引擎（2026-10-25 起）`，写清：
- 状态：实现完成或未完成，验收结论；
- 交付内容：引擎接口、Duix 引擎、App 内下载、切换开关、崩溃保护；
- 真实跑过的测试命令和结果（数量）；
- 必须通过项的结论，以及实测值摘要（链接到验收记录）；
- 上线前门槛（spec §11）；
- 下一步。

在「Repo notes」里补一条：构建 Duix 版需要先运行 `./scripts/duix/build-sdk.sh`，前置环境见本计划总览；没有 AAR 时 App 会自动编成纯 3D 版。

有失败项或跳过项时，在 `docs/blockers.md` 末尾按现有格式各加一条。

- [x] **Step 9: 提交，然后请求代码评审**

```bash
git add docs/testing/2026-10-25-duix-acceptance.md docs/project/roadmap.md
git add docs/blockers.md                       # only if changed
git add app/assets/config/duix.json            # only if debugOnly changed in Step 3
git commit -m "docs: record the Duix avatar acceptance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

然后按 AGENTS.md §3 执行 requesting-code-review，评审范围是 `dev-master...duix-avatar`。处理完评审意见后，再执行 finishing-a-development-branch。合并、推送都要先问用户。

2026-10-25：代码评审已处理（无 Critical；播放与切换交接的修复在随后的提交里）。用户决定合并到本地 `master`、不推送，并删除 `duix-avatar`。
