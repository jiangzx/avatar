# 阻塞记录

规则：步骤卡住 ≤20 分钟仍未解决 → 手动验证一次 → 记录在下表 → 跳过继续。解除后把"状态"改为"已解除"并写明方式。

| # | 日期 | 任务/步骤 | 现象 | 已做的手动验证与结论 | 跳过的影响 | 解除条件 | 状态 |
|---|---|---|---|---|---|---|---|
| 1 | 2026-10-12 | Task 0 Step 2b | 没有小米真机可连接 | 未做设备验证（无设备）；已创建 AVD API31_Phone | 检查点 ① 无法进行；真机项在验收中写“未测” | 接上小米真机后补做 Step 2b 与检查点 ① | 未解除 |
| 2 | 2026-10-12 | Task 14 Step 7 | 可用的自动化浏览器（ego-browser，Chrome 152 内核）中 `audioWorklet.addModule` 永远不返回，连最小 blob worklet、OfflineAudioContext 都一样；AppController 停在 `[loading]`；也无法代用户授予麦克风权限 | 已在该浏览器中验证：TalkingHead 头像加载、比心手势、口型 blendshape 可见；页面内 GatewayClient 走 Mock 网关：connecting→open→session.ready→greeting#1 音频与字幕→debugText"给我比心"→cancelled#1、transcript.user、avatar.action:heart（一次）、reply#2、response.end、closed；网关日志无对话文本 | Step 7 第 0–6 项的完整链路（worklet 播放、麦克风+VAD、口型同步、插话 0.2 秒停声、字幕截断、5 个动作、网关重启后重新问候）未验证 | 在真实桌面 Chrome 中按 Task 14 Step 7 手动跑一遍（戴耳机），结果记入 docs/testing/mock-e2e-checklist.md | 未解除 |
| 3 | 2026-10-12 | Task 16 Step 8–9（真机检查点 ① 部分；#1 的子项） | 没有小米真机，Step 8 能力探针与 Step 9 release 加载只在模拟器上跑过 | 【模拟器】Medium_Phone_API_36.1（Android 16，WebView 134）debug 包 8 项全部 OK；API31_Phone（Android 12，WebView 91.0.4472.114）debug 与 release 包 8 项均显示 OK，但 `webview` 低于"Chrome ≥120"的通过标准（模拟器镜像无法从商店更新 WebView）。两台都无手势时 AudioContext 为 `running`（`navigator.userActivation.hasBeenActive=false`），但无头模拟器听不到 0.3 秒提示音；麦克风只验证到 getUserMedia 成功与 `echoCancellation=true`，未验证真实拾音 | 真机的 WebView 版本、无手势 autoplay 与提示音、麦克风拾音与回声消除、GPU 名称、release 包 127.0.0.1 明文放行均未在小米上确认；失败退路暂不执行 | 接上小米真机后按 Task 16 Step 8–9 原命令重跑，结果以【真机】写入 ADR-001"其他 Day 1 验证项" | 未解除 |
