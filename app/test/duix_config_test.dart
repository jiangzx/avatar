import 'dart:convert';
import 'dart:io';

import 'package:avatar_app/duix/duix_config.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> rawConfig() =>
    jsonDecode(File('assets/config/duix.json').readAsStringSync()) as Map<String, Object?>;

void expectInvalid(Map<String, Object?> raw, String code) {
  expect(
    () => DuixConfig.parse(jsonEncode(raw)),
    throwsA(isA<FormatException>().having((e) => e.message, 'message', code)),
  );
}

void main() {
  test('the shipped config parses with the pinned assets', () {
    final cfg = DuixConfig.parse(File('assets/config/duix.json').readAsStringSync());
    expect(cfg.enabled, isTrue);
    expect(cfg.debugOnly, isFalse);
    expect(cfg.model.dir, 'Lily');
    expect(cfg.assets.map((a) => a.id), ['gj_dh_res', 'lily']);
    expect(cfg.totalBytes, 139403482 + 35062448);
    expect(cfg.base.sha256, 'c3ffeca1cb250f111f70e9e221d9115c9a825a625eff9b93d260ef7da70a5457');
    expect(cfg.model.sha256, '9ec390b42b02594470dad69d87841ebbbdfbc0b22803c60092aba8cd9c5a556b');
    expect(cfg.minSegmentMs, 1000);
    expect(cfg.bargeInThresholdRms, 200);
  });

  test('asset args carry exactly what the installer needs', () {
    final cfg = DuixConfig.parse(File('assets/config/duix.json').readAsStringSync());
    expect(cfg.model.toArgs().keys, unorderedEquals(['id', 'dir', 'url', 'sha256', 'bytes']));
  });

  test('rejects non-https urls, bad hashes and unsafe dirs', () {
    final raw = rawConfig();
    final base = Map<String, Object?>.from(raw['base']! as Map);
    expectInvalid({...raw, 'base': {...base, 'url': 'http://x/y.zip'}}, 'asset_url_invalid');
    expectInvalid({...raw, 'base': {...base, 'sha256': 'ABC'}}, 'asset_sha256_invalid');
    expectInvalid({...raw, 'base': {...base, 'dir': 'other'}}, 'base_dir_invalid');
    final model = Map<String, Object?>.from((raw['models']! as List).first as Map);
    expectInvalid({...raw, 'models': [{...model, 'dir': '../Lily'}]}, 'asset_dir_invalid');
    expectInvalid({...raw, 'models': [{...model, 'bytes': 0}]}, 'asset_bytes_invalid');
  });

  test('rejects an unlisted default model and out-of-range numbers', () {
    final raw = rawConfig();
    expectInvalid({...raw, 'defaultModel': 'nobody'}, 'default_model_not_listed');
    expectInvalid({...raw, 'minTotalMemMb': 100}, 'minTotalMemMb_out_of_range');
    expectInvalid({...raw, 'playback': {'minSegmentMs': 700, 'lipReadyTimeoutMs': 1500, 'prepareTimeoutMs': 60000}}, 'minSegmentMs_out_of_range');
    expectInvalid({...raw, 'vad': {'bargeInThresholdRms': 10, 'bargeInGraceMs': 400}}, 'bargeInThresholdRms_out_of_range');
    expectInvalid({...raw, 'statsIntervalMs': 10}, 'statsIntervalMs_out_of_range');
  });

  test('rejects non-json and missing sections', () {
    expect(() => DuixConfig.parse('nope'), throwsFormatException);
    final raw = rawConfig()..remove('playback');
    expectInvalid(raw, 'missing_playback');
  });
}
