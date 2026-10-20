import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import '../config.dart';
import 'protocol.dart';
import 'transports.dart';

enum GatewayStatus { connecting, open, reconnecting, closed }

abstract interface class GatewayClientEvents {
  void onMessage(ServerMessage message);
  void onAudio(DecodedAudioFrame frame);
  void onStatus(GatewayStatus status);
}

abstract interface class GatewayClientLike {
  void attachEvents(GatewayClientEvents events);
  Future<void> start();
  void send(ClientMessage message);
  void sendAudio(Int16List pcm16k);
  Future<void> close();
}

class GatewayHttpException implements Exception {
  const GatewayHttpException(this.statusCode);

  final int statusCode;
}

/// Supplies the device bearer for POST /session (Plan 3 B). token() == null means dev mode.
abstract interface class DeviceTokenProvider {
  Future<String?> token();

  /// The gateway rejected the token: a new token, or null to continue without identity.
  Future<String?> renew();
}

class NativeGatewayClient implements GatewayClientLike {
  NativeGatewayClient({
    required this.baseUri,
    required this.appSecret,
    required this.transport,
    required this.events,
    this.platform = 'android',
    this.audioPath = 'B',
    this.maxResume = const Duration(seconds: 55),
    this.reconnectBase = const Duration(milliseconds: 500),
    this.reconnectMax = const Duration(seconds: 4),
    this.requestTimeout = AppConfig.gatewayRequestTimeout,
    this.socketTimeout = AppConfig.gatewaySocketTimeout,
    this.identity,
  });

  final Uri baseUri;
  final String appSecret;
  final GatewayTransport transport;
  GatewayClientEvents events;
  final String platform;
  final String audioPath;
  final Duration maxResume;
  final Duration reconnectBase;
  final Duration reconnectMax;
  final Duration requestTimeout;
  final Duration socketTimeout;

  /// Device identity; null = dev mode (APP_SECRET only).
  final DeviceTokenProvider? identity;

  NativeSocket? _socket;
  StreamSubscription<Object>? _subscription;
  SessionTokens? _tokens;
  Timer? _retryTimer;
  DateTime? _disconnectedAt;
  bool _closedByUser = false;
  bool _closedEmitted = false;
  bool _sessionStarted = false;
  /// A session.start was sent at least once; a later reconnect must resume it even
  /// if the matching session.ready was lost with the socket.
  bool _startSent = false;
  int _attempt = 0;

  bool get isOpen => _socket != null;

  @override
  void attachEvents(GatewayClientEvents next) => events = next;

  @override
  Future<void> start() async {
    _closedByUser = false;
    _closedEmitted = false;
    _sessionStarted = false;
    _startSent = false;
    _attempt = 0;
    _disconnectedAt = null;
    await _startFresh();
  }

  @override
  void send(ClientMessage message) {
    final socket = _socket;
    if (socket == null) return;
    socket.send(jsonEncode(message.toJson()));
  }

  @override
  void sendAudio(Int16List pcm16k) {
    final socket = _socket;
    if (socket == null || pcm16k.isEmpty) return;
    socket.send(encodeAudioFrame(frameMic, 0, pcm16k));
  }

  @override
  Future<void> close() async {
    if (_closedByUser) return;
    _closedByUser = true;
    _retryTimer?.cancel();
    _retryTimer = null;
    send(const SessionEnd());
    final subscription = _subscription;
    _subscription = null;
    await subscription?.cancel();
    final socket = _socket;
    _socket = null;
    await socket?.close(1000);
    _emitClosed();
  }

  Future<void> _startFresh() async {
    _startSent = false;
    _tokens = await _createSession().timeout(requestTimeout);
    if (_closedByUser) return;
    await _open(resume: false);
  }

  /// POST /session with the device bearer; after a 401, one retry with the renewed (or no) bearer.
  Future<SessionTokens> _createSession() async {
    final provider = identity;
    final bearer = await provider?.token();
    try {
      return await _post('/session', const {}, bearer: bearer);
    } on GatewayHttpException catch (error) {
      if (provider == null || bearer == null || error.statusCode != 401) {
        rethrow;
      }
      return _post('/session', const {}, bearer: await provider.renew());
    }
  }

