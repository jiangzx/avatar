import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:avatar_app/local_asset_server.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('resolveAssetPath', () {
    test('maps token-prefixed paths to asset keys', () {
      expect(resolveAssetPath('/tok/', 'tok'), 'index.html');
      expect(resolveAssetPath('/tok/assets/main.js', 'tok'), 'assets/main.js');
    });
    test('rejects wrong tokens and traversal', () {
      expect(resolveAssetPath('/other/index.html', 'tok'), isNull);
      expect(resolveAssetPath('/tok/../secret', 'tok'), isNull);
      expect(resolveAssetPath('/tok/a/%2e%2e/b', 'tok'), isNull);
      expect(resolveAssetPath('/tok/a//b', 'tok'), isNull);
      expect(resolveAssetPath('/tok/a\\b', 'tok'), isNull);
    });
  });

  test('content types cover the web bundle', () {
    expect(contentTypeFor('index.html').mimeType, 'text/html');
    expect(contentTypeFor('a.js').mimeType, 'application/javascript');
    expect(contentTypeFor('a.mjs').mimeType, 'application/javascript');
    expect(contentTypeFor('ort.wasm').mimeType, 'application/wasm');
    expect(contentTypeFor('m.glb').mimeType, 'model/gltf-binary');
    expect(contentTypeFor('x.onnx').mimeType, 'application/octet-stream');
  });

  group('LocalAssetServer', () {
    late LocalAssetServer server;
    final files = {'assets/web/index.html': '<h1>hi</h1>', 'assets/web/vad/m.wasm': 'wasm'};

    setUp(() async {
      server = LocalAssetServer(loadAsset: (key) async {
        final v = files[key];
        if (v == null) throw StateError('missing $key');
        return ByteData.sublistView(Uint8List.fromList(utf8.encode(v)));
      });
      await server.start();
    });
    tearDown(() => server.stop());

    Future<HttpClientResponse> get(Uri uri) async {
      final client = HttpClient();
      final req = await client.getUrl(uri);
      final res = await req.close();
      client.close();
      return res;
    }

    test('binds to loopback with a random token', () {
      expect(server.baseUri.host, '127.0.0.1');
      expect(server.token.length, 32);
      expect(server.baseUri.path, '/${server.token}/');
    });

    test('serves assets with the right type and no caching', () async {
      final res = await get(server.baseUri.resolve('index.html'));
      expect(res.statusCode, 200);
      expect(res.headers.contentType?.mimeType, 'text/html');
      expect(res.headers.value('cache-control'), 'no-store');
      expect(await utf8.decodeStream(res), '<h1>hi</h1>');
      final wasm = await get(server.baseUri.resolve('vad/m.wasm'));
      expect(wasm.headers.contentType?.mimeType, 'application/wasm');
    });

    test('returns 404 for unknown files and wrong tokens', () async {
      expect((await get(server.baseUri.resolve('nope.js'))).statusCode, 404);
      final wrong = server.baseUri.replace(path: '/wrongtoken/index.html');
      expect((await get(wrong)).statusCode, 404);
    });
  });
}
