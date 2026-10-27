# Task 13: App 角色配置、首次选择角色、去风格、`POST /session` 带角色、垫话目录

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。先读 spec 对应章节，再读 `00-overview.md`，最后读本文件。步骤用 `- [ ]` 勾选。

**Goal:** App 端从「风格 + 形象」改成「角色」：角色清单来自 `app/assets/config/characters.json`（id 与生成的 `characterIds` 一致），首次启动选择角色并注册，本地只存 `device_token` 和 `character_id`；`POST /session` 的 body 带 `{"character": id}`；删掉风格相关的全部代码、`voiceProfile`、`characterNameForEngine`；Duix 模型和 3D 形象由角色配置决定；垫话音频按角色存放。

**Spec 章节：** 产品设计「角色」「Duix 不可用」最后一条（角标按角色显示）；技术设计 §1（契约：`POST /session` body、`voiceProfile` 删除、未知 kind 按 reply）、§9（App：角色配置、首次启动、请求 body、垫话音频、Duix 模型）；错误处理「未知角色」。

**前置：**
- Task 1 已完成：`app/lib/identity/character_ids.generated.dart` 存在，内容为 `const characterIds = <String>['xiaonuan', 'xiaokai', 'xiaoxin'];` 和 `const defaultCharacterId = 'xiaonuan';`。先跑 `node scripts/generate-character-ids.mjs --check` 确认。
- Task 7 已完成：网关 `POST /session` 接受 `{"character": id}`，非法值返回 400 `unknown_character`；`POST /device/register` 不再接收 `style`。
- 基线绿：`cd app && flutter test && flutter analyze`。

**本任务不做（留给后续任务）：**
- 按角色计算可用性、置灰样式、「不悄悄换人」：Task 14。本任务只定义 `CharacterAvailability` 类型和选择页的钩子，`EngineSwitchController` 的回退逻辑**暂时保持原样**（行为等价），由 Task 14 删除。
- 设置页的记忆区块：Task 15。
- AI 提示与休息提醒 toast：Task 16（本任务只让协议解析接受 `reminder`）。

## Files

- Create:
  - `app/assets/config/characters.json`
  - `app/lib/identity/character_availability.dart`
  - `app/lib/identity/character_picker_page.dart`
  - `app/lib/identity/character_engine_prefs.dart`（临时桥接，Task 14 删除）
  - `app/test/support/character_fixture.dart`
  - `app/test/character_picker_test.dart`
  - `app/test/avatar_page_filler_test.dart`
  - `app/assets/filler/xiaonuan/`、`app/assets/filler/xiaokai/`、`app/assets/filler/xiaoxin/`（由现有片段移动和复制，见 Step 9）
- Modify（行号为写计划时核对过的、本任务开始前的行号；同一文件改多处时，先改的会让后面的行号偏移，请按引用的代码内容定位）:
  - `app/lib/identity/characters.dart:1-64`（整体重写）
  - `app/lib/identity/device_identity.dart:1-138`（整体重写）
  - `app/lib/identity/identity_api.dart:27-32`（接口）、`:51-73`（`register`、`patchStyle`）
  - `app/lib/identity/app_shell.dart:1-254`（整体重写）
  - `app/lib/identity/companion_settings_page.dart:1-136`（整体重写，只剩「选择陪伴角色」）
  - `app/lib/main.dart:1-126`（整体重写）
  - `app/lib/avatar_page.dart:13`（import）、`:57-59`（`fillerStyle`）、`:70-101`（构造参数）、`:214-258`（`_startNativeSession`）、`:324-325`（`UiError` 分支）、`:475`（角标）
  - `app/lib/native_gateway/protocol.dart:34-54`（`SessionStart`）、`:218-220`（`response.start`）
  - `app/lib/native_gateway/gateway_client.dart:48`、`:65`、`:146-158`、`:184`
  - `app/lib/native_session/thinking_config.dart:40-41`、`:60-61`、`:67`、`:95-99`、`:112-113`
  - `app/lib/native_audio/filler_clips.dart:16-31`
  - `app/assets/config/thinking.json:12-13`
  - `app/pubspec.yaml:70-71`
  - Tests: `app/test/characters_test.dart`（重写）、`app/test/device_identity_test.dart`（重写）、`app/test/identity_api_test.dart`、`app/test/app_shell_test.dart`（重写）、`app/test/companion_picker_test.dart`（重写）、`app/test/engine_switch_controller_test.dart`（重写）、`app/test/native_gateway_client_test.dart`、`app/test/native_gateway_protocol_test.dart`、`app/test/thinking_config_test.dart`、`app/test/filler_clips_test.dart`、`app/test/filler_assets_test.dart`（重写）、`app/test/support/identity_fakes.dart`、`app/test/support/thinking_fixture.dart`
- Delete:
  - `app/lib/identity/styles.dart`
  - `app/lib/identity/style_picker_page.dart`（`identityErrorText` 移到 `character_picker_page.dart`）
  - `app/lib/identity/avatar_picker_page.dart`（只有 `companion_picker_test.dart` 在用）
  - `app/test/style_picker_test.dart`（用例并入 `character_picker_test.dart`）
  - `app/test/avatar_page_style_test.dart`（由 `avatar_page_filler_test.dart` 替代）
  - `app/assets/filler/grandchild/`、`app/assets/filler/old-friend/`（移动后不再存在）
- 不改：`app/lib/identity/avatars.generated.dart` 和 `scripts/avatar-catalog.json`。它们是 3D 形象目录（`default` → `./avatars/avatar.glb`），继续由 `WebViewAvatarEngine` 使用；目录里的 `title: '小柔'` 不再出现在任何界面上。

## Interfaces

- Consumes:
  - Task 1：`characterIds`、`defaultCharacterId`（`app/lib/identity/character_ids.generated.dart`）。
  - Task 7：`POST /session` body `{ character?: CharacterId }`，400 `unknown_character`；`POST /device/register` body 只有 `clientInfo`。
  - 现有：`PickerOption`、`SelectionCard`（`companion_picker.dart:3-83`）；`EngineSwitchController`（`engine_switch_controller.dart:16-166`，本任务不改）；`EnginePrefs`（`avatar_engine.dart:84-91`）；`DuixAvatarEngine(modelId:)`（`duix_engine.dart:20-32`）；`WebViewAvatarEngine(avatarId:)`（`webview_engine.dart:39-42`）；`defaultAvatarId`（`avatars.generated.dart:12`）；`unsupportedText` 等文案（`engine_copy.dart`）。
- Produces（与总览 C12 一致）:
  - `app/assets/config/characters.json`：`{ "characters": [ { "id", "title", "subtitle", "engine": "duix" | "webview", "duixModel"?: string, "webviewAvatar"?: string } ] }`。
  - `app/lib/identity/characters.dart`：
    ```dart
    class CharacterOption implements PickerOption { id, title, subtitle, engine, duixModel, webviewAvatar }
    class CharacterCatalog { List<CharacterOption> options; CharacterOption? byId(String id); String get defaultId; }
    Future<CharacterCatalog> loadCharacterCatalog(AssetBundle bundle);
    ```
    另加（C12 之外的新增，不改冻结形状）：`CharacterCatalog.assetPath`、`static CharacterCatalog parse(String source)`（测试和加载共用）、`bool isCharacterId(String id)`，并 re-export 生成文件。
  - `DeviceIdentity`：key `device_token`、`character_id`；`savedCharacter()`、`chooseFirstCharacter(String id)`（注册 + 保存）、`changeCharacter(String id)`；删除全部 style、avatar、`EnginePrefs` 实现。
  - `IdentityBackend.register()` 无参数；删除 `patchStyle`。
  - `NativeGatewayClient(characterId:)`，`POST /session` body 为 `{"character": id}`（`characterId` 为 null 时为 `{}`）；`SessionStart` 删除 `voiceProfile`。
  - `parseServerMessage`：`response.start` 接受 `reminder`；未知的字符串 kind 按 `reply` 处理。
  - 垫话音频 `assets/filler/<characterId>/`；`thinking.json` 的 `defaultStyle`/`styles` 改为 `defaultCharacter`/`characters`；`ThinkingConfig.defaultCharacter`、`ThinkingConfig.characters`、`clipAsset(characterId, clipId)`。
  - 给 Task 14 的钩子：
    ```dart
    // app/lib/identity/character_availability.dart
    sealed class CharacterAvailability; Available; Preparing(double? fraction); Unavailable(String reason);
    PrepareFailed(String reason); Hidden; Checking;
    bool canPick(CharacterAvailability a);
    CharacterAvailability everyCharacterAvailable(CharacterOption option);
    // app/lib/identity/character_picker_page.dart
    String initialCharacter(List<CharacterOption> options, String preferred, CharacterAvailability Function(CharacterOption) availabilityOf);
    class CharacterCardList; class CharacterPickerPage(availabilityOf, availabilityChanges, ...);
    String identityErrorText(String reason); const unknownCharacterText;
    ```
  - `AvatarPageRequest {key, identity, character: CharacterOption, engine, onEngineFailure, onUnknownCharacter}`；`AppShell({identity, catalog, avatarBuilder, engines})`；`AvatarPage(characterId, displayName, onUnknownCharacter)`。

## 调用方适配（保证 `flutter test`、`flutter analyze` 全绿）

| 位置 | 断在哪里 | 处理 |
|---|---|---|
| `lib/avatar_page.dart:13,58-59,88,94-97,222-237,252,475` | `fillerStyle`、`savedStyle`、`characterUsesYoungMaleVoice`、`youngMaleVoiceProfile`、`characterNameForEngine` 被删 | Step 11 改成 `fillerCharacter`、`characterId`、`displayName` |
| `lib/main.dart:105,119-121` | `request.avatarId`、`savedStyle`、`characterTitle` 被删；`EngineSwitchController(prefs: _identity)` 不再成立 | Step 12 重写，`prefs` 用临时的 `CharacterEnginePrefs` |
| `lib/identity/app_shell.dart` 全文 | style/avatar API 全部删除 | Step 7 重写 |
| `lib/identity/companion_settings_page.dart` 全文 | `styleOptions`、`characterOptions`、`CompanionSelection` 被删 | Step 7 重写 |
| `lib/native_audio/filler_clips.dart:20,26` | 参数名语义从 style 改为角色 | Step 9 |
| `test/support/identity_fakes.dart:8-32` | `register({style})`、`patchStyle` | Step 3：`register()`，记录 `registerCalls` |
| `test/device_identity_test.dart` 全文 | style/avatar/engine API | Step 3 重写 |
| `test/identity_api_test.dart:30-62` | `register(style:)`、`patchStyle` | Step 3 |
| `test/characters_test.dart` 全文 | 旧常量和函数 | Step 1 重写 |
| `test/style_picker_test.dart` | `StylePickerPage` 删除 | 删除，用例并入 `character_picker_test.dart`（Step 5） |
| `test/companion_picker_test.dart` 全文 | `AvatarPickerPage`、旧设置页参数 | Step 7 重写 |
| `test/app_shell_test.dart` 全文 | key、页面、builder 签名 | Step 7 重写 |
| `test/engine_switch_controller_test.dart:20,34-137,141-154` | `DeviceIdentity` 不再是 `EnginePrefs`；`avatarKey` 删除 | Step 7 重写：`prefs: CharacterEnginePrefs(...)`；断言改为「不改写角色」；删除 `_FailEngineWrite` 和依赖存储写失败的用例（`saveEngine` 已不写存储） |
| `test/avatar_page_style_test.dart` | `fillerStyle` 删除 | 删除，Step 11 新建 `avatar_page_filler_test.dart` |
| `test/thinking_config_test.dart:15,21,34-37`、`test/support/thinking_fixture.dart:14-15` | `defaultStyle`/`styles` | Step 9 |
| `test/filler_clips_test.dart:31-34`、`test/filler_assets_test.dart` | 目录名 | Step 9 |
| `test/native_gateway_protocol_test.dart` | `SessionStart(voiceProfile:)` 不再存在（当前用例没用到，只补新用例） | Step 10 |
| `test/native_gateway_client_test.dart:273-322` | 需要记录 body | Step 10 给 `FakeGatewayTransport` 加 `postedBodies` |
| `test/avatar_page_engine_test.dart`、`test/overlay_test.dart` | 不受影响（`page()` 没传 `savedStyle`；overlay 的 `name` 只是字符串） | 不改 |

## Steps

- [x] **Step 1: 写失败的测试：角色配置与目录**

新建 `app/test/support/character_fixture.dart`：

