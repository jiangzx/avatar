# 运维操作手册

给部署/值班人员用。命令在**仓库根目录**执行，除非另写路径。  
不要把密钥、密码明文、对话内容写进日志或工单。

## 1. 先看这几件事

| 东西 | 说明 |
|---|---|
| 网关端口 | 默认 `8787`（App / 反向代理连这里） |
| 后台端口 | 默认 `8788`，**只绑本机** `127.0.0.1`；未配置则后台不开 |
| 健康检查 | `GET /healthz` → `{"ok":true}` |
| 配置文件 | 本机：`gateway/.env`；Compose 生产：`gateway/.env.production`（权限建议 `600`） |
| 记忆库 | `MEMORY_DB_PATH` 指向的 SQLite；路径放在仓库外 |
| Node | 需要 **Node ≥ 24** |

**硬规则**

- 密钥只放环境变量 / `.env`，不要进 git、日志、截图正文。
- 日志只允许事件名、id、数量、耗时、错误码；不要记语音或对话文字。
- `8787` 不要直接对公网开放；对外走 Nginx（HTTPS/WSS）。后台 `8788` 只本机或经 SSH 隧道访问。

---

## 2. 首次准备

```bash
# 安装依赖（严格按 lock）
npm ci

# 本机配置：从模板复制，再改密钥
cp gateway/.env.example gateway/.env
chmod 600 gateway/.env

# 生成 App 共用密钥（≥16 位；不要用 change-me 开头）
openssl rand -hex 24
# 把结果填进 gateway/.env 的 APP_SECRET=

# 生产用 Compose 时，另备一份（不要提交）
cp gateway/.env gateway/.env.production   # 或按环境单独编辑
chmod 600 gateway/.env.production
```

**`.env` 里运维常改的项**

| 变量 | 作用 |
|---|---|
| `PORT` | 网关端口，默认 `8787` |
| `APP_SECRET` | App 与网关共用密钥（必填） |
| `ADAPTER` | `mock`（无模型） / `qwen`（真实） |
| `DASHSCOPE_API_KEY` | Qwen 时必填 |
| `QWEN_ENDPOINT` | Qwen 时必填（工作空间 WSS 地址） |
| `MEMORY_DB_PATH` | 记忆库绝对路径；不设则无开发模式（无设备注册/记忆） |
| `ADMIN_PORT` | 后台端口，如 `8788`；不设 = 后台关闭 |
| `ADMIN_PASSWORD_HASH` | 后台登录密码的哈希（见第 4 节） |
| `ADMIN_SECRET_KEY` | 可选；设了才能在后台写入模型 Key（`openssl rand -base64 32`） |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `TRUST_PROXY` | 反代场景填 `1` |

完整注释见 `gateway/.env.example`。

---

## 3. 启停网关（本机 Node）

后台与网关**同一个进程**：启停网关 = 启停后台。

本机推荐入口（后台、幂等重启、按 `PORT` 杀进程、等 `/healthz`）：

```bash
./scripts/gateway.sh start    # 已在跑则先停再启；日志 gateway/logs/gateway.out.log
./scripts/gateway.sh stop
./scripts/gateway.sh status   # up → 退出 0；down → 非 0
```

若本机还有 **launchd / 其他保活** 在管同一端口，`stop` 后可能被立刻拉起，`start` 会因端口占用失败并提示看日志；那时以保活配置为准，或先卸掉保活再使用本脚本。

底层 / 开发用法：

```bash
# 前台启动（看日志；Ctrl+C 停止）
npm start -w gateway

# 开发热重载（改代码自动重启；生产勿用）
npm run dev -w gateway

# 看谁占着 8787 / 8788
lsof -iTCP:8787 -sTCP:LISTEN
lsof -iTCP:8788 -sTCP:LISTEN

# 手工按端口停（脚本内部也是这一套）
kill "$(lsof -tiTCP:8787 -sTCP:LISTEN)"
```

启动成功日志里应出现：

- `gateway_listening`（带 `port`、`adapter`）
- 若开了后台：`admin_listening`（带 `port`）

---

## 4. 后台密码（生成 / 更换）

密码**至少 8 个字符**。`.env` 里只存哈希，不存明文。

```bash
# 交互输入（推荐，屏幕不回显）
npm run admin:hash-password -w gateway

# 或管道（注意可能进 shell 历史，用完清历史）
printf '%s' '你的密码' | npm run -s admin:hash-password -w gateway
```

把打印的整行（`scrypt$...`）写入：

