import 'package:flutter/material.dart';

/// Native UI drawn over the WebView avatar. Large text and touch targets (≥18 sp, ≥60 dp).
class AvatarOverlay extends StatelessWidget {
  const AvatarOverlay({
    super.key,
    required this.userLine,
    required this.aiLine,
    required this.status,
    required this.error,
    required this.muted,
    required this.onMute,
    required this.onEnd,
    required this.onToggleDebug,
    this.debugPanel,
  });

  final String userLine;
  final String aiLine;
  final String status;
  final String? error;
  final bool muted;
  final VoidCallback onMute;
  final VoidCallback onEnd;
  final VoidCallback onToggleDebug;
  final Widget? debugPanel;

  @override
  Widget build(BuildContext context) {
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
                child: const Text('AI 虚拟人', style: TextStyle(color: Colors.white, fontSize: 16)),
              ),
            ),
          ),
          if (status.isNotEmpty)
            Positioned(
              top: 16,
              right: 12,
              child: Text(status, style: const TextStyle(color: Colors.amberAccent, fontSize: 16)),
            ),
          Positioned(
            left: 16,
            right: 16,
            bottom: 104,
            child: Container(
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
                child: Text(error!, style: const TextStyle(color: Colors.white, fontSize: 20)),
              ),
            ),
          if (debugPanel != null) Positioned(top: 56, left: 8, right: 8, child: debugPanel!),
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
