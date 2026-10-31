# Plan 2 WSS 部署运行手册

日常启停、密码、健康检查等命令见 [ops-runbook.md](./ops-runbook.md)。

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

1. HTTPS `GET /healthz` 返回状态码和耗时。
2. `POST /session` 使用正确 App Secret 返回状态码，不打印响应 token。
3. WSS 升级返回状态码；网关日志只出现事件名、会话计数、字节数和错误码。
4. 关闭代理或网关后，客户端按既有 resume 流程恢复；验证 `session.resumed` 和旧 response 序号门控。

未提供云主机、域名、证书和 IP 白名单，因此本机不能宣称云端 WSS 已验收。部署时必须先补齐这些外部条件，再执行上述命令。

## 2026-10-15 当前服务器状态

- `aihero.com.cn` A 记录已解析到 `14.22.89.31`。
- 网关已使用 `/opt/anyidea/gateway/.env.production` 通过 systemd 启动，监听 `0.0.0.0:8787`；iptables 仅拒绝外部访问 8787，并允许 loopback，Nginx 反代本机网关。
- 本机验证：`/healthz` 返回 200；无 App Secret 的 `/session` 返回 401；正确 App Secret 的 `/session` 返回 200。响应正文未记录。
- MySQL `3306` 和 Redis `6379` 是既有对外服务，部署没有修改端口、容器或防火墙规则。
- Docker Compose 文件已上传，但 Docker Hub 的 Node 基础镜像拉取超时；当前运行的是同一源码的 systemd Node 24 fallback。镜像源恢复后可切换回 Compose。
- Let’s Encrypt 申请失败：CA 从公网访问 `http://aihero.com.cn/.well-known/acme-challenge/` 超时。服务器本地 UFW/iptables 放行，需在云安全组放行 TCP 80、443 后重试。
