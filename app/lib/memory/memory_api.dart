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

/// Addressing length limit (spec: 1–20). Counted in Unicode code points, like the
/// gateway's zod schema; the text field's own maxLength counts grapheme clusters.
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
    if (name.isEmpty || name.runes.length > addressingMaxLength) return const MemoryFailed('rejected');
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
