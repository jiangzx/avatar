import 'dart:async';

import '../config.dart';
import '../native_gateway/transports.dart';

sealed class RegisterResult {
  const RegisterResult();
}

class RegisterOk extends RegisterResult {
  const RegisterOk(this.deviceToken);

  final String deviceToken;
}

/// The gateway has no identity (404): continue in dev mode.
class RegisterUnavailable extends RegisterResult {
  const RegisterUnavailable();
}

class RegisterFailed extends RegisterResult {
  const RegisterFailed(this.statusCode);

  final int statusCode;
}

abstract interface class IdentityBackend {
  Future<RegisterResult> register({String? style});

  /// Returns the HTTP status of PATCH /agent/style.
  Future<int> patchStyle({required String token, required String style});
}

final _tokenShape = RegExp(r'^[A-Za-z0-9_-]{16,128}$');

class IdentityApi implements IdentityBackend {
  IdentityApi({
    required this.baseUri,
    required this.appSecret,
    required this.transport,
    this.platform = 'android',
    this.requestTimeout = AppConfig.gatewayRequestTimeout,
  });

  final Uri baseUri;
  final String appSecret;
  final GatewayTransport transport;
  final String platform;
  final Duration requestTimeout;

  @override
  Future<RegisterResult> register({String? style}) async {
    final response = await transport
        .post(_uri('/device/register'), appSecret: appSecret, body: {
          'clientInfo': {'platform': platform},
          'style': ?style,
        })
        .timeout(requestTimeout);
    if (response.statusCode == 404) return const RegisterUnavailable();
    if (response.statusCode != 200) return RegisterFailed(response.statusCode);
    final body = response.body;
    final token = body is Map ? body['deviceToken'] : null;
    if (token is! String || !_tokenShape.hasMatch(token)) return const RegisterFailed(502);
    return RegisterOk(token);
  }

  @override
  Future<int> patchStyle({required String token, required String style}) async {
    final response = await transport
        .patch(_uri('/agent/style'), appSecret: appSecret, bearer: token, body: {'style': style})
        .timeout(requestTimeout);
    return response.statusCode;
  }

  Uri _uri(String path) => baseUri.replace(path: path, query: null, queryParameters: null);
}
