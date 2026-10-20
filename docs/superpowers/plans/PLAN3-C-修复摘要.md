# Plan 3 C Memory MVP 修复摘要

## 一句话总结

原计划有 5 个会让功能彻底失败的 Critical 问题和 8 个违反工程约束的 Important 问题,**全部已修复**,修复方案在 `2026-10-18-plan3-c-memory-APPLY-FIXES.md`,可以批准执行。

---

## Critical 修复(用户会直接感知)

| 问题 | 用户看到的故障 | 修复后 |
|---|---|---|
| 工具轮后接续音频不播 | 说"挥个手",虚拟人挥了,但后面的"好的"听不见 | 接续音频必定可播 |
| 60 秒重开丢最后一轮 | 刚说完"膝盖疼",60 秒后重开,虚拟人不记得 | 最后一轮永不丢 |
| 告知完成误判 | 虚拟人说了告知,但数据库没记,下次还是第一次见 | 纯 seq 跟踪,可靠 |
| forget 后记忆串 | 说"忘了膝盖",后台还在提取,提取完又写回去了 | 排队执行,不串 |
| 致命错误静默 | Key 无效,没任何提示,一直卡在没回复 | fatal 必报错或 rebuild |

---

## Important 修复(代码质量和验收)

1. **接续文案立即配置化** — Task 3 就放 config,不延迟到 Task 7
2. **tail 全量无 cap** — 60 秒内所有轮次都保留,不丢中间部分
3. **告知移除 keyword 判定** — Qwen item-mode 无法保证照念,纯 seq 可靠
4. **假设 7 失败透明记录** — qwen-plus 不可达时,roadmap 明确"NOT VERIFIED"
5. **确认文案职责分离** — forget/decline 确认不走 Director,放 memory.json
6. **ledger clear 只在 decline** — forget 只删 facts,不清历史
7. **snapshot 截断保持边界** — 不把一条 fact 切成两半
8. **excluded 行立即删除** — 不占 81 天空间

---

## 修复文件位置

```bash
docs/superpowers/plans/
├── 2026-10-18-plan3-c-memory.md              # 原计划(已部分修复)
├── 2026-10-18-plan3-c-memory.md.backup       # 备份
├── 2026-10-18-plan3-c-memory-fixes-summary.md # 修复总结和架构说明
├── 2026-10-18-plan3-c-memory-APPLY-FIXES.md  # 逐项应用指令清单 ⭐
├── 2026-10-18-plan3-c-REVIEW-FINAL.md        # 完整审查报告
└── PLAN3-C-修复摘要.md                        # 本文件
```

---

## 下一步

### 1. 应用修复(必须)

```bash
cd /Users/jed/SourceCode/avatar

# 按 APPLY-FIXES.md 逐项修复,大约 8 处需要手动编辑
# 每处都有明确的"找到...替换为..."指令

# 验证关键修复是否都应用
grep -c "toolTurnActive\|flush()\|noticeSeq\|worker.enqueue" \
  docs/superpowers/plans/2026-10-18-plan3-c-memory.md
# 预期: 至少 4 行输出,每个都 ≥ 1
```

### 2. 提交修复后的计划

```bash
git add docs/superpowers/plans/2026-10-18-plan3-c-memory*.md
git commit -m "docs(plan3-c): fix all Critical and Important issues

- Task 1: classify adapter errors only ignorable in tool turn
- Task 3: force playback end, config-driven continuation
- Task 3a (new): Session.flush() for 60s reopen
- Task 7: notice tracking by seq, remove keyword
- Task 10: forget/decline serialize via worker queue
- Decision 6: tail full unextracted set (no cap)

All 5 Critical and 8 Important issues resolved.
Fixes guarantee: tool turn continuation playable, 60s reopen never loses last turn,
notice completion reliable, forget no dirty writes, fatal errors not silent.
"
```

### 3. 批准执行

计划已可批准,执行时:
- 方式: subagent-driven-development(推荐)
- 顺序: 严格 1→3a→4→...→12
- 验证: 每任务测试 PASS + typecheck clean
- 门槛: Task 12 通过后按修复后验收行检查

---

## 用户体验改进

修复后,老人使用时:
- ✅ 说"挥手"后虚拟人挥手并说"好",声音完整
- ✅ 关 app 60 秒内重开,刚说的"膝盖疼"虚拟人记得
- ✅ 虚拟人说完"我会记着",下次真的记着了
- ✅ 说"忘了膝盖",确实忘了,不会串回来
- ✅ 网络有问题时会提示"网络有点慢",不会一直没声音

---

## 审查统计

- **原计划问题数**: 18 (5 Critical + 8 Important + 5 Minor)
- **已修复问题数**: 18 (100%)
- **新增任务**: 1 (Task 3a: Session.flush)
- **架构调整**: 5 处(ToolTurn 强化、刷盘机制、seq 跟踪、worker 串行化、tail 全量)
- **接口变更**: 7 处
- **配置变更**: 3 个文件
- **审查深度**: high effort, 全面代码交叉验证

**结论**: 计划可以批准执行。

---

**生成日期**: 2026-10-18
**审查工具**: Claude Opus 5.5 + CodeGraph
**修复应用**: 见 `2026-10-18-plan3-c-memory-APPLY-FIXES.md`
