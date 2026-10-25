# 虚拟形象替换指南（Avaturn → 本仓库）

> 更新时间：2026-10-19。本文说明如何用自建/自导出的 GLB（优先 [Avaturn](https://avaturn.me)）替换当前可选虚拟形象。产品行为见 [多形象选择设计](./superpowers/specs/2026-10-19-avatar-selection-design.md)；渲染与素材约束见 [语音 POC 设计 §8.1](./superpowers/specs/2026-10-12-avatar-voice-poc-design.md#81-渲染与素材)。  
> **给外包制作方看的纯资源要求**（不含代码）：[avatar-asset-vendor-brief.md](./avatar-asset-vendor-brief.md)。

## 1. 结论（先看这里）

**提供符合要求的 `.glb` 即可替换；不是任意 GLB。**

| 你需要交的 | 是否必须 | 说明 |
|---|---|---|
| `.glb` 模型文件 | **必须** | 每个形象一个文件 |
| Avaturn 导出时勾选 **ARKit blendshapes** | **必须** | 口型、微笑依赖这套 morph；漏勾会嘴不动或加载失败 |
| 性别标记 `F` / `M` | **必须** | TalkingHead 的 `body`；写进目录即可 |
| 中文标题 + 一句气质描述 | **建议** | 选择页文案；不进模型提示词 |
| 预览截图 PNG | 可选 | 当前选择页是纯文字卡片，不依赖预览图 |

**不需要**为每个形象单独提供动作 FBX（挥手等共用 `avatar-core/public/animations/`）。**不需要**改网关、角色提示词或音色——形象选择是客户端本地偏好。

## 2. 技术约束（TalkingHead 兼容）

运行时用 `@met4citizen/talkinghead` 加载 GLB。验收口径（设计 §8.1 + 现有真机检查）：

| 项 | 要求 |
|---|---|
| 格式 | `.glb`（glTF 2.0 binary） |
| 表情 | **52 个 ARKit blendshape**（至少要有口型相关：`jawOpen`、`mouthSmile`、`mouthFunnel` 等） |
| 骨骼 | **Mixamo 兼容**；节点中应有 `Armature`、`Head` |
| 面数 | 约 **3 万三角形** 量级（手机更稳） |
| 贴图 | **≤ 1024～2048**；不做实时阴影 |
| 构图 | 竖屏半身（头到腰）；动作幅度留在画面内 |

自动化烟雾检查见 `avatar-core/test/avatarAssets.test.ts`：每个目录内模型须含 `Armature`、`Head`，且 mesh 上有 morph targets。

## 3. 在 Avaturn 里怎么做

1. 在 [avaturn.me](https://avaturn.me) 设计人物。
2. 导出选 **GLB**。
3. **务必勾选 ARKit blendshapes**（项目设计明确优先此路径）。
4. 下载后本地改名为目录约定的文件名（见下一节），或按新 `id` 命名后改目录映射。
5. 授权：只用于本仓库允许的用途；自建形象的授权由你自行确认，**不要把不可分发的 GLB 提交进 git**（`*.glb` 在 `avatar-core/public/avatars/` 下被忽略）。

## 4. 仓库里的目录与文件落点

### 4.1 唯一产品目录（改形象从这里改）

源文件：`scripts/avatar-catalog.json`

```json
{
  "defaultId": "default",
  "avatars": [
    {
      "id": "default",
      "title": "小柔",
      "description": "温和自然，陪您轻松聊天",
      "assetPath": "./avatars/avatar.glb",
      "body": "F"
    }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `id` | 本地存储的 `avatar_id`。聊天伙伴里未知 id 下次会打开 Lily；这份 GLB 目录里未知路径仍回退 `default` |
| `title` / `description` | Flutter 选择页主标题 / 副标题 |
| `assetPath` | WebView 相对路径，必须形如 `./avatars/<file>.glb`，且出现在白名单中 |
| `body` | `"F"` 或 `"M"`，传给 TalkingHead `showAvatar` |

改完后生成客户端代码（**不要手改**生成物）：

```bash
node scripts/generate-avatar-catalog.mjs
```

会写出：

- `app/lib/identity/avatars.generated.dart`
- `avatar-core/src/avatar/catalog.generated.ts`

### 4.2 GLB 放置位置

| 路径 | 作用 |
|---|---|
| `avatar-core/public/avatars/<name>.glb` | 开发与 Vite 构建的源资源（**git 忽略**） |
| `app/assets/web/avatars/` | `./scripts/build-web.sh` 拷贝后的 Flutter 内嵌资源（**git 忽略**） |

当前产品目录只有小柔这一份 GLB。Lily 是真人形象，模型在 APK 内的 Duix 压缩包里，不走这个目录。

| id | 文件 | 说明 |
|---|---|---|
| `default` | `avatar.glb` | 小柔，WebView 3D |

仅替换外观、保持 id 不变时：用新 GLB **覆盖同名文件**，再重建 Web bundle。增减形象则同时改 `avatar-catalog.json` 并重新生成。

### 4.3 与 `fetch-assets.sh` / `avatar-assets.json` 的关系

`./scripts/fetch-assets.sh` 会：

1. 生成目录代码；
2. 按 `scripts/avatar-assets.json` 恢复 `placeholder.glb` 并校验 SHA-256（`FORCE_AVATAR=1` 会重新下载）；
3. 仅当 `avatar.glb` 不存在时，把已校验的 `placeholder.glb` 复制过去作为占位；**已有的 `avatar.glb` 永不覆盖**。

`avatar.glb`（小柔）是本地自备模型，不进入上游 manifest，也不参与 checksum。`fetch-assets.sh` 不会把它换回占位模型，也不会再拉回已删除的四个示例形象。

**用 Avaturn 自建模型替换后：**

- 把 GLB 直接放进 `avatar-core/public/avatars/`，更新 `avatar-catalog.json`，跑生成脚本 + `build-web.sh`。
- 不要把已移除的 `cute-girl.glb`、`cute-boy.glb`、`young-woman.glb`、`young-man.glb` 加回 manifest；设置页不再提供这些形象。

## 5. 替换步骤（推荐清单）

### A. 替换小柔

1. 在 Avaturn 导出 GLB（勾选 ARKit）。
2. 命名为 `avatar.glb`，复制到 `avatar-core/public/avatars/`。
3. 若标题、描述或性别变了，编辑 `scripts/avatar-catalog.json` 后执行 `node scripts/generate-avatar-catalog.mjs`。
4. 构建并安装：

   ```bash
   ./scripts/build-web.sh
   # 再按现有流程 flutter run / 打 debug APK，使用 app/dev.json
   ```

5. 在聊天伙伴设置里选中小柔并保存。保存后当前聊天会结束并立刻用新形象重开。

### B. 增删或改 id

1. 编辑 `scripts/avatar-catalog.json`（每个条目含 `id`、`title`、`description`、`assetPath`、`body`）。
2. 把对应 GLB 放到 `avatar-core/public/avatars/`，文件名与 `assetPath` 一致。
3. `node scripts/generate-avatar-catalog.mjs`
4. 若测试里写死了旧文件名列表，同步更新 `avatar-core/test/avatarAssets.test.ts` 等。
5. `./scripts/build-web.sh`，再真机/模拟器验证选择页与加载。

### C. 交给维护者时的交付清单

每个形象请一并提供：

```text
- <file>.glb          # Avaturn，已勾 ARKit
- id: ...             # 或写明覆盖哪个现有 id
- title: ...
- description: ...
- body: F | M
```

## 6. 验证

| 检查 | 命令或做法 |
|---|---|
| 目录生成 | `node scripts/generate-avatar-catalog.mjs` 后确认两个 generated 文件与 JSON 一致 |
| GLB 结构烟雾 | 资源齐备时：`npm test -w avatar-core -- test/avatarAssets.test.ts` |
| 类型与单测 | `npm test -w avatar-core`；`cd app && flutter test`（含 catalog / picker） |
| Web bundle | `./scripts/build-web.sh` 后确认 `app/assets/web/avatars/` 内有对应 `.glb` |
| 真机观感 | 半身构图、微笑/口型、挥手点头等动作是否在画面内；帧率是否可接受 |

失败时的产品行为（设计已定）：某 GLB 缺失或加载失败 → 回退默认模型并发匿名诊断；**聊天会话仍可启动**。

## 7. 常见问题

**只给我一个 GLB，能不能用？**  
可以，但必须满足第 2 节；并告诉维护者对应哪个 `id`（或新建条目）以及 `body`。

**Avaturn 没勾 ARKit 会怎样？**  
模型可能能显示，但口型、固定微笑、情绪 morph 会缺或无效；与 TalkingHead 集成视为不合格素材。

**要不要改音色 / 人设？**  
不要。形象与「孙辈型 / 老朋友型」风格独立；声音走角色配置，不跟 `avatar_id` 绑定。

**能不能热切换？**  
不能。保存后下次会话再生效。

**为什么 GLB 不进 git？**  
上游示例许可多为非商用/需署名；自建文件体积大且授权因人而异。机器间用拷贝或本机重新导出；见 [新电脑迁移指南](./migration/new-machine-setup.md)。

## 8. 相关文件索引

| 文件 | 用途 |
|---|---|
| `scripts/avatar-catalog.json` | 形象目录源数据 |
| `scripts/generate-avatar-catalog.mjs` | 生成 Dart / TS |
| `scripts/avatar-assets.json` | 上游示例恢复与 checksum（可选） |
| `scripts/fetch-assets.sh` | 恢复示例资源 + 生成目录 |
| `scripts/build-web.sh` | 打进 Flutter 的 WebView bundle |
| `avatar-core/src/avatar/avatarView.ts` | `showAvatar` 加载 |
| `avatar-core/public/avatars/README.md` | 资源目录短说明 |
| `app/lib/identity/avatar_picker_page.dart` | 选择 UI |

## Truth source

| 主题 | 唯一来源 |
|---|---|
| 多形象产品行为 | `docs/superpowers/specs/2026-10-19-avatar-selection-design.md` |
| 渲染与 ARKit / Mixamo 约束 | `docs/superpowers/specs/2026-10-12-avatar-voice-poc-design.md` §8.1 |
| 本仓库替换操作步骤 | **本文** |