  Future<void> _open({required bool resume}) async {
    final tokens = _tokens;
    if (tokens == null || _closedByUser) return;
    events.onStatus(
      resume ? GatewayStatus.reconnecting : GatewayStatus.connecting,
    );
    final socket = await transport
        .openWebSocket(_webSocketUri(tokens.connectToken))
        .timeout(socketTimeout);
    if (_closedByUser) {
      await socket.close(1000);
      return;
    }
    _socket = socket;
    _subscription = socket.messages.listen(
      (data) => _onSocketData(socket, data),
      onDone: () => unawaited(_onSocketClosed(socket)),
      onError: (Object error, StackTrace stack) =>
          unawaited(_onSocketClosed(socket)),
      cancelOnError: false,
    );
    if (resume) {
      send(SessionResume(tokens.sessionId));
    } else {
      send(SessionStart(platform: platform, audioPath: audioPath));
      _startSent = true;
    }
  }

  void _onSocketData(NativeSocket socket, Object data) {
    if (!identical(_socket, socket)) return;
    if (data is String) {
      Object? raw;
      try {
        raw = jsonDecode(data);
      } on FormatException {
        return;
      }
      final message = parseServerMessage(raw);
      if (message == null) return;
      if (message is SessionReady || message is SessionResumed) {
        _sessionStarted = true;
        _attempt = 0;
        _disconnectedAt = null;
        events.onStatus(GatewayStatus.open);
      }
      events.onMessage(message);
      return;
    }
    final Uint8List? bytes = switch (data) {
      Uint8List value => value,
      List<int> value => Uint8List.fromList(value),
      ByteBuffer value => value.asUint8List(),
      _ => null,
    };
    if (bytes == null) return;
    final frame = decodeAudioFrame(bytes);
    if (frame?.kind == frameAi) events.onAudio(frame!);
  }

  Future<void> _onSocketClosed(NativeSocket socket) async {
    if (!identical(_socket, socket)) return;
    _socket = null;
    _subscription = null;
    if (_closedByUser) {
      _emitClosed();
      return;
    }
    _disconnectedAt ??= DateTime.now();
    _scheduleResume();
  }

  void _scheduleResume() {
    if (_closedByUser) return;
    final disconnectedAt = _disconnectedAt ?? DateTime.now();
    if (DateTime.now().difference(disconnectedAt) >= maxResume) {
      unawaited(_restartFresh());
      return;
    }
    final multiplier = 1 << _attempt.clamp(0, 20);
    final candidate = Duration(
      microseconds: reconnectBase.inMicroseconds * multiplier,
    );
    final delay = candidate > reconnectMax ? reconnectMax : candidate;
    _attempt++;
    events.onStatus(GatewayStatus.reconnecting);
    _retryTimer?.cancel();
    _retryTimer = Timer(delay, () => unawaited(_tryResume()));
  }

  Future<void> _tryResume() async {
    final tokens = _tokens;
    if (_closedByUser || tokens == null) return;
    try {
      _tokens = await _post('/session/resume', {
        'sessionId': tokens.sessionId,
        'resumeToken': tokens.resumeToken,
      }).timeout(requestTimeout);
      if (_closedByUser) return;
      // If the server already started the session, a lost session.ready must not make
      // us send session.start again (the gateway rejects it with 4002 until expiry).
      await _open(resume: _sessionStarted || _startSent);
    } on GatewayHttpException catch (error) {
      if (error.statusCode == 401 || error.statusCode == 404) {
        await _restartFresh();
      } else {
        _scheduleResume();
      }
    } catch (_) {
      _scheduleResume();
    }
  }

  Future<void> _restartFresh() async {
    if (_closedByUser) return;
    _attempt = 0;
    _sessionStarted = false;
    try {
      await _startFresh();
      _disconnectedAt = null;
    } catch (_) {
      // Start a fresh retry window. Keeping the old timestamp makes _scheduleResume
      // enter the expired branch again immediately, spinning without backoff.
      _disconnectedAt = DateTime.now();
      _scheduleResume();
    }
  }

  Future<SessionTokens> _post(
    String path,
    Map<String, Object?> body, {
    String? bearer,
  }) async {
    final response = await transport.post(
      _httpUri(path),
      appSecret: appSecret,
      body: body,
      bearer: bearer,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw GatewayHttpException(response.statusCode);
    }
    final tokens = SessionTokens.fromJson(response.body);
    if (tokens == null) throw const GatewayHttpException(502);
    return tokens;
  }

  Uri _httpUri(String path) =>
      baseUri.replace(path: path, query: null, queryParameters: null);

  Uri _webSocketUri(String token) {
    final scheme = baseUri.scheme == 'https' ? 'wss' : 'ws';
    return baseUri.replace(
      scheme: scheme,
      path: '/ws',
      queryParameters: {'token': token},
    );
  }

  void _emitClosed() {
    if (_closedEmitted) return;
    _closedEmitted = true;
    events.onStatus(GatewayStatus.closed);
  }
}
