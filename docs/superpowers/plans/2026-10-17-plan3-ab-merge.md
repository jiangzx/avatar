# Plan 3 A+B Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (main session; merges are not delegated). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the Plan A worktree (A1 + A2) and the Plan B worktree into `master`, connect the two features that each plan left to the merge (style-aware filler clips, merge acceptance), and verify the A+B gate.

**Architecture:** Plan B is merged first (smaller conflict surface, mostly new files), then Plan A. Shared files are resolved by the table below. The only new code is passing the locally saved style from Plan B's `DeviceIdentity` into Plan A's `AvatarPage`, so filler clips match the agent's style.

**Tech Stack:** git, Node 24 / Vitest, Flutter.

**Spec:** `docs/superpowers/specs/2026-10-17-companionship-memory-design.md` ("计划拆分与执行", gate "A+B 合并后").

## Global Constraints

- Precondition: Task 0 is on `master`; Plan A (`2026-10-17-plan3-a1-gateway-persona.md`, `2026-10-17-plan3-a2-client-thinking.md`) and Plan B (`2026-10-17-plan3-b-identity-binding.md`) have each passed their own gates in their worktrees.
- Stage explicit paths only; never `git add -A`. Do not overwrite unrelated uncommitted changes on `master`.
- The user's local Qwen gateway on port 8787 is not restarted or replaced without asking the user first. Smoke runs use port 8797.
- Never log conversation content. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Shared-file resolution table

| File | Plan A edit | Plan B edit | Resolution |
|---|---|---|---|
| `gateway/src/index.ts` | A1 T4 replaces the `const roles = fixedRoleCatalog(...)` line; A1 T5 inserts lines after it | B T7 inserts lines after the `roles` line and swaps the `contextResolver` wiring line; adds imports | Keep A's `roles` line, then A's inserted lines, then B's inserted lines; keep both import sets; B's `contextResolver` line replaces the Task 0 stub line |
| `gateway/src/config.ts` | appends `export { DirectorSchema };` | appends `loadIdentityConfig` | Keep both appends |
| `gateway/test/config.test.ts` | edits the import line (drops `loadPersona`), replaces one test | rewrites the same import line, appends tests | Use B's import line (an unused `loadPersona` import is harmless), keep A's replaced test and B's appended tests |
| `app/lib/avatar_page.dart` | A2 T8 replaces `_startNativeSession()` | B T10 adds `this.identity` to the constructor and `identity: widget.identity` to `NativeGatewayClient(` | Take A's file, then re-apply B's constructor field and the `identity:` argument; Task 2 below adds `savedStyle` |
| `app/pubspec.yaml` | appends assets | adds `flutter_secure_storage` | Keep both |
| `docs/project/roadmap.md` | Plan 3 row + notes | Plan 3 row + notes | Rewrite the Plan 3 row once in Task 3; keep both notes |
| `docs/blockers.md` | appended rows | appended rows | Keep all rows |

---

### Task 1: Merge Plan B, then Plan A

**Files:** the shared files above (conflict resolution only).

- [ ] **Step 1: Confirm a clean `master`**

Run: `git status --short && git log --oneline -5`
Expected: no staged changes; Task 0 commits present. If unrelated uncommitted changes exist, stop and ask the user.

- [ ] **Step 2: Merge Plan B**

Run: `git merge --no-ff <plan-b-branch>`
Expected: clean merge (Plan B touches the shared files only on top of Task 0). If it conflicts, resolve per the table.

- [ ] **Step 3: Verify after Plan B**

Run: `npm test && npm run typecheck && (cd app && flutter test && flutter analyze)`
Expected: all PASS. Record counts.

- [ ] **Step 4: Merge Plan A**

Run: `git merge --no-ff <plan-a-branch>`
Expected: conflicts in some of `gateway/src/index.ts`, `gateway/src/config.ts`, `gateway/test/config.test.ts`, `app/lib/avatar_page.dart`, `app/pubspec.yaml`, `docs/project/roadmap.md`, `docs/blockers.md`. Resolve each per the table, then `git add` each resolved path explicitly.

- [ ] **Step 5: Verify after Plan A**

Run: `npm test && npm run typecheck && (cd app && flutter test && flutter analyze)`
Expected: all PASS. If a test fails, fix only the merge resolution (not feature code) and re-run.

- [ ] **Step 6: Commit the merge**

