import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

typedef AssetLoader = Future<ByteData> Function(String key);

/// Serves the bundled avatar-core build on 127.0.0.1 so the WebView gets a secure context
/// (ES modules, AudioWorklet, wasm, getUserMedia) without enabling file access.
class LocalAssetServer {
  LocalAssetServer({required this.loadAsset, this.assetRoot = 'assets/web'});

  final AssetLoader loadAsset;
  final String assetRoot;
  final String token = _randomToken();
  HttpServer? _server;

  Uri get baseUri {
    final server = _server;
    if (server == null) throw StateError('LocalAssetServer not started');
    return Uri.parse('http://127.0.0.1:${server.port}/$token/');
  }

  Future<void> start() async {
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server!.listen(_handle);
  }

  Future<void> stop() async {
    await _server?.close(force: true);
    _server = null;
  }

  Future<void> _handle(HttpRequest req) async {
    final res = req.response;
    try {
      final rel = resolveAssetPath(req.uri.path, token);
      if (req.method != 'GET' || rel == null) {
        res.statusCode = HttpStatus.notFound;
      } else {
        final data = await loadAsset('$assetRoot/$rel');
        res.headers.contentType = contentTypeFor(rel);
        res.headers.set(HttpHeaders.cacheControlHeader, 'no-store');
        res.add(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
      }
    } catch (_) {
      res.statusCode = HttpStatus.notFound;
    }
    await res.close();
  }
}

/// Asset path relative to the web root, or null if outside the token prefix or attempting traversal.
String? resolveAssetPath(String path, String token) {
  final prefix = '/$token/';
  if (!path.startsWith(prefix)) return null;
  final String rel;
  try {
    rel = Uri.decodeComponent(path.substring(prefix.length));
  } on ArgumentError {
    return null;
  }
  if (rel.isEmpty) return 'index.html';
  final segments = rel.split('/');
  if (segments.any((s) => s.isEmpty || s == '.' || s == '..' || s.contains('\\'))) return null;
  return rel;
}

ContentType contentTypeFor(String path) {
  final dot = path.lastIndexOf('.');
  final ext = dot < 0 ? '' : path.substring(dot + 1).toLowerCase();
  return switch (ext) {
    'html' => ContentType('text', 'html', charset: 'utf-8'),
    'js' || 'mjs' => ContentType('application', 'javascript', charset: 'utf-8'),
    'css' => ContentType('text', 'css', charset: 'utf-8'),
    'json' => ContentType('application', 'json', charset: 'utf-8'),
    'wasm' => ContentType('application', 'wasm'),
    'glb' => ContentType('model', 'gltf-binary'),
    'png' => ContentType('image', 'png'),
    'md' => ContentType('text', 'plain', charset: 'utf-8'),
    _ => ContentType('application', 'octet-stream'),
  };
}

String _randomToken() {
  final r = Random.secure();
  return List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
}