```bash
# gateway/.env 或 gateway/.env.production
ADMIN_PORT=8788
ADMIN_PASSWORD_HASH=（粘贴生成结果）
```

然后**重启网关**。浏览器打开：`http://127.0.0.1:8788`（远程用 SSH 隧道，不要把 8788 暴露公网）。

---

## 5. 后台静态页（本机非 Docker）

Docker 镜像构建时会打进 `admin/dist`。本机直接跑 Node 时，需先有构建产物：

```bash
npm run build -w admin
# 产物：admin/dist/ ；网关启动后从这里提供页面
```

---

## 6. Docker Compose（仓库内已支持）

文件：`docker-compose.gateway.yml` + `Dockerfile.gateway`  
环境：读 `gateway/.env.production`，端口映射 `127.0.0.1:8787:8787`。

```bash
# 构建并后台启动
docker compose -f docker-compose.gateway.yml up -d --build

# 看状态 / 日志
docker compose -f docker-compose.gateway.yml ps
docker compose -f docker-compose.gateway.yml logs -f --tail=200

# 重启 / 停止
docker compose -f docker-compose.gateway.yml restart
docker compose -f docker-compose.gateway.yml down
```

容器内仍是 `npm run start`（gateway）。后台若已在 `.env.production` 开启，同样只应在本机侧访问（Compose 当前未映射 8788；需要时再单独加 `127.0.0.1:8788:8788`）。

---

## 7. 健康检查与常用探测

```bash
# 网关是否活着（应 200，正文含 ok）
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/healthz
curl -sS http://127.0.0.1:8787/healthz

# 后台页是否起来（开了 ADMIN_PORT 时应 200）
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/

# 无密钥访问业务接口应 401（说明鉴权在）
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/session \
  -H 'content-type: application/json' -d '{}'
```

对外 HTTPS 验收、WSS、证书等边界见：[plan2-wss.md](./plan2-wss.md)。

---

## 8. 记忆库备份（运维可选）

库路径看 `.env` 的 `MEMORY_DB_PATH`。备份前尽量停写或接受短暂锁；推荐用 SQLite 的 `VACUUM INTO` 拷到安全目录（权限 `600`）。

```bash
# 示例：把当前库安全拷出一份（路径按现场改）
node --env-file=gateway/.env -e '
const { DatabaseSync } = require("node:sqlite");
const src = new DatabaseSync(process.env.MEMORY_DB_PATH, { readOnly: true });
src.exec(`VACUUM INTO ${JSON.stringify(process.argv[1])}`);
src.close();
' /var/backups/avatar-memory-$(date +%Y%m%d).db
chmod 600 /var/backups/avatar-memory-*.db
```

不要把备份库提交进仓库。

---

## 9. 本机联调（非生产，可选）

```bash
# Mock 语音样本（macOS；生产 Qwen 不需要）
./scripts/make-mock-speech.sh

# 桌面 Web 调试页
npm run dev -w avatar-core

# 打进 Flutter 的 Web 资源后再跑 App
./scripts/build-web.sh
```

手机连本机网关（USB）：

```bash
adb reverse tcp:8787 tcp:8787
```

---

## 10. 出问题先查什么

| 现象 | 先做 |
|---|---|
| 8787 连不上 | `lsof -iTCP:8787`；看进程是否在；看 `gateway_listening` |
| `/healthz` 非 200 | 进程崩了或端口错；看启动终端 / Compose 日志 |
| 8788 打不开 | 是否设了 `ADMIN_PORT` + `ADMIN_PASSWORD_HASH`；是否重启过；`admin_listening` 有没有 |
| 登录提示密码不对 | 哈希是否粘完整；改哈希后是否重启；密码 ≥ 8 位 |
| Qwen 起不来 | `ADAPTER=qwen` 且 Key、Endpoint 齐全 |
| 后台能看不能改 Key | 是否配置了 `ADMIN_SECRET_KEY` |

---

## 11. 命令速查

```bash
npm ci                                 # 装依赖
./scripts/gateway.sh start             # 本机后台启/重启网关（含可选后台）
./scripts/gateway.sh stop              # 本机停止
./scripts/gateway.sh status            # 本机状态（healthz）
npm start -w gateway                   # 前台启动（含可选后台）
npm run dev -w gateway                 # 开发热重载
npm run admin:hash-password -w gateway # 生成后台密码哈希
npm run build -w admin                 # 构建后台页面
docker compose -f docker-compose.gateway.yml up -d --build
docker compose -f docker-compose.gateway.yml logs -f
docker compose -f docker-compose.gateway.yml down
curl -sS http://127.0.0.1:8787/healthz
```
