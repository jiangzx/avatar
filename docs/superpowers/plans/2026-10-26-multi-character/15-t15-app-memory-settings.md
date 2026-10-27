# Task 15: App 记忆接口与设置页（我的资料、各角色记得的事、清除）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。先读 spec 对应章节，再读 `00-overview.md`，最后读本文件。步骤用 `- [ ]` 勾选。

**Goal:** 设置页重做为四块：「选择陪伴角色」「我的资料」（称呼可改、基本资料逐条删、清除我的基本资料）、每个角色一块「X记得的事」（钉住的事 / 其他记忆两栏，逐条删、清除X的记忆）、「清除全部记忆」。数据来自网关 Task 11 的记忆接口，所有删除都要大字二次确认；写成功后通知 AppShell 重新开始会话。记忆列表只放在页面 state 里，不写任何本地存储，也不进日志。

**Spec 章节：** 产品设计「设置页」；技术设计 §7（记忆 HTTP 接口）、§9「网络和存储」「设置页」；错误处理「记忆接口失败」；安全与隐私「响应与缓存」「日志」；附录 B（App 修改称呼被拒、删除失败、两条二次确认）。

**前置：**
- Task 11 已完成：`GET /memory`（200 + `MemoryOverview`）、`PUT /memory/addressing`（204 / 400 / 409 `memory_declined`）、`DELETE /memory/items/:id`（204 / 404）、`DELETE /memory?scope=profile|character|all&character=<id>`（204 / 400），都要求 `x-app-secret` + `Authorization: Bearer`，401 表示 token 无效。
- Task 13、14 已完成并提交（`CompanionSettingsPage(options, currentCharacter, onSaveCharacter, availabilityOf, availabilityChanges)`、`CharacterCardList`、AppShell 的 `_pageEpoch`）。
- 基线绿：`cd app && flutter test && flutter analyze`。

## Files

- Create:
  - `app/lib/memory/memory_overview.dart`（`MemoryOverview` 等数据类和 JSON 校验）
  - `app/lib/memory/memory_api.dart`（`MemoryApi`、`MemoryResult`、`MemoryClearScope`）
  - `app/lib/memory/memory_copy.dart`（设置页记忆区的全部文案）
  - `app/test/support/memory_fakes.dart`
  - `app/test/memory_api_test.dart`
  - `app/test/companion_settings_page_test.dart`
  - `app/test/credential_store_test.dart`
- Modify:
  - `app/lib/native_gateway/transports.dart:20-35`（接口）、`:37-94`（`IoGatewayTransport`）
  - `app/lib/identity/credential_store.dart:1-20`
  - `app/lib/identity/secure_credential_store.dart:7-17`
  - `app/lib/avatar_engine/ui/engine_confirm_dialog.dart:1-34`（抽出通用的 `confirmLarge`，`confirmEngineSwitch` 改为调用它，外观和 key 不变）
  - `app/lib/identity/companion_settings_page.dart`（Task 14 版本，整体重写）
  - `app/lib/identity/app_shell.dart`（Task 14 版本：加 `memory`、`onMemoryChanged`、暂停页面）
  - `app/lib/main.dart`（Task 14 版本：创建 `MemoryApi`）
  - Tests：`app/test/native_gateway_transport_test.dart`、`app/test/secure_credential_store_test.dart`、`app/test/native_gateway_client_test.dart`（`FakeGatewayTransport`）、`app/test/identity_api_test.dart`（`RecordingTransport`）、`app/test/support/identity_fakes.dart`（`ThrowingCredentialStore`）、`app/test/app_shell_test.dart`（`app()` 辅助函数 + 追加用例）

## Interfaces

- Consumes：Task 11 的四个路由和状态码；Task 13 的 `CharacterOption`、`CharacterCardList`、`identityErrorText`、`DeviceTokenProvider`（`gateway_client.dart:32-37`，`DeviceIdentity` 实现）；Task 14 的 `CompanionSettingsPage` 参数和 AppShell 结构；现有 `formatDiag` / `DiagSink`（`diag_log.dart`）、`AppConfig.gatewayRequestTimeout`（`config.dart:14-19`）。
- Produces（与总览 C12 一致）：
  ```dart
  // transports.dart
  abstract interface class GatewayTransport {
    Future<GatewayHttpResponse> post(Uri uri, {required String appSecret, required Map<String, Object?> body, String? bearer});
    Future<GatewayHttpResponse> patch(Uri uri, {required String appSecret, required String bearer, required Map<String, Object?> body});
    Future<GatewayHttpResponse> get(Uri uri, {required String appSecret, String? bearer});
    Future<GatewayHttpResponse> put(Uri uri, {required String appSecret, required Map<String, Object?> body, String? bearer});
    Future<GatewayHttpResponse> delete(Uri uri, {required String appSecret, String? bearer});
    Future<NativeSocket> openWebSocket(Uri uri);
  }
  // credential_store.dart
  Future<void> delete(String key);
  // memory/memory_api.dart
  enum MemoryClearScope { profile, character, all }
  sealed class MemoryResult<T>; final class MemoryOk<T>(T value); final class MemoryFailed<T>(String reason);
  class MemoryApi {
    MemoryApi({required Uri baseUri, required String appSecret, required GatewayTransport transport,
        required DeviceTokenProvider identity, Duration requestTimeout, DiagSink diag});
    Future<MemoryResult<MemoryOverview>> overview();
    Future<MemoryResult<void>> setAddressing(String text);
    Future<MemoryResult<void>> deleteItem(String id);
    Future<MemoryResult<void>> clear(MemoryClearScope scope, {String? character});
  }
  // memory/memory_overview.dart (shape of overview contract C1)
  class MemoryItem {id, text}; class MemoryFactItem extends MemoryItem {category, sensitive};
  class MemoryPinnedItem extends MemoryItem {sensitive}; class CharacterMemory {character, pinned, facts};
  class MemoryOverview {addressing, profileItems, characters; forCharacter(id); static fromJson(raw)}
  ```
  `MemoryFailed.reason`：`network`、`declined`（409）、`rejected`（400 或本地校验失败）、`not_found`（404）、`unauthorized`（renew 后仍 401，或 renew 失败）、`bad_response`（body 不符合 C1）、`http_<status>`。
- `CompanionSettingsPage` 新参数：`MemoryApi? memory`（null 时不显示记忆区，供开发构建和旧测试）、`VoidCallback? onMemoryChanged`。
- `AppShell` 新参数：`MemoryApi? memory`。
- `confirmLarge(BuildContext, {String? title, required String body, required String cancel, required String ok, Key cancelKey, Key okKey}) → Future<bool>`（`engine_confirm_dialog.dart`）。

**会话重启的时机（对 C12「onMemoryChanged → bump 页面 epoch」的落地）：** 网关在每次写操作前已经 `endOwner` 结束了会话，聊天页的客户端会自己尝试重连并新建会话，而设置页正盖在聊天页上面。为了不在设置页底下悄悄开新会话（开场白在用户看不见时播出来），AppShell 在收到 `onMemoryChanged` 时立刻把聊天页换成空白占位（旧页面 dispose，麦克风和会话释放）并 bump epoch；设置页关闭后再用新 epoch 建页面。

## 调用方适配（保证 `flutter test`、`flutter analyze` 全绿）

| 位置 | 断在哪里 | 处理 |
|---|---|---|
| `test/native_gateway_client_test.dart` 的 `FakeGatewayTransport`（第 273 行起） | 没实现 `get`/`put`/`delete` | Step 1 加三个方法，返回 404 |
| `test/identity_api_test.dart:5-25` 的 `RecordingTransport` | 同上 | Step 1 加三个方法，`throw UnimplementedError()` |
| `test/native_gateway_transport_test.dart:30-48` | 服务端处理器对空 body 做 `jsonDecode('')` 会抛错；只记录 path 不含 query | Step 1 改处理器 |
| `lib/identity/secure_credential_store.dart`、`lib/identity/credential_store.dart` 的 `MemoryCredentialStore` | 没实现 `delete` | Step 2 |
| `test/support/identity_fakes.dart:34-40` 的 `ThrowingCredentialStore` | 没实现 `delete` | Step 2 加 `delete`，同样抛 `PlatformException` |
| `test/companion_picker_test.dart` | 设置页新增的参数都可选，旧用例照常编译；按钮 key `companion-confirm` / `companion-cancel` 和位置不变 | 不改 |
| `test/app_shell_test.dart` | `app()` 需要能传 `memory` | Step 7 |
| `test/engine_ui_test.dart` | `confirmEngineSwitch` 的文字和 key 不变 | 不改 |

## Steps

- [x] **Step 1: 写失败的测试，再实现 transport 的 `get` / `put` / `delete`**

`app/test/native_gateway_transport_test.dart`：
1. `setUp` 里的服务端处理器（第 30–48 行）替换为（记录 path + query，空 body 记为 null；`/empty` 回 204 无 body）：
   ```dart
    server.listen((request) async {
      final text = await utf8.decoder.bind(request).join();
      seen.add(
        SeenRequest(
          request.method,
          request.uri.toString(),
          request.headers.value('x-app-secret'),
          request.headers.value(HttpHeaders.authorizationHeader),
          text.isEmpty ? null : jsonDecode(text),
        ),
      );
      if (request.uri.path == '/empty') {
        request.response.statusCode = 204;
      } else {
        request.response
          ..statusCode = 201
          ..headers.contentType = ContentType.json
          ..write('{"ok":true}');
      }
      await request.response.close();
    });
   ```
