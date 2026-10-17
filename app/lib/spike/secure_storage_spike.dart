import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Spec assumption 9 probe: a value written to Keystore-backed storage survives an app restart.
/// The probe value is a random nonce, not a credential, so it may be printed.
class SecureStorageSpikePage extends StatefulWidget {
  const SecureStorageSpikePage({super.key});

  @override
  State<SecureStorageSpikePage> createState() => _SecureStorageSpikePageState();
}

class _SecureStorageSpikePageState extends State<SecureStorageSpikePage> {
  static const _key = 'spike_probe';
  final _storage = const FlutterSecureStorage();
  String _result = '检测中…';

  @override
  void initState() {
    super.initState();
    _run();
  }

  Future<void> _run() async {
    String result;
    try {
      final existing = await _storage.read(key: _key);
      if (existing == null) {
        final rng = Random.secure();
        final value = List.generate(16, (_) => rng.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
        await _storage.write(key: _key, value: value);
        final back = await _storage.read(key: _key);
        result = back == value ? 'WROTE $value readback=ok' : 'FAIL readback mismatch';
      } else {
        result = 'PERSISTED $existing';
      }
    } catch (e) {
      result = 'FAIL ${e.runtimeType}';
    }
    debugPrint('secure_storage_spike $result');
    if (mounted) setState(() => _result = result);
  }

  Future<void> _clear() async {
    await _storage.delete(key: _key);
    debugPrint('secure_storage_spike CLEARED');
    if (mounted) setState(() => _result = 'CLEARED');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(padding: const EdgeInsets.all(24), child: Text(_result, style: const TextStyle(fontSize: 20))),
            FilledButton(onPressed: _clear, child: const Text('清除', style: TextStyle(fontSize: 20))),
          ],
        ),
      ),
    );
  }
}
