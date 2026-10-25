# Avatar model assets

The WebView catalog has one character model:

- `avatar.glb` — 小柔

`placeholder.glb` is the upstream stand-in used only when `avatar.glb` is missing. It is not a picker option.

Lily is the realistic character and is not a GLB. Both Duix zip packages are copied out of the APK; see `scripts/duix/strip-lily-watermark.py`.

Run `./scripts/fetch-assets.sh` to restore `placeholder.glb` and copy it to `avatar.glb` when that file is absent. Missing or failed loads still use `avatar.glb` at runtime.
