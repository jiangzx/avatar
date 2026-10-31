# Task 8: 真实 Qwen 冒烟、回归与收尾

**Files:**
- Create: `docs/testing/2026-10-31-realtime-model-switch-smoke.md`
- Modify: `docs/project/roadmap.md`
- Modify: `docs/blockers.md`（仅在需要记跳过/未验证项时）
- 探针：`gateway/scripts/probe-emotion-p2-qwen-style.ts`、`probe-emotion-p5-qwen-speech-rate.ts`、`probe-emotion-p5-qwen-speech-rate-update.ts`（已存在）

**Interfaces:**
- Consumes: T1–T7 的实现。
- Produces: 冒烟记录、回归结果、路线图状态、blocker（如有）。

背景：模型能力、音色质量和打断体感只能靠真实 Qwen 和试听确认。没有 Key 或没有真机时，按项目规则记 blocker 并跳过，不声称通过。

- [x] **Step 1: 确认 Key 与基线**

```bash
cd gateway
node --env-file-if-exists=.env -e "console.log({ key: Boolean(process.env.DASHSCOPE_API_KEY), endpoint: Boolean(process.env.QWEN_ENDPOINT), model: process.env.QWEN_MODEL, voice: process.env.QWEN_VOICE })"
```

Expected: 不打印 Key；`key` 和 `endpoint` 为 true。若为 false，记 `docs/blockers.md`，跳到 Step 6，只跑不需要 Key 的回归。

- [x] **Step 2: 提交探针脚本并跑两个模型**

工作区里的 `probe-emotion-p2-qwen-style.ts`（支持 `QWEN_TURN_DETECTION`）和 `probe-emotion-p5-qwen-speech-rate*.ts` 是本次新增/修改的探针；如果还没提交，先提交：

```bash
git add gateway/scripts/probe-emotion-p2-qwen-style.ts gateway/scripts/probe-emotion-p5-qwen-speech-rate.ts gateway/scripts/probe-emotion-p5-qwen-speech-rate-update.ts
git commit -m "chore(scripts): add realtime speech-rate probes"
```

然后：

```bash
# 3.8：无 speech_rate，instructions 仍不应被当成语气控制
QWEN_MODEL=qwen3.8-omni-flash-realtime \
  node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p2-qwen-style.ts --runs 2 --per-response-runs 2

# 3.1：server_vad；speech_rate 1.0 / 0.8 / 0.6
QWEN_MODEL=qwen-audio-3.1-realtime-flash QWEN_TURN_DETECTION=server_vad \
  node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p5-qwen-speech-rate.ts --runs 2

# 3.1：会话中途改 speech_rate 对下一轮生效
QWEN_MODEL=qwen-audio-3.1-realtime-flash QWEN_TURN_DETECTION=server_vad \
  node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p5-qwen-speech-rate-update.ts --runs 2
```

记录：每个 rate 的 `audioMsPctVs1`、`update` 的 `ratio`、错误码。写进冒烟记录；不写正文。

Expected: 3.1 的 0.8 约 +20%，0.6 约 +60%；中途 update 的 ratio 约 1.2–1.25。若方向不一致，记 blocker，不把语速当已实现。

- [x] **Step 3: 3.1 的语言、工具与输出上限**

```bash
# 只检查 session 接受与错误码；用合成句，不送用户内容
QWEN_MODEL=qwen-audio-3.1-realtime-flash \
  node --env-file-if-exists=.env --import tsx scripts/probe-qwen-languages.ts text
```

`probe-qwen-languages.ts` 当前用 `baseSession` 的默认 `semantic_vad`；如果 3.1 报 `invalid_value`，改用 T8 Step 2 的 `probe-emotion-p2`（它支持 `QWEN_TURN_DETECTION=server_vad`）做同样的 language/tool 检查，并记录命令与结果。不要把探针脚本改成产品代码。

另外检查 `max_response_output_tokens`：用 raw WS 发 `session.update`，带 `max_response_output_tokens: 16` 和一个长回复请求；看 `session.updated` 是否回显、回复是否被截断。若未生效，在 `docs/blockers.md` 记一条新 blocker，不假设上限有效。

- [ ] **Step 4: 后台切换与真机冒烟（需要 App/真机）**

1. 后台模型页把「通话用的模型」切到 `qwen-audio-3.1-realtime-flash`，发布，确认提示「下一通电话生效」。
2. 角色页确认每个角色、每种语言有两行声音；3.1 行选择该模型 catalog 中的音色，发布。
3. 真机开新会话，确认：能连接、能出声、工具动作可播、zh/ja/en 各说一句；低情绪后下一条回复明显变慢；换语后声音是新语言音色；没有 `model_reconnecting` 故障提示。
4. 切回 3.8，确认旧音色和行为不变。

没有真机/App 时，把这一项标为跳过并记 blocker；不要用单元测试替代真机体感。

- [ ] **Step 5: 音色试听**

在真机或 raw WS 生成每个角色、每种语言的短句 WAV，交用户试听：

- 3.1 的 `xiaokai` 是否男声、`xiaonuan`/`xiaoxin` 是否可区分；
- ja/en 是否自然，是否仍带中文口音到不可接受；
- 是否出现回落成同一个默认音色。

试听通过后删除音频；报告只写「通过 / 不通过 / 未试听」和角色/语言，不写正文。不通过时保留 3.8 默认，记 blocker，并替换 `realtime.json` 的候选音色后再试。

- [x] **Step 6: 全量回归**

```bash
npm test -w protocol
npm run typecheck -w protocol
npm test -w gateway
npm run typecheck -w gateway
npm test -w admin
npm run typecheck -w admin
npm run build -w admin
git diff --check
```

Expected: 全部通过；把实际命令和结果写进 `docs/testing/2026-10-31-realtime-model-switch-smoke.md`。

- [ ] **Step 7: 可选评估（只在要改默认模型时）**

P5 的旅程/共情评估基线是在 3.8 上跑的。只有用户决定把 3.1 设为默认时，才按 `docs/superpowers/plans/2026-10-28-relational-proactivity/00-overview.md` 的评估命令在 3.1 上重跑；未跑就不改默认。

- [x] **Step 8: 写冒烟记录与路线图**

`docs/testing/2026-10-31-realtime-model-switch-smoke.md` 包含：

- 环境（模型、端点主机、Key 是否存在，不写 Key）；
- 探针指标（speech_rate、update ratio、错误码）；
- 真机结果（模型切换、工具、三语、换语、无故障提示）；
- 音色试听结论（按角色/语言，不写正文）；
- 跳过的项与 blocker 编号；
- 实际跑过的回归命令与结果。

`docs/project/roadmap.md` 加一段「实时模型切换与每模型音色（2026-10-31）」：状态、交付、实测、跳过项、下一步（是否评估 3.1 默认）。不要把冒烟记录全文复制进 roadmap，链接即可。

- [x] **Step 9: 勾选计划并提交文档**

把本计划各任务文件的复选框按实际完成情况勾选；未完成的保持未勾选并在 roadmap 说明。

```bash
git add docs/testing/2026-10-31-realtime-model-switch-smoke.md docs/project/roadmap.md docs/blockers.md docs/superpowers/plans/2026-10-31-realtime-model-switch
git commit -m "docs: record the realtime model switch smoke and close out the plan"
```

如果 Step 4/5 没有真机或试听，不要勾选它们；在 roadmap 和 blockers 里写明原因。
