# Qwen 文本摘要协议核对

日期：2026-10-14

## 已核对事实

来源：阿里云百炼官方文档“兼容 OpenAI API”页面（访问日期 2026-10-14）。

- 北京地域 endpoint 形态为 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`；workspace 和地域必须与 API Key 匹配。
- 鉴权为 `Authorization: Bearer DASHSCOPE_API_KEY`。
- 请求使用 OpenAI-compatible JSON：`model` 和 `messages`；响应文本位于 `choices[0].message.content`。
- 仓库实现 `QwenSummarizer` 使用显式 `QWEN_SUMMARIZER_ENDPOINT` 和 `QWEN_SUMMARIZER_MODEL`，默认后端仍是 `MockSummarizer`。

## 验证范围

- 已用本地 HTTP fixture 验证请求方法、Bearer 头、模型字段、消息角色、响应解析、非 2xx 错误和脱敏错误码。
- 未使用真实 DASHSCOPE Key 或 workspace endpoint；因此真实摘要延迟、配额、模型可用性和返回长度限制仍未验证。
- 测试和日志不输出对话文本或 Key。

## 参考

- https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope
