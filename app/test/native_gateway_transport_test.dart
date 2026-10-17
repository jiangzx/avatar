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
          request.uri.path,
          request.headers.value('x-app-secret'),
          request.headers.value(HttpHeaders.authorizationHeader),
          jsonDecode(text),
        ),
      );
      request.response
        ..statusCode = 201
        ..headers.contentType = ContentType.json
        ..write('{"ok":true}');
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
}
