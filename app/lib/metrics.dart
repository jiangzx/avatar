class MetricSummary {
  const MetricSummary(this.count, this.p50, this.p90);
  final int count;
  final double p50;
  final double p90;
}

/// Nearest-rank percentile of an ascending list.
double percentile(List<double> sorted, double p) {
  if (sorted.isEmpty) return 0;
  final rank = (p / 100 * sorted.length).ceil().clamp(1, sorted.length);
  return sorted[rank - 1];
}

/// Collects latency samples on device (timings only, no conversation content).
class MetricsStore {
  final _rows = <(DateTime, String, double)>[];

  void add(String name, double ms, {DateTime? at}) => _rows.add(((at ?? DateTime.now()).toUtc(), name, ms));

  Map<String, MetricSummary> summary() {
    final byName = <String, List<double>>{};
    for (final (_, name, ms) in _rows) {
      byName.putIfAbsent(name, () => []).add(ms);
    }
    return byName.map((name, values) {
      values.sort();
      return MapEntry(name, MetricSummary(values.length, percentile(values, 50), percentile(values, 90)));
    });
  }

  String toCsv() {
    final b = StringBuffer('time,name,ms');
    for (final (at, name, ms) in _rows) {
      b.write('\n${at.toIso8601String()},$name,${ms.round()}');
    }
    return b.toString();
  }
}