```dart
import 'dart:io';

import 'package:avatar_app/identity/characters.dart';

/// The shipped assets/config/characters.json (flutter test runs in app/).
CharacterCatalog loadTestCharacterCatalog() =>
    CharacterCatalog.parse(File(CharacterCatalog.assetPath).readAsStringSync());
```

把 `app/test/characters_test.dart` 整体替换为：

```dart
import 'dart:convert';
import 'dart:io';

import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/identity/avatars.dart';
import 'package:avatar_app/identity/characters.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';
import 'support/duix_fakes.dart';

Map<String, Object?> shipped() =>
    jsonDecode(File(CharacterCatalog.assetPath).readAsStringSync()) as Map<String, Object?>;

List<Map<String, Object?>> entries(Map<String, Object?> m) =>
    (m['characters'] as List).cast<Map<String, Object?>>();

void main() {
  test('the shipped catalog lists 小暖, 小凯, 小欣 in the protocol order', () {
    final catalog = loadTestCharacterCatalog();
    expect(characterIds, ['xiaonuan', 'xiaokai', 'xiaoxin']);
    expect(catalog.options.map((o) => o.id), characterIds);
    expect(catalog.options.map((o) => o.title), ['小暖', '小凯', '小欣']);
    expect(catalog.options.map((o) => o.engine), [
      AvatarEngineKind.duix,
      AvatarEngineKind.duix,
      AvatarEngineKind.webview,
    ]);
    expect(catalog.byId('xiaonuan')!.duixModel, 'lily');
    expect(catalog.byId('xiaokai')!.duixModel, 'kai');
    expect(catalog.byId('xiaoxin')!.webviewAvatar, 'default');
    expect(catalog.byId('xiaoxin')!.duixModel, isNull);
    expect(catalog.defaultId, 'xiaonuan');
    expect(catalog.defaultId, defaultCharacterId);
    expect(catalog.byId('lily'), isNull);
    for (final o in catalog.options) {
      expect(o.subtitle, isNotEmpty);
    }
  });

  test('Duix models and 3D avatars exist in their own catalogs', () {
    final duix = loadTestDuixConfig();
    for (final o in loadTestCharacterCatalog().options) {
      if (o.engine == AvatarEngineKind.duix) {
        expect(duix.models.map((m) => m.id), contains(o.duixModel), reason: o.id);
      } else {
        expect(isAvatarId(o.webviewAvatar!), isTrue, reason: o.id);
      }
    }
  });

  test('isCharacterId follows the generated list only', () {
    expect(isCharacterId('xiaokai'), isTrue);
    expect(isCharacterId('lily'), isFalse);
    expect(isCharacterId('default'), isFalse);
  });

  test('rejects a catalog whose ids differ from the generated list', () {
    final missing = shipped();
    entries(missing).removeLast();
    expect(() => CharacterCatalog.parse(jsonEncode(missing)), throwsFormatException);

    final reordered = shipped();
    final list = entries(reordered);
    list.insert(0, list.removeLast());
    expect(() => CharacterCatalog.parse(jsonEncode(reordered)), throwsFormatException);

    final unknown = shipped();
    entries(unknown).first['id'] = 'lily';
    expect(() => CharacterCatalog.parse(jsonEncode(unknown)), throwsFormatException);
  });

  test('rejects an engine without its asset id, or with the other one', () {
    final noModel = shipped();
    entries(noModel).first.remove('duixModel');
    expect(() => CharacterCatalog.parse(jsonEncode(noModel)), throwsFormatException);

    final both = shipped();
    entries(both).last['duixModel'] = 'lily';
    expect(() => CharacterCatalog.parse(jsonEncode(both)), throwsFormatException);

    final badEngine = shipped();
    entries(badEngine).first['engine'] = 'unity';
    expect(() => CharacterCatalog.parse(jsonEncode(badEngine)), throwsFormatException);

    final blankTitle = shipped();
    entries(blankTitle).first['title'] = ' ';
    expect(() => CharacterCatalog.parse(jsonEncode(blankTitle)), throwsFormatException);

    expect(() => CharacterCatalog.parse('not json'), throwsFormatException);
  });
}
```

- [x] **Step 2: 跑测试确认失败，再实现角色配置**

Run: `cd app && flutter test test/characters_test.dart`
Expected: 编译失败（`CharacterCatalog`、`loadTestCharacterCatalog` 等不存在，`characters.json` 不存在）。

新建 `app/assets/config/characters.json`（副标题按 spec「角色」表的关系定位起草，交用户审定）：

```json
{
  "characters": [
    { "id": "xiaonuan", "title": "小暖", "subtitle": "贴心懂事的孙女，说话亲近暖和", "engine": "duix", "duixModel": "lily" },
    { "id": "xiaokai", "title": "小凯", "subtitle": "阳光精神的孙子，爱听老故事", "engine": "duix", "duixModel": "kai" },
    { "id": "xiaoxin", "title": "小欣", "subtitle": "温和踏实的老朋友，说话慢条斯理", "engine": "webview", "webviewAvatar": "default" }
  ]
}
```

把 `app/lib/identity/characters.dart` 整体替换为：

```dart
import 'dart:convert';

import 'package:flutter/services.dart';

import '../avatar_engine/avatar_engine.dart';
import 'character_ids.generated.dart';
import 'companion_picker.dart';

export 'character_ids.generated.dart';

/// True only for ids in protocol/characters.json (generated list).
bool isCharacterId(String id) => characterIds.contains(id);

/// One companion the user can pick. Display copy and assets come from assets/config/characters.json.
class CharacterOption implements PickerOption {
  const CharacterOption({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.engine,
    this.duixModel,
    this.webviewAvatar,
  });

  @override
  final String id;
  @override
  final String title;
  @override
  final String subtitle;
  final AvatarEngineKind engine;

  /// Model id in assets/config/duix.json; set only for Duix characters.
  final String? duixModel;

  /// Avatar id in the 3D catalog (avatars.generated.dart); set only for WebView characters.
  final String? webviewAvatar;
}

class CharacterCatalog {
  CharacterCatalog(List<CharacterOption> options) : options = List.unmodifiable(options);

  static const assetPath = 'assets/config/characters.json';

  /// Display order; equals the generated characterIds order.
  final List<CharacterOption> options;

  String get defaultId => defaultCharacterId;

  CharacterOption? byId(String id) {
    for (final option in options) {
      if (option.id == id) return option;
    }
    return null;
  }

  /// Throws FormatException unless the ids equal [characterIds] (same order) and every asset id is present.
  static CharacterCatalog parse(String source) {
    final Object? raw;
    try {
      raw = jsonDecode(source);
    } on FormatException {
      throw const FormatException('characters_not_json');
    }
    if (raw is! Map<String, Object?>) throw const FormatException('characters_not_object');
    final list = raw['characters'];
    if (list is! List || list.isEmpty) throw const FormatException('characters_invalid');
    final options = [for (final entry in list) _option(entry)];
    var same = options.length == characterIds.length;
    for (var i = 0; same && i < options.length; i++) {
      same = options[i].id == characterIds[i];
    }
    if (!same) throw const FormatException('character_ids_mismatch');
    return CharacterCatalog(options);
  }

  static CharacterOption _option(Object? entry) {
    if (entry is! Map) throw const FormatException('character_invalid');
    final id = entry['id'];
    final title = entry['title'];
    final subtitle = entry['subtitle'];
    if (id is! String || !isCharacterId(id)) throw const FormatException('character_id_invalid');
    if (title is! String || title.trim().isEmpty || subtitle is! String || subtitle.trim().isEmpty) {
      throw const FormatException('character_copy_invalid');
    }
    final duixModel = entry['duixModel'];
    final webviewAvatar = entry['webviewAvatar'];
    switch (entry['engine']) {
      case 'duix':
        if (!_isAssetId(duixModel) || webviewAvatar != null) throw const FormatException('character_assets_invalid');
        return CharacterOption(id: id, title: title, subtitle: subtitle, engine: AvatarEngineKind.duix, duixModel: duixModel as String);
      case 'webview':
        if (!_isAssetId(webviewAvatar) || duixModel != null) throw const FormatException('character_assets_invalid');
        return CharacterOption(id: id, title: title, subtitle: subtitle, engine: AvatarEngineKind.webview, webviewAvatar: webviewAvatar as String);
      default:
        throw const FormatException('character_engine_invalid');
    }
  }
}

final _assetId = RegExp(r'^[a-z0-9][a-z0-9-]{0,39}$');

bool _isAssetId(Object? value) => value is String && _assetId.hasMatch(value);

Future<CharacterCatalog> loadCharacterCatalog(AssetBundle bundle) async =>
    CharacterCatalog.parse(await bundle.loadString(CharacterCatalog.assetPath));
```

Run: `cd app && flutter test test/characters_test.dart`
Expected: PASS。

> 说明：`flutter test <file>` 只编译该文件的 import 闭包。此时 `app_shell.dart` 等旧调用方还编译不过，但它们不在 `characters_test.dart` 的闭包里，所以单跑能通过。每一步都只跑本步的测试文件，到 Step 13 再跑全量和 `flutter analyze`。

- [x] **Step 3: 写失败的测试：`DeviceIdentity` 与 `IdentityApi` 去风格**

把 `app/test/support/identity_fakes.dart` 的 `FakeBackend`（第 7–32 行）替换为（`ThrowingCredentialStore` 不动）：

```dart
/// Scripted backend. The last queued result repeats.
class FakeBackend implements IdentityBackend {
  FakeBackend({List<RegisterResult>? registerResults})
    : _register = Queue.of(registerResults ?? const [RegisterOk('device-token-0123456789')]);

  final Queue<RegisterResult> _register;
  int registerCalls = 0;
  Exception? throwOnRegister;

  @override
  Future<RegisterResult> register() async {
    final error = throwOnRegister;
    if (error != null) throw error;
    registerCalls++;
    return _register.length > 1 ? _register.removeFirst() : _register.first;
  }
}
```

把 `app/test/device_identity_test.dart` 整体替换为：