```bash
git commit -m "merge: Plan 3 A (persona, pacing, thinking state) into master

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Style-aware filler clips

**Files:**
- Modify: `app/lib/avatar_page.dart` (constructor and `_startNativeSession()`)
- Modify: `app/lib/main.dart` (the `avatarBuilder` closure)
- Test: `app/test/avatar_page_style_test.dart` (create)

**Interfaces:**
- Consumes: `DeviceIdentity.savedStyle(): Future<String?>` (Plan B Task 9); `ThinkingConfig.parse(String)`, `ThinkingConfig.assetPath`, `ThinkingConfig.styles: List<String>`, `ThinkingConfig.defaultStyle: String`, `loadFillerClips(AssetBundle, ThinkingConfig, String style, {DiagSink diag})` (Plan A2 Tasks 2–4).
- Produces: `AvatarPage({Key? key, DeviceTokenProvider? identity, Future<String?> Function()? savedStyle})` and a pure helper `String fillerStyle(ThinkingConfig cfg, String? saved)`.

- [ ] **Step 1: Write the failing test**

Create `app/test/avatar_page_style_test.dart`:

```dart
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:avatar_app/avatar_page.dart';
import 'package:avatar_app/native_session/thinking_config.dart';

void main() {
  // Runs from app/, like A2 Task 2's thinking_config tests.
  final cfg = ThinkingConfig.parse(File(ThinkingConfig.assetPath).readAsStringSync());

  test('uses the saved style when the config knows it', () {
    expect(fillerStyle(cfg, 'old-friend'), 'old-friend');
  });

  test('falls back to the config default for unknown or missing styles', () {
    expect(fillerStyle(cfg, null), cfg.defaultStyle);
    expect(fillerStyle(cfg, 'pirate'), cfg.defaultStyle);
  });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && flutter test test/avatar_page_style_test.dart`
Expected: FAIL with `fillerStyle` undefined.

- [ ] **Step 3: Implement**

In `app/lib/avatar_page.dart`, add at top level:

```dart
/// Filler clips follow the agent's saved style; unknown or missing styles use the config default.
String fillerStyle(ThinkingConfig cfg, String? saved) =>
    saved != null && cfg.styles.contains(saved) ? saved : cfg.defaultStyle;
```

extend the constructor and field:

```dart
  const AvatarPage({super.key, this.identity, this.savedStyle});
  final DeviceTokenProvider? identity;
  final Future<String?> Function()? savedStyle;
```

and in `_startNativeSession()` replace the merge-point lines:

```dart
    // A+B merge point: use the style stored by Plan B instead of the config default.
    final clips = thinking == null
        ? const <String, Int16List>{}
        : await loadFillerClips(rootBundle, thinking, thinking.defaultStyle);
```

with:

```dart
    final saved = await widget.savedStyle?.call();
    final clips = thinking == null
        ? const <String, Int16List>{}
        : await loadFillerClips(rootBundle, thinking, fillerStyle(thinking, saved));
```

In `app/lib/main.dart`, change the builder:

```dart
    avatarBuilder: (identity) => AvatarPage(identity: identity, savedStyle: _identity.savedStyle),
```

- [ ] **Step 4: Run tests and analyze**

Run: `cd app && flutter test && flutter analyze`
Expected: PASS, no issues.

- [ ] **Step 5: Commit**

```bash
git add app/lib/avatar_page.dart app/lib/main.dart app/test/avatar_page_style_test.dart
git commit -m "feat(app): pick filler clips by the agent's saved style

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: A+B gate on the Xiaomi and roadmap

**Files:**
- Modify: `docs/project/roadmap.md`
- Modify: `docs/blockers.md` (only if an item fails or is skipped)

- [ ] **Step 1: Ask the user before touching the phone gateway**

The gate needs the merged gateway on 8787 with `ADAPTER=qwen`. Ask the user to confirm that the running gateway may be restarted. Do not proceed without confirmation.

- [ ] **Step 2: Build, install, run**

Run:

```bash
./scripts/build-web.sh
(cd app && flutter build apk --debug --dart-define-from-file=dev.json)
adb reverse tcp:8787 tcp:8787
adb push app/build/app/outputs/flutter-apk/app-debug.apk /data/local/tmp/app-debug.apk
adb shell pm install -r -d /data/local/tmp/app-debug.apk
```

Start the merged gateway with the user's Qwen environment (`ADAPTER=qwen`, port 8787, `MEMORY_DB_PATH` outside the repo).
Expected: install `Success`; gateway logs `gateway_listening`.

- [ ] **Step 3: Gate procedure**

1. Fresh install: pick 孙辈型 on first launch; talk for one exchange; note the voice and tone.
2. Open settings, switch to 老朋友型; leave the conversation so the session ends (back out of the app, wait past the 60 s grace, reopen).
3. Talk for one exchange; note the voice and tone, and that the filler clip (if one plays) uses the new voice.
4. Gateway log check: the two `session_created` events map to the same agent short hash; no conversation text appears in logs.

Expected: after step 2 the next session uses the old-friend voice and persona. Record pass/fail per step.

- [ ] **Step 4: Update the roadmap and commit**

In `docs/project/roadmap.md`, set the Plan 3 row to "A and B merged; A+B gate: <result>; next: Plan C", and list the commands and results actually run. Add a `docs/blockers.md` row for any failed or skipped step.

```bash
git add docs/project/roadmap.md docs/blockers.md
git commit -m "docs: record Plan 3 A+B merge gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
