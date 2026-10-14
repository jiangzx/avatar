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

Create `gateway/src/adapters/seeduplex.ts` and `gateway/test/seeduplex.test.ts`. Implement session.create/update/close, paced PCM16 input frames, response cancel, tool result, event whitelist, stale response tombstones, error/closed handling, and PCM16 output decoding. Tests cover fixture event mapping, cancellation, malformed/error events and intentional close without network access.

### Task 2: Configuration and factory wiring

Modify `gateway/src/config.ts`, `gateway/src/index.ts`, and config tests. Add explicit `ADAPTER=seeduplex`, `SEEDUPLEX_API_KEY`, endpoint/model/voice tunables. Reject missing key only when Seeduplex is selected. Keep MockAdapter default and use the adapter factory selected by config.

### Task 3: Session lifecycle validation

Add gateway integration tests with a fake adapter factory for response/tombstone/tool/error semantics. Verify rebuild and reconnect behavior without real network calls. Keep existing HTTP/WS shapes unchanged.

### Task 4: Real protocol smoke and docs

Run the manually approved redacted smoke with the environment-injected key; record only event types, status codes, byte counts, durations and error codes. Update roadmap, blockers and ADR follow-up. Do not place keys in files or commits.
