# 迁移到新电脑：环境、依赖与继续开发指南

> 记录于 2026-10-12，对应仓库 `master` 分支（见文末“版本快照”）。目标：在另一台电脑上得到与当前机器**完全一致**的环境和依赖，并让新电脑上的 AI agent 读完本文件就能接着干。
> 新电脑上的 agent：**先读本文件全文，再读 `AGENTS.md` 和 `docs/project/roadmap.md`，然后按第 9 节的验证清单确认环境，再继续工作。**

## 0. 一眼看懂

- 项目：AI 虚拟人语音聊天 POC（Android 手机优先）。Monorepo：`protocol/`（共享协议）、`gateway/`（Node 24 + TS）、`avatar-core/`（Vite + TS，WebView 里跑 three.js 虚拟人）、`app/`（Flutter Android 壳）。
- 当前状态：**Plan 1 代码完成，带阻塞**（详见 `docs/project/roadmap.md`）。没有任何真机或真实浏览器验证；ADR-001 是草稿。
- 当前机器没有 git 远端（`git remote -v` 为空）。**仓库必须用 bundle 或整目录拷贝迁移**（第 1 节）。
- 不在 git 里、必须在新电脑上重新生成或手动拷贝的东西：第 2 节。

## 1. 迁移仓库（没有远端，二选一）

推荐 git bundle（保留全部 49+ 个提交和分支）：

```bash
# 旧电脑（在仓库根目录）
git status --short            # 只应看到未跟踪的 .codegraph/；如有别的改动先提交
git bundle create ~/anyidea.bundle --all
git bundle verify ~/anyidea.bundle
# 把 ~/anyidea.bundle 拷到新电脑（AirDrop/U 盘/scp）

# 新电脑
git clone ~/anyidea.bundle anyidea       # 得到 master 分支
cd anyidea && git log --oneline | head -3   # 与文末“版本快照”的 HEAD 对照
```

或者整目录拷贝（含未跟踪文件），但**不要拷** `node_modules/`、`app/build/`、`app/.dart_tool/`、`avatar-core/dist/`、`app/android/.gradle/`（体积大且可重建）。

## 2. 不在 git 里的内容（新电脑必须处理）

| 内容 | 位置 | 怎么处理 |
|---|---|---|
| 网关密钥与配置 | `gateway/.env`（git 忽略） | **不要拷贝旧密钥**。`cp gateway/.env.example gateway/.env`，把 `APP_SECRET` 改成新生成的随机串（`openssl rand -hex 24`；≥16 位，且不能以 `change-me` / `same-as-` 开头，否则网关拒绝启动）。其余保持 `.env.example` 默认值：`PORT=8787`、`ADAPTER=mock`（只接受 mock）、`ALLOW_DEBUG_TEXT=1`、`DEV_ORIGINS=http://localhost:5173`、`MOCK_SPEECH_THRESHOLD=800` |
| App 运行配置 | `app/dev.json`（git 忽略） | `cp app/dev.example.json app/dev.json`，`APP_SECRET` 填成与网关**相同**的值；`GATEWAY_URL` 默认 `http://127.0.0.1:8787`（模拟器/真机用 `adb reverse tcp:8787 tcp:8787`；模拟器也可用 `http://10.0.2.2:8787`，仅 debug 包允许明文）；`AUDIO_PATH=A`、`ECHO=true` |
| Mock 语音 PCM | `gateway/mock/speech-24k.pcm`、`avatar-core/public/spike/speech-24k.pcm` | macOS：`./scripts/make-mock-speech.sh`（用 `say` 的 zh_CN 音色 + `afconvert` + `python3 -I`）。**非 macOS：脚本不可用，直接把旧电脑的这两个文件拷过去**（24 kHz、PCM16 LE、单声道，当前约 813 KB） |
| 临时虚拟人 GLB | `avatar-core/public/avatars/avatar.glb`（约 4.7 MB，CC BY-NC 4.0，仅内部演示） | `./scripts/fetch-assets.sh`（从 GitHub `met4citizen/TalkingHead` 的 `main` 分支下载，**未固定版本**；要与当前完全一致就从旧电脑拷贝该文件） |
| 可选挥手动画 | `avatar-core/public/animations/waving.fbx` | 当前机器**没有**此文件（挥手退回内置 `handup`）；无需处理 |
| VAD/ORT 资源 | `avatar-core/public/vad/` | `npm run assets -w avatar-core`（`npm run build/dev` 会自动执行；从 `node_modules` 复制 11 个文件） |
| Flutter 内嵌 Web 资源 | `app/assets/web/` | `./scripts/build-web.sh`（完整模式；`--probe-only` 只放探针页） |
| 构建产物与缓存 | `node_modules/`、`avatar-core/dist/`、`app/build/`（旧机上 2.1 GB）、`app/.dart_tool/`、`app/android/.gradle/` | 不迁移，按下文命令重建 |
| `app/android/local.properties`、`gradlew`、`gradle-wrapper.jar` 等 | git 忽略 | `flutter pub get` / 首次构建时由 Flutter 生成；`local.properties` 里的 `sdk.dir` 会自动指向新机 SDK |
| Claude Code 个人配置、技能、记忆 | `~/.claude/...` | 见第 8 节 |
| 本会话的 SDD 台账（每任务简报/报告/审查/diff） | `.superpowers/sdd/`（git 忽略） | 可选拷贝：`cp -R .superpowers /新电脑/anyidea/`；不拷也没关系，结论已写进 `docs/project/roadmap.md`、`docs/blockers.md`、计划文件勾选状态 |
| CodeGraph 索引 | `.codegraph/`（未跟踪，也未忽略） | 可选；新电脑装了 codegraph 后 `codegraph init` 重建即可。是否提交/忽略由用户决定，不要擅自处理 |