2. `main()` 末尾追加：
   ```dart
   test('get sends the secret and bearer without a body', () async {
     final res = await transport.get(at('/memory'), appSecret: 'secret-123456789', bearer: 'device-token-0123456789');
     expect(res.statusCode, 201);
     expect(res.body, {'ok': true});
     expect(seen.single.method, 'GET');
     expect(seen.single.path, '/memory');
     expect(seen.single.secret, 'secret-123456789');
     expect(seen.single.authorization, 'Bearer device-token-0123456789');
     expect(seen.single.body, isNull);
   });

   test('put sends a JSON body with the bearer', () async {
     await transport.put(
       at('/memory/addressing'),
       appSecret: 'secret-123456789',
       body: const {'text': '老王'},
       bearer: 'device-token-0123456789',
     );
     expect(seen.single.method, 'PUT');
     expect(seen.single.body, {'text': '老王'});
     expect(seen.single.authorization, 'Bearer device-token-0123456789');
   });

   test('delete keeps the query and reads an empty 204 as a null body', () async {
     final res = await transport.delete(at('/empty?scope=all'), appSecret: 'secret-123456789', bearer: 'device-token-0123456789');
     expect(res.statusCode, 204);
     expect(res.body, isNull);
     expect(seen.single.method, 'DELETE');
     expect(seen.single.path, '/empty?scope=all');
     expect(seen.single.body, isNull);
   });
   ```

Run: `cd app && flutter test test/native_gateway_transport_test.dart`
Expected: 编译失败（`get`、`put`、`delete` 不存在）。

`app/lib/native_gateway/transports.dart`：
- 第 20–35 行接口替换为：
  ```dart
  abstract interface class GatewayTransport {
    /// [bearer] adds `Authorization: Bearer <token>` (device identity); null sends none.
    Future<GatewayHttpResponse> post(
      Uri uri, {
      required String appSecret,
      required Map<String, Object?> body,
      String? bearer,
    });
    Future<GatewayHttpResponse> patch(
      Uri uri, {
      required String appSecret,
      required String bearer,
      required Map<String, Object?> body,
    });
    Future<GatewayHttpResponse> get(Uri uri, {required String appSecret, String? bearer});
    Future<GatewayHttpResponse> put(
      Uri uri, {
      required String appSecret,
      required Map<String, Object?> body,
      String? bearer,
    });
    Future<GatewayHttpResponse> delete(Uri uri, {required String appSecret, String? bearer});
    Future<NativeSocket> openWebSocket(Uri uri);
  }
  ```
- `IoGatewayTransport` 里，在 `patch` 之后（第 54 行后）加：
  ```dart
  @override
  Future<GatewayHttpResponse> get(Uri uri, {required String appSecret, String? bearer}) =>
      _send('GET', uri, appSecret: appSecret, bearer: bearer);

  @override
  Future<GatewayHttpResponse> put(
    Uri uri, {
    required String appSecret,
    required Map<String, Object?> body,
    String? bearer,
  }) => _send('PUT', uri, appSecret: appSecret, body: body, bearer: bearer);

  @override
  Future<GatewayHttpResponse> delete(Uri uri, {required String appSecret, String? bearer}) =>
      _send('DELETE', uri, appSecret: appSecret, bearer: bearer);
  ```
- `_send`（第 56–94 行）的签名把 `required Map<String, Object?> body` 改成 `Map<String, Object?>? body`，并把第 68–73 行替换为：
  ```dart
      request.headers.set('x-app-secret', appSecret);
      if (bearer != null) {
        request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $bearer');
      }
      if (body != null) {
        request.headers.contentType = ContentType.json;
        request.add(utf8.encode(jsonEncode(body)));
      }
  ```
  （204 的空响应体已有的 `on FormatException { decoded = null; }` 会读成 null。）

调用方适配：
- `app/test/native_gateway_client_test.dart` 的 `FakeGatewayTransport`，在 `patch` 后加：
  ```dart
  @override
  Future<GatewayHttpResponse> get(Uri uri, {required String appSecret, String? bearer}) async =>
      const GatewayHttpResponse(statusCode: 404, body: null);

  @override
  Future<GatewayHttpResponse> put(Uri uri, {required String appSecret, required Map<String, Object?> body, String? bearer}) async =>
      const GatewayHttpResponse(statusCode: 404, body: null);

  @override
  Future<GatewayHttpResponse> delete(Uri uri, {required String appSecret, String? bearer}) async =>
      const GatewayHttpResponse(statusCode: 404, body: null);
  ```
- `app/test/identity_api_test.dart` 的 `RecordingTransport`，在 `patch` 后加：
  ```dart
  @override
  Future<GatewayHttpResponse> get(Uri uri, {required String appSecret, String? bearer}) => throw UnimplementedError();

  @override
  Future<GatewayHttpResponse> put(Uri uri, {required String appSecret, required Map<String, Object?> body, String? bearer}) =>
      throw UnimplementedError();

  @override
  Future<GatewayHttpResponse> delete(Uri uri, {required String appSecret, String? bearer}) => throw UnimplementedError();
  ```

Run: `cd app && flutter test test/native_gateway_transport_test.dart test/native_gateway_client_test.dart test/identity_api_test.dart`
Expected: PASS。

- [x] **Step 2: 写失败的测试，再实现 `CredentialStore.delete`**

新建 `app/test/credential_store_test.dart`：

```dart
import 'package:avatar_app/identity/credential_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the in-memory store deletes one key and ignores missing ones', () async {
    final store = MemoryCredentialStore({'device_token': 't', 'character_id': 'xiaonuan'});
    await store.delete('character_id');
    await store.delete('missing');
    expect(store.values, {'device_token': 't'});
    expect(await store.read('character_id'), isNull);
  });
}
```

`app/test/secure_credential_store_test.dart` 整体替换为：

```dart
import 'package:avatar_app/identity/secure_credential_store.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('reads, writes and deletes through flutter_secure_storage', () async {
    FlutterSecureStorage.setMockInitialValues({'character_id': 'xiaokai'});
    const store = SecureCredentialStore();
    expect(await store.read('character_id'), 'xiaokai');
    await store.write('device_token', 'device-token-0123456789');
    expect(await store.read('device_token'), 'device-token-0123456789');
    await store.delete('character_id');
    expect(await store.read('character_id'), isNull);
  });
}
```

Run: `cd app && flutter test test/credential_store_test.dart test/secure_credential_store_test.dart`
Expected: 编译失败（`delete` 不存在）。

实现：
- `app/lib/identity/credential_store.dart` 整体替换为：
  ```dart
  /// Small key/value store for the device credential and the chosen character.
  abstract interface class CredentialStore {
    Future<String?> read(String key);
    Future<void> write(String key, String value);

    /// Removes [key]; a missing key is not an error.
    Future<void> delete(String key);
  }

  /// In-memory store for tests.
  class MemoryCredentialStore implements CredentialStore {
    MemoryCredentialStore([Map<String, String>? initial]) : values = {...?initial};

    final Map<String, String> values;

    @override
    Future<String?> read(String key) async => values[key];

    @override
    Future<void> write(String key, String value) async {
      values[key] = value;
    }

    @override
    Future<void> delete(String key) async {
      values.remove(key);
    }
  }
  ```
- `app/lib/identity/secure_credential_store.dart` 在 `write` 后加：
  ```dart
  @override
  Future<void> delete(String key) => _storage.delete(key: key);
  ```
- `app/test/support/identity_fakes.dart` 的 `ThrowingCredentialStore` 加：
  ```dart
  @override
  Future<void> delete(String key) async => throw PlatformException(code: 'keystore_failed');
  ```

Run: `cd app && flutter test test/credential_store_test.dart test/secure_credential_store_test.dart test/device_identity_test.dart`
Expected: PASS。

- [x] **Step 3: 写失败的测试：`MemoryApi`**

新建 `app/test/support/memory_fakes.dart`：

