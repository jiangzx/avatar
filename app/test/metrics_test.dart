import 'package:avatar_app/metrics.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('nearest-rank percentiles', () {
    final s = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
    expect(percentile(s, 50), 5.0);
    expect(percentile(s, 90), 9.0);
    expect(percentile([7.0], 90), 7.0);
  });

  test('summarizes per metric and exports CSV', () {
    final m = MetricsStore();
    final t = DateTime.utc(2026, 10, 12, 8);
    for (final v in [300.0, 100.0, 200.0]) {
      m.add('interrupt_stop_ms', v, at: t);
    }
    m.add('greeting_ms', 900, at: t);
    final s = m.summary();
    expect(s['interrupt_stop_ms']!.count, 3);
    expect(s['interrupt_stop_ms']!.p50, 200);
    expect(s['interrupt_stop_ms']!.p90, 300);
    expect(m.toCsv().split('\n').first, 'time,name,ms');
    expect(m.toCsv().split('\n')[1], '2026-10-12T08:00:00.000Z,interrupt_stop_ms,300');
  });
}
