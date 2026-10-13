import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:typed_data';

import 'package:avatar_app/native_gateway/gateway_client.dart';
import 'package:avatar_app/native_gateway/protocol.dart';
import 'package:avatar_app/native_gateway/transports.dart';
import 'package:flutter_test/flutter_test.dart';

const firstTokens = SessionTokens(sessionId: 'first', connectToken: 'connect-1', resumeToken: 'resume-1');
const secondTokens = SessionTokens(sessionId: 'first', connectToken: 'connect-2', resumeToken: 'resume-2');

void main() {
  test('starts a session and sends the existing session.start message', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens);
    final events = RecordingGatewayEvents();
    final c = NativeGatewayClient(
      baseUri: Uri.parse('http://gw.test'),
      appSecret: 'secret-123456789',
      transport: transport,
      events: events,
      reconnectBase: Duration.zero,
    );

    await c.start();

    expect(transport.lastSocket.jsonMessages.single['type'], 'session.start');
    expect(events.statuses, [GatewayStatus.connecting]);
  });

  test('routes only AI binary frames and resumes with the rotated token', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens, resumeTokens: [secondTokens]);
    final events = RecordingGatewayEvents();
    final c = NativeGatewayClient(
      baseUri: Uri.parse('http://gw.test'),
      appSecret: 'secret-123456789',
      transport: transport,
      events: events,
      reconnectBase: Duration.zero,
    );

    await c.start();
    transport.lastSocket.emitText('{"type":"session.ready","sessionId":"first"}');
    transport.lastSocket.closeUnexpectedly();
    await Future<void>.delayed(const Duration(milliseconds: 10));

    expect(transport.postedPaths, contains('/session/resume'));
    transport.lastSocket.emitText('{"type":"session.resumed","lastResponseSeq":4}');
    transport.lastSocket.emitBinary(encodeAudioFrame(frameAi, 4, Int16List(3)));
    transport.lastSocket.emitBinary(encodeAudioFrame(frameMic, 0, Int16List(3)));
    await Future<void>.delayed(Duration.zero);
    expect(events.audio.single.responseSeq, 4);
  });
}

class RecordingGatewayEvents implements GatewayClientEvents {
  final statuses = <GatewayStatus>[];
  final messages = <ServerMessage>[];
  final audio = <DecodedAudioFrame>[];

  @override
  void onAudio(DecodedAudioFrame frame) => audio.add(frame);

  @override
  void onMessage(ServerMessage message) => messages.add(message);

  @override
  void onStatus(GatewayStatus status) => statuses.add(status);
}

class FakeGatewayTransport implements GatewayTransport {
  FakeGatewayTransport({required this.tokens, List<SessionTokens>? resumeTokens}) : _resumeTokens = Queue<SessionTokens>.from(resumeTokens ?? const []);

  final SessionTokens tokens;
  final Queue<SessionTokens> _resumeTokens;
  final postedPaths = <String>[];
  final sockets = <FakeSocket>[];

  FakeSocket get lastSocket => sockets.last;

  @override
  Future<GatewayHttpResponse> post(Uri uri, {required String appSecret, required Map<String, Object?> body}) async {
    postedPaths.add(uri.path);
    final SessionTokens next = uri.path == '/session/resume' ? _resumeTokens.removeFirst() : tokens;
    return GatewayHttpResponse(statusCode: 200, body: next.toJson());
  }

  @override
  Future<NativeSocket> openWebSocket(Uri uri) async {
    final socket = FakeSocket();
    sockets.add(socket);
    return socket;
  }
}

class FakeSocket implements NativeSocket {
  final _messages = StreamController<Object>();
  final sent = <Object>[];

  List<Map<String, Object?>> get jsonMessages => sent.whereType<String>().map((value) => jsonDecode(value) as Map<String, Object?>).toList();

  @override
  Stream<Object> get messages => _messages.stream;

  @override
  Future<void> close([int? code]) async => _messages.close();

  void closeUnexpectedly() => _messages.close();

  void emitBinary(Uint8List bytes) => _messages.add(bytes);

  void emitText(String message) => _messages.add(message);

  @override
  void send(Object data) => sent.add(data);
}
