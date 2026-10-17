import 'package:avatar_app/native_session/thinking_config.dart';

Map<String, Object?> thinkingMap({List<String> evidence = const ['transcript']}) => {
      'thinkingSilenceMs': 300,
      'fillerAfterMs': 1200,
      'longWaitAfterMs': 4000,
      'thinkingMaxMs': 20000,
      'tickMs': 50,
      'tailGuardMs': 400,
      'fillerEvidence': evidence,
      'nod': {'firstAfterMs': 1500, 'everyMs': 4000},
      'audio': {'chunkMs': 20, 'maxBufferedMs': 100, 'fadeMs': 40, 'gain': 1.0, 'pumpMs': 10},
      'defaultStyle': 'grandchild',
      'styles': ['grandchild', 'old-friend'],
      'clips': {
        'thinking': [
          {'id': 'think-1', 'text': '嗯，我想想。'},
          {'id': 'think-2', 'text': '嗯，让我想一想。'},
        ],
        'longWait': [
          {'id': 'wait-1', 'text': '稍等我一下啊。'},
        ],
      },
    };

ThinkingConfig testThinking({List<String> evidence = const ['transcript']}) =>
    ThinkingConfig.fromMap(thinkingMap(evidence: evidence));
