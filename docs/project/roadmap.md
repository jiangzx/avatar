# Roadmap

Last updated: 2026-10-14 (device acceptance deferred; local hardening continued). Update at the end of every session.

## Phases

| Phase | Scope | Status | Plan |
|---|---|---|---|
| Plan 1 | Mock-driven end-to-end on a Xiaomi phone: greeting, multi-turn, barge-in with zero residue, 5 actions, reconnect, Day 1 audio A/B spike | **Complete with blockers.** Code Tasks 0–17 implemented, reviewed and merged on `master`; Task 18 checklist/report written but every device/browser item is "not run". Not demonstrated on a device. | [plan1](../superpowers/plans/2026-10-12-avatar-poc-plan1/00-overview.md) |
| Plan 1.1 | Flutter 原生采集/播放/VAD/网关会话，WebView 头像和界面 | **代码已合并至 `master`；小米启动冒烟和 30 分钟稳定性采样完成，完整真机验收延期，待本地后续任务完成后统一执行。** | [native-audio-path](../superpowers/plans/2026-10-13-native-audio-path-plan.md) |
| Plan 2 | Real adapters (Seeduplex/Qwen), LlmSummarizer, persona/Director tuning, cloud deploy (WSS), release APK, Day 6 device report | **In progress: Seeduplex protocol validation and adapter fixture core implemented; Director proactive speech now uses explicit fixed-text mapping; summarizer, deployment, and device acceptance remain; release build is ready to re-run with Plan 2 config; Qwen fallback adapter core is implemented.** | [seeduplex-plan2](../superpowers/plans/2026-10-14-seeduplex-plan2.md) |

Design: [avatar-voice-poc-design](../superpowers/specs/2026-10-12-avatar-voice-poc-design.md).

## What is and is not verified (2026-10-13)

- Verified after the Plan 1.1 merge on `master`: `npm test` → protocol 6, gateway 93, avatar-core 74 passed; `npm run typecheck` clean; `cd app && flutter test` → 36 passed; `flutter analyze` → no issues.
- Gateway-level headless check (Task 18, not a checklist pass): greeting, keyword actions once each, silence follow-ups (~8.4 s / ~25.3 s after `playback.stopped(ended)`), gateway logs contain no conversation text.
- 【模拟器】 only: Task 16 capability probe on Medium_Phone_API_36.1 (WebView 134, 8/8) and API31_Phone (WebView 91, below the ≥120 bar); release APK cleartext to 127.0.0.1 OK; autoplay `running` without gesture (no audible check). Emulator results are NOT phone results.
- NOT verified for the original Plan 1 A path: full desktop Chrome E2E (Task 14 Step 7), Task 18 checklist, WebView mic/VAD capture, AudioWorklet playback, lip-sync, barge-in latency, frame rate, and 30-minute stability. No constants were tuned. ADR-001 (audio path A vs B) is a **DRAFT, undecided**; no A/B measurements exist.
- Plan 1.1 Xiaomi 22101317C: WebView 104 loaded the avatar and Mock greeting, native `AudioRecord` was confirmed at 16 kHz mono with foreground microphone permission, and one `wave` debug action was visually observed. A 30-minute stability sample completed (31 points, renderer alive 31/31; PSS/RSS and 34.0°C recorded). Real speech/VAD, audible confirmation, full action matrix, active-response resume, reliable 10-minute false-trigger count, and 10 true interruptions remain unverified. See [native audio report](../testing/2026-10-13-native-audio-plan1-1-report.md).
- 2026-10-13 hardening pass: native session startup can retry after partial failure; native response setup/audio delivery is serialized; playback feed failures terminate the active response with an error event; HTTP/WS operations have bounded timeouts; gateway adapter startup is bounded by configurable `SESSION_START_TIMEOUT_MS` and does not announce `session.ready` before success; native avatar visibility listeners are released on stop. Regression coverage is included in the gateway, avatar-core, and Flutter suites.
- Hardening validation: `npm test` passed (protocol 6, gateway 95, avatar-core 75); `npm run typecheck`, `cd app && flutter test` (40), `flutter analyze`, `./scripts/build-web.sh`, and `flutter build apk --debug --dart-define-from-file=dev.json` all passed. The generated Web bundle is intentionally ignored under `app/assets/web/`.
- 2026-10-14 local hardening: WebView `GatewayClient` now guards malformed/stale socket messages, makes `close()` idempotent, bounds HTTP and WebSocket setup, and aborts timed-out requests. Focused `avatar-core` GatewayClient tests passed (16).
- 2026-10-14 local hardening continued: `ActionPlayer.stopAll()` now invalidates in-flight wave probes, cancels nod/turn RAF callbacks, and clears smile timers before stopping TalkingHead playback. Regression coverage passed in `avatar-core` actions tests; full `npm test` passed (protocol 6, gateway 95, avatar-core 84) and `npm run typecheck` passed.
- 2026-10-14 device acceptance decision: real voice/VAD interruption, audible playback, active-response resume, network recovery, and stability sampling are explicitly deferred; they remain open in `docs/blockers.md` and will be run together after local follow-up work.
- 2026-10-14 phase transition: by user decision, Phase 1 is marked complete and Plan 2 may begin before the empirical ADR-001 A/B measurement. This is a scheduling decision, not an A/B result; the measurement remains an explicit Plan 2 follow-up.
- Known environment limits: Plan 1's 2 GB AVD renderer kill during Silero VAD load remains unresolved for path A; Plan 1.1 does not load Silero in the product path.

## Plan 1 acceptance (from the plan overview) — status