```dart
import 'dart:convert';
import 'dart:io';

import 'package:avatar_app/diag_log.dart';
import 'package:avatar_app/memory/memory_api.dart';
import 'package:avatar_app/native_gateway/gateway_client.dart';
import 'package:avatar_app/native_gateway/transports.dart';

// Hand-written synthetic rows (AGENTS.md: no real conversation content).
const _sample = '''
{
  "profile": {
    "addressing": {"id": "a1", "text": "王叔"},
    "items": [{"id": "p1", "text": "家在天津"}]
  },
  "characters": [
    {"character": "xiaonuan",
     "pinned": [{"id": "n-pin", "text": "周三去医院复查", "sensitive": true}],
     "facts": [{"id": "n-fact", "text": "喜欢喝茉莉花茶", "category": "preference", "sensitive": false},
               {"id": "n-health", "text": "有高血压", "category": "health", "sensitive": true}]},
    {"character": "xiaokai", "pinned": [], "facts": []},
    {"character": "xiaoxin", "pinned": [],
     "facts": [{"id": "x-fact", "text": "爱听评书", "category": "preference", "sensitive": false}]}
  ]
}
''';

/// A fresh, mutable copy of the synthetic GET /memory body.
Map<String, Object?> sampleOverviewJson() => jsonDecode(_sample) as Map<String, Object?>;

/// Serves /memory like the gateway's Task 11 routes, from an in-memory overview. Records every call.
class FakeMemoryTransport implements GatewayTransport {
  FakeMemoryTransport([Map<String, Object?>? overview]) : overview = overview ?? sampleOverviewJson();

  Map<String, Object?> overview;

  /// '<METHOD> <path>[?query]' per request, e.g. 'DELETE /memory?scope=all'.
  final calls = <String>[];
  final bearers = <String?>[];
  final bodies = <Map<String, Object?>>[];

  /// Answered first, in order, instead of the normal behaviour.
  final statuses = <int>[];
  bool throwNetwork = false;

  Map<String, Object?> get _profile => overview['profile']! as Map<String, Object?>;
  List<Map<String, Object?>> get _characters => (overview['characters']! as List).cast<Map<String, Object?>>();

  @override
  Future<GatewayHttpResponse> get(Uri uri, {required String appSecret, String? bearer}) =>
      _answer('GET', uri, bearer, null, () => 200);

  @override
  Future<GatewayHttpResponse> put(Uri uri, {required String appSecret, required Map<String, Object?> body, String? bearer}) =>
      _answer('PUT', uri, bearer, body, () {
        _profile['addressing'] = {'id': 'a2', 'text': body['text']};
        return 204;
      });

  @override
  Future<GatewayHttpResponse> delete(Uri uri, {required String appSecret, String? bearer}) =>
      _answer('DELETE', uri, bearer, null, () {
        final segments = uri.pathSegments;
        if (segments.length == 3 && segments[1] == 'items') return _deleteItem(segments[2]) ? 204 : 404;
        final scope = uri.queryParameters['scope'];
        if (scope == 'profile' || scope == 'all') {
          _profile['addressing'] = null;
          _profile['items'] = <Object?>[];
        }
        for (final c in _characters) {
          if (scope == 'all' || (scope == 'character' && c['character'] == uri.queryParameters['character'])) {
            c['pinned'] = <Object?>[];
            c['facts'] = <Object?>[];
          }
        }
        return 204;
      });

  bool _deleteItem(String id) {
    var removed = false;
    bool match(Object? row) {
      final hit = row is Map && row['id'] == id;
      removed = removed || hit;
      return hit;
    }

    (_profile['items']! as List).removeWhere(match);
    for (final c in _characters) {
      (c['pinned']! as List).removeWhere(match);
      (c['facts']! as List).removeWhere(match);
    }
    return removed;
  }

  Future<GatewayHttpResponse> _answer(String method, Uri uri, String? bearer, Map<String, Object?>? body, int Function() apply) async {
    if (throwNetwork) throw const SocketException('down');
    calls.add('$method ${uri.path}${uri.hasQuery ? '?${uri.query}' : ''}');
    bearers.add(bearer);
    if (body != null) bodies.add(body);
    if (statuses.isNotEmpty) {
      return GatewayHttpResponse(statusCode: statuses.removeAt(0), body: const {'error': 'scripted'});
    }
    final status = apply();
    return GatewayHttpResponse(statusCode: status, body: status == 200 ? jsonDecode(jsonEncode(overview)) : null);
  }

  @override
  Future<GatewayHttpResponse> post(Uri uri, {required String appSecret, required Map<String, Object?> body, String? bearer}) =>
      throw UnimplementedError();

  @override
  Future<GatewayHttpResponse> patch(Uri uri, {required String appSecret, required String bearer, required Map<String, Object?> body}) =>
      throw UnimplementedError();

  @override
  Future<NativeSocket> openWebSocket(Uri uri) => throw UnimplementedError();
}

class FakeTokens implements DeviceTokenProvider {
  FakeTokens(this.current, {this.renewed});

  String? current;
  final String? renewed;
  int renewCalls = 0;

  @override
  Future<String?> token() async => current;

  @override
  Future<String?> renew() async {
    renewCalls++;
    if (renewed != null) current = renewed;
    return renewed;
  }
}

MemoryApi testMemoryApi(GatewayTransport transport, DeviceTokenProvider identity, {DiagSink? diag}) => MemoryApi(
  baseUri: Uri.parse('http://gw.test'),
  appSecret: 'secret-123456789',
  transport: transport,
  identity: identity,
  diag: diag ?? (_) {},
);
```

新建 `app/test/memory_api_test.dart`：

```dart
import 'package:avatar_app/memory/memory_api.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/memory_fakes.dart';

Matcher failedWith(String reason) => isA<MemoryFailed>().having((f) => f.reason, 'reason', reason);

void main() {
  late FakeMemoryTransport transport;
  late FakeTokens tokens;
  late List<String> lines;

  MemoryApi api() => testMemoryApi(transport, tokens, diag: lines.add);

  setUp(() {
    transport = FakeMemoryTransport();
    tokens = FakeTokens('device-token-0123456789', renewed: 'new-token-0123456789');
    lines = [];
  });

  test('overview reads every group with the device bearer', () async {
    final overview = (await api().overview() as MemoryOk<MemoryOverview>).value;
    expect(transport.calls, ['GET /memory']);
    expect(transport.bearers, ['device-token-0123456789']);
    expect(overview.addressing!.text, '王叔');
    expect(overview.profileItems.single.text, '家在天津');
    expect(overview.characters.map((c) => c.character), ['xiaonuan', 'xiaokai', 'xiaoxin']);
    final nuan = overview.forCharacter('xiaonuan')!;
    expect(nuan.pinned.single.text, '周三去医院复查');
    expect(nuan.pinned.single.sensitive, isTrue);
    expect(nuan.facts.map((f) => f.category), ['preference', 'health']);
    expect(nuan.facts.last.sensitive, isTrue);
    expect(overview.forCharacter('xiaokai')!.facts, isEmpty);
    expect(overview.forCharacter('lily'), isNull);
  });

  test('a missing addressing reads as null', () async {
    (transport.overview['profile']! as Map)['addressing'] = null;
    final overview = (await api().overview() as MemoryOk<MemoryOverview>).value;
    expect(overview.addressing, isNull);
  });

  test('a body that does not match the contract is a bad response', () async {
    transport.overview = {'profile': {'addressing': null, 'items': <Object?>[]}};
    expect(await api().overview(), failedWith('bad_response'));
    final badCategory = sampleOverviewJson();
    ((badCategory['characters']! as List).first['facts'] as List).first['category'] = 'secret';
    expect(MemoryOverview.fromJson(badCategory), isNull);
    final badPinned = sampleOverviewJson();
    ((badPinned['characters']! as List).first['pinned'] as List).first.remove('sensitive');
    expect(MemoryOverview.fromJson(badPinned), isNull);
    expect(MemoryOverview.fromJson('not a map'), isNull);
  });

  test('setAddressing PUTs the trimmed name and maps 409 and 400', () async {
    expect(await api().setAddressing('  老王 '), isA<MemoryOk<void>>());
    expect(transport.calls.last, 'PUT /memory/addressing');
    expect(transport.bodies.last, {'text': '老王'});
    transport.statuses.add(409);
    expect(await api().setAddressing('老王'), failedWith('declined'));
    transport.statuses.add(400);
    expect(await api().setAddressing('老王'), failedWith('rejected'));
  });

  test('setAddressing rejects empty and over-long names without a request', () async {
    expect(await api().setAddressing('   '), failedWith('rejected'));
    expect(await api().setAddressing('一' * 21), failedWith('rejected'));
    expect(transport.calls, isEmpty);
    expect(await api().setAddressing('一' * 20), isA<MemoryOk<void>>());
    expect(transport.calls, ['PUT /memory/addressing']);
  });

  test('deleteItem encodes the id and maps 404', () async {
    expect(await api().deleteItem('p1'), isA<MemoryOk<void>>());
    expect(transport.calls.last, 'DELETE /memory/items/p1');
    expect(await api().deleteItem('p1'), failedWith('not_found'));
    await api().deleteItem('a/b');
    expect(transport.calls.last, 'DELETE /memory/items/a%2Fb');
    expect(await api().deleteItem(''), failedWith('rejected'));
  });

  test('clear sends the scope and the character as query parameters', () async {
    await api().clear(MemoryClearScope.profile);
    await api().clear(MemoryClearScope.character, character: 'xiaokai');
    await api().clear(MemoryClearScope.all);
    expect(transport.calls, [
      'DELETE /memory?scope=profile',
      'DELETE /memory?scope=character&character=xiaokai',
      'DELETE /memory?scope=all',
    ]);
    expect(await api().clear(MemoryClearScope.character), failedWith('rejected'));
    expect(await api().clear(MemoryClearScope.all, character: 'xiaokai'), failedWith('rejected'));
    expect(transport.calls, hasLength(3));
  });

  test('a 401 renews the device token once and retries', () async {
    transport.statuses.add(401);
    expect(await api().overview(), isA<MemoryOk<MemoryOverview>>());
    expect(transport.bearers, ['device-token-0123456789', 'new-token-0123456789']);
    expect(tokens.renewCalls, 1);
  });

  test('a second 401, or a failed renew, is unauthorized', () async {
    transport.statuses.addAll([401, 401]);
    expect(await api().deleteItem('p1'), failedWith('unauthorized'));
    expect(transport.calls, hasLength(2));
    tokens = FakeTokens('device-token-0123456789'); // renew returns null
    transport.statuses.add(401);
    expect(await api().deleteItem('p1'), failedWith('unauthorized'));
    expect(transport.calls, hasLength(3));
  });

  test('network errors are reported, not thrown', () async {
    transport.throwNetwork = true;
    expect(await api().overview(), failedWith('network'));
    expect(await api().clear(MemoryClearScope.all), failedWith('network'));
  });

  test('diagnostics carry the operation and status only, never memory text', () async {
    await api().overview();
    await api().setAddressing('老王');
    expect(lines, [
      'anyidea.diag event=memory_api op=overview status=200',
      'anyidea.diag event=memory_api op=set_addressing status=204',
    ]);
    expect(lines.join(), isNot(contains('王')));
  });
}
```

