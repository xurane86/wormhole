# wormhole

通用内网反向代理 relay —— 独立 Node.js 服务 + 管理页面，给**任意内网运行的网站/网页**做出口中转，目标网站**零改造**，只需把访问地址换成 relay 地址即可。

```
用户/浏览器 ──▶ relay（公网或外侧机器）
                 │  按「子域名」路由规则转发
                 │  WebSocket 长连接（agent 主动连入，内网无需公网IP/端口）
              agent（内网）──▶ http://内网目标:端口（任意网站，不改代码）
```

**接入方式：仅支持子域名模式。** relay 依据请求的 `Host` 头，把 `{规则名}.<根域名>` 分流到对应 agent。应用始终运行在自己的 origin 根路径上，所以不需要改代码、不需要配 `basePath`，`/_next/*`、`/api/*`、Service Worker 的 scope 全都天然正确。

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

# 1. 启动 relay（公网机器），开启子域名模式
node server/index.js --port 7800 --secret my-shared-secret \
  --root-domain example.com \
  --self-host relay.example.com

# 2. 启动 agent（内网机器），注册一条路由
node agent/index.js --relay http://relay.example.com:7800 \
  --secret my-shared-secret \
  --name intranet-wiki \
  --target http://192.168.1.10:8090

# 3. 打开管理页启用规则
#    http://relay.example.com:7800/admin
```

之后外部访问 `http://intranet-wiki.example.com/` 即等于访问内网 `http://192.168.1.10:8090/`。

## 子域名模式

relay 侧需要两个参数：

| 参数 | 环境变量 | 说明 |
|---|---|---|
| `--root-domain` | — | 根域名，如 `example.com`；开启后 `{规则名}.example.com` 交给规则 |
| `--self-host` | `RELAY_SELF_HOST` | relay 自身域名（如 `relay.example.com`），不会被当成规则名 |

DNS 侧：给根域名加一条泛解析 `*.example.com` → relay 的 IP。

请求进来后的判定顺序：

1. Host 命中 `{规则名}.{root-domain}` → 转发给同名规则
2. Host 等于 `--self-host` 或根域名本身 → relay 自身路由（`/`、`/admin`、`/api/*` 等）
3. 其余 → 若配置了 `--default-rule` 走兜底，否则 404

> **为什么没有路径模式**：把应用挂在 `/p/{name}/` 前缀下，只能通过改写 HTML 里的绝对路径来兜底。但 SPA 的请求由 JS 运行时发起（Next.js 的 `/_next/*` 与 RSC 请求、`fetch("/api/x")`、`new WebSocket(origin + "/ws")`），Service Worker 的 scope 也天然是根路径 —— 这些 relay 都无法改写。子域名模式下应用根路径不变，因此兼容性最好，也是目前唯一支持的接入方式。

## 兜底模式：`--default-rule`（可选，单应用部署才建议开启）

```bash
node server/index.js --port 7800 --secret ... --default-rule intranet-wiki
# 或环境变量 RELAY_DEFAULT_RULE=intranet-wiki
```

开启后，所有**未被子域名模式匹配**的请求（含 WebSocket upgrade）都会把完整原始 path + query 转发到指定规则。适合「一台 relay 只服务一个内网应用」的部署，应用无需任何域名前缀即可完整可用。

**安全提示：这本质是“单应用兜底”，一旦开启，任何扫到你域名的未匹配路径（如 `/wp-admin`、`/.env`）都会被转发进内网应用，仅建议在内网或带认证的前置层之后使用。**

以下 relay 自身路由优先于兜底，不会被转发：`/`、`/admin`、`/admin/*`、`/style.css`、`/api/rules`、`/api/rules/*`、`/api/agent-token/*`、`/agent/ws`。指向的规则不存在时仅打启动警告，可在 `/admin` 中创建后自动生效。

## 支持的流量