## 3. 主机环境（与当前机器一致）

当前机器：MacBook（Apple Silicon `arm64`），macOS 26.7.1（25G241）。**强烈建议新电脑同为 Apple Silicon macOS**（Mock 语音脚本依赖 `say`/`afconvert`；Android 模拟器镜像用的是 `arm64-v8a`）。若是 x86 或其他系统，需把 system image 换成对应架构，并手动拷贝语音 PCM（第 2 节）。

| 工具 | 版本（当前机器） | 说明 |
|---|---|---|
| Node.js | **24.21.0**（`engines: node >=24`） | 网关使用 `node --env-file-if-exists --import tsx` |
| npm | **12.1.0** | 使用 workspaces；安装依赖请用 `npm ci`（严格按 `package-lock.json`）。npm 可能提示 `fsevents`/`protobufjs` 的安装脚本被 `allowScripts` 拦截——已确认不影响测试与构建，不要放行 |
| Python | 3.12.14 | 仅 `make-mock-speech.sh` 内用 `python3 -I` 转 WAV→PCM（只用标准库 `wave`） |
| git | 2.55.0 | |
| Flutter | **3.47.6**（stable，framework revision `5fc346839b5d0eef006ed8404392afb4dfae428d`，Engine `692136cb65`，Dart **3.13.5**，DevTools 2.60.0） | 当前安装路径 `/Users/JedJiang/Documents/flutter`（路径可不同）。安装：`git clone https://github.com/flutter/flutter.git -b stable ~/flutter && cd ~/flutter && git checkout 5fc346839b5d0eef006ed8404392afb4dfae428d`（按 revision 固定最稳；若该 revision 已无法检出，先试 `git checkout 3.47.6`——此 tag 名未在本机核实，属假设），然后 `flutter --version` 对照 |
| JDK | **Flutter 用 Android Studio 自带 JBR：OpenJDK 21.0.9**（`flutter doctor -v` 显示）。系统另有 JDK 25.0.4（默认）和 `jdk-17.jdk` | 不需要设置 `flutter config --jdk-dir`；Gradle 编译目标为 Java 17（`sourceCompatibility = VERSION_17`）。若 Gradle 因 JDK 25 报 “Unsupported class file major version”，执行 `flutter config --jdk-dir "/Applications/Android Studio.app/Contents/jbr/Contents/Home"` |
| Android Studio | 已安装于 `/Applications/Android Studio.app`（用于提供 JBR 21、AVD 管理；本机未核实具体版本，装当前稳定版即可，要求其 JBR 为 21.x） | |
| Xcode / CocoaPods / Chrome | Xcode 26.2、CocoaPods 1.17.0、Google Chrome 154.0.8037.100 | 本项目只做 Android；Chrome 用于桌面调试 `npm run dev -w avatar-core`（:5173）。Xcode 不是必需 |
| Gradle / AGP / Kotlin | Gradle **9.3.1**（wrapper，`gradle-wrapper.properties`）、Android Gradle Plugin **9.1.0**、Kotlin **2.4.0**（`app/android/settings.gradle.kts`） | 首次构建自动下载，无需手装 |
| 命令行工具 | `adb`（platform-tools 36.0.2）、`rg`、`curl`、`lsof`、`say`、`afconvert` | `rg` 非必需，但 agent 与脚本会用；`say`/`afconvert` 为 macOS 自带 |

