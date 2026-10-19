# Avatar Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four selectable avatar appearances while preserving the existing avatar, keeping avatar choice independent from chat style, and applying changes on the next session.

**Architecture:** Flutter owns the local avatar preference and selection flow. It resolves a stored avatar id through a typed catalog and sends only the catalog's relative model path to the WebView. `avatar-core` validates that path against its own allowlist and loads the requested GLB with the existing model as a runtime fallback; the gateway and protocol remain unchanged.

**Tech Stack:** Dart 3.13 / Flutter, FlutterSecureStorage, TypeScript 7, Vite, TalkingHead, Vitest, Flutter test.

**Spec:** `docs/superpowers/specs/2026-10-19-avatar-selection-design.md`

## Global Constraints

- Replies and user-facing copy are Simplified Chinese; code comments are short English.
- Do not log conversation content, audio, model paths, secrets, or model responses.
- Do not modify gateway HTTP/WS contracts, role prompts, memory, or voice configuration.
- Avatar choice is local-only, stored under `avatar_id`; it takes effect on the next session and never hot-swaps an active session.
- Only catalog-listed relative paths under `./avatars/` are accepted by the WebView bridge; reject URLs, `data:`, and traversal.
- Unknown ids and missing models fall back to the existing `avatar.glb` so old installs remain runnable.
- Do not stage unrelated working-tree changes; add explicit paths only.
- Run the relevant failing test before each implementation step and report real commands/results.

## File Map

- Create `app/lib/identity/avatars.dart`: typed avatar catalog, ids, copy, default, and relative asset paths.
- Create `app/lib/identity/companion_picker.dart`: shared selection card/section primitives used by style and avatar selection surfaces.
- Modify `app/lib/identity/styles.dart`: make style options use the shared picker option shape without changing existing ids or copy.
- Modify `app/lib/identity/device_identity.dart`: add `avatar_id` storage and guarded local save/read operations.
- Modify `app/lib/identity/app_shell.dart`: load both preferences, run the first-launch avatar step, pass avatar id into the avatar page, and open the combined settings page.
- Modify `app/lib/identity/style_picker_page.dart`: reuse shared selection primitives and preserve current first-launch/settings behavior.
- Create `app/lib/identity/avatar_picker_page.dart`: first-launch avatar selection surface.
- Create `app/lib/identity/companion_settings_page.dart`: one settings page with independent style and avatar sections and atomic navigation/error behavior.
- Modify `app/lib/main.dart`: pass the selected avatar id through `avatarBuilder`.
- Modify `app/lib/avatar_page.dart`: resolve avatar id to the catalog path and include `avatarUrl` in the WebView config.
- Create `app/test/avatar_catalog_test.dart`: catalog ids, default, paths, and unknown-id fallback.
- Modify `app/test/device_identity_test.dart`: avatar storage success/failure and no-gateway behavior.
- Create `app/test/companion_picker_test.dart`: selection, disabled/loading, and accessibility-sized controls.
- Modify/add `app/test/app_shell_test.dart`: first-launch sequencing, old-user backfill, and settings updates.
- Modify `app/test/avatar_page_style_test.dart` or create `app/test/avatar_page_config_test.dart`: config path resolution and existing style filler behavior.
- Create `avatar-core/src/avatar/catalog.ts`: WebView default and allowlisted avatar paths.
- Modify `avatar-core/src/bridge.ts`: add optional/normalized `avatarUrl` to the Flutter config type.
- Modify `avatar-core/src/bridgeValidate.ts`: validate and normalize `avatarUrl` at the boundary.
- Modify `avatar-core/src/main.ts`: use the normalized requested path for native and desktop boot.
- Modify `avatar-core/src/app.ts`: keep `AppConfig.avatarUrl` typed and passed to the shared avatar loader.
- Modify `avatar-core/src/nativeAvatar.ts`: pass the fallback diagnostic callback when loading the native-only avatar path.
- Modify `avatar-core/src/avatar/avatarView.ts`: retry the default model when a non-default model fails and expose a content-free fallback callback.
- Modify `avatar-core/test/bridgeValidate.test.ts`: valid catalog paths, default normalization, URL/traversal rejection.
- Modify/create `avatar-core/test/avatarView.test.ts`: requested model load and fallback load behavior.
- Create `avatar-core/test/catalog.test.ts`: allowlist/default invariants.
- Create `avatar-core/public/avatars/README.md`: document required model filenames and the current external-resource gap without claiming the models exist.
- Modify `docs/blockers.md`: record that four distinct GLBs are external input and visual acceptance remains open until supplied.
- Modify `docs/project/roadmap.md`: record implementation status, tests run, and the remaining asset/device gates.

### Task 1: Add the avatar catalog and local preference API

**Files:**
- Create: `app/lib/identity/avatars.dart`
- Modify: `app/lib/identity/device_identity.dart`
- Create: `app/test/avatar_catalog_test.dart`
- Modify: `app/test/device_identity_test.dart`

