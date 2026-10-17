# Plan A latency baseline (before Plan A behavior changes)

## Gateway (A1 Task 2)

Status: **NOT RUN.** Reason: user instruction for this execution was Mock only (no gateway process, no real Qwen call, no Xiaomi/adb). See `docs/blockers.md` #13. No numbers below were measured; the tables are intentionally empty.

Date: NOT RUN. Commit: `<commit before A1 Task 4 — filled in by Task 4>`. The baseline must be measured on the plan3-a commit immediately before A1 Task 4 (the first task that changes gateway behavior), so that later Plan A work is compared against unchanged behavior. Adapter: qwen (QWEN_MODEL: not recorded). Device: Xiaomi 22101317C via adb reverse. 20 spoken sentences (list in plan A1 Task 2 Step 7).

| field | n | p50 | p90 |
|---|---|---|---|
| speech_to_first_audio_ms | | | |
| vad_to_first_audio_ms | | | |
| gen_ms | | | |
| input_tokens | | | |
| output_tokens | | | |
| reply_chars | | | |

Notes: NOT RUN. Until this is measured, the Plan A gate "P50 not worse than baseline" stays open.

How to measure: run the gateway with `ADAPTER=qwen` and log to `/tmp/gw-baseline.log`, speak the 20 sentences, then `cd gateway && node --import tsx scripts/log-report.ts metrics < /tmp/gw-baseline.log`.

## Client perceived latency (A2 Task 1)

Filled by A2 Task 1.