### 当前 shell 的环境变量（只在 shell 中设置，不要写进 rc 文件，除非用户自己决定）

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
flutter config --android-sdk "$ANDROID_HOME"
```

## 4. Android SDK（精确清单）

当前 `sdkmanager --list_installed`：

```
build-tools;35.0.0   build-tools;36.0.0   build-tools;36.1.0
cmake;3.22.1
cmdline-tools;latest (20.0)
emulator (36.4.9)
ndk;28.2.13676358
platform-tools (36.0.2)
platforms;android-33  android-34  android-35  android-36  android-36.1  android-37.0
sources;android-36.1
system-images;android-31;google_apis;arm64-v8a
system-images;android-36.1;google_apis;arm64-v8a
system-images;android-36.1;google_apis_playstore;arm64-v8a
system-images;android-36;google_apis_playstore;arm64-v8a
```

新电脑上一次装齐（先装 Android Studio 并让它创建 `~/Library/Android/sdk`，或手动放 cmdline-tools）：

```bash
yes | sdkmanager --licenses
sdkmanager "platform-tools" "emulator" "cmake;3.22.1" "ndk;28.2.13676358" \
  "build-tools;35.0.0" "build-tools;36.0.0" "build-tools;36.1.0" \
  "platforms;android-33" "platforms;android-34" "platforms;android-35" "platforms;android-36" "platforms;android-36.1" "platforms;android-37.0" \
  "system-images;android-31;google_apis;arm64-v8a" \
  "system-images;android-36.1;google_apis;arm64-v8a"
