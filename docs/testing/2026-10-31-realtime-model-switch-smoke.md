# 实时模型切换冒烟记录（2026-10-31）

范围：`qwen3.8-omni-flash-realtime` 与 `qwen-audio-3.1-realtime-flash` 的模型切换、每模型音色、`speech_rate`。只记事件、计数、时长、字节数和错误码；不记对话正文。探针音频为合成句，试听后已删除。

## 环境

- 工作树：`/Users/jed/SourceCode/avatar`，分支 `feat/realtime-model-switch`，日期 2026-10-31。
- Node 24 / macOS；Qwen 使用 workspace 专属 MaaS endpoint（主机名不写），Key 从 `gateway/.env` 读取，未打印。
- 3.8：`qwen3.8-omni-flash-realtime`，`semantic_vad`，`longanlingxin`。
- 3.1：`qwen-audio-3.1-realtime-flash`，`server_vad`，候选音色 `longanlingxin_v3.1` / `xunanchuan_v3.1`。

## 1. Qwen instructions 对语气（对照）

命令：

```bash
QWEN_MODEL=qwen3.8-omni-flash-realtime \
  node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p2-qwen-style.ts --runs 2 --per-response-runs 2

QWEN_MODEL=qwen-audio-3.1-realtime-flash QWEN_TURN_DETECTION=server_vad \
  node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p2-qwen-style.ts --runs 2 --per-response-runs 2
```

3.8 结果：

| 模式 | A 时长 | B 时长 | 时长差 | RMS 差 | 结论 |
|---|---|---|---|---|---|
| session | 3860 ms | 3900 ms | +1.0% | +0.5% | 无可感知放慢/变轻 |
| per-response | 3940 ms | 3900 ms | -1.0% | -1.2% | 方向相反，不用 |

3.1 结果（同一次运行）：session A/B 均为 3520 ms / RMS 2678；per-response B 短 1.5%、响 1.9%。结论一致：**instructions 不能可靠控制语气**。

## 2. `speech_rate`（3.1）

命令：

```bash
QWEN_MODEL=qwen-audio-3.1-realtime-flash QWEN_TURN_DETECTION=server_vad \
  node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p5-qwen-speech-rate.ts --runs 2
```

| rate | 平均 audioMs | ms/char | RMS | 相对 1.0 |
|---|---|---|---|---|
| 1.0 | 3520 | 185 | 2739 | — |
| 0.8 | 4400 | 232 | 2696 | **+25.0%** |
| 0.6 | 5934 | 312 | 2676 | **+68.6%** |

RMS 基本不变，说明是语速变化而不是音量变化。

## 3. 会话中途改 `speech_rate`（3.1）

命令：

```bash
QWEN_MODEL=qwen-audio-3.1-realtime-flash QWEN_TURN_DETECTION=server_vad \
  node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p5-qwen-speech-rate-update.ts --runs 2
```

| run | 模式 | 第一轮 | 第二轮 | 比值 | ack |
|---|---|---|---|---|---|
| 1 | control（保持 1.0） | 3760 ms | 3520 ms | 0.936 | session.updated |
| 1 | update（改 0.8） | 3680 ms | 4400 ms | **1.196** | session.updated |
| 2 | control | 3520 ms | 3360 ms | 0.955 | session.updated |
| 2 | update | 3520 ms | 4400 ms | **1.250** | session.updated |

结论：中途 `session.update{speech_rate:0.8}` 对下一轮生效，确认延迟正常。

## 4. 3.1 多语言、音色与工具注册（raw WS）

合成文本输入，每语言单独会话；session 带一个 `perform_action` 工具定义，`server_vad`，`output_audio.language` 对应语言。

| 语言 | 音色 | 音频字节 | 转写字数 | 状态 |
|---|---|---|---|---|
| zh | `longanlingxin_v3.1` | 138240 | 14 | completed |
| ja | `longanlingxin_v3.1` | 46080 | 6 | completed |
| en | `longanlingxin_v3.1` | 96000 | 32 | completed |
| zh | `xunanchuan_v3.1` | 291840 | 29 | completed |

结论：3.1 能连接、能出声、三语会话被接受、工具定义被接受；**未触发真实工具调用**，音色质量未试听（见阻塞 #73）。

## 5. `max_response_output_tokens`（3.1）

raw WS：`session.update` 带 `max_response_output_tokens: 16`，请求一个约一百字的故事。

```json
{"echoed":null,"transcriptChars":113,"audioBytes":1194240,"status":"completed"}
```

结论：`session.updated` 没有回显该字段，回复 113 字，明显没有被 16 token 限制。**3.1 不执行该上限**；记阻塞 #74，不能据此把 3.1 设为默认。

## 6. 回归

实际命令与结果：

```bash
npm test -w protocol          # 3 files / 16 tests passed
npm run typecheck -w protocol # 通过
npm test -w gateway           # 126 files / 1466 tests passed
npm run typecheck -w gateway  # 通过
npm test -w admin             # 24 files / 132 tests passed
npm run typecheck -w admin    # 通过
npm run build -w admin        # 通过（vite 仅报既有 chunk >500 kB 警告）
git diff --check              # 无输出
```

说明：第一次跑全量 gateway 时出现过 1 次 `qwen.test.ts > rejects initialization on intentional_close` 时序失败（期望 `qwen_connect_closed`，收到 `qwen_connect_error`）；该文件单独运行通过，随后全量重跑 126/1466 通过。未改代码；按既有 flaky 时序问题记录。

## 7. 跳过项

| 项 | 原因 | 记录 |
|---|---|---|
| 真机 App 冒烟（后台切 3.1、新会话、工具、打断、三语） | 本次无手机/App 在场 | 阻塞 #72 |
| 3.1 每角色/每语言音色试听 | 候选音色只验证了「能出声」，未听音质和男/女声 | 阻塞 #73 |
| `smart_turn_v2` 对比 | 未在真机跑；保留 `server_vad` | 本次不宣称 `smart_turn_v2` 更好 |
| P5 旅程/共情评估（3.1） | 3.1 不设为默认，未改默认模型 | 只在决定默认时重跑 |
| 管理端浏览器手动检查 | 未开浏览器；admin 测试/typecheck/build 通过 | 真机验收时一并看 |

## 8. 结论

- `speech_rate` 是 3.1 上唯一可靠的语气补偿：0.8 约 +25%，中途更新生效；affect → 0.8 / 1.0 的实现有测试覆盖。
- 3.8 保持默认；3.1 可在后台切换，但真机、音色试听和输出上限未过，暂不设默认。
- 训练/评估结论不变：`instructions` 不能控语气，路线 A 的语音补偿只到语速层面。
