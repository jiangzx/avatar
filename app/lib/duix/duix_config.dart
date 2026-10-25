import 'dart:convert';

/// One downloadable Duix package; [dir] is its top-level folder inside the zip.
class DuixAsset {
  const DuixAsset({required this.id, required this.dir, required this.url, required this.sha256, required this.bytes});

  final String id;
  final String dir;
  final String url;
  final String sha256;
  final int bytes;

  Map<String, Object> toArgs() => {'id': id, 'dir': dir, 'url': url, 'sha256': sha256, 'bytes': bytes};
}

/// Duix engine settings (assets/config/duix.json). Ranges match DuixRuntimeConfig.kt.
class DuixConfig {
  const DuixConfig({
    required this.enabled,
    required this.debugOnly,
    required this.minTotalMemMb,
    required this.maxUncleanExits,
    required this.base,
    required this.models,
    required this.defaultModel,
    required this.minSegmentMs,
    required this.lipReadyTimeoutMs,
    required this.prepareTimeoutMs,
    required this.bargeInThresholdRms,
    required this.bargeInGraceMs,
    required this.statsIntervalMs,
  });

  static const assetPath = 'assets/config/duix.json';

  /// The SDK hard-codes this base resource folder.
  static const baseDir = 'gj_dh_res';

  final bool enabled;

  /// Hides Duix in release builds, e.g. while telemetry removal is unverified.
  final bool debugOnly;
  final int minTotalMemMb;
  final int maxUncleanExits;
  final DuixAsset base;
  final List<DuixAsset> models;
  final String defaultModel;
  final int minSegmentMs;
  final int lipReadyTimeoutMs;
  final int prepareTimeoutMs;
  final double bargeInThresholdRms;
  final int bargeInGraceMs;
  final int statsIntervalMs;

  DuixAsset get model => models.firstWhere((m) => m.id == defaultModel);

  /// Install order: shared base resources first, then the model.
  List<DuixAsset> get assets => [base, model];

  int get totalBytes => assets.fold(0, (sum, a) => sum + a.bytes);

  static DuixConfig parse(String source) {
    final Object? raw;
    try {
      raw = jsonDecode(source);
    } on FormatException {
      throw const FormatException('duix_config_not_json');
    }
    if (raw is! Map<String, Object?>) throw const FormatException('duix_config_not_object');
    final playback = _map(raw, 'playback');
    final vad = _map(raw, 'vad');
    final base = _asset(raw['base']);
    if (base.dir != baseDir) throw const FormatException('base_dir_invalid');
    final modelsRaw = raw['models'];
    if (modelsRaw is! List || modelsRaw.isEmpty) throw const FormatException('models_invalid');
    final models = [for (final m in modelsRaw) _asset(m)];
    final ids = {base.id, ...models.map((m) => m.id)};
    if (ids.length != models.length + 1) throw const FormatException('duplicate_asset_id');
    if (models.any((m) => m.dir == baseDir)) throw const FormatException('asset_dir_invalid');
    final defaultModel = raw['defaultModel'];
    if (defaultModel is! String || !models.any((m) => m.id == defaultModel)) {
      throw const FormatException('default_model_not_listed');
    }
    return DuixConfig(
      enabled: _bool(raw, 'enabled'),
      debugOnly: _bool(raw, 'debugOnly'),
      minTotalMemMb: _int(raw, 'minTotalMemMb', 2000, 32000),
      maxUncleanExits: _int(raw, 'maxUncleanExits', 1, 10),
      base: base,
      models: models,
      defaultModel: defaultModel,
      minSegmentMs: _int(playback, 'minSegmentMs', 800, 3000),
      lipReadyTimeoutMs: _int(playback, 'lipReadyTimeoutMs', 500, 5000),
      prepareTimeoutMs: _int(playback, 'prepareTimeoutMs', 5000, 180000),
      bargeInThresholdRms: _num(vad, 'bargeInThresholdRms', 50, 2000),
      bargeInGraceMs: _int(vad, 'bargeInGraceMs', 0, 2000),
      statsIntervalMs: _int(raw, 'statsIntervalMs', 1000, 60000),
    );
  }
}

final _token = RegExp(r'^[A-Za-z0-9_-]{1,64}$');
final _sha256 = RegExp(r'^[0-9a-f]{64}$');
const _maxAssetBytes = 2 * 1024 * 1024 * 1024;

DuixAsset _asset(Object? raw) {
  if (raw is! Map) throw const FormatException('asset_invalid');
  final id = raw['id'];
  final dir = raw['dir'];
  final url = raw['url'];
  final sha = raw['sha256'];
  final bytes = raw['bytes'];
  if (id is! String || !_token.hasMatch(id)) throw const FormatException('asset_id_invalid');
  if (dir is! String || !_token.hasMatch(dir)) throw const FormatException('asset_dir_invalid');
  if (url is! String || !url.startsWith('https://') || Uri.tryParse(url) == null) {
    throw const FormatException('asset_url_invalid');
  }
  if (sha is! String || !_sha256.hasMatch(sha)) throw const FormatException('asset_sha256_invalid');
  if (bytes is! int || bytes <= 0 || bytes > _maxAssetBytes) throw const FormatException('asset_bytes_invalid');
  return DuixAsset(id: id, dir: dir, url: url, sha256: sha, bytes: bytes);
}

Map<String, Object?> _map(Map<String, Object?> m, String key) {
  final v = m[key];
  if (v is! Map<String, Object?>) throw FormatException('missing_$key');
  return v;
}

bool _bool(Map<String, Object?> m, String key) {
  final v = m[key];
  if (v is! bool) throw FormatException('${key}_invalid');
  return v;
}

int _int(Map<String, Object?> m, String key, int min, int max) {
  final v = m[key];
  if (v is! int || v < min || v > max) throw FormatException('${key}_out_of_range');
  return v;
}

double _num(Map<String, Object?> m, String key, double min, double max) {
  final v = m[key];
  if (v is! num || v < min || v > max) throw FormatException('${key}_out_of_range');
  return v.toDouble();
}