flutter doctor -v     # Android toolchain 必须 [✓]，且 “All Android licenses accepted”
```

要点：项目的 `compileSdk = 37`（`permission_handler_android` 14.1.0 要求）；`app/android/build.gradle.kts` 里有一个根级 hook，把 `flutter_pcm_sound` 等低于 36 的插件库的 `compileSdk` 提到 36（只提不降）。这是计划已记录的工具链偏差，**不要“清理”掉**。

### 模拟器（AVD）

当前三个 AVD：

| 名称 | 设备 | 镜像 | 内存 | 备注 |
|---|---|---|---|---|
| `API31_Phone` | pixel_6 | android-31 google_apis arm64-v8a（Android 12，WebView 91） | 2 GB，data 6 GB | 覆盖 spec 的 Android 12 下限；**唯一在旧机上能启动的**，但 2 GB 内存下 WebView 渲染进程会被低内存杀掉（blockers #6） |
| `Pixel_9_Pro_XL` | pixel_9_pro_xl | android-36.1 google_apis arm64-v8a（Android 16） | 2048 MB，data 6 GB | 旧机磁盘不足时拒绝启动 |
| `Medium_Phone_API_36.1` | 默认 medium phone | android-36.1 | — | 探针在其上通过（WebView 134）；config 文件当前不在 `~/.android/avd/` 的常规位置 |

重建命令（新电脑内存/磁盘充足时，**建议把内存调大到 ≥4 GB 以解决 #6**；这会让它与旧机不完全一致，属于有意改进，请在 `docs/blockers.md` #6 记录结果）：

```bash
echo no | avdmanager create avd -n API31_Phone -k "system-images;android-31;google_apis;arm64-v8a" -d pixel_6
# 调内存：编辑 ~/.android/avd/API31_Phone.avd/config.ini 中 hw.ramSize
emulator -avd API31_Phone -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &   # 记下 PID，用完 kill，不要 pkill -f
adb wait-for-device && adb shell getprop ro.build.version.release
```

模拟器麦克风需在 Extended controls → Microphone 打开“使用主机音频输入”（名称以界面为准）；Mac 上戴耳机，避免扬声器回声触发打断。

## 5. Node 依赖（精确版本；`package-lock.json` 已提交）

根 `package.json`：`workspaces: ["protocol","gateway","avatar-core"]`，`engines.node >=24`。**用 `npm ci` 安装**，不要 `npm install`（避免改动 lock）。

| 包 | 版本（lock 解析值） | 使用方 |
|---|---|---|
| typescript | 7.0.2 | 三个包（devDep） |
| vitest | 5.0.3 | 三个包（devDep） |
| vite | 8.3.4 | avatar-core |
| three / @types/three | 0.180.0 / 0.180.0 | avatar-core |
| @met4citizen/talkinghead | 1.7.0 | avatar-core |
| @ricky0123/vad-web | 0.0.31 | avatar-core |
| onnxruntime-web | 1.30.0 | avatar-core |
| ws / @types/ws | 8.22.0 / 8.18.2 | gateway |
| zod | 4.6.5 | gateway |
| tsx | 4.23.15 | gateway |
| @types/node | 26.6.4 | gateway |
| @anyidea/protocol | workspace `*` | gateway、avatar-core |

若 TypeScript 7 的 `tsc` 报“未知编译选项”，计划允许回退 5.9.3，但**当前没有发生过**，不要主动回退。

## 6. Flutter / Dart 依赖（`app/pubspec.yaml` + `app/pubspec.lock` 已提交）

直接依赖（固定版本）：

| 包 | 版本 |
|---|---|
| webview_flutter | 4.14.1 |
| webview_flutter_android | 4.14.1 |
| permission_handler | 13.0.2（Android 实现 permission_handler_android 14.1.0） |
| wakelock_plus | 1.8.1 |
| record | 7.1.2（record_android 2.2.0） |
| flutter_pcm_sound | 3.3.3 |
| cupertino_icons | ^1.0.8（lock 解析 1.0.9） |
| flutter_lints（dev） | ^6.0.0（lock 解析 6.0.0） |

`environment.sdk: ^3.13.5`。**用 `flutter pub get`**（会按 lock 解析；不要 `pub upgrade`）。`flutter analyze` 会提示若干包有更新但与约束不兼容，属正常。

## 7. 一步步复现（新电脑，按顺序）

```bash
# 0) 装好第 3、4 节的工具；确认 flutter doctor 全绿
# 1) 取代码（第 1 节），然后：
cd anyidea
npm ci                                              # 精确按 lock 安装（约 282 MB）
cp gateway/.env.example gateway/.env                # 编辑 APP_SECRET（见第 2 节）
cp app/dev.example.json app/dev.json                # APP_SECRET 与网关一致
./scripts/make-mock-speech.sh                       # 非 macOS 则改为拷贝两个 pcm 文件
./scripts/fetch-assets.sh                           # 或拷贝旧机 avatar.glb
npm run assets -w avatar-core                       # 生成 avatar-core/public/vad/
(cd app && flutter pub get)
```

日常运行（Mock，**不要在没清理磁盘前随便 `flutter build`**，见第 10 节）：

```bash
npm run dev -w gateway                       # 前台终端，:8787；停止用 Ctrl-C。若后台启动：GW_PID=$!; kill "$GW_PID"，不要 pkill -f
npm run dev -w avatar-core                   # 桌面 Chrome 调试 :5173（dev 面板仅 dev 构建存在；dev server 只监听 127.0.0.1）
./scripts/build-web.sh                       # 完整构建并拷进 app/assets/web（含 APP_SECRET 泄漏检查）
adb reverse tcp:8787 tcp:8787
cd app && flutter run --dart-define-from-file=dev.json
```

## 8. Claude Code / agent 环境（新电脑上让 agent 工作方式一致）

本项目的工作流和规则依赖下列**个人配置**（不在仓库里，需从旧电脑拷到新电脑 `~/.claude/` 或重新安装）：

1. `~/.claude/CLAUDE.md`：一律用中文沟通；CodeGraph 工作流（仓库有 `.codegraph/` 且 CodeGraph MCP 可用时优先用）；Skill Market（`skill` 命令）说明。
2. `~/.claude/rules/`：`security-baseline-rule.md`、`security-js.rule.md`、`security-python.rule.md`、`security-java.rule.md`、`security-c.rule.md`（安全开发规则；本项目主要用到 baseline 和 js）。
3. `~/.claude/skills/` 里的技能，本项目流程要用到：`subagent-driven-development`（含 `implementer-prompt.md`、`task-reviewer-prompt.md`）、`brainstorming`、`code-review`、`diagnosing-bugs`、`ego-browser`、`research`、`handoff` 等；以及与 superpowers 体系配套的 `writing-plans`、`executing-plans`、`test-driven-development`、`requesting-code-review`、`finishing-a-development-branch`（这些在本机由插件/技能市场提供，具体来源本机未逐一核实——新电脑上用同一套插件/技能市场安装；缺哪个就先 `skill -f json search <名称>`，**先读 skill-cli 的 SKILL.md 再用 `skill` 命令**，不要凭空发明技能）。注意：旧机的 `subagent-driven-development` 目录**没有** `scripts/task-brief`、`scripts/review-package`，上一轮会话用手写的 `sed`/`git diff` 代替。
4. 工具链 MCP：CodeGraph（`codegraph` 在 `~/.local/bin/codegraph`，版本 1.6.0）；`skill` CLI（`~/.local/bin/skill`）。是否需要在新电脑重装由用户决定；仓库的 `.codegraph/` 未被跟踪。
5. **项目记忆**（旧机路径 `~/.claude/projects/-Users-JedJiang-SourceCode-anyidea/memory/`，目录名由仓库绝对路径编码而来；新电脑仓库路径不同则目录名也不同）。如需带过去，把这 4 个文件 + `MEMORY.md` 拷到新电脑对应的 `memory/` 目录；也可以不拷，其要点都已写在 `AGENTS.md` 与本文第 11 节：
   - `project-avatar-voice-poc.md`：7 天 Android 虚拟人语音 POC；先写代码 + 模拟器 + 桌面 Chrome，再两个真机检查点；无模型 Key 前一切用 MockAdapter；模拟器结果绝不当真机结论。
   - `feedback-skip-when-blocked.md`：卡住时限时排查（≤20 分钟）→ 手动验证 → 记入 `docs/blockers.md` → 跳过并在汇报里列出，绝不静默跳过。
   - `feedback-fix-plan-defects.md`：审查者已复现的小型 Important 缺陷（含计划规定代码里的缺陷）→ 派更强模型修复、补回归测试并同步计划代码块，不必逐次询问；改冻结接口/验收标准/范围明显扩大时仍要问。
   - `MEMORY.md`：以上三条的索引。

模型/署名约定：本项目的提交署名统一为 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`（上一轮在用户同意下覆盖了计划里写死的 Opus 署名）。新机上若使用别的模型，请先确认署名约定，不要擅自改历史。