**Interfaces:**
- `AvatarOption({id, title, subtitle, assetPath})` with immutable fields.
- `const defaultAvatarId = 'default'`.
- `const avatarOptions: List<AvatarOption>` containing `default`, `cute-girl`, `cute-boy`, `young-woman`, and `young-man`.
- `AvatarOption avatarOptionFor(String? id)` returning the default for null/unknown ids.
- `String avatarUrlFor(String? id)` returning the selected option's `assetPath`.
- `DeviceIdentity.avatarKey`, `Future<String?> savedAvatar()`, and `Future<IdentityResult> changeAvatar(String avatarId)`; `changeAvatar` validates against the catalog, writes only `avatar_id`, and never calls `IdentityBackend`.

- [ ] **Step 1: Write failing catalog tests** for the five ids, default ordering, exact relative paths, and unknown/null fallback.
- [ ] **Step 2: Run the focused test to verify failure**: `cd app && flutter test test/avatar_catalog_test.dart`.
- [ ] **Step 3: Implement the typed catalog** with the four requested labels and concise non-model-facing subtitles.
- [ ] **Step 4: Run the focused catalog test** and confirm it passes.
- [ ] **Step 5: Write failing `DeviceIdentity` tests** for avatar save/read, storage failure, invalid id rejection, and no backend calls.
- [ ] **Step 6: Run the focused identity test**: `cd app && flutter test test/device_identity_test.dart`.
- [ ] **Step 7: Implement guarded local avatar persistence** using the existing `CredentialStore` and error conventions.
- [ ] **Step 8: Run the focused identity tests** and the existing style identity tests.
- [ ] **Step 9: Commit** `feat: add local avatar catalog preference`.

### Task 2: Build the reusable picker surfaces and combined settings flow

**Files:**
- Create: `app/lib/identity/companion_picker.dart`
- Modify: `app/lib/identity/styles.dart`
- Modify: `app/lib/identity/style_picker_page.dart`
- Create: `app/lib/identity/avatar_picker_page.dart`
- Create: `app/lib/identity/companion_settings_page.dart`
- Create: `app/test/companion_picker_test.dart`
- Create/modify: `app/test/app_shell_test.dart`

**Interfaces:**
- Shared picker cards preserve the current dark-teal visual system, ≥60 dp touch targets, ≥18 sp copy, selected check state, disabled/loading state, and semantics labels.
- `AvatarPickerPage` mirrors the existing style picker API: title, confirm label, initial id, busy/error, confirm callback, and optional cancel.
- `CompanionSettingsPage` accepts current style/avatar plus independent async save callbacks and returns a `CompanionSelection(style, avatar)` only after all requested saves succeed.

- [ ] **Step 1: Add failing widget tests** for rendering all five avatar options, selecting an option, confirm callback id, loading/disabled controls, first-launch cancel absence, and settings cancel presence.
- [ ] **Step 2: Run focused widget tests to verify failure**: `cd app && flutter test test/companion_picker_test.dart test/app_shell_test.dart`.
- [ ] **Step 3: Extract the shared option/card primitives** without changing current style ids, copy, or layout character.
- [ ] **Step 4: Implement `AvatarPickerPage`** using the catalog and shared card.
- [ ] **Step 5: Implement `CompanionSettingsPage`** with separate style/avatar sections; save only changed sections and retain the page on failure.
- [ ] **Step 6: Run focused widget tests** and existing style-picker/overlay tests.
- [ ] **Step 7: Commit** `feat: add avatar picker and companion settings`.

### Task 3: Wire first launch, persistence, and next-session behavior in Flutter

**Files:**
- Modify: `app/lib/identity/app_shell.dart`
- Modify: `app/lib/main.dart`
- Modify: `app/lib/avatar_page.dart`
- Create/modify: `app/test/app_shell_test.dart`
- Create/modify: `app/test/avatar_page_config_test.dart`

**Interfaces:**
- `AppShell.avatarBuilder` becomes `Widget Function(DeviceTokenProvider identity, String avatarId)`.
- App shell state tracks `_style` and `_avatar` independently; missing avatar after a loaded style displays the avatar picker.
- `AvatarPage({identity, savedStyle, avatarId = defaultAvatarId})` remains backward-compatible for dev/test callers.
- A pure helper used by tests builds the config map with `avatarUrl: avatarUrlFor(avatarId)`; no arbitrary id is sent to JavaScript.

- [ ] **Step 1: Add failing shell tests** for style → avatar → chat sequencing, old-user avatar backfill, settings result updates, and no current-session rebuild when saving.
- [ ] **Step 2: Add failing config tests** asserting the resolved path is sent and unknown ids resolve to the default path.
- [ ] **Step 3: Run focused tests to verify failure**: `cd app && flutter test test/app_shell_test.dart test/avatar_page_config_test.dart`.
- [ ] **Step 4: Wire `AppShell` to load/save both preferences** and pass the selected id to `avatarBuilder`.
- [ ] **Step 5: Wire `AvatarPage` and `main.dart`** so only the next `AvatarPage`/session receives the new model path; keep filler style resolution unchanged.
- [ ] **Step 6: Run focused Flutter tests**, then `cd app && flutter analyze`.
- [ ] **Step 7: Commit** `feat: pass selected avatar into WebView sessions`.

