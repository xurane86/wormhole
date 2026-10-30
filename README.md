# wormhole

通用内网反向代理 relay —— 独立 Node.js 服务 + 管理页面，给**任意内网运行的网站/网页**做出口中转，目标网站**零改造**，只需把访问地址换成 relay 地址即可。

```
用户/浏览器 ──▶ relay（公网或外侧机器）
                 │  按「路由规则」转发
                 │  WebSocket 长连接（agent 主动连入，内网无需公网IP/端口）
              agent（内网）──▶ http://内网目标:端口（任意网站，不改代码）
```

## 组成

| 组件 | 运行位置 | 说明 |
|---|---|---|
| `server/` | 公网服务器 | 转发服务 + 路由规则管理 API + 管理页面 |
| `agent/` | 内网（能访问目标网站即可） | 主动连接 relay，把收到的请求转发给内网目标 |
| `public/` | 由 server 托管 | 管理页面（规则增删改、启停） |

## 快速开始

```bash
cd wormhole
npm install

# 1. 启动 relay（公网机器，或本机测试）
node server/index.js --port 7800 --secret my-shared-secret

# 2. 启动 agent（内网机器），注册一条路由
node agent/index.js --relay http://relay机器:7800 \
  --secret my-shared-secret \
  --name intranet-wiki \
  --target http://192.168.1.10:8090

# 3. 打开管理页启用规则
#    http://relay机器:7800/admin
```

之后外部访问 `http://relay机器:7800/p/intranet-wiki/` 即等于访问内网 `http://192.168.1.10:8090/`。

## 接入任意网站的方式

### 方式一：路径模式（默认，改 BaseURL 即可）

规则路径前缀为 `/p/{name}/`。目标网站若支持配置 BaseURL / 根路径（大多数 Wiki、文档站、内部系统都支持），把它设为 `http://relay:7800/p/{name}/` 即完成接入。

agent 会在转发时自动改写 HTML 里的绝对路径引用（`href="/..."`、`src="/..."`），帮助无 BaseURL 配置的简单站点尽量正常工作。

### 方式二：子域名模式（完全不改动感）

`--host-mode`：设置 DNS 泛解析 `*.relay.你的域名.com` 指向 relay，访问 `{name}.relay.你的域名.com` 即直达内网站点，页面完全不需要路径前缀，兼容性最好。需在 relay 侧加 `--root-domain` 参数开启。

### 兑底模式：`--default-rule`（可选，单应用部署才建议开启）

```bash
node server/index.js --port 7800 --secret ... --default-rule intranet-wiki
# 或环境变量 RELAY_DEFAULT_RULE=intranet-wiki
```

开启后，所有既不是路径模式（`/p/{name}/...`）、也不是子域名模式的请求（含 WebSocket upgrade），都会把完整原始 path + query 转发到指定规则。适合「一台 relay 只服务一个内网应用」的部署，应用无需任何路径前缀即可完整可用。

**安全提示：这本质是“单应用兑底”，一旦开启，任何扫到你域名的未匹配路径（如 `/wp-admin`、`/.env`）都会被转发进内网应用，仅建议在内网或带认证的前置层之后使用。**

以下 relay 自身路由优先于兑底，不会被转发：`/`、`/admin`、`/admin/*`、`/style.css`、`/api/rules`、`/api/rules/*`、`/api/agent-token/*`、`/agent/ws`。指向的规则不存在时仅打启动警告，可在 `/admin` 中创建后自动生效。

## 支持的流量

- 普通 HTTP/HTTPS 请求（GET/POST/PUT/DELETE/PATCH，含二进制与流式响应）
- WebSocket 透传：浏览器到内网目标的应用层 WebSocket 连接会在 relay 上自动桥接（含路径模式 `/p/{name}/ws/...`、子域名模式与下述 `--default-rule` 兑底模式）。文本/二进制帧原样透传，客户端请求的子协议由目标选中的协议回显；规则不存在返回 404、规则停用返回 502、agent 离线返回 503。注意：JS 发起的 `fetch("/api/...")` 等绝对路径请求在路径模式下仍无法由 relay 改写，SPA 类应用建议配置应用自身 basePath
- 请求/响应头按需透传，自动处理 `Host`、`X-Forwarded-*`