Run: `cd app && flutter test test/memory_api_test.dart`
Expected: 编译失败（`app/lib/memory/` 不存在）。

- [x] **Step 4: 实现 `MemoryOverview` 和 `MemoryApi`**

新建 `app/lib/memory/memory_overview.dart`：

```dart
/// GET /memory body (overview contract C1). Lives only in widget state: never cached, stored or logged.
class MemoryItem {
  const MemoryItem({required this.id, required this.text});

  final String id;
  final String text;
}

class MemoryFactItem extends MemoryItem {
  const MemoryFactItem({required super.id, required super.text, required this.category, required this.sensitive});

  /// preference | person | health | other | safety
  final String category;
  final bool sensitive;
}

class MemoryPinnedItem extends MemoryItem {
  const MemoryPinnedItem({required super.id, required super.text, required this.sensitive});

  final bool sensitive;
}

class CharacterMemory {
  const CharacterMemory({required this.character, required this.pinned, required this.facts});

  final String character;

  /// Newest first (gateway order).
  final List<MemoryPinnedItem> pinned;
  final List<MemoryFactItem> facts;
}

class MemoryOverview {
  const MemoryOverview({required this.addressing, required this.profileItems, required this.characters});

  final MemoryItem? addressing;
  final List<MemoryItem> profileItems;
  final List<CharacterMemory> characters;

  CharacterMemory? forCharacter(String id) {
    for (final memory in characters) {
      if (memory.character == id) return memory;
    }
    return null;
  }

  /// Null when [raw] does not match the GET /memory shape; callers treat it as a bad response.
  static MemoryOverview? fromJson(Object? raw) {
    try {
      if (raw is! Map) return null;
      final profile = raw['profile'];
      final characters = raw['characters'];
      if (profile is! Map || characters is! List) return null;
      final addressing = profile['addressing'];
      final items = profile['items'];
      if (items is! List) return null;
      return MemoryOverview(
        addressing: addressing == null ? null : _item(addressing),
        profileItems: [for (final item in items) _item(item)],
        characters: [for (final entry in characters) _character(entry)],
      );
    } on FormatException {
      return null;
    }
  }
}

const _factCategories = {'preference', 'person', 'health', 'other', 'safety'};

MemoryItem _item(Object? raw) {
  if (raw is! Map) throw const FormatException('memory_item');
  final id = raw['id'];
  final text = raw['text'];
  if (id is! String || id.isEmpty || text is! String) throw const FormatException('memory_item');
  return MemoryItem(id: id, text: text);
}

bool _sensitive(Object? raw) {
  final value = (raw as Map)['sensitive'];
  if (value is! bool) throw const FormatException('memory_sensitive');
  return value;
}

MemoryPinnedItem _pinned(Object? raw) {
  final item = _item(raw);
  return MemoryPinnedItem(id: item.id, text: item.text, sensitive: _sensitive(raw));
}

MemoryFactItem _fact(Object? raw) {
  final item = _item(raw);
  final category = (raw as Map)['category'];
  if (category is! String || !_factCategories.contains(category)) throw const FormatException('memory_category');
  return MemoryFactItem(id: item.id, text: item.text, category: category, sensitive: _sensitive(raw));
}

CharacterMemory _character(Object? raw) {
  if (raw is! Map) throw const FormatException('memory_character');
  final character = raw['character'];
  final pinned = raw['pinned'];
  final facts = raw['facts'];
  if (character is! String || pinned is! List || facts is! List) throw const FormatException('memory_character');
  return CharacterMemory(
    character: character,
    pinned: [for (final item in pinned) _pinned(item)],
    facts: [for (final item in facts) _fact(item)],
  );
}
```

新建 `app/lib/memory/memory_api.dart`：

```dart
import 'dart:async';

import '../config.dart';
import '../diag_log.dart';
import '../native_gateway/gateway_client.dart';
import '../native_gateway/transports.dart';
import 'memory_overview.dart';

export 'memory_overview.dart';

enum MemoryClearScope { profile, character, all }

sealed class MemoryResult<T> {
  const MemoryResult();
}

final class MemoryOk<T> extends MemoryResult<T> {
  const MemoryOk(this.value);

  final T value;
}

final class MemoryFailed<T> extends MemoryResult<T> {
  const MemoryFailed(this.reason);

  /// `network`, `declined` (409), `rejected` (400 or bad input), `not_found` (404),
  /// `unauthorized` (401 after one renew), `bad_response`, or `http_<status>`.
  final String reason;
}

/// Addressing length limit (spec: 1–20). Same unit as the gateway's zod string length (UTF-16).
const addressingMaxLength = 20;

/// GET / PUT / DELETE /memory for the settings page. Keeps nothing between calls; logs no memory text.
class MemoryApi {
  MemoryApi({
    required this.baseUri,
    required this.appSecret,
    required this.transport,
    required this.identity,
    this.requestTimeout = AppConfig.gatewayRequestTimeout,
    this.diag = logcatDiagSink,
  });

  final Uri baseUri;
  final String appSecret;
  final GatewayTransport transport;
  final DeviceTokenProvider identity;
  final Duration requestTimeout;
  final DiagSink diag;

  Future<MemoryResult<MemoryOverview>> overview() async {
    final sent = await _send('overview', (bearer) => transport.get(_uri('/memory'), appSecret: appSecret, bearer: bearer));
    switch (sent) {
      case MemoryFailed(:final reason):
        return MemoryFailed(reason);
      case MemoryOk(value: final response):
        if (response.statusCode != 200) return MemoryFailed(_reason(response.statusCode));
        final overview = MemoryOverview.fromJson(response.body);
        return overview == null ? const MemoryFailed('bad_response') : MemoryOk(overview);
    }
  }

  Future<MemoryResult<void>> setAddressing(String text) async {
    final name = text.trim();
    if (name.isEmpty || name.length > addressingMaxLength) return const MemoryFailed('rejected');
    return _write(
      'set_addressing',
      (bearer) => transport.put(_uri('/memory/addressing'), appSecret: appSecret, body: {'text': name}, bearer: bearer),
    );
  }

  Future<MemoryResult<void>> deleteItem(String id) async {
    if (id.isEmpty) return const MemoryFailed('rejected');
    final uri = baseUri.replace(pathSegments: ['memory', 'items', id]);
    return _write('delete_item', (bearer) => transport.delete(uri, appSecret: appSecret, bearer: bearer));
  }

  /// [character] is required for [MemoryClearScope.character] and forbidden otherwise.
  Future<MemoryResult<void>> clear(MemoryClearScope scope, {String? character}) async {
    if ((scope == MemoryClearScope.character) != (character != null)) return const MemoryFailed('rejected');
    final uri = baseUri.replace(path: '/memory', queryParameters: {'scope': scope.name, 'character': ?character});
    return _write('clear_${scope.name}', (bearer) => transport.delete(uri, appSecret: appSecret, bearer: bearer));
  }

  Future<MemoryResult<void>> _write(String op, Future<GatewayHttpResponse> Function(String? bearer) request) async {
    final sent = await _send(op, request);
    return switch (sent) {
      MemoryFailed(:final reason) => MemoryFailed(reason),
      MemoryOk(value: final response) => response.statusCode == 204 || response.statusCode == 200
          ? const MemoryOk(null)
          : MemoryFailed(_reason(response.statusCode)),
    };
  }

  /// One request; after a 401, renew the device token once and retry (same as POST /session).
  Future<MemoryResult<GatewayHttpResponse>> _send(
    String op,
    Future<GatewayHttpResponse> Function(String? bearer) request,
  ) async {
    try {
      var response = await request(await identity.token()).timeout(requestTimeout);
      if (response.statusCode == 401) {
        final renewed = await identity.renew();
        if (renewed == null) {
          _log(op, 401);
          return const MemoryFailed('unauthorized');
        }
        response = await request(renewed).timeout(requestTimeout);
      }
      _log(op, response.statusCode);
      if (response.statusCode == 401) return const MemoryFailed('unauthorized');
      return MemoryOk(response);
    } on Exception {
      _log(op, 0);
      return const MemoryFailed('network');
    }
  }

  void _log(String op, int status) => diag(formatDiag('memory_api', {'op': op, 'status': status}));

  static String _reason(int status) => switch (status) {
    400 => 'rejected',
    401 => 'unauthorized',
    404 => 'not_found',
    409 => 'declined',
    _ => 'http_$status',
  };

  Uri _uri(String path) => baseUri.replace(path: path, query: null, queryParameters: null);
}
```

