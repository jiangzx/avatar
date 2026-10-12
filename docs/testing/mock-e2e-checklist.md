# Mock 全链路验收清单（Plan 1 / Task 18）

前置：`npm run dev -w gateway`；`adb reverse tcp:8787 tcp:8787`；`./scripts/build-web.sh`；`cd app && flutter run --dart-define-from-file=dev.json`。
调试面板：长按左上角"AI 虚拟人"。每项写：通过/不通过 + 实测数据 + 备注，模拟器与真机分两列记录。
"环境"列：【模拟器】= 写代码阶段在模拟器上验证功能即可，检查点 ② 真机抽查；【真机】= 只有真机结果算数；【两者】= 模拟器验功能，数值以真机为准。
Mock 不识别语音内容：每检测到一段说话，就按 `gateway/mock/script.json` 的 `turns` 顺序给出下一条识别结果（说什么都一样）。需要指定内容时用调试框输入文字。

| # | 场景（spec §10） | 环境 | 操作 | 通过标准 | 模拟器结果 | 真机结果 |
|---|---|---|---|---|---|---|
| 1 | 主动迎宾 | 【两者】 | 冷启动 App，不触碰屏幕 | 自动开口问候；`greeting_ms` ≤2000【预估目标】；另用秒表记"点图标到开口"的秒数 | 未测：模拟器不可用（API31_Phone 仅 2 GB 内存，WebView 渲染进程被 lowmemorykiller 杀掉，见 blockers #6；磁盘仅剩约 1.8 GiB，不能新开模拟器或 flutter build） | 未测：缺少真机 |
| 2 | 多轮链路 | 【两者】 | 连续说 5 句话（识别结果按脚本顺序） | 每轮 listening→thinking→speaking→idle；字幕与脚本一致；无卡死 | 未测：模拟器不可用（API31_Phone 仅 2 GB 内存，WebView 渲染进程被 lowmemorykiller 杀掉，见 blockers #6；磁盘仅剩约 1.8 GiB，不能新开模拟器或 flutter build） | 未测：缺少真机 |
| 3 | 打断零残留 | 【两者】 | AI 说话时插话，重复 20 次 | 每次声音迅速停止；`interrupt_stop_ms` P50 ≤300、P90 ≤500【预估目标】；旧回复的声音/字幕 0 次再出现 | 未测：模拟器不可用（API31_Phone 仅 2 GB 内存，WebView 渲染进程被 lowmemorykiller 杀掉，见 blockers #6；磁盘仅剩约 1.8 GiB，不能新开模拟器或 flutter build） | 未测：缺少真机 |
| 4 | 动作 | 【两者】 | 调试框依次输入 5 个动作指令各 2 次；再用语音继续说，直到轮到脚本里含"挥""比心"的两条（`turns` 第 3、4 条，循环使用；想从头开始就重启网关并重开 App） | 动作正确且每次只执行一次（关键词与工具调用去重）；动作期间口型正常；`action_latency_ms` ≤1000 | 未测：模拟器不可用（API31_Phone 仅 2 GB 内存，WebView 渲染进程被 lowmemorykiller 杀掉，见 blockers #6；磁盘仅剩约 1.8 GiB，不能新开模拟器或 flutter build） | 未测：缺少真机 |
| 5 | 静默追问 | 【模拟器】 | 迎宾结束后保持沉默 40 秒 | 约 8 秒后追问"刚才聊到这儿…"1 次，再约 25 秒后说"我在这儿呢，想聊随时叫我。"，之后不再主动开口 | 部分（仅网关级，非通过）：无头脚本观察到播放结束后约 8.4 s 追问、再约 25.3 s 说收尾语，之后至 50 s 无更多；App/WebView 链路未测。未测：模拟器不可用（API31_Phone 仅 2 GB 内存，WebView 渲染进程被 lowmemorykiller 杀掉，见 blockers #6；磁盘仅剩约 1.8 GiB，不能新开模拟器或 flutter build） | 不适用（仅模拟器项，检查点 ② 真机无需做） |
| 6 | 口型/状态一致 | 【两者】 | 观察 3 轮对话 | 嘴只在 AI 出声时动；打断瞬间嘴合上；listening 时有注视和轻点头 | 未测：模拟器不可用（API31_Phone 仅 2 GB 内存，WebView 渲染进程被 lowmemorykiller 杀掉，见 blockers #6；磁盘仅剩约 1.8 GiB，不能新开模拟器或 flutter build） | 未测：缺少真机 |
| 7 | 静音 | 【模拟器】 | 点麦克风按钮静音后说话 | 不触发任何回复；Director 不追问；再次点击恢复 | 未测：模拟器不可用（API31_Phone 仅 2 GB 内存，WebView 渲染进程被 lowmemorykiller 杀掉，见 blockers #6；磁盘仅剩约 1.8 GiB，不能新开模拟器或 flutter build） | 不适用（仅模拟器项） |
| 8 | 短断网续接 | 【两者】 | **注意：`adb reverse` 不经过设备网络，开飞行模式不会断开它，本项不能用 127.0.0.1。** 模拟器：`dev.json` 的 `GATEWAY_URL` 改为 `http://10.0.2.2:8787`（模拟器访问电脑的地址，只有 debug 包允许明文），重新 `flutter run`，对话中执行 `adb shell cmd connectivity airplane-mode enable`，10 秒后 `... disable`（命令不可用时用模拟器下拉快捷设置里的飞行模式）。真机：`dev.json` 的 `GATEWAY_URL` 改为 `http://<电脑局域网 IP>:8787`（只有 debug 包允许明文访问局域网），手机与电脑连同一 Wi-Fi，重新 `flutter run`；对话中开飞行模式 10 秒再关（macOS 防火墙弹窗时允许 node 接入） | 状态显示"网络有点慢"→ 恢复；AI 说"刚才网络断了一下，我们接着聊吧。"；没有旧音频；网关日志出现 `session_resumed`（若先出现 `ws_heartbeat_timeout` 或 `connection_superseded` 也属正常） | 未测：模拟器不可用（API31_Phone 仅 2 GB 内存，WebView 渲染进程被 lowmemorykiller 杀掉，见 blockers #6；磁盘仅剩约 1.8 GiB，不能新开模拟器或 flutter build） | 未测：缺少真机 |
| 9 | 长断网 | 【两者】 | 同第 8 项的方式（模拟器用 `10.0.2.2`，真机用局域网 IP），断网 70 秒后恢复 | 建立新会话并重新迎宾，问候有声音、有字幕 | 未测：模拟器不可用（API31_Phone 仅 2 GB 内存，WebView 渲染进程被 lowmemorykiller 杀掉，见 blockers #6；磁盘仅剩约 1.8 GiB，不能新开模拟器或 flutter build） | 未测：缺少真机 |
| 10 | 切后台 | 【真机】 | 回到桌面 30 秒再返回 | App 不崩溃；回来后能继续对话（记录是否需要重连） | 不适用（仅真机） | 未测：缺少真机 |
| 11 | 来电 | 【真机】 | 用另一部手机拨入，挂断后观察 | 不崩溃；记录音频是否恢复 | 不适用（仅真机） | 未测：缺少真机 |
| 12 | 30 分钟稳定性 | 【真机】 | 每 1–2 分钟说一句话，持续 30 分钟 | 0 次崩溃；调试面板记录帧率（chrome://inspect 的 Performance 或肉眼）；机身温度主观记录 | 不适用（仅真机） | 未测：缺少真机 |
| 13 | 日志合规 | 【模拟器】 | 检查网关终端输出 | 只有事件名和数值，无任何对话文本 | 部分（仅网关级，非通过）：无头运行期间网关 stdout 只有事件名与数值，未出现对话文本；App 联调下的终端输出未测。未测：模拟器不可用（API31_Phone 仅 2 GB 内存，WebView 渲染进程被 lowmemorykiller 杀掉，见 blockers #6；磁盘仅剩约 1.8 GiB，不能新开模拟器或 flutter build） | 不适用（仅模拟器项，检查点 ② 真机无需做） |