```dart
import 'dart:io';

import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:avatar_app/identity/identity_api.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/identity_fakes.dart';

const tokenKey = DeviceIdentity.tokenKey;
const characterKey = DeviceIdentity.characterKey;

void main() {
  test('only device_token and character_id are stored', () {
    expect(tokenKey, 'device_token');
    expect(characterKey, 'character_id');
  });

  test('first character choice registers once and stores token and character', () async {
    final store = MemoryCredentialStore();
    final backend = FakeBackend();
    final identity = DeviceIdentity(store: store, backend: backend);
    expect(await identity.savedCharacter(), isNull);
    expect(await identity.chooseFirstCharacter('xiaokai'), isA<IdentityOk>());
    expect(backend.registerCalls, 1);
    expect(store.values, {tokenKey: 'device-token-0123456789', characterKey: 'xiaokai'});
    expect(await identity.savedCharacter(), 'xiaokai');
    expect(await identity.token(), 'device-token-0123456789');
  });

  test('an existing token is kept on first choice', () async {
    final store = MemoryCredentialStore({tokenKey: 'kept-token-0123456789'});
    final backend = FakeBackend();
    await DeviceIdentity(store: store, backend: backend).chooseFirstCharacter('xiaonuan');
    expect(backend.registerCalls, 0);
    expect(store.values, {tokenKey: 'kept-token-0123456789', characterKey: 'xiaonuan'});
  });

  test('registration failures are reported and nothing is stored', () async {
    final store = MemoryCredentialStore();
    final result = await DeviceIdentity(
      store: store,
      backend: FakeBackend(registerResults: [const RegisterFailed(503)]),
    ).chooseFirstCharacter('xiaonuan');
    expect(result, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'http_503'));
    expect(store.values, isEmpty);
  });

  test('a gateway without identity (404) stores only the character', () async {
    final store = MemoryCredentialStore();
    final result = await DeviceIdentity(
      store: store,
      backend: FakeBackend(registerResults: [const RegisterUnavailable()]),
    ).chooseFirstCharacter('xiaoxin');
    expect(result, isA<IdentityOk>());
    expect(store.values, {characterKey: 'xiaoxin'});
  });

  test('network and storage errors become readable failure reasons', () async {
    final backend = FakeBackend()..throwOnRegister = const SocketException('down');
    final network = await DeviceIdentity(store: MemoryCredentialStore(), backend: backend).chooseFirstCharacter('xiaonuan');
    expect(network, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'network'));
    final storage = await DeviceIdentity(store: ThrowingCredentialStore(), backend: FakeBackend()).chooseFirstCharacter('xiaonuan');
    expect(storage, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'storage'));
  });

  test('unknown character ids are rejected and nothing is stored', () async {
    final store = MemoryCredentialStore();
    final backend = FakeBackend();
    final identity = DeviceIdentity(store: store, backend: backend);
    expect(
      await identity.chooseFirstCharacter('lily'),
      isA<IdentityFailed>().having((r) => r.reason, 'reason', 'invalid_character'),
    );
    expect(backend.registerCalls, 0);
    expect(
      await identity.changeCharacter('default'),
      isA<IdentityFailed>().having((r) => r.reason, 'reason', 'invalid_character'),
    );
    expect(store.values, isEmpty);
  });

  test('a saved id that is no longer a character reads as not chosen', () async {
    final identity = DeviceIdentity(
      store: MemoryCredentialStore({tokenKey: 't-0123456789abcdef', characterKey: 'lily'}),
      backend: FakeBackend(),
    );
    expect(await identity.savedCharacter(), isNull);
  });

  test('changeCharacter saves locally without calling the gateway', () async {
    final store = MemoryCredentialStore({tokenKey: 'device-token-0123456789', characterKey: 'xiaonuan'});
    final backend = FakeBackend();
    expect(await DeviceIdentity(store: store, backend: backend).changeCharacter('xiaoxin'), isA<IdentityOk>());
    expect(store.values[characterKey], 'xiaoxin');
    expect(backend.registerCalls, 0);
  });

  test('changeCharacter maps storage errors to a readable failure', () async {
    final result = await DeviceIdentity(store: ThrowingCredentialStore(), backend: FakeBackend()).changeCharacter('xiaokai');
    expect(result, isA<IdentityFailed>().having((r) => r.reason, 'reason', 'storage'));
  });

  test('renew replaces the token only after a successful registration', () async {
    final store = MemoryCredentialStore({tokenKey: 'old-token-0123456789', characterKey: 'xiaonuan'});
    final backend = FakeBackend(registerResults: [const RegisterUnavailable(), const RegisterOk('new-token-0123456789')]);
    final identity = DeviceIdentity(store: store, backend: backend);
    expect(await identity.renew(), isNull);
    expect(store.values[tokenKey], 'old-token-0123456789');
    expect(await identity.renew(), 'new-token-0123456789');
    expect(store.values, {tokenKey: 'new-token-0123456789', characterKey: 'xiaonuan'});
    expect(backend.registerCalls, 2);
  });

  test('renew never throws: backend and storage failures return null', () async {
    final backend = FakeBackend()..throwOnRegister = const SocketException('down');
    final store = MemoryCredentialStore({tokenKey: 'old-token-0123456789'});
    expect(await DeviceIdentity(store: store, backend: backend).renew(), isNull);
    expect(store.values[tokenKey], 'old-token-0123456789');
    expect(await DeviceIdentity(store: ThrowingCredentialStore(), backend: FakeBackend()).renew(), isNull);
  });
}
```

在 `app/test/identity_api_test.dart` 里：
1. 删除第 30–38 行的用例 `register posts client info and style with the app secret`，替换为：
   ```dart
   test('register posts only client info with the app secret', () async {
     final t = RecordingTransport(const GatewayHttpResponse(statusCode: 200, body: {'deviceToken': 'device-token-0123456789'}));
     final result = await api(t).register();
     expect(result, isA<RegisterOk>().having((r) => r.deviceToken, 'deviceToken', 'device-token-0123456789'));
     expect(t.calls.single, {
       'method': 'POST', 'path': '/device/register', 'secret': 'secret-123456789', 'bearer': null,
       'body': {'clientInfo': {'platform': 'android'}},
     });
   });
   ```
2. 删除第 40–44 行（`register omits the style when none is given`，已被上一条覆盖）和第 55–62 行（`patchStyle ...`）。`RecordingTransport.patch` 保留（`GatewayTransport` 仍有 `patch`）。

- [x] **Step 4: 跑测试确认失败，再实现 `DeviceIdentity` 和 `IdentityApi`**

Run: `cd app && flutter test test/device_identity_test.dart test/identity_api_test.dart`
Expected: 编译失败（`characterKey`、`chooseFirstCharacter`、`register()` 签名不匹配）。

`app/lib/identity/identity_api.dart`：
- 第 27–32 行的接口替换为：
  ```dart
  abstract interface class IdentityBackend {
    Future<RegisterResult> register();
  }
  ```
- 第 51–73 行（`register` 和 `patchStyle`）替换为：
  ```dart
  @override
  Future<RegisterResult> register() async {
    final response = await transport
        .post(_uri('/device/register'), appSecret: appSecret, body: {
          'clientInfo': {'platform': platform},
        })
        .timeout(requestTimeout);
    if (response.statusCode == 404) return const RegisterUnavailable();
    if (response.statusCode != 200) return RegisterFailed(response.statusCode);
    final body = response.body;
    final token = body is Map ? body['deviceToken'] : null;
    if (token is! String || !_tokenShape.hasMatch(token)) return const RegisterFailed(502);
    return RegisterOk(token);
  }
  ```

把 `app/lib/identity/device_identity.dart` 整体替换为：

```dart
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter/services.dart';

import '../native_gateway/gateway_client.dart';
import 'characters.dart';
import 'credential_store.dart';
import 'identity_api.dart';

sealed class IdentityResult {
  const IdentityResult();
}

class IdentityOk extends IdentityResult {
  const IdentityOk();
}

class IdentityFailed extends IdentityResult {
  const IdentityFailed(this.reason);

  /// One of `network`, `storage`, `invalid_character`, `http_<status>`, or a Duix reason code.
  final String reason;
}

/// Device credential and the locally chosen character. The token leaves this class only as a bearer header.
class DeviceIdentity implements DeviceTokenProvider {
  DeviceIdentity({required this.store, required this.backend});

  static const tokenKey = 'device_token';
  static const characterKey = 'character_id';

  final CredentialStore store;
  final IdentityBackend backend;

  /// Null = first launch, or a saved id that is no longer a character (show the picker).
  Future<String?> savedCharacter() async {
    final id = await store.read(characterKey);
    return id != null && isCharacterId(id) ? id : null;
  }

  @override
  Future<String?> token() => store.read(tokenKey);

  /// First launch: register unless a token exists, then remember the character.
  Future<IdentityResult> chooseFirstCharacter(String id) => _guard(() async {
    if (!isCharacterId(id)) return const IdentityFailed('invalid_character');
    if (await store.read(tokenKey) == null) {
      final result = await backend.register();
      switch (result) {
        case RegisterOk(:final deviceToken):
          await store.write(tokenKey, deviceToken);
        case RegisterUnavailable():
          break; // gateway without identity: dev mode, no token
        case RegisterFailed(:final statusCode):
          return IdentityFailed('http_$statusCode');
      }
    }
    await store.write(characterKey, id);
    return const IdentityOk();
  });

  /// Local only: the next POST /session carries the new character.
  Future<IdentityResult> changeCharacter(String id) => _guard(() async {
    if (!isCharacterId(id)) return const IdentityFailed('invalid_character');
    await store.write(characterKey, id);
    return const IdentityOk();
  });

  /// Registers again after a 401. Keeps the old token unless registration succeeds.
  @override
  Future<String?> renew() async {
    // Never throws: callers fall back to no bearer on any failure.
    try {
      final result = await backend.register();
      if (result is! RegisterOk) return null;
      await store.write(tokenKey, result.deviceToken);
      // Anonymous diagnostic: this phone is now a new owner; old memories no longer attach.
      debugPrint('device_reregistered');
      return result.deviceToken;
    } catch (_) {
      debugPrint('device_renew_failed');
      return null;
    }
  }

  Future<IdentityResult> _guard(Future<IdentityResult> Function() body) async {
    try {
      return await body();
    } on PlatformException {
      return const IdentityFailed('storage');
    } on Exception {
      return const IdentityFailed('network');
    }
  }
}
```

Run: `cd app && flutter test test/device_identity_test.dart test/identity_api_test.dart`
Expected: PASS。

- [x] **Step 5: 写失败的测试：角色选择页**

新建 `app/test/character_picker_test.dart`：

```dart
import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/identity/character_availability.dart';
import 'package:avatar_app/identity/character_picker_page.dart';
import 'package:avatar_app/identity/characters.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';

final catalog = loadTestCharacterCatalog();

Widget picker({
  required ValueChanged<String> onConfirm,
  String initial = 'xiaonuan',
  bool busy = false,
  String? error,
  VoidCallback? onCancel,
  CharacterAvailability Function(CharacterOption option) availabilityOf = everyCharacterAvailable,
}) => MaterialApp(
  home: CharacterPickerPage(
    title: '选一位陪您聊天的伙伴',
    confirmLabel: '就选这个',
    options: catalog.options,
    initial: initial,
    onConfirm: onConfirm,
    busy: busy,
    error: error,
    onCancel: onCancel,
    availabilityOf: availabilityOf,
  ),
);

Finder checkIn(String id) =>
    find.descendant(of: find.byKey(Key('character-$id')), matching: find.byIcon(Icons.check_circle));

Future<void> tapCard(WidgetTester tester, String id) async {
  final finder = find.byKey(Key('character-$id'));
  await tester.ensureVisible(finder);
  await tester.tapAt(tester.getTopLeft(finder) + const Offset(32, 24));
  await tester.pump();
}

CharacterAvailability noDuix(CharacterOption o) =>
    o.engine == AvatarEngineKind.duix ? const Unavailable('这台手机暂时用不了真人形象') : const Available();

CharacterAvailability hiddenDuix(CharacterOption o) =>
    o.engine == AvatarEngineKind.duix ? const Hidden() : const Available();

void main() {
  testWidgets('lists 小暖, 小凯, 小欣, highlights 小暖, and confirms the tapped one', (tester) async {
    final chosen = <String>[];
    await tester.pumpWidget(picker(onConfirm: chosen.add));
    expect(find.text('小暖'), findsOneWidget);
    expect(find.text('小凯'), findsOneWidget);
    expect(find.text('小欣'), findsOneWidget);
    expect(find.text('贴心懂事的孙女，说话亲近暖和'), findsOneWidget);
    expect(checkIn('xiaonuan'), findsOneWidget);
    await tapCard(tester, 'xiaokai');
    expect(checkIn('xiaokai'), findsOneWidget);
    expect(checkIn('xiaonuan'), findsNothing);
    await tester.tap(find.byKey(const Key('character-confirm')));
    expect(chosen, ['xiaokai']);
    expect(find.byKey(const Key('character-cancel')), findsNothing);
    expect(tester.getSize(find.byKey(const Key('character-confirm'))).height, greaterThanOrEqualTo(64));
  });

  testWidgets('highlights 小欣 when 小暖 cannot be picked, and ignores taps on locked cards', (tester) async {
    final chosen = <String>[];
    await tester.pumpWidget(picker(onConfirm: chosen.add, availabilityOf: noDuix));
    expect(checkIn('xiaoxin'), findsOneWidget);
    await tapCard(tester, 'xiaonuan');
    expect(checkIn('xiaoxin'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    expect(chosen, ['xiaoxin']);
  });

  testWidgets('hidden characters are not shown at all', (tester) async {
    await tester.pumpWidget(picker(onConfirm: (_) {}, availabilityOf: hiddenDuix));
    expect(find.byKey(const Key('character-xiaonuan')), findsNothing);
    expect(find.byKey(const Key('character-xiaokai')), findsNothing);
    expect(checkIn('xiaoxin'), findsOneWidget);
  });

  testWidgets('disables cards and confirm while busy and shows the error', (tester) async {
    final chosen = <String>[];
    await tester.pumpWidget(picker(onConfirm: chosen.add, busy: true, error: '网络连接失败，请检查网络后再试'));
    await tapCard(tester, 'xiaokai');
    expect(checkIn('xiaonuan'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    expect(chosen, isEmpty);
    expect(find.text('网络连接失败，请检查网络后再试'), findsOneWidget);
  });

  testWidgets('offers a large back button when cancellable', (tester) async {
    var cancelled = 0;
    await tester.pumpWidget(picker(onConfirm: (_) {}, onCancel: () => cancelled++));
    expect(tester.getSize(find.byKey(const Key('character-cancel'))).height, greaterThanOrEqualTo(60));
    await tester.tap(find.byKey(const Key('character-cancel')));
    expect(cancelled, 1);
  });

  test('initialCharacter keeps a pickable preference and otherwise takes the first pickable one', () {
    expect(initialCharacter(catalog.options, 'xiaonuan', everyCharacterAvailable), 'xiaonuan');
    expect(initialCharacter(catalog.options, 'xiaokai', everyCharacterAvailable), 'xiaokai');
    expect(initialCharacter(catalog.options, 'xiaonuan', noDuix), 'xiaoxin');
    expect(initialCharacter(catalog.options, 'xiaonuan', hiddenDuix), 'xiaoxin');
    expect(canPick(const Available()), isTrue);
    expect(canPick(const Preparing(0.5)), isTrue);
    expect(canPick(const PrepareFailed('形象准备没成功，请重试')), isTrue);
    expect(canPick(const Unavailable('x')), isFalse);
    expect(canPick(const Checking()), isFalse);
    expect(canPick(const Hidden()), isFalse);
  });

  test('maps failure reasons to plain Chinese', () {
    expect(identityErrorText('network'), '网络连接失败，请检查网络后再试');
    expect(identityErrorText('storage'), '手机保存身份信息失败，请重试');
    expect(identityErrorText('http_400'), '这个伙伴暂时不可用，请换一个');
    expect(identityErrorText('http_401'), '应用配置有误，请联系家人');
    expect(identityErrorText('http_429'), '现在注册的人太多了，请稍后再试');
    expect(identityErrorText('http_503'), '现在注册的人太多了，请稍后再试');
    expect(identityErrorText('invalid_character'), '这个伙伴暂时不可用，请换一个');
    expect(identityErrorText('low_memory'), '这台手机暂时用不了真人形象（需要 64 位、8GB 以上内存的手机）');
    expect(identityErrorText('http_500'), '出错了（http_500），请稍后再试');
    expect(unknownCharacterText, '这位伙伴暂时联系不上，请重新选一位');
  });
}
```

