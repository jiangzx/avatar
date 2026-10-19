# Avatar model assets

The WebView avatar catalog reserves these relative filenames:

- `avatar.glb` - the existing default model
- `cute-girl.glb` - 可爱小女孩
- `cute-boy.glb` - 可爱小男孩
- `young-woman.glb` - 青年美女
- `young-man.glb` - 青年俊男

Each model must be a licensed GLB compatible with TalkingHead 1.7.0 and must
be reviewed on the target phone for framing, materials, facial blendshapes, and
animation quality before it is accepted as product art.

The setup script downloads the three upstream examples at a pinned TalkingHead
revision and verifies SHA-256 checksums. `cute-boy.glb` is a local derived
variant of the pinned AvatarSDK male source: it keeps the rig and blendshapes
and changes proportions for a younger, cuter silhouette. These files remain
ignored because the upstream examples are non-commercial or attribution-bound;
use them only for this internal POC and review the source terms before release.

Run `./scripts/fetch-assets.sh` to restore all five files. Missing or failed
loads still use the existing model at runtime, so an incomplete asset download
does not prevent the chat session from starting.
