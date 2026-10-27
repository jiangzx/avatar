import 'package:avatar_app/identity/identity_api.dart';
import 'package:avatar_app/native_gateway/transports.dart';
import 'package:flutter_test/flutter_test.dart';

class RecordingTransport implements GatewayTransport {
  RecordingTransport(this.response);

  GatewayHttpResponse response;
  final calls = <Map<String, Object?>>[];

  @override
  Future<GatewayHttpResponse> post(Uri uri, {required String appSecret, required Map<String, Object?> body, String? bearer}) async {
    calls.add({'method': 'POST', 'path': uri.path, 'secret': appSecret, 'bearer': bearer, 'body': body});
    return response;
  }

  @override
  Future<GatewayHttpResponse> patch(Uri uri, {required String appSecret, required String bearer, required Map<String, Object?> body}) async {
    calls.add({'method': 'PATCH', 'path': uri.path, 'secret': appSecret, 'bearer': bearer, 'body': body});
    return response;
  }

  @override
  Future<NativeSocket> openWebSocket(Uri uri) => throw UnimplementedError();
}

void main() {
  IdentityApi api(RecordingTransport t) => IdentityApi(baseUri: Uri.parse('http://gw.test'), appSecret: 'secret-123456789', transport: t);

  test('register posts only client info with the app secret', () async {
    final t = RecordingTransport(const GatewayHttpResponse(statusCode: 200, body: {'deviceToken': 'device-token-0123456789'}));
    final result = await api(t).register();
    expect(result, isA<RegisterOk>().having((r) => r.deviceToken, 'deviceToken', 'device-token-0123456789'));
    expect(t.calls.single, {
      'method': 'POST', 'path': '/device/register', 'secret': 'secret-123456789', 'bearer': null,
      'body': {'clientInfo': {'platform': 'android'}},
    });
  });

  test('maps 404 to unavailable, other errors and malformed tokens to failures', () async {
    final t = RecordingTransport(const GatewayHttpResponse(statusCode: 404, body: {'error': 'not_found'}));
    expect(await api(t).register(), isA<RegisterUnavailable>());
    t.response = const GatewayHttpResponse(statusCode: 503, body: {'error': 'owner_capacity'});
    expect(await api(t).register(), isA<RegisterFailed>().having((r) => r.statusCode, 'statusCode', 503));
    t.response = const GatewayHttpResponse(statusCode: 200, body: {'deviceToken': 'bad token!'});
    expect(await api(t).register(), isA<RegisterFailed>().having((r) => r.statusCode, 'statusCode', 502));
  });
}