然后删除 `app/test/style_picker_test.dart`（`git rm`）。

- [x] **Step 6: 跑测试确认失败，再实现可用性类型和选择页**

Run: `cd app && flutter test test/character_picker_test.dart`
Expected: 编译失败（`character_availability.dart`、`character_picker_page.dart` 不存在）。

新建 `app/lib/identity/character_availability.dart`：

```dart
import 'characters.dart';

/// Whether a character can run on this phone right now (spec「Duix 不可用」).
/// Task 14 computes it in EngineSwitchController.availabilityFor.
sealed class CharacterAvailability {
  const CharacterAvailability();
}

/// Ready, or the bundled model only needs copying once it is picked.
final class Available extends CharacterAvailability {
  const Available();
}

/// The model is being copied; [fraction] is null when progress is unknown.
final class Preparing extends CharacterAvailability {
  const Preparing(this.fraction);

  final double? fraction;
}

/// Greyed out with a plain-language [reason].
final class Unavailable extends CharacterAvailability {
  const Unavailable(this.reason);

  final String reason;
}

/// Copying failed; picking it again retries. [reason] is plain language.
final class PrepareFailed extends CharacterAvailability {
  const PrepareFailed(this.reason);

  final String reason;
}

/// Not offered on this build or phone; the card is not shown.
final class Hidden extends CharacterAvailability {
  const Hidden();
}

/// Still probing the phone; shown as loading, not pickable.
final class Checking extends CharacterAvailability {
  const Checking();
}

bool canPick(CharacterAvailability availability) =>
    availability is Available || availability is Preparing || availability is PrepareFailed;

/// Default hook: every character can run (3D-only tests, Task 13).
CharacterAvailability everyCharacterAvailable(CharacterOption option) => const Available();
```

新建 `app/lib/identity/character_picker_page.dart`（`identityErrorText` 从被删的 `style_picker_page.dart:9-20` 移过来，`invalid_avatar` 改为 `invalid_character`）：

```dart
import 'package:flutter/material.dart';

import '../avatar_engine/ui/engine_copy.dart';
import 'character_availability.dart';
import 'characters.dart';
import 'companion_picker.dart';

/// Plain-language text for identity failure reasons.
String identityErrorText(String reason) => switch (reason) {
  'network' => '网络连接失败，请检查网络后再试',
  'storage' => '手机保存身份信息失败，请重试',
  'http_400' || 'invalid_character' => '这个伙伴暂时不可用，请换一个',
  'http_401' => '应用配置有误，请联系家人',
  'abi_unsupported' || 'low_memory' || 'storage_unavailable' || 'duix_unsupported' => unsupportedText(
    reason == 'duix_unsupported' ? null : reason,
  ),
  'http_429' || 'http_503' => '现在注册的人太多了，请稍后再试',
  _ => '出错了（$reason），请稍后再试',
};

/// POST /session answered 400 for the saved character.
const unknownCharacterText = '这位伙伴暂时联系不上，请重新选一位';

/// The preferred character when it can be picked, else the first visible one that can.
String initialCharacter(
  List<CharacterOption> options,
  String preferred,
  CharacterAvailability Function(CharacterOption option) availabilityOf,
) {
  for (final option in options) {
    if (option.id == preferred && canPick(availabilityOf(option))) return option.id;
  }
  for (final option in options) {
    if (canPick(availabilityOf(option))) return option.id;
  }
  return preferred;
}

/// Large character cards (≥60 dp, ≥18 sp). Hidden characters are left out; locked ones ignore taps.
class CharacterCardList extends StatelessWidget {
  const CharacterCardList({
    super.key,
    required this.options,
    required this.selected,
    required this.onSelect,
    this.availabilityOf = everyCharacterAvailable,
    this.enabled = true,
    this.gap = 16,
  });

  final List<CharacterOption> options;
  final String selected;
  final ValueChanged<String> onSelect;
  final CharacterAvailability Function(CharacterOption option) availabilityOf;
  final bool enabled;
  final double gap;

  @override
  Widget build(BuildContext context) {
    final cards = <Widget>[];
    for (final option in options) {
      final availability = availabilityOf(option);
      if (availability is Hidden) continue;
      cards.add(
        Padding(
          padding: EdgeInsets.only(bottom: gap),
          child: SelectionCard(
            option: option,
            selected: option.id == selected,
            keyPrefix: 'character',
            onTap: enabled && canPick(availability) ? () => onSelect(option.id) : null,
          ),
        ),
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: cards);
  }
}

/// First launch, and whenever the saved character cannot continue: pick one character.
class CharacterPickerPage extends StatefulWidget {
  const CharacterPickerPage({
    super.key,
    required this.title,
    required this.confirmLabel,
    required this.options,
    required this.initial,
    required this.onConfirm,
    this.availabilityOf = everyCharacterAvailable,
    this.availabilityChanges,
    this.onCancel,
    this.busy = false,
    this.error,
  });

  final String title;
  final String confirmLabel;
  final List<CharacterOption> options;

  /// Preferred highlight; replaced by the first pickable character when it cannot be picked.
  final String initial;
  final ValueChanged<String> onConfirm;
  final CharacterAvailability Function(CharacterOption option) availabilityOf;

  /// Rebuilds the cards when availability changes (Task 14 passes the EngineSwitchController).
  final Listenable? availabilityChanges;
  final VoidCallback? onCancel;
  final bool busy;

  /// Error or the reason the picker is shown again.
  final String? error;

  @override
  State<CharacterPickerPage> createState() => _CharacterPickerPageState();
}

class _CharacterPickerPageState extends State<CharacterPickerPage> {
  late String _selected = initialCharacter(widget.options, widget.initial, widget.availabilityOf);

  bool get _selectedPickable {
    for (final option in widget.options) {
      if (option.id == _selected) return canPick(widget.availabilityOf(option));
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final changes = widget.availabilityChanges;
    return Scaffold(
      backgroundColor: const Color(0xFF10131A),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: changes == null ? _body() : ListenableBuilder(listenable: changes, builder: (_, _) => _body()),
        ),
      ),
    );
  }

  Widget _body() {
    final error = widget.error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(widget.title, style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.bold)),
        if (error != null) ...[
          const SizedBox(height: 12),
          Text(error, key: const Key('character-error'), style: const TextStyle(color: Colors.amberAccent, fontSize: 18)),
        ],
        const SizedBox(height: 24),
        Expanded(
          child: SingleChildScrollView(
            child: CharacterCardList(
              options: widget.options,
              selected: _selected,
              availabilityOf: widget.availabilityOf,
              enabled: !widget.busy,
              onSelect: (id) => setState(() => _selected = id),
            ),
          ),
        ),
        SizedBox(
          height: 64,
          child: FilledButton(
            key: const Key('character-confirm'),
            onPressed: widget.busy || !_selectedPickable ? null : () => widget.onConfirm(_selected),
            child: widget.busy
                ? Semantics(
                    label: '正在保存',
                    child: const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3)),
                  )
                : Text(widget.confirmLabel, style: const TextStyle(fontSize: 22)),
          ),
        ),
        if (widget.onCancel != null) ...[
          const SizedBox(height: 12),
          SizedBox(
            height: 60,
            child: TextButton(
              key: const Key('character-cancel'),
              onPressed: widget.busy ? null : widget.onCancel,
              child: const Text('返回', style: TextStyle(fontSize: 20)),
            ),
          ),
        ],
      ],
    );
  }
}
```

Run: `cd app && flutter test test/character_picker_test.dart`
Expected: PASS。

- [x] **Step 7: 写失败的测试：AppShell、设置页、引擎控制器适配**

把 `app/test/companion_picker_test.dart` 整体替换为：

```dart
import 'package:avatar_app/identity/companion_settings_page.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';

final catalog = loadTestCharacterCatalog();

Finder checkIn(String id) =>
    find.descendant(of: find.byKey(Key('character-$id')), matching: find.byIcon(Icons.check_circle));

Future<void> tapCard(WidgetTester tester, String id) async {
  final finder = find.byKey(Key('character-$id'));
  await tester.scrollUntilVisible(finder, 160);
  await tester.tapAt(tester.getTopLeft(finder) + const Offset(32, 24));
  await tester.pump();
}

/// Pushes the settings page and records what it pops with.
class Popped {
  bool done = false;
  String? value;
}

Widget host(Popped popped, Future<IdentityResult> Function(String id) onSave) => MaterialApp(
  home: Builder(
    builder: (context) => Scaffold(
      body: TextButton(
        onPressed: () async {
          final result = await Navigator.of(context).push<String>(
            MaterialPageRoute(
              builder: (_) => CompanionSettingsPage(
                options: catalog.options,
                currentCharacter: 'xiaoxin',
                onSaveCharacter: onSave,
              ),
            ),
          );
          popped
            ..done = true
            ..value = result;
        },
        child: const Text('open'),
      ),
    ),
  ),
);

void main() {
  testWidgets('settings lists the characters and saves the tapped one', (tester) async {
    final saved = <String>[];
    final popped = Popped();
    await tester.pumpWidget(host(popped, (id) async {
      saved.add(id);
      return const IdentityOk();
    }));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('选择陪伴角色'), findsOneWidget);
    expect(find.text('聊天风格'), findsNothing);
    expect(checkIn('xiaoxin'), findsOneWidget);
    await tapCard(tester, 'xiaokai');
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(saved, ['xiaokai']);
    expect(popped.value, 'xiaokai');
  });

  testWidgets('confirm stays off until another character is picked; back pops nothing', (tester) async {
    final saved = <String>[];
    final popped = Popped();
    await tester.pumpWidget(host(popped, (id) async {
      saved.add(id);
      return const IdentityOk();
    }));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pump();
    expect(saved, isEmpty);
    expect(tester.getSize(find.byKey(const Key('companion-cancel'))).height, greaterThanOrEqualTo(60));
    await tester.tap(find.byKey(const Key('companion-cancel')));
    await tester.pumpAndSettle();
    expect(popped.done, isTrue);
    expect(popped.value, isNull);
  });

  testWidgets('a failed save keeps the page and shows why', (tester) async {
    final popped = Popped();
    await tester.pumpWidget(host(popped, (_) async => const IdentityFailed('storage')));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaonuan');
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('手机保存身份信息失败，请重试'), findsOneWidget);
    expect(find.byKey(const Key('companion-confirm')), findsOneWidget);
    expect(popped.done, isFalse);
  });
}
```

把 `app/test/app_shell_test.dart` 整体替换为（Task 14 会再改其中与回退有关的用例；这里先锁定「行为等价」）：