## 9. 环境一致性验证清单（新电脑逐条跑，期望值来自当前机器）

```bash
node -v && npm -v                               # v24.21.0 / 12.1.0
flutter --version                               # 3.47.6, Dart 3.13.5, revision 5fc346839b
flutter doctor -v                               # Android toolchain [✓]，Java 21.0.9 (Android Studio JBR)，licenses accepted
npm ci
npm test                                        # protocol 6 / gateway 93 / avatar-core 71 全部通过
npm run typecheck                               # 退出码 0
(cd app && flutter pub get && flutter test && flutter analyze)   # 19 个测试通过；No issues found
git status --short                              # 只应出现未跟踪的 .codegraph/（若拷贝了的话）
git log --oneline | head -3                     # 与文末版本快照对照
```

可选（不需要设备/模拟器，不会占大量磁盘）：`npm run build -w avatar-core`（构建应成功；构建时必须没有 `avatar-core/.env.local`）。

## 10. 已知环境限制与风险（新电脑上要重新评估）

- **磁盘**：旧机剩余约 1.7 GiB；`app/build/` 约 2.1 GB（曾被删除重建过一次）。新电脑建议预留 ≥15 GB（Flutter + Android SDK + 镜像 + 构建）。
- **模拟器内存**：旧机仅 2 GB AVD 可用，WebView 渲染进程在加载 Silero VAD 后被低内存杀掉（blockers #6，对产品页是推断）。新电脑若有条件，给 `API31_Phone` ≥4 GB。
- **没有小米真机**：所有设备结论缺失（blockers #1、#3、#4、#7）。新电脑如果能接真机，直接做真机检查点。
- **自动化浏览器**：旧机的 ego-browser（Chrome 152）里 `audioWorklet.addModule` 永不返回，桌面 Chrome 端到端联调没做（blockers #2）。新电脑用真实 Chrome 手动做，戴耳机。
- 第三方资源**未固定版本**：`avatar.glb` 从 GitHub `main` 下载，若要完全一致请拷贝旧机文件。

## 11. 项目要点速查（agent 必读摘要，细则以 `AGENTS.md` 为准）