### WebSocket 保活与心跳

- **relay → 浏览器**：relay 每 30s 给浏览器侧连接发一次 Ping（浏览器会自动回 Pong，对页面无感）。这不是可选优化：前置的 Cloudflare（空闲 100s 断连）、nginx（`proxy_read_timeout` 默认 60s）等会把长时间没有数据的 WebSocket 掐掉，表现为“连上一会儿就断开”。间隔可用 `RELAY_WS_KEEPALIVE_MS` 调整；连续 3 次收不到 Pong 才判死并回收连接。
- **agent → 内网目标**：目标站若用 RFC6455 的 Ping 做心跳（很常见），agent 会原样回 Pong（含 Ping 携带的数据），不会因为漏回心跳被目标判死断开；分片消息（continuation 帧）会被正确拼回。
- **close 码**：浏览器不带状态码关闭时看到的是保留码 1005/1006，这类码不允许出现在线上，relay/agent 会归一化成 1000 再转发，避免对端 ws 库报 `invalid status code`。

## 排查：子域名模式连上一会儿就断开

按以下顺序看：

1. **前置代理的空闲超时**：浏览器 → Cloudflare/nginx → relay 这条链路上，WS 空闲会被中间层掐断。relay 已内置 30s 保活 Ping；若仍偶发，检查反向代理的 `proxy_read_timeout`/`proxy_send_timeout` 是否小于 30s。
2. **目标站自己的心跳**：确认 agent 侧日志没有 `与 relay 断开`，同时目标站日志里没有 `no pong`/心跳超时。agent 会回 Pong，若目标站用的是应用层心跳（JSON 消息而非 WS 控制帧），relay 只做透传，需要目标站自身正确应答。
3. **agent 是否在反复重连**：relay 控制台会打印 `[agent] "xxx" 已连接 / 已断开`。若频繁出现，说明 relay 与 agent 之间的链路不稳（网络/前置代理），此时浏览器侧的所有 WS 都会跟着断。
4. **路径模式下的应用**：若应用前端用绝对路径（Next.js 的 `/_next/...`、`/api/...`、`ws://host/ws` 等），路径模式本身就无法工作，见下节。

## 路径模式能接什么、不能接什么

路径模式（`/p/{name}/`）只在「应用自身支持配置 BaseURL/basePath」时才完整可用：

- 能接：支持 BaseURL 的 Wiki、文档站、后台系统；纯静态站（relay 会注入 `<base>` 并改写 HTML/CSS 里的绝对路径）。
- 接不了：前端硬编码绝对路径的 SPA（Next.js 的 `/_next/*` 与 RSC 请求、`fetch("/api/x")`、`new WebSocket(origin + "/ws")`）。这些请求由 JS 运行时发起，relay 改不到，会直接打到 relay 根路径上（404 或落到别的规则）。
- 这类应用用**子域名模式**，或给应用配 basePath；单应用部署也可以用 `--default-rule` 兑底。

## 测试

```bash
npm test        # test/e2e.mjs：同进程拉起 relay + agent + 模拟目标站
```

覆盖路径/子域名两种模式的 HTTP 与 WS 转发、目标侧心跳（Ping→Pong）、WS 子协议协商、relay 侧保活。


## 管理页面

`http://relay:7800/admin`

- 查看/新增/编辑/删除路由规则
- 启用/停用单条规则（停用后 relay 返回 502 提示页）
- 实时显示每条规则的连接 agent 与流量统计

## 安全建议

- `--secret` 为 server 与 agent 的共享密钥，务必使用强随机值
- 生产环境在前置一层 HTTPS（Caddy/Nginx 均可）
- 管理页默认无鉴权，只应暴露在内网或加 Basic Auth；可用 `--admin-user/--admin-pass` 开启管理页 Basic Auth

## 配置持久化

规则保存在 `--data` 目录（默认 `./relay-data/rules.json`），重启不丢失。agent 侧规则写在各自启动参数或 `agent/config.json`。
