# Roadmap

Last updated: 2026-10-13 (Plan 1.1 device smoke). Update at the end of every session.

## Phases

| Phase | Scope | Status | Plan |
|---|---|---|---|
| Plan 1 | Mock-driven end-to-end on a Xiaomi phone: greeting, multi-turn, barge-in with zero residue, 5 actions, reconnect, Day 1 audio A/B spike | **Complete with blockers.** Code Tasks 0–17 implemented, reviewed and merged on `master`; Task 18 checklist/report written but every device/browser item is "not run". Not demonstrated on a device. | [plan1](../superpowers/plans/2026-10-12-avatar-poc-plan1/00-overview.md) |
| Plan 1.1 | Flutter 原生采集/播放/VAD/网关会话，WebView 头像和界面 | **代码完成；小米设备启动冒烟部分通过，完整真机验收未完成。** | [native-audio-path](../superpowers/plans/2026-10-13-native-audio-path-plan.md) |
| Plan 2 | Real adapters (Seeduplex/Qwen), LlmSummarizer, persona/Director tuning, cloud deploy (WSS), release APK, Day 6 device report | Not started; plan not written | — |

Design: [avatar-voice-poc-design](../superpowers/specs/2026-10-12-avatar-voice-poc-design.md).

## What is and is not verified (2026-10-13)

- Verified by running in the current Plan 1.1 worktree: `npm test` → protocol 6, gateway 93, avatar-core 74 passed; `npm run typecheck` clean; `cd app && flutter test` → 36 passed; `flutter analyze` → no issues.
- Gateway-level headless check (Task 18, not a checklist pass): greeting, keyword actions once each, silence follow-ups (~8.4 s / ~25.3 s after `playback.stopped(ended)`), gateway logs contain no conversation text.
- 【模拟器】 only: Task 16 capability probe on Medium_Phone_API_36.1 (WebView 134, 8/8) and API31_Phone (WebView 91, below the ≥120 bar); release APK cleartext to 127.0.0.1 OK; autoplay `running` without gesture (no audible check). Emulator results are NOT phone results.
- NOT verified for the original Plan 1 A path: full desktop Chrome E2E (Task 14 Step 7), Task 18 checklist, WebView mic/VAD capture, AudioWorklet playback, lip-sync, barge-in latency, frame rate, and 30-minute stability. No constants were tuned. ADR-001 (audio path A vs B) is a **DRAFT, undecided**; no A/B measurements exist.
- Plan 1.1 Xiaomi 22101317C smoke: WebView 104 loaded the avatar and Mock greeting in debug/release, native `AudioRecord` initialized at 16 kHz mono, and one `wave` debug action was visually observed. Real speech/VAD, audible confirmation, full action matrix, resume with an active response, 10-minute false-trigger count, and 30-minute stability remain unmeasured. See [native audio report](../testing/2026-10-13-native-audio-plan1-1-report.md).
- Known environment limits: Plan 1's 2 GB AVD renderer kill during Silero VAD load remains unresolved for path A; Plan 1.1 does not load Silero in the product path.

## Plan 1 acceptance (from the plan overview) — status

Greets on open (gateway side ✓ headless; device ✗); scripted multi-turn with subtitles (✗ device); local-VAD barge-in leaves no stale audio/subtitle (logic covered by unit tests incl. AppController fakes; device ✗); 5 actions tool+keyword deduped (gateway ✓; visual ✗); short reconnect resumes / long reconnect starts new session (unit + client tests ✓; device ✗); Ledger/summary/session rebuild covered by automated tests ✓; Day 1 device probe and audio A/B spike with ADR-001 ✗ (draft only).

## Cross-phase dependencies

Plan 2 cannot start until:
- A model Key is available and the real protocol is verified against official docs.
- ADR-001 (audio path A or B) is decided from real-device data (Task 17 Steps 5–7).
- Plan 1 contracts stay frozen: `protocol`, `RealtimeAdapter`/`MockScript`, HTTP/WS, Bridge. (Post-review fixes only re-send existing messages; no shape changed. New values: Bridge error codes `bad_config`/`bad_message`, status `audio_suspended`.)

## Blockers

See [docs/blockers.md](../blockers.md): #1/#3/#6/#7 are partially relieved by the Plan 1.1 device smoke; #2 desktop Chrome E2E and #4 A/B measurement remain open.

## Next steps

1. Complete Plan 1.1 on the connected Xiaomi: real voice/VAD interruption, active-response resume, all five actions, 10-minute false-trigger count, 10 true interruptions, and 30-minute stability. Keep Plan 1's WebView ≥120 and A/B measurements separate.
2. Run the remaining Plan 1 probe/A-B/Task 18 checks and desktop Chrome E2E when their respective environments are available.
3. Write Plan 2 only after a model Key is available and ADR-001 has real A/B data.

## Handed to Plan 2 (accepted minors / hardening, from the final review)

Gateway: wire Task 7/8 tunables (confirmWindowMs, dedupeMs, ledger limits, grace/unclaimed/heartbeat/rate limits) into config; WS Origin check, POST /session rate limit/lockout, session cap, session.start timeout after claim, terminate WS on shutdown; revoke older unclaimed connectTokens on rotation; rebuild backoff and buffering mic audio during rebuild; count superseded replies as false interruptions; Director.resume() rate limit; summarize() backoff; escape persona/ledger text in instructions; loadMockScript validation.
Client/app: GatewayClient (idempotent close, stale-socket guard in onmessage, JSON.parse guard, fetch/WS timeouts, 401 handling, close-code aware reconnect), ActionPlayer.stopAll cancelling in-flight turn/nod, AvatarView dispose, fetch-assets pinning/checksum, LocalAssetServer hardening (control chars, nosniff/CSP, loader error counters), WebView origin checks + `frame-src 'none'`, `allowBackup=false`, limit the root Gradle compileSdk hook to the specific plugin, exclude spike/probe pages from release bundles, widget smoke test for `AvatarApp`, build-web.sh arg whitelist and dev.json secret check, release must use `adb reverse`/127.0.0.1 only.

## Repo notes

- Untracked `.codegraph/` is the user's CodeGraph index; not ignored or committed by this work (user's call).
- Progress ledger for this session lives in the git-ignored `.superpowers/sdd/` (per-task briefs, reports, diffs).
- 2026-10-12: host Flutter was upgraded 3.41.2 → 3.47.7 (latest stable, via `flutter upgrade`; Dart 3.13.5, DevTools 2.60.0, revision abaf9c523), Android licenses accepted; `flutter doctor` all green. Re-ran `cd app && flutter pub get && flutter analyze && flutter test` → 19 passed, no issues. Version pins updated in the migration guide and plan overview.
