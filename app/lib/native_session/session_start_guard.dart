/// Invalidates an in-flight async session start when the page ends or starts another.
/// The page also checks `mounted`; this covers End during the same route's lifetime.
class SessionStartGuard {
  int _epoch = 0;
  bool _ended = false;

  bool get ended => _ended;

  /// Returns -1 when the page has already ended and no start may begin.
  int begin() => _ended ? -1 : ++_epoch;

  bool isCurrent(int token) => !_ended && token == _epoch;

  void end() {
    _ended = true;
    _epoch++;
  }

  /// A new session after the user ends and taps "keep chatting".
  void reset() {
    _ended = false;
    _epoch++;
  }
}
