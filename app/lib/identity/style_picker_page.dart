import 'package:flutter/material.dart';

import 'device_identity.dart';
import 'styles.dart';

/// Plain-language text for identity failure reasons.
String identityErrorText(String reason) => switch (reason) {
  'network' => '网络连接失败，请检查网络后再试',
  'storage' => '手机保存身份信息失败，请重试',
  'http_400' => '这个伙伴暂时不可用，请换一个',
  'http_401' => '应用配置有误，请联系家人',
  'http_429' || 'http_503' => '现在注册的人太多了，请稍后再试',
  _ => '出错了（$reason），请稍后再试',
};

/// Two large cards (≥60 dp targets, ≥18 sp text) and one confirm button. First launch and settings.
class StylePickerPage extends StatefulWidget {
  const StylePickerPage({
    super.key,
    required this.title,
    required this.confirmLabel,
    required this.initial,
    required this.onConfirm,
    this.onCancel,
    this.busy = false,
    this.error,
  });

  final String title;
  final String confirmLabel;
  final String initial;
  final ValueChanged<String> onConfirm;
  final VoidCallback? onCancel;
  final bool busy;
  final String? error;

  @override
  State<StylePickerPage> createState() => _StylePickerPageState();
}

class _StylePickerPageState extends State<StylePickerPage> {
  late String _selected = widget.initial;

  @override
  Widget build(BuildContext context) {
    final error = widget.error;
    return Scaffold(
      backgroundColor: const Color(0xFF10131A),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(widget.title, style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.bold)),
              const SizedBox(height: 24),
              Expanded(
                child: ListView(
                  children: [
                    for (final option in styleOptions)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 16),
                        child: _StyleCard(
                          option: option,
                          selected: option.id == _selected,
                          onTap: widget.busy ? null : () => setState(() => _selected = option.id),
                        ),
                      ),
                    if (error != null) Text(error, style: const TextStyle(color: Colors.amberAccent, fontSize: 18)),
                  ],
                ),
              ),
              SizedBox(
                height: 64,
                child: FilledButton(
                  key: const Key('style-confirm'),
                  onPressed: widget.busy ? null : () => widget.onConfirm(_selected),
                  child: widget.busy
                      ? const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3))
                      : Text(widget.confirmLabel, style: const TextStyle(fontSize: 22)),
                ),
              ),
              if (widget.onCancel != null) ...[
                const SizedBox(height: 12),
                SizedBox(
                  height: 60,
                  child: TextButton(
                    key: const Key('style-cancel'),
                    onPressed: widget.busy ? null : widget.onCancel,
                    child: const Text('返回', style: TextStyle(fontSize: 20)),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _StyleCard extends StatelessWidget {
  const _StyleCard({required this.option, required this.selected, required this.onTap});

  final StyleOption option;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      key: Key('style-${option.id}'),
      color: selected ? const Color(0xFF1F3B3A) : const Color(0xFF1B1F2A),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: selected ? Colors.tealAccent : Colors.white24, width: selected ? 3 : 1),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(option.title, style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 8),
                    Text(option.subtitle, style: const TextStyle(color: Colors.white70, fontSize: 18)),
                  ],
                ),
              ),
              if (selected) const Icon(Icons.check_circle, color: Colors.tealAccent, size: 36),
            ],
          ),
        ),
      ),
    );
  }
}

/// Settings: change the style via PATCH /agent/style. Pops with the new style id, or null.
class StyleSettingsPage extends StatefulWidget {
  const StyleSettingsPage({super.key, required this.identity, required this.current});

  final DeviceIdentity identity;
  final String current;

  @override
  State<StyleSettingsPage> createState() => _StyleSettingsPageState();
}

class _StyleSettingsPageState extends State<StyleSettingsPage> {
  bool _busy = false;
  String? _error;

  Future<void> _save(String style) async {
    if (style == widget.current) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final result = await widget.identity.changeStyle(style);
    if (!mounted) return;
    switch (result) {
      case IdentityOk():
        Navigator.of(context).pop(style);
      case IdentityFailed(:final reason):
        setState(() {
          _busy = false;
          _error = identityErrorText(reason);
        });
    }
  }

  @override
  Widget build(BuildContext context) => StylePickerPage(
    title: '换一位聊天伙伴',
    confirmLabel: '保存',
    initial: widget.current,
    busy: _busy,
    error: _error,
    onConfirm: _save,
    onCancel: () => Navigator.of(context).pop(),
  );
}
