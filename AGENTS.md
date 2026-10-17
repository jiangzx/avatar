# AGENTS.md

AI avatar voice-chat POC (Android phone first). Read this file first, then `docs/project/roadmap.md` for current state.

## 1. Project Snapshot

- Goal and scope: `docs/superpowers/specs/2026-10-12-avatar-voice-poc-design.md` (approved design, treat as a constraint).
- Monorepo (npm workspaces): `protocol/` (shared types), `gateway/` (Node 24 + TS), `avatar-core/` (Vite + TS, three.js, runs in WebView), `app/` (Flutter Android shell).
- Exact tool versions and the task list live in the plan, not here: `docs/superpowers/plans/2026-10-12-avatar-poc-plan1/00-overview.md`.
- Commands (`npm test -w <pkg>`, `npm run typecheck -w <pkg>`, `flutter test`) exist only after the task that creates them is done. Check `package.json` / `pubspec.yaml` before running; never assume.

## 2. Hard Rules (non-negotiable)

- Language: replies in Simplified Chinese; code comments in English, short.
- Never log conversation content (audio, ASR text, reply text). Logs carry event names, ids, counts, durations, error codes only.
- Conversation text may be persisted only in the memory store (SQLite behind `MemoryStore`, per `docs/superpowers/specs/2026-10-17-companionship-memory-design.md`), after the memory notice and unless the owner declined, and must be deletable. Never store audio. Exception: hand-written synthetic eval scenarios and their results may live in `docs/testing/`.
- Never commit secrets. Keys go in env vars or `--dart-define`; `.env*` stays ignored (`.env.example` excepted).
- Until a model Key exists, everything must run on `MockAdapter` (`ADAPTER=mock` only).
- Tunable values live in config files, not scattered in code.
- Do not invent skills, commands, dependencies, or APIs. Unverified third-party behavior is an assumption: mark it and validate with a minimal step first.
- Never overwrite unrelated uncommitted changes; never stage with `git add -A`. Add explicit paths.
- Never claim code, tests, or verification are done unless you ran them. Report the real command and result; if you could not verify, say what and why.

## 2.1 Engineering Rules

- Layers: server → (session, identity) → (adapter, memory, roles); no reverse imports. Realtime models go through `RealtimeAdapter`, text models through one text-model client interface.
- Prompts, spoken copy, thresholds, budgets, word lists live in `gateway/roles/**`, `gateway/config/*.json`, or app-side config files; gateway config is zod-validated (cross-checked where values interact) at startup. No hardcoding.
- Extend via registries (tools, roles, adapters), not if-else chains in the session flow. No generic plugin framework.
- No module-level mutable state (inject shared resources such as the DB connection); per-session data (voice, role, style, memory snapshot) lives in the session context.
- Timeouts, retries, fallbacks go through one shared policy helper; classify adapter errors as ignorable / retryable / fatal. Never fail silently, never leave the user in dead air.
- Metrics per reply: first-audio latency, generation time, token usage, error code (content-free). Client-side metrics go to anonymous logcat diagnostics, not new protocol messages.
- Validate at boundaries only (HTTP, WS, tool args, config, model JSON) with zod; reject on failure.
- Keep code small and readable; short English comments on core paths; unit tests for key logic (TDD).

## 3. Workflow (Superpowers)

- Substantial or unclear feature: brainstorming, then writing-plans. No parallel OpenSpec workflow.
- Implement only from an approved plan. Get plan approval before starting its tasks.
- Execute with one method per plan: subagent-driven-development or executing-plans. Do not mix without a stated reason.
- Per task: TDD (failing test, implement, pass), then commit. Use verification-before-completion before saying "done", and requesting-code-review before merging a plan's work. Use finishing-a-development-branch at the end.
- Parallel subagents: each in its own git worktree; follow the parallel rules in the plan overview. Shared files and frozen contracts are listed there.
- Do not start a task before its prerequisites and required interfaces are ready (see the dependency table in the plan overview).

## 4. Project Memory (single source of truth per topic)

| Topic | Location |
|---|---|
| Phase index, status, next task, handoff notes | `docs/project/roadmap.md` |
| Task-level steps, interfaces, acceptance | `docs/superpowers/plans/` |
| Approved design | `docs/superpowers/specs/` |
| Cross-phase dependencies | roadmap "Cross-phase dependencies" section; split into `docs/project/dependency-map.md` only when it outgrows that |
| Durable decisions (ADRs) | `docs/adr/` (plans reference `docs/adr/ADR-001-day1-selection.md`) |
| Stable shared architecture | `docs/architecture/` (create only when the design spec stops being enough) |
| Blocked or skipped steps | `docs/blockers.md` (template in the plan) |

Do not duplicate facts across these. Link instead. Chat history is not memory.

## 5. Session Start Checklist

1. `git status`, `git diff --stat`, `git log --oneline -10`.
2. Read `docs/project/roadmap.md` and the plan file for the current task.
3. Verify claimed completion against code and by running its tests. Distrust checkboxes.
4. State the exact next task, its prerequisites, and open blockers before editing.

## 6. Session End Checklist

Update `docs/project/roadmap.md` (status, next task, tests actually run with results, blockers) and tick completed steps in the plan. Commit docs with the code they describe.

## 7. Blockers and Design Changes

- Stuck on a step (env, SDK, device, unverifiable API): time-box 20 minutes, do one manual verification, record in `docs/blockers.md`, skip to the next task, and list every skipped item in the progress report. Never skip silently.
- Material design flaw found: stop the affected work, report evidence, impact, and proposed fix. After a decision, update the spec/plan and roadmap in the same change. No silent breaking changes or scope growth.
- Interface or contract needs changing downstream: stop and report; do not edit the upstream file from a downstream task.

## 8. Scope Discipline

- Plan 1 is Mock-driven only. Real adapters, cloud deployment, release APK belong to Plan 2.
- No new abstractions, dependencies, or docs unless the approved plan needs them. Keep code simple (KISS).
- Keep each plan bounded and verifiable; break big phases into separate plans with explicit dependencies and acceptance criteria.
- If requirements are materially ambiguous, ask or propose one minimal explicit decision.
