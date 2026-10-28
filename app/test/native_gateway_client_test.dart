import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:typed_data';

import 'package:avatar_app/native_gateway/gateway_client.dart';
import 'package:avatar_app/native_gateway/protocol.dart';
import 'package:avatar_app/native_gateway/transports.dart';
import 'package:flutter_test/flutter_test.dart';

const firstTokens = SessionTokens(
  sessionId: 'first',
  connectToken: 'connect-1',
  resumeToken: 'resume-1',
);
const secondTokens = SessionTokens(
  sessionId: 'first',
  connectToken: 'connect-2',
  resumeToken: 'resume-2',
);

void main() {
  test(
    'starts a session and sends the existing session.start message',
    () async {
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
    },
  );

  test(
    'routes only AI binary frames and resumes with the rotated token',
    () async {
      final transport = FakeGatewayTransport(
        tokens: firstTokens,
        resumeTokens: [secondTokens],
      );
      final events = RecordingGatewayEvents();
      final c = NativeGatewayClient(
        baseUri: Uri.parse('http://gw.test'),
        appSecret: 'secret-123456789',
        transport: transport,
        events: events,
        reconnectBase: Duration.zero,
      );

      await c.start();
      transport.lastSocket.emitText(
        '{"type":"session.ready","sessionId":"first"}',
      );
      transport.lastSocket.closeUnexpectedly();
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(transport.postedPaths, contains('/session/resume'));
      transport.lastSocket.emitText(
        '{"type":"session.resumed","lastResponseSeq":4}',
      );
      transport.lastSocket.emitBinary(
        encodeAudioFrame(frameAi, 4, Int16List(3)),
      );
      transport.lastSocket.emitBinary(
        encodeAudioFrame(frameMic, 0, Int16List(3)),
      );
      await Future<void>.delayed(Duration.zero);
      expect(events.audio.single.responseSeq, 4);
    },
  );

  test(
    'fails fast when session creation exceeds the request timeout',
    () async {
      final transport = FakeGatewayTransport(tokens: firstTokens)
        ..hangPosts = true;
      final events = RecordingGatewayEvents();
      final c = NativeGatewayClient(
        baseUri: Uri.parse('http://gw.test'),
        appSecret: 'secret-123456789',
        transport: transport,
        events: events,
        requestTimeout: const Duration(milliseconds: 1),
      );

      await expectLater(c.start(), throwsA(isA<TimeoutException>()));
    },
  );

  NativeGatewayClient client(
    FakeGatewayTransport transport,
    DeviceTokenProvider? identity,
  ) => NativeGatewayClient(
    baseUri: Uri.parse('http://gw.test'),
    appSecret: 'secret-123456789',
    transport: transport,
    events: RecordingGatewayEvents(),
    reconnectBase: Duration.zero,
    identity: identity,
  );

  test('sends the device bearer when creating a session', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens);
    await client(
      transport,
      FakeTokenProvider('device-token-0123456789'),
    ).start();
    expect(transport.postedBearers, ['device-token-0123456789']);
    expect(transport.lastSocket.jsonMessages.single['type'], 'session.start');
  });

  test(
    'renews a rejected device token once and retries with the new one',
    () async {
      final transport = FakeGatewayTransport(
        tokens: firstTokens,
        rejectedBearers: {'old-token-0123456789'},
      );
      final identity = FakeTokenProvider(
        'old-token-0123456789',
        renewed: 'new-token-0123456789',
      );
      await client(transport, identity).start();
      expect(transport.postedBearers, [
        'old-token-0123456789',
        'new-token-0123456789',
      ]);
      expect(identity.renewCalls, 1);
      expect(transport.lastSocket.jsonMessages.single['type'], 'session.start');
    },
  );

  test('continues without a bearer when renewal is unavailable', () async {
    final transport = FakeGatewayTransport(
      tokens: firstTokens,
      rejectedBearers: {'old-token-0123456789'},
    );
    await client(transport, FakeTokenProvider('old-token-0123456789')).start();
    expect(transport.postedBearers, ['old-token-0123456789', null]);
  });

  test('does not renew when the request had no bearer', () async {
    final transport = FakeGatewayTransport(
      tokens: firstTokens,
      rejectedBearers: {null},
    );
    final identity = FakeTokenProvider(null);
    await expectLater(
      client(transport, identity).start(),
      throwsA(
        isA<GatewayHttpException>().having(
          (e) => e.statusCode,
          'statusCode',
          401,
        ),
      ),
    );
    expect(identity.renewCalls, 0);
  });

  test('resumes instead of starting when session.ready was lost', () async {
    final transport = FakeGatewayTransport(
      tokens: firstTokens,
      resumeTokens: [secondTokens],
    );
    final c = NativeGatewayClient(
      baseUri: Uri.parse('http://gw.test'),
      appSecret: 'secret-123456789',
      transport: transport,
      events: RecordingGatewayEvents(),
      reconnectBase: Duration.zero,
    );
    await c.start();
    // The server may have started the session before the ready frame was lost.
    transport.lastSocket.closeUnexpectedly();
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(transport.postedPaths, contains('/session/resume'));
    expect(transport.lastSocket.jsonMessages.single['type'], 'session.resume');
  });

  test('reconnects when session.ready never arrives', () async {
    final transport = FakeGatewayTransport(
      tokens: firstTokens,
      resumeTokens: [secondTokens],
    );
    final c = NativeGatewayClient(
      baseUri: Uri.parse('http://gw.test'),
      appSecret: 'secret-123456789',
      transport: transport,
      events: RecordingGatewayEvents(),
      reconnectBase: Duration.zero,
      readyTimeout: const Duration(milliseconds: 20),
    );
    await c.start();
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(transport.postedPaths, contains('/session/resume'));
    expect(transport.lastSocket.jsonMessages.single['type'], 'session.resume');
    await c.close();
  });

  test('backs off when fresh session creation keeps failing after the resume window', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens);
    final events = RecordingGatewayEvents();
    final c = NativeGatewayClient(
      baseUri: Uri.parse('http://gw.test'),
      appSecret: 'secret-123456789',
      transport: transport,
      events: events,
      maxResume: const Duration(milliseconds: 80),
      reconnectBase: const Duration(milliseconds: 1),
      reconnectMax: const Duration(milliseconds: 2),
    );
    await c.start();
    transport.lastSocket.emitText(
      '{"type":"session.ready","sessionId":"first"}',
    );
    transport.failResume = true;
    transport.failFresh = true;
    transport.lastSocket.closeUnexpectedly();
    // Let the resume window expire with both endpoints failing.
    await Future<void>.delayed(const Duration(milliseconds: 150));
    final before = transport.postedPaths.where((p) => p == '/session').length;
    await Future<void>.delayed(const Duration(milliseconds: 100));
    final after = transport.postedPaths.where((p) => p == '/session').length;
    // A hot loop would issue hundreds of POST /session calls in this window.
    expect(after - before, lessThanOrEqualTo(5));
    await c.close();
  });

  test('resume never sends the bearer', () async {
    final transport = FakeGatewayTransport(
      tokens: firstTokens,
      resumeTokens: [secondTokens],
    );
    await client(
      transport,
      FakeTokenProvider('device-token-0123456789'),
    ).start();
    transport.lastSocket.emitText(
      '{"type":"session.ready","sessionId":"first"}',
    );
    transport.lastSocket.closeUnexpectedly();
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(transport.postedPaths, ['/session', '/session/resume']);
    expect(transport.postedBearers, ['device-token-0123456789']);
  });

  test('POST /session carries the chosen character; session.start has no voice profile', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens);
    await NativeGatewayClient(
      baseUri: Uri.parse('http://gw.test'),
      appSecret: 'secret-123456789',
      transport: transport,
      events: RecordingGatewayEvents(),
      reconnectBase: Duration.zero,
      language: 'zh',
      characterId: 'xiaokai',
    ).start();
    expect(transport.postedBodies.single, {'character': 'xiaokai'});
    expect(transport.lastSocket.jsonMessages.single['clientInfo'], {'platform': 'android', 'audioPath': 'B', 'language': 'zh'});
  });

  test('without a character the session body stays empty', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens);
    await client(transport, null).start();
    expect(transport.postedBodies.single, isEmpty);
  });

  test('the retry after a renewed token keeps the character', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens, rejectedBearers: {'old-token-0123456789'});
    await NativeGatewayClient(
      baseUri: Uri.parse('http://gw.test'),
      appSecret: 'secret-123456789',
      transport: transport,
      events: RecordingGatewayEvents(),
      reconnectBase: Duration.zero,
      characterId: 'xiaonuan',
      identity: FakeTokenProvider('old-token-0123456789', renewed: 'new-token-0123456789'),
    ).start();
    expect(transport.postedBodies, [
      {'character': 'xiaonuan'},
      {'character': 'xiaonuan'},
    ]);
  });

  test('a 403 owner_banned keeps the code and is not renewed', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens)
      ..freshRejection = const GatewayHttpResponse(statusCode: 403, body: {'error': 'owner_banned'});
    final identity = FakeTokenProvider('device-token-0123456789', renewed: 'new-token-0123456789');
    await expectLater(
      client(transport, identity).start(),
      throwsA(isA<GatewayHttpException>()
          .having((e) => e.statusCode, 'statusCode', 403)
          .having((e) => e.errorCode, 'errorCode', 'owner_banned')),
    );
    expect(identity.renewCalls, 0);
  });

  test('a 409 character_disabled keeps the code', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens)
      ..freshRejection = const GatewayHttpResponse(statusCode: 409, body: {'error': 'character_disabled'});
    await expectLater(
      client(transport, FakeTokenProvider('device-token-0123456789')).start(),
      throwsA(isA<GatewayHttpException>().having((e) => e.errorCode, 'errorCode', 'character_disabled')),
    );
  });

  test('an error body that is not a short code leaves errorCode null', () async {
    final transport = FakeGatewayTransport(tokens: firstTokens)
      ..freshRejection = const GatewayHttpResponse(statusCode: 500, body: {'error': 'Some <html> text'});
    await expectLater(
      client(transport, FakeTokenProvider(null)).start(),
      throwsA(isA<GatewayHttpException>().having((e) => e.errorCode, 'errorCode', isNull)),
    );
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
  FakeGatewayTransport({
    required this.tokens,
    List<SessionTokens>? resumeTokens,
    Set<String?>? rejectedBearers,
  }) : _resumeTokens = Queue<SessionTokens>.from(resumeTokens ?? const []),
       rejectedBearers = rejectedBearers ?? {};

  final SessionTokens tokens;
  final Queue<SessionTokens> _resumeTokens;

  /// POST /session answers 401 for these bearers (null = no bearer).
  final Set<String?> rejectedBearers;
  final postedPaths = <String>[];
  final postedBodies = <Map<String, Object?>>[];
  final postedBearers = <String?>[];
  final sockets = <FakeSocket>[];
  bool hangPosts = false;
  /// POST /session answers 401; used to test fresh-session failure handling.
  bool failFresh = false;
  /// POST /session/resume answers 500; used to keep the client in its retry loop.
  bool failResume = false;
  /// POST /session answers this instead of tokens (status + body), e.g. 403 owner_banned.
  GatewayHttpResponse? freshRejection;

  FakeSocket get lastSocket => sockets.last;

  @override
  Future<GatewayHttpResponse> post(
    Uri uri, {
    required String appSecret,
    required Map<String, Object?> body,
    String? bearer,
  }) async {
    if (hangPosts) return Completer<GatewayHttpResponse>().future;
    postedPaths.add(uri.path);
    if (uri.path == '/session') postedBodies.add(body);
    if (uri.path == '/session') {
      postedBearers.add(bearer);
      final rejection = freshRejection;
      if (rejection != null) return rejection;
      if (rejectedBearers.contains(bearer) || failFresh) {
        return const GatewayHttpResponse(
          statusCode: 401,
          body: {'error': 'unauthorized'},
        );
      }
    }
    if (uri.path == '/session/resume' && failResume) {
      return const GatewayHttpResponse(statusCode: 500, body: null);
    }
    final SessionTokens next = uri.path == '/session/resume'
        ? _resumeTokens.removeFirst()
        : tokens;
    return GatewayHttpResponse(statusCode: 200, body: next.toJson());
  }

  @override
  Future<GatewayHttpResponse> patch(
    Uri uri, {
    required String appSecret,
    required String bearer,
    required Map<String, Object?> body,
  }) async => const GatewayHttpResponse(statusCode: 404, body: null);

  @override
  Future<GatewayHttpResponse> get(Uri uri, {required String appSecret, String? bearer}) async =>
      const GatewayHttpResponse(statusCode: 404, body: null);

  @override
  Future<GatewayHttpResponse> put(
    Uri uri, {
    required String appSecret,
    required Map<String, Object?> body,
    String? bearer,
  }) async => const GatewayHttpResponse(statusCode: 404, body: null);

  @override
  Future<GatewayHttpResponse> delete(Uri uri, {required String appSecret, String? bearer}) async =>
      const GatewayHttpResponse(statusCode: 404, body: null);

  @override
  Future<NativeSocket> openWebSocket(Uri uri) async {
    final socket = FakeSocket();
    sockets.add(socket);
    return socket;
  }
}

class FakeTokenProvider implements DeviceTokenProvider {
  FakeTokenProvider(this.current, {this.renewed});

  String? current;
  final String? renewed;
  int renewCalls = 0;

  @override
  Future<String?> token() async => current;

  @override
  Future<String?> renew() async {
    renewCalls++;
    if (renewed != null) current = renewed;
    return renewed;
  }
}

class FakeSocket implements NativeSocket {
  final _messages = StreamController<Object>();
  final sent = <Object>[];

  List<Map<String, Object?>> get jsonMessages => sent
      .whereType<String>()
      .map((value) => jsonDecode(value) as Map<String, Object?>)
      .toList();

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
