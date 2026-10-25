import '../avatar_engine.dart';

// User-facing copy for the engine switch (spec §6). Never says "Duix".

const engineLabels = {AvatarEngineKind.webview: '3D 形象', AvatarEngineKind.duix: '真人形象'};

String confirmTitle(AvatarEngineKind target) => '换成${engineLabels[target]}？';
const confirmBody = '这次聊天会先结束，然后用新形象重新开始。';
const confirmCancel = '先不换';
const confirmOk = '现在换';

String unsupportedText(String? reason) => switch (reason) {
  'abi_unsupported' || 'low_memory' => '这台手机暂时用不了真人形象（需要 64 位、8GB 以上内存的手机）',
  'storage_unavailable' => '手机存储暂时不可用，真人形象打不开',
  _ => '这个版本暂时用不了真人形象',
};

const fallbackText = '真人形象没能打开，先用 3D 形象陪您聊';
const crashDisabledText = '真人形象上次出了问题，先换回 3D 形象';
const duixReadyText = '真人形象准备好了';
const duixReadyAction = '现在换';

const downloadTitle = '下载真人形象';
int megabytes(int bytes) => (bytes / 1000000).round();
String downloadBody(int totalBytes) => '需要下载约 ${megabytes(totalBytes)}MB，建议连上 Wi-Fi 再下载。';
String downloadProgress(int received, int total) => '已下载 ${megabytes(received)}MB / ${megabytes(total)}MB';
const downloadStart = '开始下载';
const downloadLater = '以后再说';
const downloadCancel = '取消下载';
const downloadPreparing = '正在准备…';
const downloadRetry = '重试';
String downloadFailed(String code) => code == 'no_space' ? '手机存储空间不够，请清理后重试' : '下载没成功，请检查网络后重试';
const readySwitchNow = '现在换（会重新开始聊天）';
const readyLater = '稍后';