Run: `cd app && flutter test test/memory_api_test.dart`
Expected: PASS。

- [x] **Step 5: 写失败的测试：设置页四块**

新建 `app/test/companion_settings_page_test.dart`：

```dart
import 'package:avatar_app/identity/companion_settings_page.dart';
import 'package:avatar_app/identity/device_identity.dart';
import 'package:avatar_app/memory/memory_api.dart';
import 'package:avatar_app/memory/memory_copy.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/character_fixture.dart';
import 'support/memory_fakes.dart';

final catalog = loadTestCharacterCatalog();

MemoryApi api(FakeMemoryTransport transport) => testMemoryApi(transport, FakeTokens('device-token-0123456789'));

Widget page({MemoryApi? memory, VoidCallback? onMemoryChanged}) => MaterialApp(
  home: CompanionSettingsPage(
    options: catalog.options,
    currentCharacter: 'xiaoxin',
    onSaveCharacter: (_) async => const IdentityOk(),
    memory: memory,
    onMemoryChanged: onMemoryChanged,
  ),
);

Future<void> reveal(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(finder, 200);
  await tester.pumpAndSettle();
}

/// A tall screen keeps every block built and visible, so no test depends on scroll position.
Future<void> open(WidgetTester tester, Widget app) async {
  tester.view.physicalSize = const Size(800, 6000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(app);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('shows the four blocks in order, with every list and large text', (tester) async {
    await open(tester, page(memory: api(FakeMemoryTransport())));
    double y(Finder f) => tester.getTopLeft(f).dy;
    expect(y(find.text('选择陪伴角色')), lessThan(y(find.text('我的资料'))));
    expect(y(find.text('我的资料')), lessThan(y(find.text('小暖记得的事'))));
    expect(y(find.text('小暖记得的事')), lessThan(y(find.text('小凯记得的事'))));
    expect(y(find.text('小凯记得的事')), lessThan(y(find.text('小欣记得的事'))));
    expect(y(find.text('小欣记得的事')), lessThan(y(find.byKey(const Key('clear-all')))));
    for (final text in ['称呼：王叔', '家在天津', '周三去医院复查', '喜欢喝茉莉花茶', '有高血压', '爱听评书']) {
      expect(find.text(text), findsOneWidget, reason: text);
    }
    expect(find.text('钉住的事'), findsNWidgets(3));
    expect(find.text('其他记忆'), findsNWidgets(3));
    expect(find.text('清除我的基本资料'), findsOneWidget);
    expect(find.text('清除小暖的记忆'), findsOneWidget);
    expect(find.text('清除全部记忆'), findsOneWidget);
    expect(tester.widget<Text>(find.text('家在天津')).style!.fontSize, greaterThanOrEqualTo(18));
    expect(tester.widget<Text>(find.text('小暖记得的事')).style!.color, Colors.tealAccent);
    expect(tester.getSize(find.byKey(const Key('delete-p1'))).height, greaterThanOrEqualTo(60));
    expect(tester.getSize(find.byKey(const Key('clear-all'))).height, greaterThanOrEqualTo(60));
  });

  testWidgets('deleting an item asks first; cancel sends nothing; confirm deletes, reloads and reports once', (tester) async {
    final transport = FakeMemoryTransport();
    var changed = 0;
    await open(tester, page(memory: api(transport), onMemoryChanged: () => changed++));
    await reveal(tester, find.byKey(const Key('delete-n-fact')));
    await tester.tap(find.byKey(const Key('delete-n-fact')));
    await tester.pumpAndSettle();
    expect(find.text(deleteItemConfirm), findsOneWidget);
    expect(tester.widget<Text>(find.text(deleteItemConfirm)).style!.fontSize, greaterThanOrEqualTo(20));
    await tester.tap(find.byKey(const Key('memory-confirm-cancel')));
    await tester.pumpAndSettle();
    expect(transport.calls, ['GET /memory']);
    await tester.tap(find.byKey(const Key('delete-n-fact')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('memory-confirm-ok')));
    await tester.pumpAndSettle();
    expect(transport.calls, ['GET /memory', 'DELETE /memory/items/n-fact', 'GET /memory']);
    expect(find.text('喜欢喝茉莉花茶'), findsNothing);
    expect(changed, 1);
  });

  testWidgets('clearing one character uses the approved copy and leaves the others', (tester) async {
    final transport = FakeMemoryTransport();
    await open(tester, page(memory: api(transport)));
    await reveal(tester, find.byKey(const Key('clear-character-xiaonuan')));
    await tester.tap(find.byKey(const Key('clear-character-xiaonuan')));
    await tester.pumpAndSettle();
    expect(find.text('清除后，小暖会忘掉和您聊过的事，不能恢复。确定清除吗？'), findsOneWidget);
    expect(find.text('先不清除'), findsOneWidget);
    await tester.tap(find.text('确定清除'));
    await tester.pumpAndSettle();
    expect(transport.calls[1], 'DELETE /memory?scope=character&character=xiaonuan');
    expect(find.text('周三去医院复查'), findsNothing);
    await reveal(tester, find.text('爱听评书'));
    expect(find.text('爱听评书'), findsOneWidget);
  });

  testWidgets('clearing everything uses the approved copy', (tester) async {
    final transport = FakeMemoryTransport();
    await open(tester, page(memory: api(transport)));
    await reveal(tester, find.byKey(const Key('clear-all')));
    await tester.tap(find.byKey(const Key('clear-all')));
    await tester.pumpAndSettle();
    expect(find.text('清除后，所有伙伴都会忘掉和您聊过的事，也会忘掉您的基本资料，不能恢复。确定清除吗？'), findsOneWidget);
    await tester.tap(find.byKey(const Key('memory-confirm-ok')));
    await tester.pumpAndSettle();
    expect(transport.calls[1], 'DELETE /memory?scope=all');
    expect(find.text('爱听评书'), findsNothing);
    await reveal(tester, find.text('称呼：还没有'));
    expect(find.text('家在天津'), findsNothing);
  });

  testWidgets('clearing my profile removes the addressing and the basic facts', (tester) async {
    final transport = FakeMemoryTransport();
    await open(tester, page(memory: api(transport)));
    await reveal(tester, find.byKey(const Key('clear-profile')));
    await tester.tap(find.byKey(const Key('clear-profile')));
    await tester.pumpAndSettle();
    expect(find.text(clearProfileConfirm), findsOneWidget);
    await tester.tap(find.byKey(const Key('memory-confirm-ok')));
    await tester.pumpAndSettle();
    expect(transport.calls[1], 'DELETE /memory?scope=profile');
    await reveal(tester, find.text('称呼：还没有'));
    expect(find.text('家在天津'), findsNothing);
  });

  testWidgets('a failed delete keeps the lists and says so', (tester) async {
    final transport = FakeMemoryTransport();
    var changed = 0;
    await open(tester, page(memory: api(transport), onMemoryChanged: () => changed++));
    transport.statuses.add(500);
    await reveal(tester, find.byKey(const Key('delete-p1')));
    await tester.tap(find.byKey(const Key('delete-p1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('memory-confirm-ok')));
    await tester.pumpAndSettle();
    expect(tester.widget<Text>(find.byKey(const Key('memory-notice'))).data, '没删成功，请再试一次。');
    expect(find.text('家在天津'), findsOneWidget);
    expect(transport.calls, ['GET /memory', 'DELETE /memory/items/p1']);
    // The gateway already ended the session, so the chat restarts even on failure.
    expect(changed, 1);
  });

  testWidgets('editing the addressing saves the trimmed name', (tester) async {
    final transport = FakeMemoryTransport();
    var changed = 0;
    await open(tester, page(memory: api(transport), onMemoryChanged: () => changed++));
    await reveal(tester, find.byKey(const Key('addressing-edit')));
    await tester.tap(find.byKey(const Key('addressing-edit')));
    await tester.pumpAndSettle();
    expect(find.text('王叔'), findsOneWidget); // prefilled
    await tester.enterText(find.byKey(const Key('addressing-field')), '  老王 ');
    await tester.tap(find.byKey(const Key('addressing-save')));
    await tester.pumpAndSettle();
    expect(transport.bodies.single, {'text': '老王'});
    expect(find.text('称呼：老王'), findsOneWidget);
    expect(changed, 1);
  });

  testWidgets('an empty addressing is caught in the dialog', (tester) async {
    final transport = FakeMemoryTransport();
    await open(tester, page(memory: api(transport)));
    await reveal(tester, find.byKey(const Key('addressing-edit')));
    await tester.tap(find.byKey(const Key('addressing-edit')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('addressing-field')), '   ');
    await tester.tap(find.byKey(const Key('addressing-save')));
    await tester.pump();
    expect(find.text(addressingEmptyError), findsOneWidget);
    expect(transport.bodies, isEmpty);
    await tester.tap(find.byKey(const Key('addressing-cancel')));
    await tester.pumpAndSettle();
    expect(find.text('称呼：王叔'), findsOneWidget);
  });

  testWidgets('a phone that declined memory cannot save an addressing', (tester) async {
    final transport = FakeMemoryTransport();
    var changed = 0;
    await open(tester, page(memory: api(transport), onMemoryChanged: () => changed++));
    transport.statuses.add(409);
    await reveal(tester, find.byKey(const Key('addressing-edit')));
    await tester.tap(find.byKey(const Key('addressing-edit')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('addressing-field')), '老王');
    await tester.tap(find.byKey(const Key('addressing-save')));
    await tester.pumpAndSettle();
    expect(
      tester.widget<Text>(find.byKey(const Key('memory-notice'))).data,
      '您选了不让伙伴记事，所以不能保存称呼。想恢复的话，直接跟伙伴说「可以记住」就行。',
    );
    expect(find.text('称呼：王叔'), findsOneWidget);
    expect(changed, 1);
  });

  testWidgets('a failed load offers a retry', (tester) async {
    final transport = FakeMemoryTransport()..statuses.add(503);
    await open(tester, page(memory: api(transport)));
    await reveal(tester, find.byKey(const Key('memory-retry')));
    expect(find.text(memoryLoadFailedText), findsOneWidget);
    await tester.tap(find.byKey(const Key('memory-retry')));
    await tester.pumpAndSettle();
    await reveal(tester, find.text('家在天津'));
    expect(find.text('家在天津'), findsOneWidget);
  });

  testWidgets('without a memory api only the character block shows', (tester) async {
    await open(tester, page());
    expect(find.text('选择陪伴角色'), findsOneWidget);
    expect(find.text('我的资料'), findsNothing);
    expect(find.text('清除全部记忆'), findsNothing);
  });
}
```

