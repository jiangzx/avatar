import 'dart:convert';
import 'dart:io';

import 'package:avatar_app/native_gateway/transports.dart';
import 'package:flutter_test/flutter_test.dart';

class SeenRequest {
  const SeenRequest(
    this.method,
    this.path,
    this.secret,
    this.authorization,
    this.body,
  );

  final String method;
  final String path;
  final String? secret;
  final String? authorization;
  final Object? body;
}

void main() {
  late HttpServer server;
  late List<SeenRequest> seen;
  const transport = IoGatewayTransport();

  setUp(() async {
    seen = [];
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
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
  });

  tearDown(() => server.close(force: true));

  Uri at(String path) => Uri.parse('http://127.0.0.1:${server.port}$path');

  test(
    'post sends the app secret and no authorization header without a bearer',
    () async {
      final res = await transport.post(
        at('/session'),
        appSecret: 'secret-123456789',
        body: const {},
      );
      expect(res.statusCode, 201);
      expect(res.body, {'ok': true});
      expect(seen.single.method, 'POST');
      expect(seen.single.secret, 'secret-123456789');
      expect(seen.single.authorization, isNull);
    },
  );

  test('post adds the bearer header when given', () async {
    await transport.post(
      at('/session'),
      appSecret: 'secret-123456789',
      body: const {},
      bearer: 'device-token-0123456789',
    );
    expect(seen.single.authorization, 'Bearer device-token-0123456789');
  });

  test('patch sends PATCH with the bearer and a JSON body', () async {
    final res = await transport.patch(
      at('/agent/style'),
      appSecret: 'secret-123456789',
      bearer: 'device-token-0123456789',
      body: const {'style': 'old-friend'},
    );
    expect(res.statusCode, 201);
    expect(seen.single.method, 'PATCH');
    expect(seen.single.path, '/agent/style');
    expect(seen.single.authorization, 'Bearer device-token-0123456789');
    expect(seen.single.body, {'style': 'old-friend'});
  });

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
}
