import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../config.dart';

class GatewayHttpResponse {
  const GatewayHttpResponse({required this.statusCode, required this.body});

  final int statusCode;
  final Object? body;
}

abstract interface class NativeSocket {
  Stream<Object> get messages;
  void send(Object data);
  Future<void> close([int? code]);
}

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
  Future<NativeSocket> openWebSocket(Uri uri);
}

class IoGatewayTransport implements GatewayTransport {
  const IoGatewayTransport();

  @override
  Future<GatewayHttpResponse> post(
    Uri uri, {
    required String appSecret,
    required Map<String, Object?> body,
    String? bearer,
  }) => _send('POST', uri, appSecret: appSecret, body: body, bearer: bearer);

  @override
  Future<GatewayHttpResponse> patch(
    Uri uri, {
    required String appSecret,
    required String bearer,
    required Map<String, Object?> body,
  }) => _send('PATCH', uri, appSecret: appSecret, body: body, bearer: bearer);

  Future<GatewayHttpResponse> _send(
    String method,
    Uri uri, {
    required String appSecret,
    required Map<String, Object?> body,
    String? bearer,
  }) async {
    final client = HttpClient();
    try {
      final request = await client
          .openUrl(method, uri)
          .timeout(AppConfig.gatewayRequestTimeout);
      request.headers.contentType = ContentType.json;
      request.headers.set('x-app-secret', appSecret);
      if (bearer != null) {
        request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $bearer');
      }
      request.add(utf8.encode(jsonEncode(body)));
      final response = await request.close().timeout(
        AppConfig.gatewayRequestTimeout,
      );
      final text = await utf8.decoder
          .bind(response)
          .join()
          .timeout(AppConfig.gatewayRequestTimeout);
      Object? decoded;
      try {
        decoded = jsonDecode(text);
      } on FormatException {
        decoded = null;
      }
      return GatewayHttpResponse(
        statusCode: response.statusCode,
        body: decoded,
      );
    } finally {
      client.close(force: true);
    }
  }

  @override
  Future<NativeSocket> openWebSocket(Uri uri) async => _IoNativeSocket(
    await WebSocket.connect(uri.toString())
        .timeout(AppConfig.gatewaySocketTimeout),
  );
}

class _IoNativeSocket implements NativeSocket {
  const _IoNativeSocket(this._socket);

  final WebSocket _socket;

  @override
  Stream<Object> get messages => _socket.map<Object>((event) => event);

  @override
  void send(Object data) => _socket.add(data);

  @override
  Future<void> close([int? code]) async {
    await _socket.close(code);
  }
}
