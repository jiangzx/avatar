import 'dart:async';
import 'dart:convert';
import 'dart:io';

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
  Future<GatewayHttpResponse> post(Uri uri, {required String appSecret, required Map<String, Object?> body});
  Future<NativeSocket> openWebSocket(Uri uri);
}

class IoGatewayTransport implements GatewayTransport {
  const IoGatewayTransport();

  @override
  Future<GatewayHttpResponse> post(Uri uri, {required String appSecret, required Map<String, Object?> body}) async {
    final client = HttpClient();
    try {
      final request = await client.postUrl(uri);
      request.headers.contentType = ContentType.json;
      request.headers.set('x-app-secret', appSecret);
      request.add(utf8.encode(jsonEncode(body)));
      final response = await request.close();
      final text = await utf8.decoder.bind(response).join();
      Object? decoded;
      try {
        decoded = jsonDecode(text);
      } on FormatException {
        decoded = null;
      }
      return GatewayHttpResponse(statusCode: response.statusCode, body: decoded);
    } finally {
      client.close(force: true);
    }
  }

  @override
  Future<NativeSocket> openWebSocket(Uri uri) async => _IoNativeSocket(await WebSocket.connect(uri.toString()));
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
