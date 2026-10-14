# Seeduplex Plan 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an explicitly enabled Seeduplex realtime adapter while preserving MockAdapter as the default backend and frozen client contracts.

**Architecture:** `SeeduplexAdapter` owns one upstream WebSocket, translates the documented JSON event protocol into `RealtimeAdapter` events, and converts output audio to PCM16/24 kHz mono. Session continues to own interruption, tombstones, ledger and client protocol behavior. Configuration selects `ADAPTER=seeduplex` only when a gateway environment key is present.

**Tech Stack:** Node 24, TypeScript, `ws`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-avatar-voice-poc-design.md`; protocol evidence: `docs/research/seeduplex-protocol-validation.md`.

## Global Constraints

- `ADAPTER=mock` remains the default and all existing tests remain Mock-only.
- Never log audio, ASR text, model text, keys, tool arguments or tool results.
- Frozen protocol, `RealtimeAdapter`, HTTP/WS and Bridge message shapes are unchanged.
- Key is injected through gateway environment variables only.
- Real network calls are excluded from unit tests; tests use sanitized protocol fixtures.
- ADR-001 A/B measurement remains a later device follow-up.

### Task 1: Adapter protocol core

**Status: complete.** `gateway/src/adapters/seeduplex.ts` and `gateway/test/seeduplex.test.ts` implement session.create/update/close, paced PCM16 input frames, response cancel, tool result, event whitelist, error/closed handling, and PCM16 output decoding. Fixture tests cover event mapping, cancellation identity and malformed JSON.

### Task 2: Configuration and factory wiring

**Status: complete.** Configuration accepts explicit `ADAPTER=seeduplex` with environment-only `SEEDUPLEX_API_KEY`; endpoint/model/voice are tunable and MockAdapter remains the default.

### Task 3: Session lifecycle validation

**Status: complete for local contract coverage.** Existing Session tests cover fake-adapter cancellation, tool and rebuild semantics; adapter fixture tests cover protocol translation; `gateway/test/seeduplex.integration.test.ts` now exercises HTTP session creation, client WebSocket startup, upstream `session.created`, proactive greeting audio, and client `response.end` through the frozen gateway protocol. Real-device and public deployment acceptance remain separate.

### Task 4: Real protocol smoke and docs

**Status: partial.** Redacted direct-adapter smoke succeeded with HTTP 101, session initialization, output audio, response completion and cancellation; the corrected probe also handles UTF-8 JSON carried in binary WebSocket frames. Tool invocation was not triggered by the available synthetic text path; device/audio fixture validation remains open. No key was written or logged.


### Task 5: Qwen fallback adapter

**Status: complete.** Added `gateway/src/adapters/qwen.ts`, explicit `ADAPTER=qwen` configuration, environment-only `DASHSCOPE_API_KEY`, workspace endpoint/model/voice settings, and sanitized fixture coverage. Official Qwen documentation was cross-checked for Bearer auth, workspace WSS endpoint, `response.create`, and audio event names.