Run: `cd app && flutter test test/companion_settings_page_test.dart`
Expected: 编译失败（`memory_copy.dart` 不存在，设置页没有 `memory` 参数）。

- [x] **Step 6: 实现文案、通用确认框和设置页**

新建 `app/lib/memory/memory_copy.dart`（附录 B 已有的照抄；其余是新写的，标在注释里，交用户审定）：

```dart
// Settings memory copy (spec 产品设计「设置页」, 附录 B). Never shown below 18 sp.

// From 附录 B.
const addressingDeclinedText = '您选了不让伙伴记事，所以不能保存称呼。想恢复的话，直接跟伙伴说「可以记住」就行。';
const deleteFailedText = '没删成功，请再试一次。';
String clearCharacterConfirm(String name) => '清除后，$name会忘掉和您聊过的事，不能恢复。确定清除吗？';
const clearAllConfirm = '清除后，所有伙伴都会忘掉和您聊过的事，也会忘掉您的基本资料，不能恢复。确定清除吗？';
const clearCancel = '先不清除';
const clearOk = '确定清除';

// Section titles and buttons (spec 设置页 tree).
const profileSectionTitle = '我的资料';
String characterMemoryTitle(String name) => '$name记得的事';
const pinnedTitle = '钉住的事';
const otherMemoryTitle = '其他记忆';
const clearProfileLabel = '清除我的基本资料';
String clearCharacterLabel(String name) => '清除$name的记忆';
const clearAllLabel = '清除全部记忆';

// New in this task (pending user review).
const addressingLabel = '称呼';
const addressingEmpty = '还没有';
const addressingEditLabel = '修改称呼';
const addressingDialogTitle = '您希望伙伴怎么称呼您？';
const addressingHint = '比如：王叔、李阿姨';
const addressingEmptyError = '称呼不能是空的';
const addressingRejectedText = '这个称呼存不了，请换一个说法。';
const saveFailedText = '没保存成功，请再试一次。';
const profileItemsEmpty = '还没有基本资料';
const memoryListEmpty = '还没有';
const clearProfileConfirm = '清除后，所有伙伴都会忘掉您的称呼和基本资料，不能恢复。确定清除吗？';
const deleteItemConfirm = '删除这一条吗？相关聊天原话会一起删除，不能恢复。';
const deleteLabel = '删除';
const deleteCancel = '先不删';
const deleteOk = '确定删除';
const memoryLoadFailedText = '记得的事暂时打不开，请稍后再试。';
const memoryRetry = '重试';
const dialogCancel = '取消';
const dialogSave = '保存';
```

把 `app/lib/avatar_engine/ui/engine_confirm_dialog.dart` 整体替换为（`confirmEngineSwitch` 的文字、字号、key 都不变）：

```dart
import 'package:flutter/material.dart';

import '../avatar_engine.dart';
import 'engine_copy.dart';

/// Large two-button confirm (title 24 sp, body and buttons 20 sp, 60 dp buttons). True = [ok].
Future<bool> confirmLarge(
  BuildContext context, {
  String? title,
  required String body,
  required String cancel,
  required String ok,
  Key cancelKey = const Key('confirm-cancel'),
  Key okKey = const Key('confirm-ok'),
}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (dialog) => AlertDialog(
      title: title == null ? null : Text(title, style: const TextStyle(fontSize: 24)),
      content: Text(body, style: const TextStyle(fontSize: 20)),
      actions: [
        SizedBox(
          height: 60,
          child: TextButton(
            key: cancelKey,
            onPressed: () => Navigator.of(dialog).pop(false),
            child: Text(cancel, style: const TextStyle(fontSize: 20)),
          ),
        ),
        SizedBox(
          height: 60,
          child: FilledButton(
            key: okKey,
            onPressed: () => Navigator.of(dialog).pop(true),
            child: Text(ok, style: const TextStyle(fontSize: 20)),
          ),
        ),
      ],
    ),
  );
  return result ?? false;
}

/// Switching ends the current chat, so it always asks first. True = switch now.
Future<bool> confirmEngineSwitch(BuildContext context, AvatarEngineKind target) => confirmLarge(
  context,
  title: confirmTitle(target),
  body: confirmBody,
  cancel: confirmCancel,
  ok: confirmOk,
  cancelKey: const Key('engine-confirm-cancel'),
  okKey: const Key('engine-confirm-ok'),
);
```

把 `app/lib/identity/companion_settings_page.dart` 整体替换为：

