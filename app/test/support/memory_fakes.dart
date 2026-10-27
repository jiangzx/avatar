import 'dart:async';
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

  /// `<METHOD> <path>[?query]` per request, e.g. `DELETE /memory?scope=all`.
  final calls = <String>[];
  final bearers = <String?>[];
  final bodies = <Map<String, Object?>>[];

  /// Answered first, in order, instead of the normal behaviour.
  final statuses = <int>[];
  bool throwNetwork = false;

  /// When set, write requests (non-GET) wait for it before answering.
  Completer<void>? writeGate;

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
    final gate = writeGate;
    if (method != 'GET' && gate != null) await gate.future;
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
