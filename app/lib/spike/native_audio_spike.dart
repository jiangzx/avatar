import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_pcm_sound/flutter_pcm_sound.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:record/record.dart';

import 'energy_trigger.dart';

const int nativeFeedChunkSamples = 12000; // TUNABLE: 0.5 s @ 24 kHz per feed and feed threshold
const Duration nativeRenderInterval = Duration(seconds: 1); // TUNABLE: stats refresh period

/// Path B: native capture (VOICE_COMMUNICATION + in-communication mode + speakerphone + AEC)
/// while flutter_pcm_sound loops the same speech sample on the loudspeaker.
class NativeAudioSpikePage extends StatefulWidget {
  const NativeAudioSpikePage({super.key});

  @override
  State<NativeAudioSpikePage> createState() => _NativeAudioSpikePageState();
}

class _NativeAudioSpikePageState extends State<NativeAudioSpikePage> {
  final _recorder = AudioRecorder();
  final _trigger = EnergyTrigger();
  StreamSubscription<Uint8List>? _sub;
  Timer? _ticker;
  Int16List? _speech;
  int _offset = 0;
  DateTime? _startedAt;
  double _lastRms = 0;
  final _pending = BytesBuilder(copy: false);

  Future<void> _start() async {
    if (!(await Permission.microphone.request()).isGranted) return;
    final bytes = await rootBundle.load('assets/web/spike/speech-24k.pcm');
    final raw = Uint8List.fromList(bytes.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes & ~1));
    _speech = raw.buffer.asInt16List(); // copied, so the view is 2-byte aligned
    // The plugin's default log level prints sample bytes of every feed; keep audio out of logs.
    await FlutterPcmSound.setLogLevel(LogLevel.none);
    await FlutterPcmSound.setup(sampleRate: 24000, channelCount: 1);
    await FlutterPcmSound.setFeedThreshold(nativeFeedChunkSamples);
    FlutterPcmSound.setFeedCallback((_) => _feed());
    await _feed();
    FlutterPcmSound.start();

    final stream = await _recorder.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: 16000,
      numChannels: 1,
      echoCancel: true,
      noiseSuppress: true,
      autoGain: true,
      androidConfig: AndroidRecordConfig(
        audioSource: AndroidAudioSource.voiceCommunication,
        audioManagerMode: AudioManagerMode.modeInCommunication,
        speakerphone: true,
      ),
    ));
    _sub = stream.listen(_onMic);
    _startedAt = DateTime.now();
    _ticker = Timer.periodic(nativeRenderInterval, (_) => setState(() {}));
    setState(() {});
  }

  Future<void> _feed() async {
    final speech = _speech;
    if (speech == null) return;
    // A fresh list per feed: the plugin sends the whole backing buffer, not just the view.
    final chunk = Int16List(nativeFeedChunkSamples);
    for (var i = 0; i < nativeFeedChunkSamples; i++) {
      chunk[i] = speech[(_offset + i) % speech.length];
    }
    _offset = (_offset + nativeFeedChunkSamples) % speech.length;
    await FlutterPcmSound.feed(PcmArrayInt16(bytes: ByteData.sublistView(chunk)));
  }

  /// Re-frames the recorder byte stream into 20 ms (320-sample) frames.
  void _onMic(Uint8List data) {
    _pending.add(data);
    final all = _pending.takeBytes();
    const frameBytes = 640;
    var off = 0;
    final view = ByteData.sublistView(all);
    while (off + frameBytes <= all.length) {
      final frame = Int16List(320);
      for (var i = 0; i < 320; i++) {
        frame[i] = view.getInt16(off + i * 2, Endian.little);
      }
      _lastRms = rmsInt16(frame);
      _trigger.push(frame);
      off += frameBytes;
    }
    if (off < all.length) _pending.add(Uint8List.fromList(all.sublist(off)));
  }

  Future<void> _stop() async {
    _ticker?.cancel();
    await _sub?.cancel();
    await _recorder.stop();
    FlutterPcmSound.setFeedCallback(null);
    await FlutterPcmSound.release();
    if (mounted) setState(() => _startedAt = null);
  }

  @override
  void dispose() {
    _stop();
    _recorder.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final started = _startedAt;
    final minutes = started == null ? 0.0 : DateTime.now().difference(started).inMilliseconds / 60000;
    final per10 = minutes > 0 ? (_trigger.count / minutes * 10).toStringAsFixed(1) : '0';
    return Scaffold(
      appBar: AppBar(title: const Text('音频方案 B：原生采集 + 原生外放')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: DefaultTextStyle(
          style: const TextStyle(fontSize: 18, color: Colors.white),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('手机平放，媒体音量 70%，安静房间，测试期间不要说话。'),
            const SizedBox(height: 12),
            Row(children: [
              FilledButton(onPressed: started == null ? _start : null, child: const Text('开始')),
              const SizedBox(width: 12),
              OutlinedButton(onPressed: started != null ? _stop : null, child: const Text('停止')),
            ]),
            const SizedBox(height: 16),
            Text('已运行 ${minutes.toStringAsFixed(1)} 分钟'),
            Text('能量触发 ${_trigger.count} 次（$per10/10min）'),
            Text('当前 RMS ${_lastRms.round()}'),
          ]),
        ),
      ),
    );
  }
}
