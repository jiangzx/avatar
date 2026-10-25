import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// SPIKE=duix_probe: shows whether this build and phone can run the Duix renderer.
class DuixProbeSpikePage extends StatefulWidget {
  const DuixProbeSpikePage({super.key});

  @override
  State<DuixProbeSpikePage> createState() => _DuixProbeSpikePageState();
}

class _DuixProbeSpikePageState extends State<DuixProbeSpikePage> {
  static const _channel = MethodChannel('anyidea/duix');
  String _result = '检测中…';

  @override
  void initState() {
    super.initState();
    _probe();
  }

  Future<void> _probe() async {
    String text;
    try {
      final r = await _channel.invokeMapMethod<String, Object?>('probe', {'minTotalMemMb': 7000});
      text = 'supported=${r?['supported']} reason=${r?['reason'] ?? 'none'}';
    } on PlatformException catch (e) {
      text = 'error=${e.code}';
    } on MissingPluginException {
      text = 'error=missing_plugin';
    }
    if (mounted) setState(() => _result = text);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(child: Text(_result, style: const TextStyle(fontSize: 22))),
  );
}