```dart
import 'dart:async';

import 'package:flutter/material.dart';

import '../avatar_engine/ui/engine_confirm_dialog.dart';
import '../memory/memory_api.dart';
import '../memory/memory_copy.dart';
import 'character_availability.dart';
import 'character_picker_page.dart';
import 'characters.dart';
import 'device_identity.dart';

/// Settings: pick the companion; see and delete what the companions remember.
/// Pops with the newly saved character id, or null. Memory lists live only in this page's state.
class CompanionSettingsPage extends StatefulWidget {
  const CompanionSettingsPage({
    super.key,
    required this.options,
    required this.currentCharacter,
    required this.onSaveCharacter,
    this.availabilityOf = everyCharacterAvailable,
    this.availabilityChanges,
    this.memory,
    this.onMemoryChanged,
  });

  final List<CharacterOption> options;
  final String currentCharacter;
  final Future<IdentityResult> Function(String id) onSaveCharacter;
  final CharacterAvailability Function(CharacterOption option) availabilityOf;

  /// Rebuilds the cards while a model is being prepared (the EngineSwitchController).
  final Listenable? availabilityChanges;

  /// Null hides the memory blocks (dev builds and tests without a gateway).
  final MemoryApi? memory;

  /// Called after every successful memory write; the shell restarts the chat.
  final VoidCallback? onMemoryChanged;

  @override
  State<CompanionSettingsPage> createState() => _CompanionSettingsPageState();
}

class _CompanionSettingsPageState extends State<CompanionSettingsPage> {
  late String _selected = widget.currentCharacter;
  bool _busy = false;
  String? _error;

  MemoryOverview? _overview;
  bool _loadingMemory = false;
  bool _loadFailed = false;
  bool _writing = false;
  String? _memoryNotice;

  @override
  void initState() {
    super.initState();
    if (widget.memory != null) unawaited(_loadMemory());
  }

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

  Future<void> _loadMemory() async {
    final api = widget.memory;
    if (api == null) return;
    setState(() {
      _loadingMemory = true;
      _loadFailed = false;
    });
    final result = await api.overview();
    if (!mounted) return;
    setState(() {
      _loadingMemory = false;
      switch (result) {
        case MemoryOk(:final value):
          _overview = value;
        case MemoryFailed():
          _loadFailed = true;
      }
    });
  }

  /// One write. The gateway ends the live session before any write is validated, so the shell
  /// restarts the chat after every attempt. Success reloads; failure keeps the lists and says so.
  Future<void> _run(
    Future<MemoryResult<void>> Function(MemoryApi api) write, {
    String Function(String reason)? failureText,
  }) async {
    final api = widget.memory;
    if (api == null || _writing) return;
    setState(() {
      _writing = true;
      _memoryNotice = null;
    });
    final result = await write(api);
    if (!mounted) return;
    widget.onMemoryChanged?.call();
    switch (result) {
      case MemoryOk():
        setState(() => _writing = false);
        await _loadMemory();
      case MemoryFailed(:final reason):
        setState(() {
          _writing = false;
          _memoryNotice = failureText?.call(reason) ?? deleteFailedText;
        });
    }
  }

  /// Every deletion asks first (spec): large dialog, then the write.
  Future<void> _confirmThen(String body, String cancel, String ok, Future<MemoryResult<void>> Function(MemoryApi api) write) async {
    if (_writing) return;
    final confirmed = await confirmLarge(
      context,
      body: body,
      cancel: cancel,
      ok: ok,
      cancelKey: const Key('memory-confirm-cancel'),
      okKey: const Key('memory-confirm-ok'),
    );
    if (!confirmed || !mounted) return;
    await _run(write);
  }

  Future<void> _editAddressing(MemoryItem? current) async {
    if (_writing) return;
    final name = await showDialog<String>(
      context: context,
      builder: (_) => _AddressingDialog(initial: current?.text ?? ''),
    );
    if (name == null || !mounted) return;
    await _run(
      (api) => api.setAddressing(name),
      failureText: (reason) => switch (reason) {
        'declined' => addressingDeclinedText,
        'rejected' => addressingRejectedText,
        _ => saveFailedText,
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final message = _error ?? _memoryNotice;
    return Scaffold(
      backgroundColor: const Color(0xFF10131A),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('聊天伙伴设置', style: TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Expanded(
                child: ListView(
                  children: [
                    _header('选择陪伴角色'),
                    _cards(),
                    ..._memoryBlocks(),
                  ],
                ),
              ),
              if (message != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8, bottom: 12),
                  child: Text(
                    message,
                    key: Key(_error != null ? 'companion-error' : 'memory-notice'),
                    style: const TextStyle(color: Colors.amberAccent, fontSize: 18),
                  ),
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

  Widget _cards() {
    Widget list() => CharacterCardList(
      options: widget.options,
      selected: _selected,
      availabilityOf: widget.availabilityOf,
      enabled: !_busy,
      gap: 12,
      onSelect: (id) => setState(() => _selected = id),
    );
    final changes = widget.availabilityChanges;
    return changes == null ? list() : ListenableBuilder(listenable: changes, builder: (_, _) => list());
  }

  List<Widget> _memoryBlocks() {
    if (widget.memory == null) return const [];
    final overview = _overview;
    if (overview == null) {
      if (!_loadFailed) {
        return const [Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()))];
      }
      return [
        const SizedBox(height: 16),
        const Text(memoryLoadFailedText, style: TextStyle(color: Colors.amberAccent, fontSize: 18)),
        const SizedBox(height: 8),
        SizedBox(
          height: 60,
          child: OutlinedButton(
            key: const Key('memory-retry'),
            onPressed: _loadingMemory ? null : () => unawaited(_loadMemory()),
            child: const Text(memoryRetry, style: TextStyle(fontSize: 20)),
          ),
        ),
      ];
    }
    return [
      _header(profileSectionTitle),
      _addressingRow(overview.addressing),
      for (final item in overview.profileItems) _itemRow(item),
      if (overview.profileItems.isEmpty) _emptyLine(profileItemsEmpty),
      _actionButton(
        key: const Key('clear-profile'),
        label: clearProfileLabel,
        onPressed: () => unawaited(_confirmThen(clearProfileConfirm, clearCancel, clearOk, (api) => api.clear(MemoryClearScope.profile))),
      ),
      for (final option in widget.options) ..._characterBlock(option, overview.forCharacter(option.id)),
      const SizedBox(height: 24),
      _actionButton(
        key: const Key('clear-all'),
        label: clearAllLabel,
        danger: true,
        onPressed: () => unawaited(_confirmThen(clearAllConfirm, clearCancel, clearOk, (api) => api.clear(MemoryClearScope.all))),
      ),
    ];
  }

  List<Widget> _characterBlock(CharacterOption option, CharacterMemory? memory) {
    final pinned = memory?.pinned ?? const <MemoryPinnedItem>[];
    final facts = memory?.facts ?? const <MemoryFactItem>[];
    return [
      _header(characterMemoryTitle(option.title)),
      _subheader(pinnedTitle),
      for (final item in pinned) _itemRow(item),
      if (pinned.isEmpty) _emptyLine(memoryListEmpty),
      _subheader(otherMemoryTitle),
      for (final item in facts) _itemRow(item),
      if (facts.isEmpty) _emptyLine(memoryListEmpty),
      _actionButton(
        key: Key('clear-character-${option.id}'),
        label: clearCharacterLabel(option.title),
        onPressed: () => unawaited(_confirmThen(
          clearCharacterConfirm(option.title),
          clearCancel,
          clearOk,
          (api) => api.clear(MemoryClearScope.character, character: option.id),
        )),
      ),
    ];
  }

  Widget _addressingRow(MemoryItem? addressing) => Row(
    children: [
      Expanded(
        child: Text(
          '$addressingLabel：${addressing?.text ?? addressingEmpty}',
          style: const TextStyle(color: Colors.white, fontSize: 20),
        ),
      ),
      SizedBox(
        height: 60,
        child: TextButton(
          key: const Key('addressing-edit'),
          style: TextButton.styleFrom(minimumSize: const Size(96, 60)),
          onPressed: _writing ? null : () => unawaited(_editAddressing(addressing)),
          child: const Text(addressingEditLabel, style: TextStyle(fontSize: 20)),
        ),
      ),
    ],
  );

  Widget _itemRow(MemoryItem item) => Padding(
    padding: const EdgeInsets.only(bottom: 4),
    child: Row(
      children: [
        Expanded(child: Text(item.text, style: const TextStyle(color: Colors.white, fontSize: 20))),
        SizedBox(
          height: 60,
          child: TextButton(
            key: Key('delete-${item.id}'),
            style: TextButton.styleFrom(minimumSize: const Size(72, 60)),
            onPressed: _writing
                ? null
                : () => unawaited(_confirmThen(deleteItemConfirm, deleteCancel, deleteOk, (api) => api.deleteItem(item.id))),
            child: const Text(deleteLabel, style: TextStyle(fontSize: 20)),
          ),
        ),
      ],
    ),
  );

  Widget _actionButton({required Key key, required String label, required VoidCallback onPressed, bool danger = false}) =>
      Padding(
        padding: const EdgeInsets.only(top: 12),
        child: SizedBox(
          height: 60,
          child: OutlinedButton(
            key: key,
            style: OutlinedButton.styleFrom(
              foregroundColor: danger ? Colors.redAccent : Colors.white,
              side: BorderSide(color: danger ? Colors.redAccent : Colors.white38),
            ),
            onPressed: _writing ? null : onPressed,
            child: Text(label, style: const TextStyle(fontSize: 20)),
          ),
        ),
      );

  static Widget _header(String text) => Padding(
    padding: const EdgeInsets.only(top: 20, bottom: 12),
    child: Text(text, style: const TextStyle(color: Colors.tealAccent, fontSize: 19, fontWeight: FontWeight.bold)),
  );

  static Widget _subheader(String text) => Padding(
    padding: const EdgeInsets.only(top: 8, bottom: 4),
    child: Text(text, style: const TextStyle(color: Colors.white70, fontSize: 18, fontWeight: FontWeight.bold)),
  );

  static Widget _emptyLine(String text) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Text(text, style: const TextStyle(color: Colors.white54, fontSize: 18)),
  );
}

/// Edits the addressing: 1–20 characters, large text. Pops with the trimmed name, or null.
class _AddressingDialog extends StatefulWidget {
  const _AddressingDialog({required this.initial});

  final String initial;

  @override
  State<_AddressingDialog> createState() => _AddressingDialogState();
}

class _AddressingDialogState extends State<_AddressingDialog> {
  late final _controller = TextEditingController(text: widget.initial);
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final name = _controller.text.trim();
    if (name.isEmpty) {
      setState(() => _error = addressingEmptyError);
      return;
    }
    Navigator.of(context).pop(name);
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text(addressingDialogTitle, style: TextStyle(fontSize: 24)),
    content: TextField(
      key: const Key('addressing-field'),
      controller: _controller,
      autofocus: true,
      maxLength: addressingMaxLength,
      style: const TextStyle(fontSize: 22),
      decoration: InputDecoration(
        hintText: addressingHint,
        hintStyle: const TextStyle(fontSize: 20),
        errorText: _error,
        errorStyle: const TextStyle(fontSize: 18),
        counterStyle: const TextStyle(fontSize: 18),
      ),
      onSubmitted: (_) => _submit(),
    ),
    actions: [
      SizedBox(
        height: 60,
        child: TextButton(
          key: const Key('addressing-cancel'),
          onPressed: () => Navigator.of(context).pop(),
          child: const Text(dialogCancel, style: TextStyle(fontSize: 20)),
        ),
      ),
      SizedBox(
        height: 60,
        child: FilledButton(
          key: const Key('addressing-save'),
          onPressed: _submit,
          child: const Text(dialogSave, style: TextStyle(fontSize: 20)),
        ),
      ),
    ],
  );
}
```