Greets on open (gateway side ✓ headless; product page ✗); scripted multi-turn with subtitles (✗ device); local-VAD barge-in leaves no stale audio/subtitle (logic covered by unit tests incl. AppController fakes; device ✗); 5 actions tool+keyword deduped (gateway ✓; visual ✗); short reconnect resumes / long reconnect starts new session (unit + client tests ✓; device ✗); Ledger/summary/session rebuild covered by automated tests ✓; Task 16 probe ran on-device with version/audio caveats; Spike A smoke failed before counters; audio A/B and ADR-001 decision remain open.

## Cross-phase dependencies

Plan 2 entry conditions:
- **Satisfied / provided by user decision:** Phase 1 is closed for scheduling purposes; the empirical ADR-001 A/B measurement is deferred.
- A model Key must be verified against the official protocol before enabling a real adapter in runtime.
- Plan 1 contracts stay frozen: `protocol`, `RealtimeAdapter`/`MockScript`, HTTP/WS, Bridge. (Post-review fixes only re-send existing messages; no shape changed. New values: Bridge error codes `bad_config`/`bad_message`, status `audio_suspended`.)

## Blockers

See [docs/blockers.md](../blockers.md): #1/#3/#6/#7 are partially relieved by the Plan 1.1 device smoke; #2 desktop Chrome E2E and #4 A/B measurement remain open.

## Next steps

1. Continue Plan 2 from `docs/superpowers/plans/2026-10-14-seeduplex-plan2.md`: finish adapter integration review, then add the remaining real-model, deployment and device tasks.
2. Return to the deferred Xiaomi/desktop acceptance: real voice/VAD interruption, audible playback, active-response resume, network recovery, five actions, false-trigger sampling, true interruptions, and remaining Task 18 checks.
3. Seeduplex protocol docs and successful key validation are recorded in `docs/research/seeduplex-protocol-validation.md`; `ADAPTER=mock` remains the default, while `ADAPTER=seeduplex` requires an explicit environment key. Complete ADR-001 A/B measurement as a tracked follow-up.

## Handed to Plan 2 (accepted minors / hardening, from the final review)

Gateway: wire Task 7/8 tunables (confirmWindowMs, dedupeMs, ledger limits, grace/unclaimed/heartbeat/rate limits) into config; WS Origin check, POST /session rate limit/lockout, session cap, session.start timeout after claim, terminate WS on shutdown; revoke older unclaimed connectTokens on rotation; rebuild backoff and buffering mic audio during rebuild; count superseded replies as false interruptions; Director.resume() rate limit; summarize() backoff; escape persona/ledger text in instructions; loadMockScript validation.
Client/app: GatewayClient (idempotent close, stale-socket guard in onmessage, JSON.parse guard, fetch/WS timeouts, 401 handling, close-code aware reconnect), ActionPlayer.stopAll cancelling in-flight turn/nod, AvatarView dispose, fetch-assets pinning/checksum, LocalAssetServer hardening (control chars, nosniff/CSP, loader error counters), WebView origin checks + `frame-src 'none'`, `allowBackup=false`, limit the root Gradle compileSdk hook to the specific plugin, exclude spike/probe pages from release bundles, widget smoke test for `AvatarApp`, build-web.sh arg whitelist and dev.json secret check, release must use `adb reverse`/127.0.0.1 only.

## Repo notes

- Untracked `.codegraph/` is the user's CodeGraph index; not ignored or committed by this work (user's call).
- Progress ledger for this session lives in the git-ignored `.superpowers/sdd/` (per-task briefs, reports, diffs).
- 2026-10-12: host Flutter was upgraded 3.41.2 → 3.47.7 (latest stable, via `flutter upgrade`; Dart 3.13.5, DevTools 2.60.0, revision abaf9c523), Android licenses accepted; `flutter doctor` all green. Re-ran `cd app && flutter pub get && flutter analyze && flutter test` → 19 passed, no issues. Version pins updated in the migration guide and plan overview.

- 2026-10-14 Plan 2 protocol verification: official Seeduplex docs/demo were cross-checked. The local-key WebSocket probe returned HTTP 403 with `X-Api-Key` and HTTP 401 with Bearer auth before any event or audio was sent; validation and blocker are recorded in `docs/research/seeduplex-protocol-validation.md` and `docs/blockers.md`.

- 2026-10-14 Plan 2 adapter core: added explicit `ADAPTER=seeduplex` configuration, environment-only key injection, Seeduplex WebSocket event/audio mapping, cancellation/tool-result translation, and sanitized local fixture tests. Full `npm test` (protocol 6, gateway 98, avatar-core 84) and `npm run typecheck` passed.

- 2026-10-14 protocol contract audit: Seeduplex `speech_text_buffer.commit` is direct TTS, not a generic model response trigger. The existing Director instruction path therefore needs an explicit design decision before real adapter runtime enablement.

- 2026-10-14 proactive speech decision: added explicit Director text fields and Seeduplex direct-TTS mapping so internal prompt instructions are never sent as spoken content.

- 2026-10-14 Qwen fallback: official WebSocket protocol was checked and a frozen-contract adapter with Bearer auth, workspace endpoint, `response.create`, audio/transcript/tool mapping and fixture tests was added. No Qwen Key or workspace endpoint was available for live smoke.

- 2026-10-14 Plan 2 validation after Qwen addition: `npm test` passed (protocol 6, gateway 100, avatar-core 84); `npm run typecheck` passed; `git diff --check` passed.

- 2026-10-14 deployment runbook: documented WSS/TLS/IP-allowlist acceptance and environment-only model/App secrets in `docs/deployment/plan2-wss.md`; cloud target credentials and certificate remain external prerequisites.