```dart
import 'dart:async';

import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/avatar_engine/engine_switch_controller.dart';
import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_crash_guard.dart';
import 'package:avatar_app/identity/app_shell.dart';
import 'package:avatar_app/identity/character_engine_prefs.dart';
import 'package:avatar_app/identity/character_picker_page.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:avatar_app/identity/identity_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';
import 'support/duix_fakes.dart';
import 'support/identity_fakes.dart';

const tokenKey = DeviceIdentity.tokenKey;
const characterKey = DeviceIdentity.characterKey;

final catalog = loadTestCharacterCatalog();
AvatarPageRequest? lastRequest;

Widget app(DeviceIdentity identity, {EngineSwitchController? engines}) => MaterialApp(
  home: AppShell(
    identity: identity,
    catalog: catalog,
    engines: engines,
    avatarBuilder: (request) {
      lastRequest = request;
      return Scaffold(
        key: request.key,
        body: Text(request.engine == AvatarEngineKind.duix ? 'DUIX-${request.character.id}' : 'AVATAR-${request.character.id}'),
      );
    },
  ),
);

EngineSwitchController engines(MemoryCredentialStore store, FakeDuixBridge bridge, {bool config = true}) =>
    EngineSwitchController(
      prefs: CharacterEnginePrefs(identity: DeviceIdentity(store: store, backend: FakeBackend()), catalog: catalog),
      bridge: bridge,
      guard: DuixCrashGuard(store),
      loadConfig: () async => config ? loadTestDuixConfig() : null,
      debugBuild: true,
      diag: (_) {},
    );

Map<String, String> returning(String character) => {tokenKey: 'device-token-0123456789', characterKey: character};

Finder checkIn(String id) =>
    find.descendant(of: find.byKey(Key('character-$id')), matching: find.byIcon(Icons.check_circle));

/// Cards can extend under the bottom buttons. Tap inside the visible top of the card.
Future<void> tapCard(WidgetTester tester, String id) async {
  final finder = find.byKey(Key('character-$id'));
  await tester.scrollUntilVisible(finder, 160);
  await tester.tapAt(tester.getTopLeft(finder) + const Offset(32, 24));
  await tester.pump();
}

void main() {
  testWidgets('first launch: 小暖 is highlighted; confirming registers and opens 小暖', (tester) async {
    final store = MemoryCredentialStore();
    final backend = FakeBackend();
    final identity = DeviceIdentity(store: store, backend: backend);
    await tester.pumpWidget(app(identity, engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    expect(find.text('选一位陪您聊天的伙伴'), findsOneWidget);
    expect(checkIn('xiaonuan'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    expect(backend.registerCalls, 1);
    expect(store.values, {tokenKey: 'device-token-0123456789', characterKey: 'xiaonuan'});
  });

  testWidgets('first launch: picking 小欣 opens the 3D page', (tester) async {
    final store = MemoryCredentialStore();
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    await tester.pumpWidget(app(identity, engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaoxin');
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values[characterKey], 'xiaoxin');
  });

  testWidgets('a saved id that is not a character shows the picker again', (tester) async {
    final store = MemoryCredentialStore({tokenKey: 't-0123456789abcdef', characterKey: 'lily'});
    final backend = FakeBackend();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: backend), engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    expect(find.text('选一位陪您聊天的伙伴'), findsOneWidget);
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    expect(backend.registerCalls, 0); // the token is kept
  });

  testWidgets('registration failure keeps the picker and explains why', (tester) async {
    final store = MemoryCredentialStore();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend(registerResults: [const RegisterFailed(503)]))));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('现在注册的人太多了，请稍后再试'), findsOneWidget);
    expect(find.textContaining('AVATAR-'), findsNothing);
    expect(store.values, isEmpty);
  });

  testWidgets('a gateway without identity still lets the user choose', (tester) async {
    final store = MemoryCredentialStore();
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend(registerResults: [const RegisterUnavailable()]))));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaoxin');
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values, {characterKey: 'xiaoxin'});
  });

  testWidgets('first launch: a second tap while registering sends no second request', (tester) async {
    final backend = GatedBackend();
    await tester.pumpWidget(app(DeviceIdentity(store: MemoryCredentialStore(), backend: backend)));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaoxin');
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pump();
    expect(backend.registerCalls, 1);
    backend.release();
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(backend.registerCalls, 1);
  });

  testWidgets('the page key carries the engine, character and epoch, never a style', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend())));
    await tester.pumpAndSettle();
    expect((lastRequest!.key as ValueKey<String>).value, 'avatar-webview-xiaoxin-0');
  });

  testWidgets('settings switches from 小欣 to 小暖 and rebuilds the page', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    await tester.pumpWidget(app(identity, engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(find.byKey(const Key('engine-switch')), findsNothing);
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    expect(find.text('聊天伙伴设置'), findsOneWidget);
    await tapCard(tester, 'xiaonuan');
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    expect(store.values[characterKey], 'xiaonuan');
  });

  testWidgets('choosing 小凯 keeps the realistic engine and restarts on 小凯', (tester) async {
    final store = MemoryCredentialStore(returning('xiaonuan'));
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    await tester.pumpWidget(app(identity, engines: engines(store, FakeDuixBridge())));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaokai');
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaokai'), findsOneWidget);
    expect(store.values[characterKey], 'xiaokai');
  });

  testWidgets('settings refuses a Duix character on an unsupported phone', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    final identity = DeviceIdentity(store: store, backend: FakeBackend());
    final bridge = FakeDuixBridge(support: const DuixSupport(supported: false, reason: 'low_memory'));
    await tester.pumpWidget(app(identity, engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings')));
    await tester.pumpAndSettle();
    await tapCard(tester, 'xiaonuan');
    await tester.tap(find.byKey(const Key('companion-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('这台手机暂时用不了真人形象（需要 64 位、8GB 以上内存的手机）'), findsOneWidget);
    expect(store.values[characterKey], 'xiaoxin');
    await tester.tap(find.byKey(const Key('companion-cancel')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
  });

  testWidgets('no Duix config: no switch, 3D page', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, FakeDuixBridge(), config: false)));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(find.byKey(const Key('engine-switch')), findsNothing);
  });

  // Temporary (Task 14 replaces): the old fallback stays, but the saved character is never rewritten.
  testWidgets('a Duix failure falls back for this session and keeps the saved character', (tester) async {
    final store = MemoryCredentialStore(returning('xiaonuan'));
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text('DUIX-xiaonuan'), findsOneWidget);
    lastRequest!.onEngineFailure!(const AvatarEngineFailure('duix_prepare_timeout'));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values[characterKey], 'xiaonuan');
  });

  // Temporary (Task 14 replaces).
  testWidgets('a crash loop runs 3D this launch and keeps the saved character', (tester) async {
    final store = MemoryCredentialStore({
      ...returning('xiaonuan'),
      DuixCrashGuard.inflightKey: '1',
      DuixCrashGuard.countKey: '1',
    });
    final bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend()), engines: engines(store, bridge)));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    expect(store.values[characterKey], 'xiaonuan');
  });

  testWidgets('an unknown character answer from the gateway returns to the picker', (tester) async {
    final store = MemoryCredentialStore(returning('xiaoxin'));
    await tester.pumpWidget(app(DeviceIdentity(store: store, backend: FakeBackend())));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
    lastRequest!.onUnknownCharacter!();
    await tester.pumpAndSettle();
    expect(find.text(unknownCharacterText), findsOneWidget);
    expect(find.text('AVATAR-xiaoxin'), findsNothing);
    await tapCard(tester, 'xiaoxin');
    await tester.tap(find.byKey(const Key('character-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
  });
}

/// Backend whose registration stays in flight until release().
class GatedBackend implements IdentityBackend {
  final _gate = Completer<void>();
  var registerCalls = 0;

  void release() => _gate.complete();

  @override
  Future<RegisterResult> register() async {
    registerCalls++;
    await _gate.future;
    return const RegisterOk('device-token-0123456789');
  }
}
```

> 旧用例 `settings: a second tap while saving sends no second request` 删除：换角色已不发网络请求，没有可以拦截的请求了。

把 `app/test/engine_switch_controller_test.dart` 整体替换为（Task 14 会再整体重写）：

```dart
import 'package:avatar_app/avatar_engine/avatar_engine.dart';
import 'package:avatar_app/avatar_engine/engine_switch_controller.dart';
import 'package:avatar_app/duix/duix_bridge.dart';
import 'package:avatar_app/duix/duix_config.dart';
import 'package:avatar_app/duix/duix_crash_guard.dart';
import 'package:avatar_app/identity/character_engine_prefs.dart';
import 'package:avatar_app/identity/credential_store.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';
import 'support/duix_fakes.dart';
import 'support/identity_fakes.dart';

const characterKey = DeviceIdentity.characterKey;

void main() {
  late MemoryCredentialStore store;
  late FakeDuixBridge bridge;

  EngineSwitchController controller({DuixConfig? config, bool useConfig = true, bool debugBuild = true}) =>
      EngineSwitchController(
        prefs: CharacterEnginePrefs(
          identity: DeviceIdentity(store: store, backend: FakeBackend()),
          catalog: loadTestCharacterCatalog(),
        ),
        bridge: bridge,
        guard: DuixCrashGuard(store),
        loadConfig: () async => useConfig ? (config ?? loadTestDuixConfig()) : null,
        debugBuild: debugBuild,
        diag: (_) {},
      );

  setUp(() {
    store = MemoryCredentialStore();
    bridge = FakeDuixBridge(installed: {'gj_dh_res': true, 'lily': true});
  });

  test('the saved character decides the saved engine; a new install reads as 小暖', () async {
    final fresh = controller();
    await fresh.load();
    expect(fresh.savedEngine, AvatarEngineKind.duix);
    store.values[characterKey] = 'xiaoxin';
    final threeD = controller();
    await threeD.load();
    expect(threeD.savedEngine, AvatarEngineKind.webview);
  });

  test('no config hides Duix and the session uses 3D', () async {
    store.values[characterKey] = 'xiaonuan';
    final c = controller(useConfig: false);
    await c.load();
    expect(c.availability, DuixAvailability.hidden);
    expect(c.sessionEngine, AvatarEngineKind.webview);
  });

  test('debugOnly hides Duix in release builds only', () async {
    final release = controller(config: loadTestDuixConfig({'debugOnly': true}), debugBuild: false);
    await release.load();
    expect(release.availability, DuixAvailability.hidden);
    final debug = controller(config: loadTestDuixConfig({'debugOnly': true}));
    await debug.load();
    expect(debug.availability, DuixAvailability.ready);
  });

  test('an unsupported phone keeps the saved character but runs 3D', () async {
    store.values[characterKey] = 'xiaonuan';
    bridge.support = const DuixSupport(supported: false, reason: 'low_memory');
    final c = controller();
    await c.load();
    expect(c.availability, DuixAvailability.unsupported);
    expect(c.unsupportedReason, 'low_memory');
    expect(c.sessionEngine, AvatarEngineKind.webview);
    expect(c.savedEngine, AvatarEngineKind.duix);
  });

  test('a failed bundle keeps the session on 3D for this launch', () async {
    store.values[characterKey] = 'xiaonuan';
    bridge.bundleError = const DuixBridgeError('asset_missing');
    final missing = controller();
    await missing.load();
    expect(missing.availability, DuixAvailability.needsDownload);
    expect(missing.sessionEngine, AvatarEngineKind.webview);
  });

  test('repeated crashes run 3D without rewriting the saved character', () async {
    store.values.addAll({characterKey: 'xiaonuan', DuixCrashGuard.inflightKey: '1', DuixCrashGuard.countKey: '1'});
    final c = controller();
    await c.load();
    expect(c.sessionEngine, AvatarEngineKind.webview);
    expect(store.values[characterKey], 'xiaonuan');
    expect(c.takeNotice(), EngineNotice.crashDisabled);
    expect(c.takeNotice(), isNull);
  });

  test('choose rebuilds the page and writes no storage', () async {
    final c = controller();
    await c.load();
    final epoch = c.pageEpoch;
    await c.choose(AvatarEngineKind.webview);
    expect(c.sessionEngine, AvatarEngineKind.webview);
    expect(c.pageEpoch, epoch + 1);
    expect(store.values.containsKey(characterKey), isFalse);
  });

  test('a Duix failure falls back for this session only', () async {
    store.values[characterKey] = 'xiaonuan';
    final c = controller();
    await c.load();
    c.reportDuixFailure(const AvatarEngineFailure('duix_not_installed'));
    expect(c.sessionEngine, AvatarEngineKind.webview);
    expect(c.savedEngine, AvatarEngineKind.duix);
    expect(c.takeNotice(), EngineNotice.fallback);
    c.reportDuixFailure(const AvatarEngineFailure('again'));
    expect(c.takeNotice(), isNull); // already on 3D
  });

  test('bundling during load does not ask the user to switch', () async {
    final c = controller();
    await c.load();
    expect(c.availability, DuixAvailability.ready);
    expect(c.takeNotice(), isNull);
  });

  test('choosing Duix copies the bundle and then switches', () async {
    store.values[characterKey] = 'xiaoxin';
    bridge.bundleError = const DuixBridgeError('asset_missing');
    final c = controller();
    await c.load();
    expect(c.sessionEngine, AvatarEngineKind.webview);
    bridge.bundleError = null;
    await c.choose(AvatarEngineKind.duix);
    expect(c.sessionEngine, AvatarEngineKind.duix);
    expect(store.values[characterKey], 'xiaoxin'); // the shell saves the character, not the controller
  });
}
```

