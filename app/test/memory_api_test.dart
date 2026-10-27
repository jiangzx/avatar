import 'package:avatar_app/memory/memory_api.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/memory_fakes.dart';

Matcher failedWith(String reason) => isA<MemoryFailed>().having((f) => f.reason, 'reason', reason);

void main() {
  late FakeMemoryTransport transport;
  late FakeTokens tokens;
  late List<String> lines;

  MemoryApi api() => testMemoryApi(transport, tokens, diag: lines.add);

  setUp(() {
    transport = FakeMemoryTransport();
    tokens = FakeTokens('device-token-0123456789', renewed: 'new-token-0123456789');
    lines = [];
  });

  test('overview reads every group with the device bearer', () async {
    final overview = (await api().overview() as MemoryOk<MemoryOverview>).value;
    expect(transport.calls, ['GET /memory']);
    expect(transport.bearers, ['device-token-0123456789']);
    expect(overview.addressing!.text, '王叔');
    expect(overview.profileItems.single.text, '家在天津');
    expect(overview.characters.map((c) => c.character), ['xiaonuan', 'xiaokai', 'xiaoxin']);
    final nuan = overview.forCharacter('xiaonuan')!;
    expect(nuan.pinned.single.text, '周三去医院复查');
    expect(nuan.pinned.single.sensitive, isTrue);
    expect(nuan.facts.map((f) => f.category), ['preference', 'health']);
    expect(nuan.facts.last.sensitive, isTrue);
    expect(overview.forCharacter('xiaokai')!.facts, isEmpty);
    expect(overview.forCharacter('lily'), isNull);
  });

  test('a missing addressing reads as null', () async {
    (transport.overview['profile']! as Map)['addressing'] = null;
    final overview = (await api().overview() as MemoryOk<MemoryOverview>).value;
    expect(overview.addressing, isNull);
  });

  test('a body that does not match the contract is a bad response', () async {
    transport.overview = {'profile': {'addressing': null, 'items': <Object?>[]}};
    expect(await api().overview(), failedWith('bad_response'));
    final badCategory = sampleOverviewJson();
    ((badCategory['characters']! as List).first['facts'] as List).first['category'] = 'secret';
    expect(MemoryOverview.fromJson(badCategory), isNull);
    final badPinned = sampleOverviewJson();
    ((badPinned['characters']! as List).first['pinned'] as List).first.remove('sensitive');
    expect(MemoryOverview.fromJson(badPinned), isNull);
    expect(MemoryOverview.fromJson('not a map'), isNull);
  });

  test('setAddressing PUTs the trimmed name and maps 409 and 400', () async {
    expect(await api().setAddressing('  老王 '), isA<MemoryOk<void>>());
    expect(transport.calls.last, 'PUT /memory/addressing');
    expect(transport.bodies.last, {'text': '老王'});
    transport.statuses.add(409);
    expect(await api().setAddressing('老王'), failedWith('declined'));
    transport.statuses.add(400);
    expect(await api().setAddressing('老王'), failedWith('rejected'));
  });

  test('setAddressing rejects empty and over-long names without a request', () async {
    expect(await api().setAddressing('   '), failedWith('rejected'));
    expect(await api().setAddressing('一' * 21), failedWith('rejected'));
    expect(transport.calls, isEmpty);
    expect(await api().setAddressing('一' * 20), isA<MemoryOk<void>>());
    expect(transport.calls, ['PUT /memory/addressing']);
  });

  test('deleteItem encodes the id and maps 404', () async {
    expect(await api().deleteItem('p1'), isA<MemoryOk<void>>());
    expect(transport.calls.last, 'DELETE /memory/items/p1');
    expect(await api().deleteItem('p1'), failedWith('not_found'));
    await api().deleteItem('a/b');
    expect(transport.calls.last, 'DELETE /memory/items/a%2Fb');
    expect(await api().deleteItem(''), failedWith('rejected'));
  });

  test('clear sends the scope and the character as query parameters', () async {
    await api().clear(MemoryClearScope.profile);
    await api().clear(MemoryClearScope.character, character: 'xiaokai');
    await api().clear(MemoryClearScope.all);
    expect(transport.calls, [
      'DELETE /memory?scope=profile',
      'DELETE /memory?scope=character&character=xiaokai',
      'DELETE /memory?scope=all',
    ]);
    expect(await api().clear(MemoryClearScope.character), failedWith('rejected'));
    expect(await api().clear(MemoryClearScope.all, character: 'xiaokai'), failedWith('rejected'));
    expect(transport.calls, hasLength(3));
  });

  test('a 401 renews the device token once and retries', () async {
    transport.statuses.add(401);
    expect(await api().overview(), isA<MemoryOk<MemoryOverview>>());
    expect(transport.bearers, ['device-token-0123456789', 'new-token-0123456789']);
    expect(tokens.renewCalls, 1);
  });

  test('a second 401, or a failed renew, is unauthorized', () async {
    transport.statuses.addAll([401, 401]);
    expect(await api().deleteItem('p1'), failedWith('unauthorized'));
    expect(transport.calls, hasLength(2));
    tokens = FakeTokens('device-token-0123456789'); // renew returns null
    transport.statuses.add(401);
    expect(await api().deleteItem('p1'), failedWith('unauthorized'));
    expect(transport.calls, hasLength(3));
  });

  test('network errors are reported, not thrown', () async {
    transport.throwNetwork = true;
    expect(await api().overview(), failedWith('network'));
    expect(await api().clear(MemoryClearScope.all), failedWith('network'));
  });

  test('diagnostics carry the operation and status only, never memory text', () async {
    await api().overview();
    await api().setAddressing('老王');
    expect(lines, [
      'anyidea.diag event=memory_api op=overview status=200',
      'anyidea.diag event=memory_api op=set_addressing status=204',
    ]);
    expect(lines.join(), isNot(contains('王')));
  });
}
