# anyidea

- 调研：`docs/elderly-avatar-companion/`
- POC 设计：`docs/superpowers/specs/2026-10-12-avatar-voice-poc-design.md`
- 实施计划：`docs/superpowers/plans/2026-10-12-avatar-poc-plan1/`
- 阻塞记录：`docs/blockers.md`
- 新电脑迁移与环境复现：`docs/migration/new-machine-setup.md`
- 运维启停 / 密码 / 健康检查：`docs/deployment/ops-runbook.md`

## 本地运行（Mock）

```bash
./scripts/make-mock-speech.sh        # 生成测试语音
npm install
cp gateway/.env.example gateway/.env # 填写 APP_SECRET（≥16 位）
npm run dev -w gateway               # 网关 :8787
npm run dev -w avatar-core           # 桌面 Chrome 调试 :5173
./scripts/build-web.sh && (cd app && flutter run --dart-define-from-file=dev.json)
```
