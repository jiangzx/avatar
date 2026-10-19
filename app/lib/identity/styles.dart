/// Styles of the elder-companion role. Ids must match the gateway RoleCatalog style ids.
import 'companion_picker.dart';

class StyleOption implements PickerOption {
  const StyleOption({required this.id, required this.title, required this.subtitle, this.sampleAsset});

  final String id;
  final String title;
  final String subtitle;

  /// Sample voice clip. Null until Plan A picks per-style voices and records samples (spec assumptions 2 and 4).
  final String? sampleAsset;
}

const defaultStyleId = 'grandchild';

const styleOptions = <StyleOption>[
  StyleOption(id: 'grandchild', title: '孙辈型', subtitle: '像孙子孙女一样，爱撒娇、好奇，陪您聊家常'),
  StyleOption(id: 'old-friend', title: '老朋友型', subtitle: '像多年的老朋友，稳重贴心，陪您说说心里话'),
];
