import 'package:flutter/material.dart';

import '../avatar_engine/ui/engine_copy.dart';
import 'companion_picker.dart';
import 'device_identity.dart';
import 'styles.dart';

/// Plain-language text for identity failure reasons.
String identityErrorText(String reason) => switch (reason) {
  'network' => '网络连接失败，请检查网络后再试',
  'storage' => '手机保存身份信息失败，请重试',
  'http_400' => '这个伙伴暂时不可用，请换一个',
  'http_401' => '应用配置有误，请联系家人',
  'invalid_avatar' => '这个形象暂时不可用，请换一个',
  'abi_unsupported' || 'low_memory' || 'storage_unavailable' || 'duix_unsupported' => unsupportedText(
    reason == 'duix_unsupported' ? null : reason,
  ),
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
              Text(
                widget.title,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 26,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 24),
              Expanded(
                child: ListView(
                  children: [
                    for (final option in styleOptions)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 16),
                        child: SelectionCard(
                          option: option,
                          selected: option.id == _selected,
                          keyPrefix: 'style',
                          onTap: widget.busy
                              ? null
                              : () => setState(() => _selected = option.id),
                        ),
                      ),
                    if (error != null)
                      Text(
                        error,
                        style: const TextStyle(
                          color: Colors.amberAccent,
                          fontSize: 18,
                        ),
                      ),
                  ],
                ),
              ),
              SizedBox(
                height: 64,
                child: FilledButton(
                  key: const Key('style-confirm'),
                  onPressed: widget.busy
                      ? null
                      : () => widget.onConfirm(_selected),
                  child: widget.busy
                      ? Semantics(
                          label: '正在保存',
                          child: SizedBox(
                            width: 28,
                            height: 28,
                            child: CircularProgressIndicator(strokeWidth: 3),
                          ),
                        )
                      : Text(
                          widget.confirmLabel,
                          style: const TextStyle(fontSize: 22),
                        ),
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

/// Settings: change the style via PATCH /agent/style. Pops with the new style id, or null.
class StyleSettingsPage extends StatefulWidget {
  const StyleSettingsPage({
    super.key,
    required this.identity,
    required this.current,
  });

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