Run: `cd app && flutter test test/companion_settings_page_test.dart test/companion_picker_test.dart test/engine_ui_test.dart`
Expected: PASS。

- [x] **Step 7: 写失败的测试，再接入 AppShell 和 main**

`app/test/app_shell_test.dart`（Task 14 版本）：
1. import 区加：
   ```dart
   import 'package:avatar_app/memory/memory_api.dart';
   import 'support/memory_fakes.dart';
   ```
2. `app()` 替换为：
   ```dart
   Widget app(DeviceIdentity identity, {EngineSwitchController? engines, MemoryApi? memory}) => MaterialApp(
     home: AppShell(
       identity: identity,
       catalog: catalog,
       engines: engines,
       memory: memory,
       avatarBuilder: (request) {
         lastRequest = request;
         return Scaffold(
           key: request.key,
           body: Text(request.engine == AvatarEngineKind.duix ? 'DUIX-${request.character.id}' : 'AVATAR-${request.character.id}'),
         );
       },
     ),
   );
   ```
3. `main()` 末尾追加：
   ```dart
   testWidgets('a memory change stops the chat under settings and restarts it on return', (tester) async {
     final store = MemoryCredentialStore(returning('xiaoxin'));
     final identity = DeviceIdentity(store: store, backend: FakeBackend());
     final transport = FakeMemoryTransport();
     await tester.pumpWidget(app(identity, memory: testMemoryApi(transport, identity)));
     await tester.pumpAndSettle();
     expect(pageKey(), 'avatar-xiaoxin-0');
     await tester.tap(find.byKey(const Key('settings')));
     await tester.pumpAndSettle();
     expect(find.text('AVATAR-xiaoxin', skipOffstage: false), findsOneWidget);
     await tester.scrollUntilVisible(find.byKey(const Key('delete-p1')), 200);
     await tester.tap(find.byKey(const Key('delete-p1')));
     await tester.pumpAndSettle();
     await tester.tap(find.byKey(const Key('memory-confirm-ok')));
     await tester.pumpAndSettle();
     expect(transport.bearers.first, 'device-token-0123456789');
     expect(find.text('AVATAR-xiaoxin', skipOffstage: false), findsNothing);
     await tester.tap(find.byKey(const Key('companion-cancel')));
     await tester.pumpAndSettle();
     expect(find.text('AVATAR-xiaoxin'), findsOneWidget);
     expect(pageKey(), 'avatar-xiaoxin-1');
   });

   testWidgets('settings without a memory change keeps the same chat page', (tester) async {
     final store = MemoryCredentialStore(returning('xiaoxin'));
     final identity = DeviceIdentity(store: store, backend: FakeBackend());
     await tester.pumpWidget(app(identity, memory: testMemoryApi(FakeMemoryTransport(), identity)));
     await tester.pumpAndSettle();
     await tester.tap(find.byKey(const Key('settings')));
     await tester.pumpAndSettle();
     await tester.tap(find.byKey(const Key('companion-cancel')));
     await tester.pumpAndSettle();
     expect(pageKey(), 'avatar-xiaoxin-0');
   });
   ```

Run: `cd app && flutter test test/app_shell_test.dart`
Expected: 编译失败（`AppShell` 没有 `memory` 参数）。

`app/lib/identity/app_shell.dart`（Task 14 版本）：
1. import 区加 `import '../memory/memory_api.dart';`
2. `AppShell` 构造函数加 `this.memory,`，字段加：
   ```dart
   /// Settings reads and deletes memory through it; null hides the memory blocks.
   final MemoryApi? memory;
   ```
3. `_AppShellState` 字段区加：
   ```dart
   /// A memory write ended the gateway session; keep no chat page under settings until it closes.
   bool _suspended = false;
   ```
4. 加方法：
   ```dart
   void _onMemoryChanged() {
     if (!mounted || _suspended) return;
     setState(() {
       _suspended = true;
       _pageEpoch++;
     });
   }
   ```
5. `_openSettings` 整体替换为：
   ```dart
   Future<void> _openSettings() async {
     final current = _character;
     if (current == null) return;
     final saved = await Navigator.of(context).push<String>(
       MaterialPageRoute(
         builder: (_) => CompanionSettingsPage(
           options: widget.catalog.options,
           currentCharacter: current,
           onSaveCharacter: _saveFromSettings,
           availabilityOf: _availabilityOf,
           availabilityChanges: widget.engines,
           memory: widget.memory,
           onMemoryChanged: _onMemoryChanged,
         ),
       ),
     );
     if (!mounted) return;
     setState(() {
       if (saved != null && saved != _character) {
         _character = saved;
         _pageEpoch++;
       }
       _suspended = false; // the new epoch (bumped on the memory change) starts a fresh session
     });
   }
   ```
6. `_home` 里 `Positioned.fill(child: widget.avatarBuilder(...))` 改为：
   ```dart
      Positioned.fill(
        child: _suspended
            ? const ColoredBox(color: Color(0xFF10131A))
            : widget.avatarBuilder(
                AvatarPageRequest(
                  key: ValueKey('avatar-${character.id}-$_pageEpoch'),
                  identity: widget.identity,
                  character: character,
                  engine: character.engine,
                  onEngineFailure: character.engine == AvatarEngineKind.duix
                      ? (failure) => _onEngineFailure(character, failure)
                      : null,
                  onUnknownCharacter: _onUnknownCharacter,
                ),
              ),
      ),
   ```

`app/lib/main.dart`（Task 14 版本）：
1. import 区加 `import 'memory/memory_api.dart';`
2. `_HomeState` 里 `_identity` 下面加：
   ```dart
   late final _memory = MemoryApi(
     baseUri: Uri.parse(AppConfig.gatewayUrl),
     appSecret: AppConfig.appSecret,
     transport: const IoGatewayTransport(),
     identity: _identity,
   );
   ```
3. `build` 里的 `AppShell(` 加参数 `memory: _memory,`

Run: `cd app && flutter test test/app_shell_test.dart`
Expected: PASS。

- [x] **Step 8: 全量验证**

```bash
cd app
grep -rnE "debugPrint|print\(|logcatDiagSink\(" lib/memory lib/identity/companion_settings_page.dart
flutter test
flutter analyze
```

Expected：`grep` 没有输出（记忆相关代码只通过 `MemoryApi._log` 记 op 和状态码）；`flutter test` 全部 PASS；`flutter analyze` 输出 `No issues found!`。

- [x] **Step 9: 提交**

勾选本文件已完成的步骤，然后：

```bash
git add app/lib/memory/memory_overview.dart app/lib/memory/memory_api.dart app/lib/memory/memory_copy.dart \
  app/lib/native_gateway/transports.dart app/lib/identity/credential_store.dart \
  app/lib/identity/secure_credential_store.dart app/lib/avatar_engine/ui/engine_confirm_dialog.dart \
  app/lib/identity/companion_settings_page.dart app/lib/identity/app_shell.dart app/lib/main.dart \
  app/test/support/memory_fakes.dart app/test/support/identity_fakes.dart \
  app/test/memory_api_test.dart app/test/companion_settings_page_test.dart app/test/credential_store_test.dart \
  app/test/secure_credential_store_test.dart app/test/native_gateway_transport_test.dart \
  app/test/native_gateway_client_test.dart app/test/identity_api_test.dart app/test/app_shell_test.dart \
  docs/superpowers/plans/2026-10-26-multi-character/15-t15-app-memory-settings.md
git commit -m "feat(app): show and delete each companion's memories in settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收清单

- [x] `GatewayTransport` 有 `get` / `put` / `delete`；GET、DELETE 不发 body；204 空响应读成 null；DELETE 保留 query。
- [x] `CredentialStore.delete` 在三个实现里都有，测试覆盖。
- [x] `MemoryApi`：401 时 renew 后只重试一次；renew 失败或二次 401 返回 `unauthorized`；409 → `declined`；400 → `rejected`；404 → `not_found`；body 不符合 C1 → `bad_response`；网络异常不抛出。
- [x] 称呼本地先校验（去空白后 1–20 字），不合格不发请求。
- [x] 设置页顺序：选择陪伴角色 → 我的资料 → 小暖 / 小凯 / 小欣记得的事（各有「钉住的事」「其他记忆」两栏，含健康类）→ 清除全部记忆。
- [x] 所有删除和清除都先弹大字确认框（正文 20sp，按钮 60dp），清除某个角色和清除全部用附录 B 的原文。
- [x] 删除失败显示「没删成功，请再试一次。」且列表不变、不通知 AppShell；称呼被拒（409）显示附录 B 原文。
- [x] 每次写请求返回后（无论成功失败）都调用 `onMemoryChanged`，因为网关在校验前就已结束会话：AppShell 立刻移除聊天页（释放会话和麦克风）并 bump epoch，设置页关闭后用新 key 重开会话；没有改动时页面 key 不变。
- [x] 记忆列表只在页面 state 里，不写 `CredentialStore`、不写文件；日志只有 `event=memory_api op=<op> status=<code>`。
- [x] 文字 ≥18sp，标题 26 粗体，区块标题 tealAccent 19 粗体，按钮 ≥60dp（主按钮 64 / 22sp）。
- [x] `cd app && flutter test` 全绿；`flutter analyze` 无问题。
