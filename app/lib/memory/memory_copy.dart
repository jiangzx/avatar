// Settings memory copy (spec 产品设计「设置页」, 附录 B). Never shown below 18 sp.

// From 附录 B.
const addressingDeclinedText = '您选了不让伙伴记事，所以不能保存称呼。想恢复的话，直接跟伙伴说「可以记住」就行。';
const deleteFailedText = '没删成功，请再试一次。';
String clearCharacterConfirm(String name) => '清除后，$name会忘掉和您聊过的事，不能恢复。确定清除吗？';
const clearAllConfirm = '清除后，所有伙伴都会忘掉和您聊过的事，也会忘掉您的基本资料，不能恢复。确定清除吗？';
const clearCancel = '先不清除';
const clearOk = '确定清除';

// Section titles and buttons (spec 设置页 tree).
const profileSectionTitle = '我的资料';
String characterMemoryTitle(String name) => '$name记得的事';
const pinnedTitle = '钉住的事';
const otherMemoryTitle = '其他记忆';
const clearProfileLabel = '清除我的基本资料';
String clearCharacterLabel(String name) => '清除$name的记忆';
const clearAllLabel = '清除全部记忆';

// New in this task (pending user review).
const addressingLabel = '称呼';
const addressingEmpty = '还没有';
const addressingEditLabel = '修改称呼';
const addressingDialogTitle = '您希望伙伴怎么称呼您？';
const addressingHint = '比如：王叔、李阿姨';
const addressingEmptyError = '称呼不能是空的';
const addressingRejectedText = '这个称呼存不了，请换一个说法。';
const saveFailedText = '没保存成功，请再试一次。';
const profileItemsEmpty = '还没有基本资料';
const memoryListEmpty = '还没有';
const clearProfileConfirm = '清除后，所有伙伴都会忘掉您的称呼和基本资料，不能恢复。确定清除吗？';
const deleteItemConfirm = '删除这一条吗？相关聊天原话会一起删除，不能恢复。';
const deleteLabel = '删除';
const deleteCancel = '先不删';
const deleteOk = '确定删除';
const memoryLoadFailedText = '记得的事暂时打不开，请稍后再试。';
const memoryRetry = '重试';
const dialogCancel = '取消';
const dialogSave = '保存';
