# Qwen realtime validation for Plan A

Status: NOT RUN. Reason: user instruction for this execution (Mock only, no services, no real model calls, no API keys). See `docs/blockers.md` #12. No value below was measured; every fallback is the plan's own default, not a finding.

Date: not run. Model: not run (`QWEN_MODEL`). Region: not run. Probe: `gateway/scripts/qwen-probe.ts` (helpers in `gateway/scripts/lib/qwen-raw.ts`), written and unit-tested only.

To run later, from `gateway/` with a local `.env`: `node --env-file-if-exists=.env --import tsx scripts/qwen-probe.ts <instructions|cap|audio --wav f|voices --voices a,b>`.

## 1. Per-response instructions on `response.create`

| run | a status | a ends with 喵 | b ends with 喵 | user items created |
|---|---|---|---|---|
| 1 | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| 2 | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| 3 | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

Verdict: NOT RUN. Fallback chosen: `RESPONSE_INSTRUCTIONS = 'item'` in `gateway/src/adapters/qwen.ts` (the plan's code literal says `'replace'`; do not copy it). Revisit after the probe runs (`inconclusive` also means `item`).

## 2. Voices

| voice | accepted | audio ms | listener note |
|---|---|---|---|
| NOT RUN | NOT RUN | NOT RUN | NOT RUN |

Per-session voice works: NOT RUN. Fallback chosen: grandchild = `null`, old-friend = `null` (adapter default voice). Official voice names were not looked up.

## 3. Output cap, usage, speech_stopped

- Typical short reply: output_tokens = NOT RUN, input_tokens = NOT RUN, chars = NOT RUN, audio ms = NOT RUN.
- `response.create` `max_output_tokens=20`: NOT RUN.
- `session.update` `max_response_output_tokens=20`: NOT RUN.
- `response.done.response.usage` present: NOT RUN; fields: NOT RUN.
- `input_audio_buffer.speech_stopped` seen: NOT RUN.

Fallback chosen: no cap field verified; `gateway/config/pacing.json` `output.maxTokens` = `null`; usage and speech fields may be null.

## 4a. User transcript timing

Partial deltas: NOT RUN. Completed minus response.created: NOT RUN. Fallback chosen for `app/assets/config/thinking.json` `fillerEvidence`: `["transcript","responseStart"]`.

## 5. Zero frames

Phase 2 speech_started after zeros: NOT RUN. Second response: NOT RUN. Errors: NOT RUN. Fallback chosen: keep zero-value frames during filler; verify on device in A2 Task 9.
