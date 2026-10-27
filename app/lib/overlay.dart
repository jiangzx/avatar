import 'package:flutter/material.dart';

/// Native UI drawn over the avatar. Large text and touch targets (≥18 sp, ≥60 dp).
class AvatarOverlay extends StatelessWidget {
  const AvatarOverlay({
    super.key,
    required this.userLine,
    required this.aiLine,
    required this.status,
    required this.error,
    required this.muted,
    required this.name,
    required this.onMute,
    required this.onEnd,
    required this.onToggleDebug,
    this.onRetry,
    this.debugPanel,
    this.presence,
    this.caption,
    this.toast,
  });

  final String userLine;
  final String aiLine;
  final String status;
  final String? error;
  final bool muted;

  /// The character on screen. Long-press opens the debug panel.
  final String name;
  final VoidCallback onMute;
  final VoidCallback onEnd;
  final VoidCallback onToggleDebug;
  final VoidCallback? onRetry;
  final Widget? debugPanel;

  /// Optional status pill shown just above the subtitle card.
  final Widget? presence;

  /// Always-on AI notice under the top row (spec「AI 提示」); null hides it.
  final String? caption;

  /// Rest-reminder text above the subtitles; null hides it.
  final String? toast;

  @override
  Widget build(BuildContext context) {
    final error = this.error;
    final presence = this.presence;
    final debugPanel = this.debugPanel;
    final caption = this.caption;
    final toast = this.toast;
    return SafeArea(
      child: Stack(
        children: [
          Positioned(
            top: 12,
            left: 12,
            child: GestureDetector(
              onLongPress: onToggleDebug,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(16)),
                child: Text(name, style: const TextStyle(color: Colors.white, fontSize: 16)),
              ),
            ),
          ),
          if (status.isNotEmpty)
            Positioned(
              top: 16,
              right: 12,
              child: Text(status, style: const TextStyle(color: Colors.amberAccent, fontSize: 16)),
            ),
          if (caption != null)
            // Below the name and status row, above the face; never takes taps.
            Positioned(
              top: 52,
              left: 12,
              right: 12,
              child: IgnorePointer(
                child: Center(
                  child: Container(
                    key: const Key('ai-caption'),
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                    decoration: BoxDecoration(color: const Color(0x42000000), borderRadius: BorderRadius.circular(12)),
                    child: Text(
                      caption,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: Color(0xCCFFFFFF), fontSize: 18),
                    ),
                  ),
                ),
              ),
            ),
          Positioned(
            left: 16,
            right: 16,
            bottom: 104,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (toast != null) ...[
                  Container(
                    key: const Key('rest-toast'),
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: const Color(0xE6203A38),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: Colors.tealAccent),
                    ),
                    child: Text(toast, style: const TextStyle(color: Colors.white, fontSize: 20)),
                  ),
                  const SizedBox(height: 8),
                ],
                if (presence != null) ...[
                  Align(alignment: Alignment.centerLeft, child: presence),
                  const SizedBox(height: 8),
                ],
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(12)),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (userLine.isNotEmpty) Text(userLine, style: const TextStyle(color: Colors.white70, fontSize: 18)),
                      if (aiLine.isNotEmpty) Text(aiLine, style: const TextStyle(color: Colors.white, fontSize: 20)),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 24,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                _RoundButton(key: const Key('mute'), icon: muted ? Icons.mic_off : Icons.mic, color: Colors.white24, onTap: onMute),
                const SizedBox(width: 40),
                _RoundButton(key: const Key('end'), icon: Icons.call_end, color: Colors.redAccent, onTap: onEnd),
              ],
            ),
          ),
          if (error != null)
            Center(
              child: Container(
                margin: const EdgeInsets.all(24),
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(color: Colors.black87, borderRadius: BorderRadius.circular(12)),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(error, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 20)),
                    if (onRetry != null) ...[
                      const SizedBox(height: 12),
                      TextButton(key: const Key('retry'), onPressed: onRetry, child: const Text('重试')),
                    ],
                  ],
                ),
              ),
            ),
          if (debugPanel != null) Positioned(top: 128, left: 8, right: 8, child: debugPanel),
        ],
      ),
    );
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({super.key, required this.icon, required this.color, required this.onTap});

  final IconData icon;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: color,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: SizedBox(width: 64, height: 64, child: Icon(icon, color: Colors.white, size: 32)),
      ),
    );
  }
}
