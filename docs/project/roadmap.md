# Roadmap

Last updated: 2026-10-12. Update at the end of every session.

## Phases

| Phase | Scope | Status | Plan |
|---|---|---|---|
| Plan 1 | Mock-driven end-to-end on a Xiaomi phone: greeting, multi-turn, barge-in with zero residue, 5 actions, reconnect, Day 1 audio A/B spike | Plan written, not yet reviewed/approved; no code | [plan1](../superpowers/plans/2026-10-12-avatar-poc-plan1/00-overview.md) |
| Plan 2 | Real adapters (Seeduplex/Qwen), LlmSummarizer, persona/Director tuning, cloud deploy (WSS), release APK, Day 6 device report | Not started; plan not written | — |

Design: [avatar-voice-poc-design](../superpowers/specs/2026-10-12-avatar-voice-poc-design.md).

## Plan 1 acceptance (from the plan overview)

Greets on open; scripted multi-turn with subtitles; local-VAD barge-in leaves no stale audio/subtitle; 5 actions (tool + keyword, deduped); short reconnect resumes, long reconnect starts a new session; Ledger/summary/session rebuild covered by automated tests; Day 1 device probe and audio A/B spike done with ADR-001.

## Cross-phase dependencies

Plan 2 cannot start until:
- A model Key is available and the real protocol is verified against official docs.
- ADR-001 (audio path A or B) is decided in Plan 1 Task 17.
- Plan 1 contracts are frozen: `protocol`, `RealtimeAdapter`/`MockScript`, HTTP/WS, Bridge.

## Current state / handoff

- Verified: repo has docs only (spec, plan1, research). CodeGraph initialized, index empty (no source yet).
- Plan1 reviewed and revised (2026-10-12): see the plan overview for the dependency table, technical-assumption status, and device checkpoints.
- Decision (user, 2026-10-12): write code first and integrate on the Android emulator + desktop Chrome; insert two real-device checkpoints (① capability probe + quick echo test, ② A/B spike + on-device acceptance). Emulator results are labeled 【模拟器】 and never replace device results. No Xiaomi phone available yet.
- Uncommitted: plan1 doc edits and `AGENTS.md` (review before starting Task 0).
- Tests run: none.
- Next task: get plan1 approved, then Task 0 (environment and monorepo skeleton; Step 2a emulator setup).
- Blockers: none recorded (`docs/blockers.md` does not exist yet; created in Task 0).