> 删除的旧用例 `a failed save keeps the crash count and still runs 3D` 和 `_FailEngineWrite`：`CharacterEnginePrefs.saveEngine` 不再写存储，前提不存在了。

Run: `cd app && flutter test test/companion_picker_test.dart test/app_shell_test.dart test/engine_switch_controller_test.dart`
Expected: 编译失败（`CharacterEnginePrefs` 不存在，`AppShell` 无 `catalog` 参数，`AvatarPageRequest.character` 不存在，设置页参数不匹配）。

- [x] **Step 8: 实现 AppShell、设置页和临时的 `CharacterEnginePrefs`**

新建 `app/lib/identity/character_engine_prefs.dart`：

```dart
import '../avatar_engine/avatar_engine.dart';
import 'characters.dart';
import 'device_identity.dart';

/// Temporary bridge for EngineSwitchController (Task 14 deletes it with EnginePrefs).
/// The saved engine is the saved character's engine; nothing is ever rewritten.
class CharacterEnginePrefs implements EnginePrefs {
  CharacterEnginePrefs({required this.identity, required this.catalog});

  final DeviceIdentity identity;
  final CharacterCatalog catalog;

  /// A new install reads as the default character. Storage trouble reads as 3D.
  @override
  Future<AvatarEngineKind> savedEngine() async {
    try {
      final saved = await identity.savedCharacter();
      return (catalog.byId(saved ?? catalog.defaultId) ?? catalog.options.first).engine;
    } on Exception {
      return AvatarEngineKind.webview;
    }
  }

  /// The character is the choice; the engine is never stored separately.
  @override
  Future<bool> saveEngine(AvatarEngineKind engine) async => true;
}
```

把 `app/lib/identity/companion_settings_page.dart` 整体替换为：

```dart
import 'package:flutter/material.dart';

import 'character_picker_page.dart';
import 'characters.dart';
import 'device_identity.dart';

/// Settings. Pops with the newly saved character id, or null when nothing changed.
class CompanionSettingsPage extends StatefulWidget {
  const CompanionSettingsPage({
    super.key,
    required this.options,
    required this.currentCharacter,
    required this.onSaveCharacter,
  });

  final List<CharacterOption> options;
  final String currentCharacter;
  final Future<IdentityResult> Function(String id) onSaveCharacter;

  @override
  State<CompanionSettingsPage> createState() => _CompanionSettingsPageState();
}

class _CompanionSettingsPageState extends State<CompanionSettingsPage> {
  late String _selected = widget.currentCharacter;
  bool _busy = false;
  String? _error;

  Future<void> _save() async {
    if (_busy || _selected == widget.currentCharacter) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final result = await widget.onSaveCharacter(_selected);
    if (!mounted) return;
    switch (result) {
      case IdentityOk():
        Navigator.of(context).pop(_selected);
      case IdentityFailed(:final reason):
        setState(() {
          _busy = false;
          _error = identityErrorText(reason);
        });
    }
  }

  @override
  Widget build(BuildContext context) {
    final error = _error;
    return Scaffold(
      backgroundColor: const Color(0xFF10131A),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('聊天伙伴设置', style: TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.bold)),
              const SizedBox(height: 20),
              Expanded(
                child: ListView(
                  children: [
                    const Text('选择陪伴角色', style: TextStyle(color: Colors.tealAccent, fontSize: 19, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 12),
                    CharacterCardList(
                      options: widget.options,
                      selected: _selected,
                      enabled: !_busy,
                      gap: 12,
                      onSelect: (id) => setState(() => _selected = id),
                    ),
                  ],
                ),
              ),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(error, style: const TextStyle(color: Colors.amberAccent, fontSize: 18)),
                ),
              SizedBox(
                height: 64,
                child: FilledButton(
                  key: const Key('companion-confirm'),
                  onPressed: _busy || _selected == widget.currentCharacter ? null : _save,
                  child: _busy
                      ? const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3))
                      : const Text('换成这位伙伴', style: TextStyle(fontSize: 22)),
                ),
              ),
              const SizedBox(height: 12),
              SizedBox(
                height: 60,
                child: TextButton(
                  key: const Key('companion-cancel'),
                  onPressed: _busy ? null : () => Navigator.of(context).pop(),
                  child: const Text('返回', style: TextStyle(fontSize: 20)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
```

把 `app/lib/identity/app_shell.dart` 整体替换为：

```dart
import 'dart:async';

import 'package:flutter/material.dart';

import '../avatar_engine/avatar_engine.dart';
import '../avatar_engine/engine_switch_controller.dart';
import '../avatar_engine/ui/engine_copy.dart';
import '../duix/duix_installer.dart';
import '../native_gateway/gateway_client.dart';
import 'character_picker_page.dart';
import 'characters.dart';
import 'companion_settings_page.dart';
import 'device_identity.dart';

/// What the shell asks the avatar builder for. A new [key] means a fresh page and session.
class AvatarPageRequest {
  const AvatarPageRequest({
    required this.key,
    required this.identity,
    required this.character,
    required this.engine,
    this.onEngineFailure,
    this.onUnknownCharacter,
  });

  final Key key;
  final DeviceTokenProvider identity;
  final CharacterOption character;
  final AvatarEngineKind engine;

  /// Set for Duix pages.
  final void Function(AvatarEngineFailure failure)? onEngineFailure;

  /// POST /session answered 400: the gateway does not know this character.
  final VoidCallback? onUnknownCharacter;
}

/// First launch: character picker + registration. Afterwards: the chat with a settings button on top.
class AppShell extends StatefulWidget {
  const AppShell({
    super.key,
    required this.identity,
    required this.catalog,
    required this.avatarBuilder,
    this.engines,
  });

  final DeviceIdentity identity;
  final CharacterCatalog catalog;
  final Widget Function(AvatarPageRequest request) avatarBuilder;

  /// Null = 3D only (tests and builds without Duix).
  final EngineSwitchController? engines;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  bool _loading = true;
  String? _character;

  /// Set when the saved character cannot continue; the picker shows this reason.
  String? _pickerReason;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.engines?.addListener(_onEngines);
    unawaited(_load());
  }

  @override
  void dispose() {
    widget.engines?.removeListener(_onEngines);
    super.dispose();
  }

  void _onEngines() {
    final notice = widget.engines?.takeNotice();
    if (notice == null || !mounted) return;
    WidgetsBinding.instance.addPostFrameCallback((_) => _showNotice(notice));
  }

  void _showNotice(EngineNotice notice) {
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    switch (notice) {
      case EngineNotice.fallback:
        messenger.showSnackBar(_snack(fallbackText));
      case EngineNotice.crashDisabled:
        messenger.showSnackBar(_snack(crashDisabledText));
      case EngineNotice.duixReady:
        messenger.showSnackBar(_snack(duixReadyText));
    }
  }

  static SnackBar _snack(String text) => SnackBar(content: Text(text, style: const TextStyle(fontSize: 18)));

  Future<void> _load() async {
    String? character;
    String? error;
    try {
      character = await widget.identity.savedCharacter();
    } on Exception {
      error = identityErrorText('storage');
    }
    await widget.engines?.load(); // never throws: failures read as "Duix hidden or unsupported"
    if (!mounted) return;
    setState(() {
      _character = character;
      _error = error;
      _loading = false;
    });
  }

  /// Picker confirm. First launch registers; later picks only save locally.
  Future<void> _pick(String id) async {
    if (_busy) return;
    final first = _character == null;
    setState(() {
      _busy = true;
      _error = null;
    });
    final result = first ? await widget.identity.chooseFirstCharacter(id) : await widget.identity.changeCharacter(id);
    if (!mounted) return;
    switch (result) {
      case IdentityOk():
        setState(() {
          _busy = false;
          _character = id;
          _pickerReason = null;
        });
        await _followEngine(id);
      case IdentityFailed(:final reason):
        setState(() {
          _busy = false;
          _error = identityErrorText(reason);
        });
    }
  }

  /// Temporary until Task 14: the session engine follows the chosen character.
  Future<void> _followEngine(String id) async {
    final engines = widget.engines;
    final option = widget.catalog.byId(id);
    if (engines == null || option == null || option.engine == engines.sessionEngine) return;
    await engines.choose(option.engine);
    if (mounted && option.engine == AvatarEngineKind.duix && engines.sessionEngine != AvatarEngineKind.duix) {
      final state = engines.installer?.state;
      final code = state is InstallFailed ? state.code : null;
      ScaffoldMessenger.of(context).showSnackBar(_snack(unsupportedText(
        code == 'abi_unsupported' || code == 'low_memory' || code == 'storage_unavailable' ? code : null,
      )));
    }
  }

  Future<IdentityResult> _saveFromSettings(String id) async {
    final option = widget.catalog.byId(id);
    final engines = widget.engines;
    if (option != null &&
        option.engine == AvatarEngineKind.duix &&
        (engines == null || engines.availability == DuixAvailability.unsupported)) {
      return IdentityFailed(engines?.unsupportedReason ?? 'duix_unsupported');
    }
    return widget.identity.changeCharacter(id);
  }

  Future<void> _openSettings() async {
    final current = _character;
    if (current == null) return;
    final saved = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder: (_) => CompanionSettingsPage(
          options: widget.catalog.options,
          currentCharacter: current,
          onSaveCharacter: _saveFromSettings,
        ),
      ),
    );
    if (!mounted || saved == null || saved == _character) return;
    setState(() => _character = saved);
    await _followEngine(saved);
  }

  void _onUnknownCharacter() {
    if (!mounted) return;
    setState(() => _pickerReason = unknownCharacterText);
  }

  Widget _picker(String initial, String? reason) => CharacterPickerPage(
    title: '选一位陪您聊天的伙伴',
    confirmLabel: '就选这个',
    options: widget.catalog.options,
    initial: initial,
    busy: _busy,
    error: _error ?? reason,
    onConfirm: _pick,
  );

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(
        backgroundColor: Color(0xFF10131A),
        body: Center(child: CircularProgressIndicator()),
      );
    }
    final character = _character;
    if (character == null) return _picker(widget.catalog.defaultId, null);
    final reason = _pickerReason;
    if (reason != null) return _picker(character, reason);
    final engines = widget.engines;
    if (engines == null) return _home(AvatarEngineKind.webview, 0, null);
    return ListenableBuilder(
      listenable: engines,
      builder: (context, _) => _home(engines.sessionEngine, engines.pageEpoch, engines),
    );
  }

  Widget _home(AvatarEngineKind engine, int epoch, EngineSwitchController? engines) {
    final saved = widget.catalog.byId(_character!)!;
    // Temporary until Task 14: a Duix character on a 3D session shows the first 3D character.
    final shown = saved.engine == engine
        ? saved
        : widget.catalog.options.firstWhere((o) => o.engine == engine, orElse: () => saved);
    return Stack(
      children: [
        Positioned.fill(
          child: widget.avatarBuilder(
            AvatarPageRequest(
              key: ValueKey('avatar-${engine.name}-${shown.id}-$epoch'),
              identity: widget.identity,
              character: shown,
              engine: engine,
              onEngineFailure: engine == AvatarEngineKind.duix ? engines?.reportDuixFailure : null,
              onUnknownCharacter: _onUnknownCharacter,
            ),
          ),
        ),
        // Bottom-right, clear of the centered mute/end buttons in AvatarOverlay.
        Positioned(
          right: 16,
          bottom: 28,
          child: SafeArea(child: _SettingsButton(onTap: _openSettings)),
        ),
      ],
    );
  }
}

class _SettingsButton extends StatelessWidget {
  const _SettingsButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    label: '换聊天伙伴',
    button: true,
    child: Material(
      color: Colors.white24,
      shape: const CircleBorder(),
      child: InkWell(
        key: const Key('settings'),
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: const SizedBox(
          width: 64,
          height: 64,
          child: Icon(Icons.tune, color: Colors.white, size: 32),
        ),
      ),
    ),
  );
}
```