### Task 4: Validate the avatar path and add runtime model fallback in avatar-core

**Files:**
- Create: `avatar-core/src/avatar/catalog.ts`
- Modify: `avatar-core/src/bridge.ts`
- Modify: `avatar-core/src/bridgeValidate.ts`
- Modify: `avatar-core/src/main.ts`
- Modify: `avatar-core/src/app.ts`
- Modify: `avatar-core/src/nativeAvatar.ts`
- Modify: `avatar-core/src/avatar/avatarView.ts`
- Create: `avatar-core/test/catalog.test.ts`
- Modify: `avatar-core/test/bridgeValidate.test.ts`
- Create/modify: `avatar-core/test/avatarView.test.ts`

**Interfaces:**
- `DEFAULT_AVATAR_URL = './avatars/avatar.glb'`.
- `ALLOWED_AVATAR_URLS` contains exactly the five catalog paths.
- `parseFromFlutter({type:'config', ...})` returns a normalized `avatarUrl`, defaulting when omitted, and returns null for absolute URLs, non-avatar paths, traversal, or non-string values.
- `AvatarView.load(url, onFallback?)` attempts the requested model and retries the default once when the requested non-default model fails; `onFallback` receives no content and is used only for `avatar_fallback` diagnostics.

- [ ] **Step 1: Write failing catalog and bridge tests** for allowlisted paths, omitted default, traversal, `http:`, `data:`, and unknown model names.
- [ ] **Step 2: Run focused TypeScript tests to verify failure**: `npm test -w avatar-core -- test/catalog.test.ts test/bridgeValidate.test.ts`.
- [ ] **Step 3: Implement the catalog and normalized bridge config**; preserve all existing gateway/audio validation.
- [ ] **Step 4: Write failing `AvatarView` fallback tests** with a fake TalkingHead whose requested load rejects and default load succeeds.
- [ ] **Step 5: Run the focused avatar view test to verify failure**: `npm test -w avatar-core -- test/avatarView.test.ts`.
- [ ] **Step 6: Implement one bounded default retry** and connect the content-free diagnostic callback from both AppController and NativeAvatarController.
- [ ] **Step 7: Run focused TypeScript tests and typecheck**: `npm test -w avatar-core -- test/catalog.test.ts test/bridgeValidate.test.ts test/avatarView.test.ts && npm run typecheck -w avatar-core`.
- [ ] **Step 8: Commit** `feat: validate avatar assets and fall back safely`.

### Task 5: Document resource inputs, build the WebView bundle, and verify the complete change

**Files:**
- Create: `avatar-core/public/avatars/README.md`
- Modify: `docs/blockers.md`
- Modify: `docs/project/roadmap.md`

- [ ] **Step 1: Document the required GLB filenames, licensing/provenance expectations, and the fact that this checkout currently has only the local default model.**
- [ ] **Step 2: Run the full JavaScript suite and typecheck**: `npm test && npm run typecheck`.
- [ ] **Step 3: Run the full Flutter suite and analyzer**: `cd app && flutter test && flutter analyze`.
- [ ] **Step 4: Run `./scripts/build-web.sh`** only if the local asset prerequisites are present; otherwise run `./scripts/build-web.sh --probe-only` and record why the full build is deferred.
- [ ] **Step 5: Inspect the generated bundle** to confirm `app/assets/web/avatars/` contains the default model and expected directory structure, without committing generated ignored output.
- [ ] **Step 6: Run `git diff --check` and the Impeccable detector once on changed UI files**: `/Users/jed/.agents/skills/impeccable/scripts/impeccable detect --json app/lib/identity app/lib/avatar_page.dart`.
- [ ] **Step 7: Update the roadmap with exact tests/results and leave the external-GLB and device visual gates open.**
- [ ] **Step 8: Commit** `docs: record avatar selection verification and asset gate`.

## Acceptance Criteria

- A fresh install can choose a chat style, then an avatar, and reach the chat page.
- An existing install with a style but no avatar receives one avatar-selection step and then proceeds normally.
- The settings page exposes both independent choices; changing either does not call the wrong backend or alter the other choice.
- A saved avatar applies after the next session starts; the current session is not restarted.
- Only five known relative model paths cross the WebView bridge; malformed paths are rejected and omitted paths normalize to the default.
- A missing non-default GLB retries the default model and keeps the conversation usable.
- Existing gateway, memory, style, audio, and Mock behavior remains unchanged.
- All executed test/build commands and any skipped visual/device checks are recorded in `docs/project/roadmap.md`.
