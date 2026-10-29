# Task 8: 并排盲测、结论与回写

**Files:**
- Modify: `docs/testing/2026-10-30-web-photoreal-spike.md`（加盲测与最终结论）
- Modify: `docs/research/2026-10-30-web-photoreal-avatar-options.md`（结论段）
- Modify: `docs/project/roadmap.md`（状态、下一步、真实结果）

**Interfaces:**
- Consumes: T7 的 S1–S5 结果；T5/T6 的可运行页面。
- Produces: 一个明确的 C 路线结论；阶段 b 或 B/E 的下一步。

前提：T7 判定 S1 ≥20 且 S2 ≤500、S3/S4 通过。若 T7 已判定停 C，本任务只写失败报告与下一步，不做盲测。

- [ ] **Step 1: 准备两段对比视频**

Web 端：`npm run dev:photoreal -w avatar-core`，等 `ready`，开始，录屏 10 秒（QuickTime 或手机拍屏幕均可）。

Android Duix：打开「智伴」，让 Lily 说一段 5–10 秒的回复，录屏同样 10 秒。

要求：
- 两段都只保留人脸+上半身，构图相近；
- 同一台设备/同一距离/同一音量录制，避免音量差影响判断；
- **不要**把任何用户对话文本写进报告或文件名；文件名只用 `web-a.mp4`、`duix-b.mp4`；
- 已知限制：两张脸不同、两段音频不同、录音设备可能不同。盲测只回答「真人感 / 口型跟声 / 是否明显更差」，不是逐像素对比。

- [ ] **Step 2: 盲测**

用抛硬币决定哪段叫 A、哪段叫 B。找 3–5 名评审（至少包含用户本人），不看标签，按顺序看两段，回答：

1. 哪一段更像真人在说话？（A/B/差不多）
2. 哪一段的口型跟声音更同步？（A/B/差不多）
3. Web 那段（看完后再揭标签）和手机 Duix 比：明显更差 / 差不多 / 更好？
4. 一句话理由（只记评价，不记对话内容）。

如果评审只有用户本人，写「n=1，主观」，不要包装成多人结论。

- [ ] **Step 3: 交互体感（可选，但建议做）**

让评审实际点一次 Web demo 的「打断」，再在手机上打断一次 Lily。问：停得够不够快？嘴有没有马上闭上？只记 yes/no 和一句理由。

- [ ] **Step 4: 把结果写进报告**

在 `docs/testing/2026-10-30-web-photoreal-spike.md` 追加：

```markdown
## Blind comparison

- n = ...
- Clips: web-a.mp4 vs duix-b.mp4 (different faces and audio; not a pixel comparison)
- More human: A x / B x / tie x
- Better lip sync: A x / B x / tie x
- Web vs Duix: clearly worse x / about the same x / better x
- Interrupt: yes x / no x
- Notes (no conversation content): ...

## Final decision

- Route C: pass / fail
- Why: ...
- Next:
  - pass → stage b outline (gateway integration)
  - fail → B one-week spike / Ultralight-FeatherTalk follow-up / E
```

- [ ] **Step 5: 回写研究文档与 roadmap**

研究文档的结论段改成真实结果（只改结论，不改原选项表）：

```markdown
- 2026-10-30 结论：路线 C 在 M3 Max + Chrome 上 <pass/fail>。S1 中位 <fps> fps，S2 冷启动 <ms> ms，S3 <ms> ms，S4 <pass/fail>；盲测 n=<n>，Web 相对 Duix <clearly worse/about the same/better>。
- 若产品化：Wav2Lip 许可不可用；需换 Ultralight/FeatherTalk（许可需先核实）或走 B。
```

`docs/project/roadmap.md` 增加一段（放在最上面或对应阶段）：

```markdown
## Web 真人形象可行性（2026-10-30）

状态：**<通过/未通过>**。计划：`docs/superpowers/plans/2026-10-30-web-photoreal-demo/`。
- 目标机：M3 Max / macOS 26.3.1 / Chrome <version>。
- 结果：S1 <fps> fps、S2 <ms> ms、S3 <ms> ms、S4 <pass/fail>；盲测 n=<n>，Web 相对 Duix <结论>。
- 测试：`npm test -w avatar-core` ... 项通过；`npm run typecheck -w avatar-core` 通过。
- 下一步：<阶段 b / B / E>。
```

- [ ] **Step 6: 最终检查与提交**

```bash
npm test -w avatar-core
npm run typecheck -w avatar-core
git diff --check
git status --short
```

Expected: 全量 avatar-core 测试通过；typecheck 无输出；`git diff --check` 无输出；`git status` 只有本任务要提交的文档和 T7 的文档。

```bash
git add docs/testing/2026-10-30-web-photoreal-spike.md \
  docs/research/2026-10-30-web-photoreal-avatar-options.md \
  docs/project/roadmap.md
git commit -m "docs(photoreal): record the blind test and route C decision"
```

- [ ] **Step 7: 报告给用户**

用简体中文给出：
- S1–S5 的实测值与判定；
- 盲测结果与 n；
- 明确的下一步：阶段 b（接网关）或 B/E；
- 没有跑的项目（写 `NOT RUN`，不要写成通过）；
- 所有跳过项的清单。