删除旧文件：

```bash
git rm app/lib/identity/styles.dart app/lib/identity/style_picker_page.dart app/lib/identity/avatar_picker_page.dart
```

Run: `cd app && flutter test test/companion_picker_test.dart test/app_shell_test.dart test/engine_switch_controller_test.dart`
Expected: PASS。

- [x] **Step 9: 写失败的测试，再实现垫话目录和 `thinking.json`**

`app/test/support/thinking_fixture.dart` 第 14–15 行替换为：

```dart
      'defaultCharacter': 'xiaonuan',
      'characters': ['xiaonuan', 'xiaokai', 'xiaoxin'],
```

`app/test/thinking_config_test.dart`：
- 第 15 行改为 `expect(c.defaultCharacter, 'xiaonuan');`，紧接着加一行 `expect(c.characters, ['xiaonuan', 'xiaokai', 'xiaoxin']);`
- 第 21 行改为 `expect(c.clipAsset('xiaonuan', 'think-1'), 'assets/filler/xiaonuan/think-1.pcm');`
- 第 34–37 行替换为：
  ```dart
  test('rejects a default character that is not listed', () {
    final m = shipped()..['defaultCharacter'] = 'pirate';
    expect(() => ThinkingConfig.fromMap(m), throwsFormatException);
  });
  ```

`app/test/filler_clips_test.dart` 第 27–38 行替换为：

```dart
  test('loads the clips of one character and logs missing ones', () async {
    final cfg = testThinking();
    final lines = <String>[];
    final bundle = _MapBundle({
      'assets/filler/xiaonuan/think-1.pcm': Uint8List(4800),
      'assets/filler/xiaonuan/wait-1.pcm': Uint8List(4800),
    });
    final clips = await loadFillerClips(bundle, cfg, 'xiaonuan', diag: lines.add);
    expect(clips.keys, ['think-1', 'wait-1']);
    expect(clips['think-1']!.length, 2400);
    expect(lines, ['anyidea.diag event=filler_clip_missing id=think-2']);
  });
```

把 `app/test/filler_assets_test.dart` 整体替换为：

```dart
import 'dart:io';

import 'package:avatar_app/identity/characters.dart';
import 'package:avatar_app/native_session/thinking_config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final cfg = ThinkingConfig.parse(File(ThinkingConfig.assetPath).readAsStringSync());

  test('filler folders follow the generated character ids and are bundled', () {
    expect(cfg.characters, characterIds);
    expect(cfg.defaultCharacter, defaultCharacterId);
    final pubspec = File('pubspec.yaml').readAsStringSync();
    for (final id in cfg.characters) {
      expect(pubspec, contains('- assets/filler/$id/'), reason: id);
    }
    expect(pubspec, isNot(contains('assets/filler/grandchild/')));
    expect(pubspec, isNot(contains('assets/filler/old-friend/')));
  });

  test('every configured clip exists for every character as 24 kHz PCM16 of sane length', () {
    for (final id in cfg.characters) {
      for (final clip in cfg.allClips) {
        final f = File(cfg.clipAsset(id, clip.id));
        expect(f.existsSync(), isTrue, reason: f.path);
        final bytes = f.lengthSync();
        expect(bytes.isEven, isTrue, reason: f.path);
        expect(bytes / 2 / 24, inInclusiveRange(300, 2500), reason: f.path);
      }
    }
  });
}
```

Run: `cd app && flutter test test/thinking_config_test.dart test/filler_clips_test.dart test/filler_assets_test.dart`
Expected: FAIL（`defaultCharacter`、`characters` 不存在）。

实现：

`app/lib/native_session/thinking_config.dart`：
- 第 40–41 行改为 `required this.defaultCharacter,` / `required this.characters,`
- 第 60–61 行改为：
  ```dart
  /// Filler clips live per character: assets/filler/<characterId>/.
  final String defaultCharacter;
  final List<String> characters;
  ```
- 第 67 行改为 `String clipAsset(String characterId, String clipId) => 'assets/filler/$characterId/$clipId.pcm';`
- 第 95–99 行改为：
  ```dart
  final characters = _strings(m, 'characters', _isId);
  final defaultCharacter = m['defaultCharacter'];
  if (defaultCharacter is! String || !characters.contains(defaultCharacter)) {
    throw const FormatException('default_character_not_listed');
  }
  ```
- 第 112–113 行改为 `defaultCharacter: defaultCharacter,` / `characters: characters,`

`app/lib/native_audio/filler_clips.dart` 第 16–31 行替换为：

```dart
/// Loads one character's filler clips; a missing clip is logged and skipped (that filler stays silent).
Future<Map<String, Int16List>> loadFillerClips(
  AssetBundle bundle,
  ThinkingConfig cfg,
  String characterId, {
  DiagSink diag = logcatDiagSink,
}) async {
  final out = <String, Int16List>{};
  for (final clip in cfg.allClips) {
    try {
      out[clip.id] = pcm16FromBytes(await bundle.load(cfg.clipAsset(characterId, clip.id)));
    } catch (_) {
      diag(formatDiag('filler_clip_missing', {'id': clip.id}));
    }
  }
  return out;
}
```

`app/assets/config/thinking.json` 第 12–13 行替换为：

```json
  "defaultCharacter": "xiaonuan",
  "characters": ["xiaonuan", "xiaokai", "xiaoxin"],
```

`app/pubspec.yaml` 第 70–71 行替换为：

```yaml
    - assets/filler/xiaonuan/
    - assets/filler/xiaokai/
    - assets/filler/xiaoxin/
```

移动占位垫话片段（`fillersEnabled` 仍为 false；两套旧片段的字节完全相同，写计划时用 md5 核对过）。原来的孙辈风格给小暖和小凯，老朋友风格给小欣：

| 源文件 | 目标文件 |
|---|---|
| `assets/filler/grandchild/think-1.pcm` | `assets/filler/xiaonuan/think-1.pcm`（移动）、`assets/filler/xiaokai/think-1.pcm`（复制） |
| `assets/filler/grandchild/think-2.pcm` | `assets/filler/xiaonuan/think-2.pcm`（移动）、`assets/filler/xiaokai/think-2.pcm`（复制） |
| `assets/filler/grandchild/wait-1.pcm` | `assets/filler/xiaonuan/wait-1.pcm`（移动）、`assets/filler/xiaokai/wait-1.pcm`（复制） |
| `assets/filler/old-friend/think-1.pcm` | `assets/filler/xiaoxin/think-1.pcm`（移动） |
| `assets/filler/old-friend/think-2.pcm` | `assets/filler/xiaoxin/think-2.pcm`（移动） |
| `assets/filler/old-friend/wait-1.pcm` | `assets/filler/xiaoxin/wait-1.pcm`（移动） |

```bash
cd app
git mv assets/filler/grandchild assets/filler/xiaonuan
mkdir -p assets/filler/xiaokai
cp assets/filler/xiaonuan/think-1.pcm assets/filler/xiaonuan/think-2.pcm assets/filler/xiaonuan/wait-1.pcm assets/filler/xiaokai/
git mv assets/filler/old-friend assets/filler/xiaoxin
ls assets/filler   # expect: xiaokai xiaonuan xiaoxin
```

Run: `cd app && flutter test test/thinking_config_test.dart test/filler_clips_test.dart test/filler_assets_test.dart`
Expected: PASS。

- [x] **Step 10: 写失败的测试，再实现协议和 `POST /session` body**

`app/test/native_gateway_protocol_test.dart`：在 `main()` 末尾追加：

```dart
  test('response.start accepts reminder and reads unknown kinds as reply', () {
    final reminder = parseServerMessage({'type': 'response.start', 'responseSeq': 4, 'kind': 'reminder'});
    expect((reminder! as ResponseStart).kind, 'reminder');
    final unknown = parseServerMessage({'type': 'response.start', 'responseSeq': 5, 'kind': 'celebration'});
    expect((unknown! as ResponseStart).kind, 'reply');
    expect(parseServerMessage({'type': 'response.start', 'responseSeq': 5}), isNull);
    expect(parseServerMessage({'type': 'response.start', 'kind': 'reply'}), isNull);
  });

  test('session.start never carries a voice profile', () {
    final info = const SessionStart(language: 'zh').toJson()['clientInfo'] as Map;
    expect(info.keys, isNot(contains('voiceProfile')));
  });
```

`app/test/native_gateway_client_test.dart`：
1. `FakeGatewayTransport`（第 273 行起）字段区加 `final postedBodies = <Map<String, Object?>>[];`，在 `post` 里 `postedPaths.add(uri.path);` 之后加：
   ```dart
   if (uri.path == '/session') postedBodies.add(body);
   ```
2. 在 `main()` 末尾追加：
   ```dart
   test('POST /session carries the chosen character; session.start has no voice profile', () async {
     final transport = FakeGatewayTransport(tokens: firstTokens);
     await NativeGatewayClient(
       baseUri: Uri.parse('http://gw.test'),
       appSecret: 'secret-123456789',
       transport: transport,
       events: RecordingGatewayEvents(),
       reconnectBase: Duration.zero,
       language: 'zh',
       characterId: 'xiaokai',
     ).start();
     expect(transport.postedBodies.single, {'character': 'xiaokai'});
     expect(transport.lastSocket.jsonMessages.single['clientInfo'], {'platform': 'android', 'audioPath': 'B', 'language': 'zh'});
   });

   test('without a character the session body stays empty', () async {
     final transport = FakeGatewayTransport(tokens: firstTokens);
     await client(transport, null).start();
     expect(transport.postedBodies.single, isEmpty);
   });

   test('the retry after a renewed token keeps the character', () async {
     final transport = FakeGatewayTransport(tokens: firstTokens, rejectedBearers: {'old-token-0123456789'});
     await NativeGatewayClient(
       baseUri: Uri.parse('http://gw.test'),
       appSecret: 'secret-123456789',
       transport: transport,
       events: RecordingGatewayEvents(),
       reconnectBase: Duration.zero,
       characterId: 'xiaonuan',
       identity: FakeTokenProvider('old-token-0123456789', renewed: 'new-token-0123456789'),
     ).start();
     expect(transport.postedBodies, [
       {'character': 'xiaonuan'},
       {'character': 'xiaonuan'},
     ]);
   });
   ```

Run: `cd app && flutter test test/native_gateway_protocol_test.dart test/native_gateway_client_test.dart`
Expected: 编译失败（`characterId` 参数不存在）。

实现：

`app/lib/native_gateway/protocol.dart` 第 34–54 行（`SessionStart`）替换为：

```dart
class SessionStart extends ClientMessage {
  const SessionStart({this.platform = 'android', this.audioPath = 'B', this.language});

  final String platform;
  final String audioPath;
  final String? language;

  @override
  Map<String, Object> toJson() => {
        'type': 'session.start',
        'clientInfo': {
          'platform': platform,
          'audioPath': audioPath,
          'language': ?language,
        },
      };
}
```

同文件 `parseServerMessage` 的第 218–220 行替换为：

```dart
    case 'response.start':
      final kind = raw['kind'];
      if (responseSeq == null || kind is! String) return null;
      // Unknown kinds read as a plain reply (spec §1: backward compatible).
      return ResponseStart(responseSeq, _responseKinds.contains(kind) ? kind : 'reply');
```

并在文件末尾（`_positiveInt` 前）加：

```dart
const _responseKinds = {'reply', 'greeting', 'followup', 'reminder'};
```

`app/lib/native_gateway/gateway_client.dart`：
- 第 48 行 `this.voiceProfile,` 改为 `this.characterId,`
- 第 65 行 `final String? voiceProfile;` 改为：
  ```dart
  /// Sent as {"character": id} on POST /session; null lets the gateway use its default.
  final String? characterId;
  ```
- 第 146–158 行 `_createSession` 替换为：
  ```dart
  Map<String, Object?> get _sessionBody => {'character': ?characterId};

  /// POST /session with the device bearer; after a 401, one retry with the renewed (or no) bearer.
  Future<SessionTokens> _createSession() async {
    final provider = identity;
    final bearer = await provider?.token();
    try {
      return await _post('/session', _sessionBody, bearer: bearer);
    } on GatewayHttpException catch (error) {
      if (provider == null || bearer == null || error.statusCode != 401) {
        rethrow;
      }
      return _post('/session', _sessionBody, bearer: await provider.renew());
    }
  }
  ```