- 回复用简体中文；代码注释英文且简短；**不要记录对话内容**（音频/ASR 文本/回复文本）到日志；不提交密钥；拿到模型 Key 之前只用 `ADAPTER=mock`；可调参数集中为配置或顶部导出的 `// TUNABLE` 常量；不发明依赖/API；**绝不 `git add -A`，只 add 显式路径**；未实际运行的验证不得声称通过。
- 流程：Superpowers。计划在 `docs/superpowers/plans/2026-10-12-avatar-poc-plan1/`（00-overview.md 为入口，含依赖表、全局约束、技术假设状态）；设计在 `docs/superpowers/specs/2026-10-12-avatar-voice-poc-design.md`（已批准，视为约束）；状态在 `docs/project/roadmap.md`；阻塞在 `docs/blockers.md`；ADR 在 `docs/adr/`（ADR-001 为草稿未决）。
- 冻结契约（改动前必须停下回报）：`protocol/src/index.ts`、`RealtimeAdapter`/`MockScript`、HTTP/WS 契约、Bridge（`avatar-core/src/bridge.ts` 的 `ToFlutter`/`FromFlutter`）。`avatar-core` 会校验 `FromFlutter` 并把 `config.gatewayUrl` 限制在白名单（127.0.0.1、localhost、10.0.2.2、RFC1918；仅 http/https，不允许 URL 内带用户信息）。
- 网络策略：release 包只对 `127.0.0.1` 放行明文；debug 包为联调放宽（有意例外）。
- Plan 1 范围：只做 Mock；真实适配器、云端部署、release APK 属 Plan 2。
- 当前未完成项与下一步：见 `docs/project/roadmap.md` 的“Next steps”和 `docs/blockers.md` #1–#7（尤其 #7 列出了剩余验收清单与要在真机/大内存模拟器上跑的命令）。

## 12. 给新电脑 agent 的提示词（整段复制即可）

```
你在一台新电脑上接手仓库 anyidea（AI 虚拟人语音聊天 POC，Android 手机优先）。请严格按顺序做：

1. 用简体中文与我沟通；代码和注释按项目约定（注释英文、简短）。
2. 先完整阅读 docs/migration/new-machine-setup.md（环境、依赖、复现步骤、验证清单、已知限制），然后阅读 AGENTS.md、docs/project/roadmap.md、docs/blockers.md。
3. 按该文档第 9 节验证环境与当前机器一致：Node 24.21.0、npm 12.1.0、Flutter 3.47.6（Dart 3.13.5，revision 5fc346839b）、Android SDK 清单、npm ci 的精确依赖、flutter pub get 的精确依赖。不一致就先停下来向我报告差异，不要自行升级或降级任何版本，不要 npm install / pub upgrade。
4. 按文档第 2、7 节补齐不在 git 里的文件：gateway/.env 与 app/dev.json（APP_SECRET 新生成且两处一致，绝不使用或打印旧密钥，也不要提交）、Mock 语音 PCM、avatar.glb、VAD 资源。
5. 运行验证并如实汇报真实输出：npm test（期望 protocol 6 / gateway 93 / avatar-core 71）、npm run typecheck、cd app && flutter test（期望 19 个）&& flutter analyze（期望无问题）。
6. 汇报：环境是否一致、有哪些差异或失败、磁盘/模拟器内存情况，并说明下一步建议（来自 roadmap 的 Next steps 与 blockers #7）。等我确认后再开始任何新开发。

硬规则（来自 AGENTS.md，不可违反）：不记录对话内容到日志；不提交密钥；拿到模型 Key 前只用 ADAPTER=mock；不发明依赖或 API；绝不用 git add -A，只 add 显式路径；没实际运行过的验证不得声称通过；卡住时限时 20 分钟、手动验证一次、记入 docs/blockers.md 后跳过并在汇报里列出；改动冻结契约（protocol、RealtimeAdapter/MockScript、HTTP/WS、Bridge）前先停下报告；真机或模拟器的结果要分开标注，模拟器结果不得当作真机结论。提交署名统一用 “Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>”（除非我另有说明）。
```

## 13. 版本快照（生成本文件时）

- 分支：`master`；无远端；本文件所在提交之前的最后一个功能/文档提交为 `fdc2308 docs: roadmap and plan status at end of Plan 1 execution`（之后会多一个提交加入本文件，请以 `git log --oneline | head -3` 实际输出为准）。
- 提交总数：49 个（含本文件之前）。
- 测试基线：protocol 6 / gateway 93 / avatar-core 71 / flutter 19，typecheck 与 flutter analyze 干净（2026-10-12 实测）。
