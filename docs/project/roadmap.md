# Roadmap

Last updated: 2026-10-12 (end of Plan 1 execution session). Update at the end of every session.

## Phases

| Phase | Scope | Status | Plan |
|---|---|---|---|
| Plan 1 | Mock-driven end-to-end on a Xiaomi phone: greeting, multi-turn, barge-in with zero residue, 5 actions, reconnect, Day 1 audio A/B spike | **Complete with blockers.** Code Tasks 0–17 implemented, reviewed and merged on `master`; Task 18 checklist/report written but every device/browser item is "not run". Not demonstrated on a device. | [plan1](../superpowers/plans/2026-10-12-avatar-poc-plan1/00-overview.md) |
| Plan 2 | Real adapters (Seeduplex/Qwen), LlmSummarizer, persona/Director tuning, cloud deploy (WSS), release APK, Day 6 device report | Not started; plan not written | — |

Design: [avatar-voice-poc-design](../superpowers/specs/2026-10-12-avatar-voice-poc-design.md).

## What is and is not verified (2026-10-12)

- Verified by running (final run after all fixes): `npm test` → protocol 6, gateway 93, avatar-core 71 passed; `npm run typecheck` clean; `cd app && flutter test` → 19 passed; `flutter analyze` → no issues.
- Gateway-level headless check (Task 18, not a checklist pass): greeting, keyword actions once each, silence follow-ups (~8.4 s / ~25.3 s after `playback.stopped(ended)`), gateway logs contain no conversation text.
- 【模拟器】 only: Task 16 capability probe on Medium_Phone_API_36.1 (WebView 134, 8/8) and API31_Phone (WebView 91, below the ≥120 bar); release APK cleartext to 127.0.0.1 OK; autoplay `running` without gesture (no audible check). Emulator results are NOT phone results.
- NOT verified anywhere: full avatar page in a real browser or on a device (Task 14 Step 7, Task 18 Step 0 and checklist items 1–12), mic/VAD capture, AudioWorklet playback, lip-sync, barge-in latency, frame rate, 30-min stability, any metric value. No constants were tuned. ADR-001 (audio path A vs B) is a **DRAFT, undecided**; no A/B measurements exist.
- Known environment limits: no Xiaomi phone; only a 2 GB AVD works (WebView renderer gets low-memory-killed during Silero VAD load); host disk ~1.7 GiB free (do not run `flutter build` until space is freed).

## Plan 1 acceptance (from the plan overview) — status

Greets on open (gateway side ✓ headless; device ✗); scripted multi-turn with subtitles (✗ device); local-VAD barge-in leaves no stale audio/subtitle (logic covered by unit tests incl. AppController fakes; device ✗); 5 actions tool+keyword deduped (gateway ✓; visual ✗); short reconnect resumes / long reconnect starts new session (unit + client tests ✓; device ✗); Ledger/summary/session rebuild covered by automated tests ✓; Day 1 device probe and audio A/B spike with ADR-001 ✗ (draft only).

## Cross-phase dependencies

Plan 2 cannot start until:
- A model Key is available and the real protocol is verified against official docs.
- ADR-001 (audio path A or B) is decided from real-device data (Task 17 Steps 5–7).
- Plan 1 contracts stay frozen: `protocol`, `RealtimeAdapter`/`MockScript`, HTTP/WS, Bridge. (Post-review fixes only re-send existing messages; no shape changed. New values: Bridge error codes `bad_config`/`bad_message`, status `audio_suspended`.)

## Blockers

See [docs/blockers.md](../blockers.md): #1 no phone (open), #2 desktop Chrome E2E not run (open), #3 Task 16 Step 8–9 on phone (open), #4 Task 17 Steps 5–7 (open), #5 VAD asset path (path fix done; was found by emulator smoke), #6 2 GB AVD renderer kill (open, inferred for product page), #7 Task 18 remaining checklist (open).

## Next steps

1. Free disk space; get a Xiaomi phone (or a larger-RAM AVD) and run blockers #7/#3/#4 exactly as written: checkpoint ① (Task 0 Step 2b, Task 16 Steps 8–9, Task 17 Spike A `echo=true`), then checkpoint ② (full A/B, ADR-001 decision, Task 18 checklist, tuning from device data). Also run the desktop Chrome E2E (Task 14 Step 7) with headphones.
2. Write Plan 2 (needs the Key + ADR-001).

## Handed to Plan 2 (accepted minors / hardening, from the final review)

Gateway: wire Task 7/8 tunables (confirmWindowMs, dedupeMs, ledger limits, grace/unclaimed/heartbeat/rate limits) into config; WS Origin check, POST /session rate limit/lockout, session cap, session.start timeout after claim, terminate WS on shutdown; revoke older unclaimed connectTokens on rotation; rebuild backoff and buffering mic audio during rebuild; count superseded replies as false interruptions; Director.resume() rate limit; summarize() backoff; escape persona/ledger text in instructions; loadMockScript validation.
Client/app: GatewayClient (idempotent close, stale-socket guard in onmessage, JSON.parse guard, fetch/WS timeouts, 401 handling, close-code aware reconnect), ActionPlayer.stopAll cancelling in-flight turn/nod, AvatarView dispose, fetch-assets pinning/checksum, LocalAssetServer hardening (control chars, nosniff/CSP, loader error counters), WebView origin checks + `frame-src 'none'`, `allowBackup=false`, limit the root Gradle compileSdk hook to the specific plugin, exclude spike/probe pages from release bundles, widget smoke test for `AvatarApp`, build-web.sh arg whitelist and dev.json secret check, release must use `adb reverse`/127.0.0.1 only.

## Repo notes

- Untracked `.codegraph/` is the user's CodeGraph index; not ignored or committed by this work (user's call).
- Progress ledger for this session lives in the git-ignored `.superpowers/sdd/` (per-task briefs, reports, diffs).
- 2026-10-12: host Flutter was upgraded 3.41.2 → 3.47.7 (latest stable, via `flutter upgrade`; Dart 3.13.5, DevTools 2.60.0, revision abaf9c523), Android licenses accepted; `flutter doctor` all green. Re-ran `cd app && flutter pub get && flutter analyze && flutter test` → 19 passed, no issues. Version pins updated in the migration guide and plan overview.
