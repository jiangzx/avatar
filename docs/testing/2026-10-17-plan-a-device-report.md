# Plan A device acceptance — Xiaomi 22101317C — 2026-10-17

Commit: 2ebc3a5 (code under test). Gateway: not started. APK: not built. Device acceptance was NOT RUN (user instruction: Mock only, no services/device/real model). Automated: `npm test` protocol 6, gateway 219, avatar-core 96 passed; `npm run typecheck` clean; `flutter test` 105 passed; `flutter analyze` no issues.

| Gate item (spec) | Result | Evidence |
|---|---|---|
| 20 场景问句比例 ≤ 1/3 | NOT RUN | user instruction: Mock only, no services/device/real model; blockers #15 |
| 平均回复字数 ≤ 配置值 | NOT RUN | user instruction: Mock only, no services/device/real model; blockers #15 |
| 静默 10 分钟 unprompted = 0 | NOT RUN | user instruction: Mock only, no services/device/real model; blockers #24 |
| 每 5 分钟主动说话 ≤ 3 | NOT RUN | user instruction: Mock only, no services/device/real model; blockers #24 |
| 静音后 500 ms 内思考态 100% | NOT RUN | user instruction: Mock only, no services/device/real model; blockers #21, #22 |
| 满足条件必定垫话 | NOT RUN | user instruction: Mock only, no services/device/real model; blockers #22 |
| 无反馈空白 = 0 | NOT RUN | user instruction: Mock only, no services/device/real model; blockers #22 |
| 感知延迟 P50 不差于基线 | NOT RUN | user instruction: Mock only, no services/device/real model; blockers #18, #22 |
| 情绪表情可见 | NOT RUN | user instruction: Mock only, no services/device/real model; blockers #23 |
| 两种风格人设和音色可用 | NOT RUN | user instruction: Mock only, no services/device/real model; blockers #17, #19, #25 |

## Per-turn observations

NOT RUN (user instruction: Mock only, no services/device/real model); blockers #22. No turns were spoken; the table is intentionally empty.

| # | utterance | feedback ≤0.5 s (Y/N) | filler heard | filler voice matches | clean cut |
|---|---|---|---|---|---|

## Gateway metrics (log-report metrics)

NOT RUN (no gateway log exists); blockers #21.

## Notes, failures, skipped items

Steps 2–6 of A2 Task 9 skipped: #21 (build/install/capture), #22 (spoken turns), #23 (emotion/backchannel), #24 (10-minute silence), #25 (both styles). Step 2 also depends on the full web/APK build skipped in #20.

Known device-verification carry items:
- Assumption 5: zero-value uplink frames are kept during filler; check `model_auto_cancel` and that every filler turn still gets a reply.
- Filler residue after `stopFiller` (AudioTrack buffer) may be audible or counted; verify cut cleanliness.
- Thinking pose visuals (`eyesLookUp`, `headRotateZ`) and the per-emotion smile are unit-tested only.
- Filler voice differs from reply voice (macOS `say` placeholders), blockers #19.
- Both styles have `"voice": null`, blockers #17.
- Hotline number unverified (wording only), blockers #16.
- Thinking timeout returns silently to idle, which conflicts with the "no dead air" gate; judge on device.