- 第 184 行改为 `send(SessionStart(platform: platform, audioPath: audioPath, language: language));`

Run: `cd app && flutter test test/native_gateway_protocol_test.dart test/native_gateway_client_test.dart`
Expected: PASS。

- [x] **Step 11: 写失败的测试，再改 `AvatarPage`**

新建 `app/test/avatar_page_filler_test.dart`，删除 `app/test/avatar_page_style_test.dart`（`git rm`）：

```dart
import 'dart:io';

import 'package:avatar_app/avatar_page.dart';
import 'package:avatar_app/native_session/thinking_config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // Runs from app/, like the thinking_config tests.
  final cfg = ThinkingConfig.parse(File(ThinkingConfig.assetPath).readAsStringSync());

  test('filler clips follow the character', () {
    expect(fillerCharacter(cfg, 'xiaokai'), 'xiaokai');
    expect(fillerCharacter(cfg, 'xiaoxin'), 'xiaoxin');
  });

  test('unknown or missing characters use the config default', () {
    expect(fillerCharacter(cfg, null), cfg.defaultCharacter);
    expect(fillerCharacter(cfg, 'grandchild'), cfg.defaultCharacter);
  });
}
```

Run: `cd app && flutter test test/avatar_page_filler_test.dart`
Expected: 编译失败（`fillerCharacter` 不存在）。

改 `app/lib/avatar_page.dart`：
- 删除第 13 行 `import 'identity/characters.dart';`
- 第 57–59 行替换为：
  ```dart
  /// Filler clips follow the character; unknown or missing ids use the config default.
  String fillerCharacter(ThinkingConfig cfg, String? characterId) =>
      characterId != null && cfg.characters.contains(characterId) ? characterId : cfg.defaultCharacter;
  ```
- 第 71–97 行（构造函数到 `displayName` 字段）替换为：
  ```dart
  const AvatarPage({
    super.key,
    required this.engineFactory,
    this.identity,
    this.onEngineFailure,
    this.onUnknownCharacter,
    this.characterId,
    this.displayName = '',
    this.handoff,
    this.platform = const AvatarPagePlatform(),
  });

  /// Called once; the page owns and disposes the engine.
  final AvatarEngine Function() engineFactory;

  /// Device bearer source for POST /session; null = dev mode (APP_SECRET only).
  final DeviceTokenProvider? identity;

  /// Set when another engine can take over; otherwise a failure shows the retry error.
  final void Function(AvatarEngineFailure failure)? onEngineFailure;

  /// POST /session answered 400 (unknown character). Null shows the usual error.
  final VoidCallback? onUnknownCharacter;

  /// Chosen character: sent on POST /session and picks the filler clips. Null = gateway default (dev).
  final String? characterId;

  /// Corner label: the character title from assets/config/characters.json.
  final String displayName;
  ```
- `_startNativeSession` 中第 219–237 行（从 `final thinking = await _loadThinking();` 到 `clips` 赋值结束）替换为：
  ```dart
    final thinking = await _loadThinking();
    final clips = thinking == null
        ? const <String, Int16List>{}
        : await loadFillerClips(rootBundle, thinking, fillerCharacter(thinking, widget.characterId));
  ```
- 第 252 行 `voiceProfile: ...` 改为 `characterId: widget.characterId,`
- `_onNativeEvent` 第 324–325 行替换为：
  ```dart
        case UiError(:final code):
          final unknown = widget.onUnknownCharacter;
          if (code == 'gateway_http_400' && unknown != null) {
            unknown(); // the only 400 of POST /session is unknown_character
            return;
          }
          setState(() => _error = _errorLabel(code));
  ```
- 第 475 行改为 `name: widget.displayName,`

Run: `cd app && flutter test test/avatar_page_filler_test.dart test/avatar_page_engine_test.dart test/avatar_page_test.dart`
Expected: PASS。

- [x] **Step 12: 重写 `main.dart`**

把 `app/lib/main.dart` 整体替换为：

```dart
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'avatar_engine/avatar_engine.dart';
import 'avatar_engine/engine_switch_controller.dart';
import 'avatar_engine/webview_engine.dart';
import 'avatar_page.dart';
import 'config.dart';
import 'diag_log.dart';
import 'duix/duix_bridge.dart';
import 'duix/duix_config.dart';
import 'duix/duix_crash_guard.dart';
import 'duix/duix_engine.dart';
import 'identity/app_shell.dart';
import 'identity/avatars.dart';
import 'identity/character_engine_prefs.dart';
import 'identity/characters.dart';
import 'identity/device_identity.dart';
import 'identity/identity_api.dart';
import 'identity/secure_credential_store.dart';
import 'native_gateway/transports.dart';
import 'spike/duix_probe_spike.dart';
import 'spike/native_audio_spike.dart';
import 'spike/secure_storage_spike.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
  runApp(AvatarApp(catalog: await _loadCatalog()));
}

/// Null when assets/config/characters.json is missing or invalid; the app shows a config error.
Future<CharacterCatalog?> _loadCatalog() async {
  try {
    return await loadCharacterCatalog(rootBundle);
  } catch (_) {
    logcatDiagSink(formatDiag('characters_config_invalid', {}));
    return null;
  }
}

class AvatarApp extends StatelessWidget {
  const AvatarApp({super.key, required this.catalog});

  final CharacterCatalog? catalog;

  @override
  Widget build(BuildContext context) {
    final catalog = this.catalog;
    final problem = AppConfig.validate() ?? (catalog == null ? 'characters.json' : null);
    return MaterialApp(
      title: '智伴',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorSchemeSeed: Colors.teal,
        brightness: Brightness.dark,
      ),
      home: switch (AppConfig.spike) {
        'native_audio' => const NativeAudioSpikePage(),
        'secure_storage' => const SecureStorageSpikePage(),
        'duix_probe' => const DuixProbeSpikePage(),
        _ =>
          catalog != null && problem == null
              ? _Home(catalog: catalog)
              : Scaffold(
                  body: Center(
                    child: Text(
                      '配置错误：$problem',
                      style: const TextStyle(fontSize: 20),
                    ),
                  ),
                ),
      },
    );
  }
}

/// Owns the single DeviceIdentity for the app's lifetime.
class _Home extends StatefulWidget {
  const _Home({required this.catalog});

  final CharacterCatalog catalog;

  @override
  State<_Home> createState() => _HomeState();
}

class _HomeState extends State<_Home> {
  static const _store = SecureCredentialStore();
  late final _identity = DeviceIdentity(
    store: _store,
    backend: IdentityApi(
      baseUri: Uri.parse(AppConfig.gatewayUrl),
      appSecret: AppConfig.appSecret,
      transport: const IoGatewayTransport(),
    ),
  );
  final _bridge = MethodChannelDuixBridge();
  final _handoff = EngineHandoff();
  // Task 14 removes CharacterEnginePrefs together with EnginePrefs.
  late final _engines = EngineSwitchController(
    prefs: CharacterEnginePrefs(identity: _identity, catalog: widget.catalog),
    bridge: _bridge,
    guard: DuixCrashGuard(_store),
    loadConfig: () async => DuixConfig.parse(await rootBundle.loadString(DuixConfig.assetPath)),
    debugBuild: kDebugMode,
  );

  @override
  void dispose() {
    _engines.dispose();
    super.dispose();
  }

  AvatarEngine _engineFor(AvatarPageRequest request) {
    final config = _engines.config;
    if (request.engine == AvatarEngineKind.duix && config != null) {
      return DuixAvatarEngine(
        bridge: _bridge,
        config: config,
        guard: DuixCrashGuard(_store),
        modelId: request.character.duixModel,
      );
    }
    return WebViewAvatarEngine(avatarId: request.character.webviewAvatar ?? defaultAvatarId);
  }

  @override
  Widget build(BuildContext context) => AppShell(
    identity: _identity,
    catalog: widget.catalog,
    engines: _engines,
    avatarBuilder: (request) => AvatarPage(
      key: request.key,
      engineFactory: () => _engineFor(request),
      identity: request.identity,
      characterId: request.character.id,
      displayName: request.character.title,
      onEngineFailure: request.onEngineFailure,
      onUnknownCharacter: request.onUnknownCharacter,
      handoff: _handoff,
    ),
  );
}
```

- [x] **Step 13: 全量验证**

```bash
cd app
grep -rnE "style_id|avatar_id|styleKey|avatarKey|savedStyle|patchStyle|voiceProfile|youngMale|characterNameForEngine|grandchild|old-friend|characterLily|characterKai|characterXiaorou" lib assets/config pubspec.yaml
grep -rnE "styleKey|avatarKey|savedStyle|patchStyle|chooseFirstStyle|changeAvatar|StylePickerPage|AvatarPickerPage|characterNameForEngine" test
flutter test
flutter analyze
```

Expected：两条 `grep` 都没有输出（测试里故意出现的 `'grandchild'` 字面量只用于「旧 id 被拒绝」的断言，不在第二条的匹配范围内）；`flutter test` 全部 PASS；`flutter analyze` 输出 `No issues found!`。

- [x] **Step 14: 提交**

勾选本文件已完成的步骤，然后：

```bash
git add app/assets/config/characters.json app/assets/config/thinking.json app/pubspec.yaml \
  app/assets/filler/xiaonuan app/assets/filler/xiaokai app/assets/filler/xiaoxin \
  app/lib/identity/characters.dart app/lib/identity/character_availability.dart \
  app/lib/identity/character_picker_page.dart app/lib/identity/character_engine_prefs.dart \
  app/lib/identity/device_identity.dart app/lib/identity/identity_api.dart \
  app/lib/identity/app_shell.dart app/lib/identity/companion_settings_page.dart \
  app/lib/main.dart app/lib/avatar_page.dart app/lib/native_gateway/protocol.dart \
  app/lib/native_gateway/gateway_client.dart app/lib/native_session/thinking_config.dart \
  app/lib/native_audio/filler_clips.dart \
  app/test/support/character_fixture.dart app/test/support/identity_fakes.dart app/test/support/thinking_fixture.dart \
  app/test/character_picker_test.dart app/test/characters_test.dart app/test/device_identity_test.dart \
  app/test/identity_api_test.dart app/test/app_shell_test.dart app/test/companion_picker_test.dart \
  app/test/engine_switch_controller_test.dart app/test/native_gateway_client_test.dart \
  app/test/native_gateway_protocol_test.dart app/test/thinking_config_test.dart \
  app/test/filler_clips_test.dart app/test/filler_assets_test.dart app/test/avatar_page_filler_test.dart \
  docs/superpowers/plans/2026-10-26-multi-character/13-t13-app-characters-identity.md
git status --short   # the git rm / git mv deletions are already staged; nothing unrelated is staged
git commit -m "feat(app): pick a character instead of a style and send it on POST /session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收清单

- [x] `assets/config/characters.json` 的 id 与生成的 `characterIds` 完全一致（含顺序），加载时校验，测试覆盖缺失、乱序、未知 id、引擎与资源不匹配。
- [x] 首次启动显示「选一位陪您聊天的伙伴」，默认高亮小暖；确认后 `register()`（无参数）一次，本地只存 `device_token`、`character_id`。
- [x] `initialCharacter` 在小暖不可选时回落到第一个可选的角色（Task 14 接入真实可用性后即小欣）。
- [x] 代码和测试里不再有 `style_id`、`avatar_id`、`patchStyle`、`StylePickerPage`、`StyleSettingsPage`、`AvatarPickerPage`、`styles.dart`、`voiceProfile`、`characterNameForEngine`。
- [x] `POST /session` body 为 `{"character": id}`，401 重试时 body 不变；`session.start` 不带 `voiceProfile`。
- [x] `response.start` 接受 `reminder`，未知 kind 按 `reply`。
- [x] 角标显示角色配置里的 `title`；Duix 模型取 `duixModel`，3D 形象取 `webviewAvatar`。
- [x] 垫话音频在 `assets/filler/<characterId>/`，`thinking.json` 用 `defaultCharacter`/`characters`，pubspec 已声明三个目录。
- [x] 网关对未知角色返回 400 时，App 回到选择页并显示「这位伙伴暂时联系不上，请重新选一位」。
- [x] `cd app && flutter test` 全绿；`flutter analyze` 无问题。