## Step 0 首跑核对（页面完整模式）

状态（2026-10-12）：全部**未做**——没有可用模拟器（2 GB 内存被杀、磁盘不足）和真机，也未执行 `./scripts/build-web.sh` 之后的 `flutter run`。

| # | 核对项 | 环境 | 结果 |
|---|---|---|---|
| 0.1 | 页面加载、虚拟人出现、无需点击即开始 Mock 问候 | 模拟器/真机 | 未测：无设备 |
| 0.2 | 调试面板 `audio_context=running`、`echoCancellation=true`、`greeting_ms` 有数值 | 模拟器/真机 | 未测：无设备 |
| 0.3 | 调试框输入"挥挥手"：挥手并说"好呀，来，挥挥手！" | 模拟器/真机 | 未测：无设备（网关级仅见 `avatar.action`，见报告） |
| 0.4 | 对着手机说话：listening→thinking→speaking，字幕为脚本下一条 | 模拟器/真机 | 未测：无设备 |
| 0.5 | `chrome://inspect` 控制台无 `ERR_CLEARTEXT_NOT_PERMITTED`/`NotAllowedError`/worklet/wasm 加载失败 | 模拟器/真机 | 未测：无设备 |
| 0.6 | 外放问候与追问时是否出现自己冒出来的用户字幕；按需调 `MOCK_SPEECH_THRESHOLD` | 仅真机 | 未测：缺少真机；阈值保持 `gateway/.env` 现值，未调 |