- 普通 HTTP/HTTPS 请求（GET/POST/PUT/DELETE/PATCH，含二进制与流式响应）
- WebSocket 透传：浏览器到内网目标的应用层 WebSocket 连接会在 relay 上自动桥接（子域名模式与 `--default-rule` 兜底模式）。文本/二进制帧原样透传，客户端请求的子协议由目标选中的协议回显；规则不存在返回 404、规则停用返回 502、agent 离线返回 503
- 请求/响应头按需透传（自动去掉 hop-by-hop 头），自动处理 `Host`、`X-Forwarded-*`

### WebSocket 保活与心跳

- **relay → 浏览器**：relay 每 30s 给浏览器侧连接发一次 Ping（浏览器会自动回 Pong，对页面无感）。这不是可选优化：前置的 Cloudflare（空闲 100s 断连）、nginx（`proxy_read_timeout` 默认 60s）等会把长时间没有数据的 WebSocket 掐掉，表现为“连上一会儿就断开”。间隔可用 `RELAY_WS_KEEPALIVE_MS` 调整；连续 3 次收不到 Pong 才判死并回收连接。
- **agent → 内网目标**：目标站若用 RFC6455 的 Ping 做心跳（很常见），agent 会原样回 Pong（含 Ping 携带的数据），不会因为漏回心跳被目标判死断开；分片消息（continuation 帧）会被正确拼回。
- **close 码**：浏览器不带状态码关闭时看到的是保留码 1005/1006，这类码不允许出现在线上，relay/agent 会归一化成 1000 再转发，避免对端 ws 库报 `invalid status code`。

## 排查：子域名模式连上一会儿就断开

按以下顺序看：

1. **前置代理的空闲超时**：浏览器 → Cloudflare/nginx → relay 这条链路上，WS 空闲会被中间层掐断。relay 已内置 30s 保活 Ping；若仍偶发，检查反向代理的 `proxy_read_timeout`/`proxy_send_timeout` 是否小于 30s。
2. **目标站自己的心跳**：确认 agent 侧日志没有 `与 relay 断开`，同时目标站日志里没有 `no pong`/心跳超时。agent 会回 Pong，若目标站用的是应用层心跳（JSON 消息而非 WS 控制帧），relay 只做透传，需要目标站自身正确应答。
3. **agent 是否在反复重连**：relay 控制台会打印 `[agent] "xxx" 已连接 / 已断开`。若频繁出现，说明 relay 与 agent 之间的链路不稳（网络/前置代理），此时浏览器侧的所有 WS 都会跟着断。注意 agent 每 30s 发一次 Ping，10s 内收不到 Pong 就会主动重连；如果 agent 经过 Cloudflare 等终结型 WS 代理，控制帧可能不透传，建议让 agent 直连 relay 源站地址。

## 反向代理 / CDN 注意事项

- 反代要把 `Host` 原样透传给 relay，否则子域名规则无法匹配。
- 若在 relay 前面开了**静态资源缓存**（如 Nginx Proxy Manager 的 Asset Caching），注意它通常会连同 5xx 响应一起缓存。relay 抖动时产生的 502/503 会被缓存住，表现为“某个 `.js` 一直 502”。建议对 relay 关闭静态资源缓存。
- WebSocket 需要反代支持 Upgrade 透传。

## 测试

```bash
npm test        # test/e2e.mjs：同进程拉起 relay + agent + 模拟目标站
```

覆盖子域名模式的 HTTP 与 WS 转发、目标侧心跳（Ping→Pong）、WS 子协议协商、relay 侧保活。

## 管理页面

`http://relay:7800/admin`

- 查看/新增/编辑/删除路由规则
- 启用/停用单条规则（停用后 relay 返回 502 提示页）
- 实时显示每条规则的连接 agent 与流量统计
- 入口地址列显示子域名访问地址（`{规则名}.<根域名>`）

## 安全建议

- `--secret` 为 server 与 agent 的共享密钥，务必使用强随机值
- 生产环境在前置一层 HTTPS（Caddy/Nginx 均可）
- 管理页默认无鉴权，只应暴露在内网或加 Basic Auth；可用 `--admin-user/--admin-pass` 开启管理页 Basic Auth

## 配置持久化

规则保存在 `--data` 目录（默认 `./relay-data/rules.json`），重启不丢失。agent 侧规则写在各自启动参数或 `agent/config.json`。
