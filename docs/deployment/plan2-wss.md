# Plan 2 WSS 部署运行手册

此文档只描述可验证的部署边界，不包含域名、证书、模型 Key 或 App Secret。

## 网关进程

在境内云主机上设置以下环境变量后启动 Node 24 网关：

- `APP_SECRET`：随机长密钥，仅由网关和 APK 的构建注入使用。
- `ADAPTER=seeduplex` 或 `ADAPTER=qwen`。
- Seeduplex：`SEEDUPLEX_API_KEY`、可选 endpoint/model/voice。
- Qwen：`DASHSCOPE_API_KEY`、`QWEN_ENDPOINT`、model/voice。
- `PORT` 绑定回环地址，由反向代理对外提供 TLS。

网关本身只接受现有 HTTP/WS 协议；反向代理负责 TLS/WSS、连接升级和 IP 白名单。代理不得记录 WebSocket payload。

## 反向代理验收

部署后只记录以下脱敏结果：

1. HTTPS `GET /health` 返回状态码和耗时。
2. `POST /session` 使用正确 App Secret 返回状态码，不打印响应 token。
3. WSS 升级返回状态码；网关日志只出现事件名、会话计数、字节数和错误码。
4. 关闭代理或网关后，客户端按既有 resume 流程恢复；验证 `session.resumed` 和旧 response 序号门控。

未提供云主机、域名、证书和 IP 白名单，因此本机不能宣称云端 WSS 已验收。部署时必须先补齐这些外部条件，再执行上述命令。
